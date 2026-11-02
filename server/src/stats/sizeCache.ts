/**
 * 照片库体积缓存
 *
 * 为什么单独抽出来：体积是唯一需要「遍历整个照片库」才能得到的统计量。
 * 旧实现（routes/stats.ts 内联）有三处问题，都会让 /api/stats 的 5 秒轮询
 * 变成一场无谓的磁盘 IO 风暴：
 *
 *   ① 只要「资产数变化」或「扫描轮次变化」就清空缓存 + 删 stats.json + 重算。
 *      扫描期间资产数每 200 条提交一次就变一次（scanner/index.ts），
 *      等于扫描全程每 5 秒把整个照片库遍历一遍（正式库 2 万文件）。
 *   ② 内存缓存是模块闭包变量，切库后不重置 —— 新库首次请求会读到旧库的字节数。
 *   ③ 失效分支用的是「当前库」的 statsCachePath() 删文件，而遍历在途完成时
 *      又以当前 config.libraryRoot 落盘 —— 双向都能把旧库数字写到新库名下。
 *
 * 现在三条规则：
 *   - 任务运行期不遍历：扫描 / 导入 / 同步在跑时 ensure() 直接返回，
 *     等任务结束后的第一次请求再算（缩略图生成不算 —— 体积是源文件大小，与它无关）。
 *   - 按库归属：contextKey = dbPath + libraryRoot。key 变化即丢内存缓存并重读
 *     该库自己的 stats.json；遍历带 shouldAbort，落盘前再校验一次 key，
 *     不符就整份丢弃（绝不跨库写）。
 *   - 单飞 + 脏标记：同一时刻只有一个遍历；数据过期只标 dirty，仍返回上一次的值，
 *     不再出现「算完又清空 → 前端看到 null 抖动」的空窗。
 *
 * 依赖全部注入（walk / countAssets / 时钟 / 文件读写），因此单测不需要
 * 启 Fastify、也不需要真实照片库。
 */

/** 落盘的缓存文件内容 */
export interface SizeCacheEntry {
  /** 库根绝对路径（归属校验用） */
  libraryRoot: string
  totalBytes: number
  /** 计算时的资产数（判断是否过期） */
  assetCount: number
  /** 计算时的扫描轮次（判断是否过期） */
  scanRunId: number
  /** 计算时刻（排查用；当前不参与失效判断） */
  computedAt: number
}

export interface SizeCacheDeps {
  /** 库上下文标识：库切换（dbPath / libraryRoot 变化）即判定缓存作废 */
  contextKey: () => string
  /** 当前库根目录（遍历起点，也是落盘归属） */
  libraryRoot: () => string
  /** 当前库的体积缓存文件路径 */
  cachePath: () => string
  /** 当前库的资产总数 */
  countAssets: () => number
  /** 当前扫描轮次 */
  scanRunId: () => number
  /** 是否有任务在跑（扫描 / 导入 / 同步）；true 期间不做整库遍历 */
  isQuiet: () => boolean
  /** 遍历目录累加文件字节数；shouldAbort() 为 true 时应尽快返回 */
  walk: (dir: string, shouldAbort: () => boolean) => Promise<number>
  exists: (p: string) => boolean
  readFile: (p: string) => string
  writeFile: (p: string, data: string) => void
  now: () => number
  log?: (message: string, err?: unknown) => void
}

export interface SizeCache {
  /** 资产数变化时标记待重算（不立刻清空，继续返回旧值） */
  touch: (assetTotal: number) => void
  /** 条件满足时在后台开算（单飞：已有遍历在跑则跳过） */
  ensure: () => void
  /** 当前已知字节数；null = 该库尚未算出（首次启动且任务在跑） */
  readonly bytes: number | null
  /** 测试用：完全复位内存状态 */
  reset: () => void
}

export function createSizeCache(deps: SizeCacheDeps): SizeCache {
  let cache: SizeCacheEntry | null = null
  /** 内存缓存当前对应的库上下文（null = 尚未同步过） */
  let loadedFor: string | null = null
  /** 数据已过期，等下一次 ensure() 重算 */
  let dirty = true
  /** 正在遍历的库上下文 key（null = 没有遍历在跑） */
  let computingKey: string | null = null

  /** 从当前库的 stats.json 恢复；路径或归属不符一律忽略（触发重算） */
  function loadFromDisk(): void {
    try {
      if (!deps.exists(deps.cachePath())) return
      const data = JSON.parse(deps.readFile(deps.cachePath())) as Partial<SizeCacheEntry>
      const valid =
        data.libraryRoot === deps.libraryRoot() &&
        typeof data.totalBytes === 'number' &&
        typeof data.assetCount === 'number' &&
        typeof data.scanRunId === 'number'
      if (!valid) return
      cache = {
        libraryRoot: data.libraryRoot as string,
        totalBytes: data.totalBytes as number,
        assetCount: data.assetCount as number,
        scanRunId: data.scanRunId as number,
        computedAt: typeof data.computedAt === 'number' ? data.computedAt : deps.now(),
      }
      dirty = false
    } catch {
      // 缓存损坏 / 版本不符：忽略，等重算
    }
  }

  /**
   * 把内存状态对齐到当前库。key 不变就是一次字符串比较（幂等，可放心在每个
   * 公开方法开头调用）；key 变了说明切过库，丢弃旧库的内存缓存并重读新库的落盘缓存。
   */
  function syncContext(): void {
    const key = deps.contextKey()
    if (key === loadedFor) return
    loadedFor = key
    cache = null
    dirty = true
    loadFromDisk()
  }

  async function compute(key: string): Promise<void> {
    computingKey = key
    const root = deps.libraryRoot()
    try {
      const bytes = await deps.walk(root, () => deps.contextKey() !== key)
      // 遍历期间切了库：这份结果属于旧库，绝不能落到新库名下
      if (deps.contextKey() !== key) {
        deps.log?.('[stats] 体积遍历期间库已切换，丢弃结果')
        return
      }
      const assetCount = deps.countAssets()
      const scanRunId = deps.scanRunId()
      const entry: SizeCacheEntry = {
        libraryRoot: root,
        totalBytes: bytes,
        assetCount,
        scanRunId,
        computedAt: deps.now(),
      }
      cache = entry
      dirty = false
      deps.writeFile(deps.cachePath(), JSON.stringify(entry))
    } catch (err) {
      // 失败不置 dirty=false：留给下一次请求重试，不在这里自旋（避免失败时死循环）
      deps.log?.('[stats] 体积计算失败:', err)
    } finally {
      computingKey = null
    }
  }

  return {
    touch(assetTotal: number): void {
      syncContext()
      if (!cache) {
        dirty = true
        return
      }
      // 资产数变了，或扫描轮次变了（重扫可能改了文件内容）→ 标记待重算
      if (cache.assetCount !== assetTotal || cache.scanRunId !== deps.scanRunId()) dirty = true
    },

    ensure(): void {
      syncContext()
      if (computingKey) return // 已有遍历在跑（任意库），不并发开第二个
      if (!deps.isQuiet()) return // 任务在跑：等结束后的第一次请求再算
      if (cache && !dirty) return
      void compute(deps.contextKey())
    },

    get bytes(): number | null {
      syncContext()
      return cache?.totalBytes ?? null
    },

    reset(): void {
      cache = null
      loadedFor = null
      dirty = true
      computingKey = null
    },
  }
}
