/**
 * 照片库路由（P0 单活跃库模型）
 *
 * GET   /api/libraries            ：库列表（account 打码，不泄露完整邮箱）
 * POST  /api/libraries {name}     ：新建库并激活（首次引导「设置库名」步骤）
 * PATCH /api/libraries/:id/active ：切换激活库（热切换：停 watcher → 清队列 → 关 DB
 *                                   → 覆写 config → 重开 DB → 重扫 → 启 watcher）
 *
 * 热切换保证（对应架构文档 §3.2.2）：
 *   1. 同步任务在跑/在等重试时拒绝切换（409），避免 icloudpd 进程写错库目录；
 *   2. 缩略图队列清空 + 进度复位，旧库任务不会串到新库；
 *   3. 现有路由持有 getDb() 代理，切库后自动指向新库连接，零改动。
 */
import type { FastifyInstance } from 'fastify'
import {
  listLibraries,
  getLibraryById,
  createLibrary,
  setActiveLibrary,
  deleteLibrary,
  updateLibraryConfig,
  validateLibraryName,
  type LibraryRow,
} from '../db/libraries.js'
import { applyLibraryPaths, getCurrentLibrary, resetLibraryPaths } from '../context.js'
import { closeDb, getDb } from '../db/index.js'
import { stopWatcher, startWatcher } from '../scanner/watcher.js'
import { runScan, scanProgress } from '../scanner/index.js'
import { clearThumbnailQueue } from '../pipeline/queue.js'
import { isSyncBusy } from '../icloudpd/sync.js'
import { resetSyncState } from '../icloudpd/state.js'
import { isImportBusy, importState } from '../import/state.js'
import { stopAuth } from '../icloudpd/auth.js'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** 只读统计某库 library.db 的照片/视频数（无 DB / 打不开 → 0，不影响列表） */
function countAssets(dbPath: string): { photos: number; videos: number } {
  try {
    if (!fs.existsSync(dbPath)) return { photos: 0, videos: 0 }
    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db
        .prepare(`SELECT type, COUNT(*) AS c FROM assets GROUP BY type`)
        .all() as { type: string; c: number }[]
      const counts: Record<string, number> = {}
      for (const r of rows) counts[r.type] = r.c
      // 与主页 /api/stats 口径统一：照片数 = 普通照片 + 实况照片（live），视频数不含实况附带视频
      return {
        photos: (counts.photo ?? 0) + (counts.live ?? 0),
        videos: counts.video ?? 0,
      }
    } finally {
      db.close()
    }
  } catch {
    return { photos: 0, videos: 0 }
  }
}

/**
 * 库计数缓存（10 秒 TTL）
 *
 * 背景：GET /api/libraries 对**每个库**都 `new Database(dbPath)` 开一次只读连接、
 * 跑一次 GROUP BY、再 close。设置中心打开期间每 5 秒拉一次列表，3 个库就是
 * 每 5 秒 3 次连接开闭 + 3 次索引扫描（含非激活库，产生无谓的 WAL 读锁与句柄抖动）。
 * 而库计数只在「扫描落库 / 删照片」时变化，属低频数据，没必要每轮都真算。
 *
 * 失效策略：key 带 token（扫描轮次 + 扫描状态 + 导入状态）。状态位一变 key 就变，
 * 扫描结束立刻重算，不用等 TTL 过期 —— 这是 TTL 之外的必要补充，因为扫描期间
 * runId 早已自增、结束时不带新信号，只看 runId 会让「扫描完成」滞后 10 秒。
 */
const COUNT_CACHE_TTL_MS = 10_000
/** 缓存条目上限：切库/删库 + 状态位组合会累积，超限整体丢弃（比 LRU 简单且够用） */
const COUNT_CACHE_MAX = 32
interface CountCacheEntry {
  photos: number
  videos: number
  at: number
}
const countCache = new Map<string, CountCacheEntry>()

/** 测试隔离：模块级缓存必须在用例之间清空，否则前一个用例的数字会串到后一个 */
export function resetCountCache(): void {
  countCache.clear()
}

/** 构造缓存 token：把「会影响资产数」的离散状态位拼进来，任一变化即视为新 key */
export function countCacheToken(): string {
  return `${scanProgress.runId}:${scanProgress.status}:${importState.status}`
}

/** 带缓存的库计数（导出供测试直接驱动，路由内部使用） */
export function countAssetsCached(dbPath: string, token: string): { photos: number; videos: number } {
  const key = `${dbPath}#${token}`
  const now = Date.now()
  const hit = countCache.get(key)
  if (hit && now - hit.at < COUNT_CACHE_TTL_MS) {
    return { photos: hit.photos, videos: hit.videos }
  }
  const fresh = countAssets(dbPath)
  if (countCache.size >= COUNT_CACHE_MAX) countCache.clear()
  countCache.set(key, { ...fresh, at: now })
  return fresh
}

/** 库列表的对外形态（激活标记 + 目录展示；本地单机应用，账号原样返回供完整显示） */
function toPublic(row: LibraryRow) {
  return {
    id: row.id,
    name: row.name,
    account: row.account,
    authStatus: row.auth_status,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    active: row.active === 1,
    libraryRoot: row.library_root,
    cacheDir: row.cache_dir,
    cookieDir: row.cookie_dir,
    untilFound: row.until_found,
    recentLimit: row.recent_limit,
  }
}

/**
 * 切库 / 删库 / 删照片 守卫：同步任务执行中或照片库扫描进行中 → 返回错误文案（null = 放行）。
 * 抽出为独立函数便于单元测试（审查 P1 在途扫描守卫 + 同步任务守卫）。
 *
 * 'delete-asset' 用于 DELETE /api/assets（R-15/R-16）：扫描在途时删除会与删除对账互相踩
 * （对账基于本轮遍历快照，刚删掉的文件可能被重新插入或被判孤儿），同步在途时 icloudpd
 * 正在写同一目录，所以同样拒绝。
 */
export function libraryBusyGuard(action: 'switch' | 'delete' | 'delete-asset'): string | null {
  // 导入任务在跑时拒绝切库/删库/删照片（导入会向 import/ 目录写文件并依赖 runScan 落库）
  if (isImportBusy()) {
    // 三个阶段文案不同（C-06）：归置中可取消、取消后正在收尾、落库中不可取消。
    // 一律说「请等待完成或取消」会在后两种情况下误导用户去点一个已经无效的取消。
    const what =
      importState.phase === 'scanning'
        ? '导入的照片正在入库，请稍候'
        : importState.cancelRequested
          ? '导入正在收尾，请稍候'
          : '正在导入照片，请等待完成或取消'
    if (action === 'switch') return `${what}再切换照片库`
    if (action === 'delete-asset') return `${what}再删除照片`
    return `${what}再删除照片库`
  }
  if (isSyncBusy()) {
    if (action === 'switch') return '同步任务执行中，请先等待完成或取消后再切换照片库'
    if (action === 'delete-asset') return '同步任务执行中，请先等待完成或取消后再删除照片'
    return '同步任务执行中，请先等待完成或取消后再删除照片库'
  }
  // 在途扫描未完成时拒绝切换/删除（审查 P1）：旧扫描会在切库后继续经 getDb() 代理写入新库，
  // 其删除对账会把新库资产判为孤儿批量删除 → 数据记录被清空/污染
  if (scanProgress.status === 'scanning') {
    if (action === 'switch') return '照片库扫描进行中，请稍候再切换'
    if (action === 'delete-asset') return '照片库扫描进行中，请稍候再删除照片'
    return '照片库扫描进行中，请稍候再删除'
  }
  return null
}

/**
 * 切库 / 删激活库前的统一收尾（审查 C-15）。
 *
 * 为什么必须停认证会话：`startAuth` 时 cookieDir 就固定成当时那个库的目录，
 * 会话与库是绑定的。不停掉会出三件事：
 *   ① icloudpd 继续往旧库目录写 cookie（删库场景下是往一个马上要被删的目录写）；
 *   ② `GET /api/auth` 对新库的前端返回旧库的会话 —— 用户看到的「等待输验证码」
 *      其实是旧库的；
 *   ③ 用户在界面上输入的验证码经 `/api/auth/input` 转交给旧库会话。
 * 会话停掉后 `/api/auth` 返回 null，前端认证弹窗随之关闭。
 * 切库/删库都是用户显式操作，静默终止一个属于旧库的认证流程是符合预期的。
 *
 * 抽成导出函数同时便于单测：这是唯一能直接断言「切库会停认证」的入口
 * （switchToLibrary 是闭包内的私有函数）。
 */
export function prepareLibrarySwitch(): void {
  stopAuth()
  stopWatcher()
  clearThumbnailQueue()
  closeDb()
}

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/libraries', async () => {
    const current = getCurrentLibrary()
    // token 在循环外算一次：同一次响应里所有库共享同一份状态快照，口径一致
    const token = countCacheToken()
    return {
      libraries: listLibraries().map((l) => ({
        ...toPublic(l),
        ...countAssetsCached(path.join(l.cache_dir, 'library.db'), token),
      })),
      activeId: current?.id ?? null,
    }
  })

  app.post('/api/libraries', async (request, reply) => {
    const body = request.body as { name?: string } | null
    const name = body?.name ?? ''
    const error = validateLibraryName(name)
    if (error) return reply.code(400).send({ error })
    const existing = listLibraries().find((l) => l.name === name.trim())
    if (existing) return reply.code(409).send({ error: '库名已存在' })

    // P2-7：首次建库（当前无库）会触发激活切换（停 watcher/清队列/关 DB），
    // 与切库/删库同等需要过守卫，保持「写操作都过 guard」的一致契约。
    const willActivate = listLibraries().length === 0
    if (willActivate) {
      const busy = libraryBusyGuard('switch')
      if (busy) return reply.code(409).send({ error: busy })
    }

    const lib = createLibrary(name)
    // 仅首次建库（无任何库、createLibrary 内部会激活）需要切换上下文启动扫描；
    // 已有激活库时新建库不激活、不切换——主页面/下拉/设置中心的当前库保持不变
    if (lib.active === 1) {
      switchToLibrary(lib.id)
    }
    return reply.code(201).send({
      ok: true,
      library: toPublic(getLibraryById(lib.id)!),
      note: lib.active === 1 ? '已创建并激活；照片墙已切换，浏览器将刷新' : '已创建；当前照片库保持不变',
    })
  })

  app.patch('/api/libraries/:id/active', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    const target = getLibraryById(id)
    if (!target) return reply.code(404).send({ error: '库不存在' })
    if (target.active === 1) return reply.send({ ok: true, activeId: id, unchanged: true })

    const busy = libraryBusyGuard('switch')
    if (busy) return reply.code(409).send({ error: busy })
    switchToLibrary(id)
    return reply.send({ ok: true, activeId: id })
  })

  /**
   * 更新单库同步参数：untilFound（增量：连续 N 个已存在则停，默认 20）
   *                       recentLimit（下载限量，0=全量不限，默认 0）
   * 环境变量 ICLOUDPD_RECENT 已废弃并移除（config.ts 不再读取），下载限量按库在此配置。
   */
  app.patch('/api/libraries/:id/config', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    const target = getLibraryById(id)
    if (!target) return reply.code(404).send({ error: '库不存在' })
    const body = (request.body ?? {}) as { untilFound?: number; recentLimit?: number }
    updateLibraryConfig(id, {
      untilFound: body.untilFound,
      recentLimit: body.recentLimit,
    })
    const updated = getLibraryById(id)!
    return reply.send({ ok: true, config: { untilFound: updated.until_found, recentLimit: updated.recent_limit } })
  })

  /**
   * 删除照片库（仅本地：注册 + 缓存；勾选时连同本地已下载照片副本一起删。云端 iCloud 不受影响）
   *
   * 删除范围说明（安全边界，用户确认弹窗同文案）：
   *   - 永远删除：meta.db 库注册 + server/cache/lib<id>（缩略图/library.db/stats/cookies 会话）
   *   - 可选删除（removePhotos=true）：iCloudPhoto/lib<id> 本地照片副本；云端原片不动
   *   - 绝不调用 icloudpd 删除类命令
   *
   * 约束：
   *   - 同步任务执行中 → 409（防止删到正在写入的目录）
   *   - 删除当前激活库 → 自动切到剩余库（id 最小）；删最后一个 → 回到无库状态（前端整页刷新走首次引导）
   */
  app.delete('/api/libraries/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    const lib = getLibraryById(id)
    if (!lib) return reply.code(404).send({ error: '库不存在' })

    const busy = libraryBusyGuard('delete')
    if (busy) return reply.code(409).send({ error: busy })
    // 走到这里必然无运行中任务；删除后清全局同步状态残留
    resetSyncState()

    const body = request.body as { removePhotos?: boolean } | null
    const removePhotos = body?.removePhotos === true
    const isActive = lib.active === 1
    /** 删除后要接管的库（删除前算好；无剩余库则为 null） */
    let next: ReturnType<typeof getLibraryById> = null

    // 删除激活库：先停认证/watcher / 清缩略图队列 / 关库 DB，避免删到打开的文件
    if (isActive) {
      prepareLibrarySwitch()

      // R-02 修复（2026-10-28 竞态）：closeDb() 之后 config.dbPath 仍指向被删库，
      // 而下面的 fsp.rm 是异步的（缓存目录可能有几万个缩略图，耗时数十秒），
      // 这期间事件循环会让出 —— 前端每 5 秒的 /api/stats 轮询就会经 getDb() 的
      // ensureOpen() 在这个「正在被删」的目录里重新 mkdir + 建 library.db，
      // Windows 上删除已打开文件 → EPERM → 接口 500，且库只删了一半。
      //
      // 因此在任何 await 之前先把激活标记与 config 指向「下一个库」；
      // 没有剩余库时指向默认无库路径。这样后续所有 DB 访问都落在安全的库上，
      // 被删目录里不会再有人重建文件。
      next = listLibraries().filter((l) => l.id !== id)[0] ?? null
      if (next) {
        setActiveLibrary(next.id)
        applyLibraryPaths(next)
      } else {
        resetLibraryPaths()
      }
    }

    // 缓存目录（注册表记录 + 缩略图/DB/cookies）永远删。
    // 用异步 rm（libuv 线程池）而非 rmSync：大目录（缩略图可数十 GB）同步删除会阻塞事件循环，
    // 期间整个服务无响应（审查 P2）。
    // 删除失败也要把新库正常启动起来（否则服务处于「已切库但没监听」的半瘫状态），
    // 因此这里先捕获错误，收尾之后再决定返回码。
    let deleteError: Error | null = null
    try {
      await fsp.rm(lib.cache_dir, { recursive: true, force: true })
      // 本地照片副本：仅勾选时删（云端原片不动）
      if (removePhotos) {
        await fsp.rm(lib.library_root, { recursive: true, force: true })
      } else {
        // 未勾选时：照片根若是建库预建的空目录（2026-10-28 起建库会预建），顺手清掉避免留空壳。
        // 用 rmdir（非递归）而不是 rm：目录里还有照片时必然抛 ENOTEMPTY，
        // 正好保证这条清理逻辑永远不会误删任何照片。
        try {
          await fsp.rmdir(lib.library_root)
        } catch {
          // 非空（有照片）或本就不存在 → 保持原样
        }
      }
      // 移除注册
      deleteLibrary(id)
    } catch (err) {
      deleteError = err as Error
      console.error(`[libraries] 删除库目录失败（记录保留，可重试）: ${deleteError.message}`)
    }

    if (isActive) {
      if (next) {
        // 上下文已在删除前切好，这里只需打开连接并启动扫描/监听
        getDb()
        void runScan('switch').catch((err) => {
          scanProgress.status = 'error'
          scanProgress.message = (err as Error).message
          console.error(`[libraries] 删除后切换扫描失败: ${(err as Error).message}`)
        })
        startWatcher()
        console.log(`[libraries] 已删除照片库 ${lib.name}，切换激活库: ${next.name}`)
        if (deleteError) return reply.code(500).send({ error: `删除库目录失败：${deleteError.message}` })
        return reply.send({ ok: true, activeId: next.id, remaining: listLibraries().length })
      }
      // 最后一个库：回到无库状态（config 路径已在删除前重置为默认，前端整页刷新 → 首次引导）
      console.log(`[libraries] 已删除最后一个照片库 ${lib.name}，回到无库状态`)
      if (deleteError) return reply.code(500).send({ error: `删除库目录失败：${deleteError.message}` })
      return reply.send({ ok: true, activeId: null, remaining: 0 })
    }

    if (deleteError) return reply.code(500).send({ error: `删除库目录失败：${deleteError.message}` })
    console.log(`[libraries] 已删除照片库 ${lib.name}`)
    return reply.send({ ok: true, activeId: getCurrentLibrary()?.id ?? null, remaining: listLibraries().length })
  })

  /**
   * 热切换激活库（共用逻辑）：
   * 停 watcher → 清缩略图队列 → 关旧 DB → 覆写 config → 重开新 DB → 增量扫描 → 启 watcher
   */
  function switchToLibrary(id: number): void {
    prepareLibrarySwitch()
    // 切库后同步状态复位（全局单例；否则新库 stats 会残留旧库的「同步完成/已下载 N 项」文案）
    resetSyncState()

    const lib = setActiveLibrary(id)
    applyLibraryPaths(lib)

    // 重开新库连接（建表/迁移），启动新库增量扫描
    getDb()
    void runScan('switch').catch((err) => {
      scanProgress.status = 'error'
      scanProgress.message = (err as Error).message
      console.error(`[libraries] 切换后扫描失败: ${(err as Error).message}`)
    })
    startWatcher()
    console.log(`[libraries] 已切换激活库: ${lib.name} (${lib.library_root})`)
  }
}
