/**
 * 统计与扫描路由
 *
 * GET /api/stats  ：库规模统计（照片/视频/实况数量、体积、缩略图队列积压）
 * POST /api/scan  ：触发一次全量扫描（幂等增量），扫描中重复调用返回进行中状态
 * GET  /api/dates ：按「年-月」分组：{ ym, label, count, offset } 倒序；
 *                   offset = 该月首资产在倒序流中的全局位置（日期快速定位跳转用）
 *
 * 性能修复（审查 P1-①）：
 *   旧实现首次 /api/stats 时用 fs.readdirSync/statSync 同步遍历整个照片库
 *   （2 万文件），会把 Node 事件循环阻塞 10~30 秒，期间所有缩略图/分页请求
 *   全部排队 —— 表现为"后端启动后首屏卡很久"。
 *   现改为：
 *     a) 体积缓存落盘到 cache/stats.json（进程重启不重算）；
 *     b) 未命中缓存时后台异步分片计算（每批让出事件循环），本次响应先返回
 *        totalBytes=null，算完写盘，后续请求读到真实值。
 *
 * 体积缓存第二轮修复（2026-11-02，逻辑已抽到 stats/sizeCache.ts）：
 *   上面 b) 只解决了"阻塞"，没解决"重复"——只要资产数或扫描轮次变化就重算，
 *   扫描期间资产数每 200 条提交就变一次，等于每 5 秒重走一遍整库。
 *   现在：任务运行期不遍历、缓存按库归属校验、过期期间返回旧值。
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { config } from '../config.js'
import { runScan, scanProgress } from '../scanner/index.js'
import { getThumbnailProgress, getQueueMetrics, queueSize } from '../pipeline/queue.js'
import { getCurrentLibrary } from '../context.js'
import { syncState } from '../icloudpd/state.js'
import { publicImportState, importState } from '../import/state.js'
import { createSizeCache } from '../stats/sizeCache.js'

/** 体积缓存文件（落盘，避免每次启动重算）。函数取当前激活库 cacheDir（切库后自动跟随） */
function statsCachePath(): string {
  return path.join(config.cacheDir, 'stats.json')
}

/**
 * 异步分片遍历一个目录树，累加所有文件字节数；每批让出事件循环，避免阻塞其他请求。
 * shouldAbort 用于「遍历期间切了库」时提前收尾 —— 结果会被 sizeCache 丢弃，
 * 不必为了一个注定作废的结果把整个旧库走完。
 */
async function walkSize(
  dir: string,
  batchSize = 256,
  shouldAbort?: () => boolean,
): Promise<number> {
  let total = 0
  const stack = [dir]
  let pending = 0 // 本批已 stat 的文件数，用于周期性让出事件循环
  while (stack.length > 0) {
    if (shouldAbort?.()) return total
    const cur = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue // 目录被删除/无权限：跳过，不影响整体统计
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(full)
      } else if (e.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          /* 文件瞬时不可读：跳过 */
        }
        if (++pending >= batchSize) {
          pending = 0
          // 让出事件循环：让正在排队的缩略图/API 请求有机会执行
          await new Promise<void>((r) => setImmediate(r))
        }
      }
    }
  }
  return total
}

/**
 * 统计缩略图失败项：「未忽略」与「已忽略」两个数。
 *
 * 合并成一条 GROUP BY（旧实现是两条独立 COUNT(*)，assets 表无 thumb_status 索引时
 * 等于每次请求两次全表扫描，见 schema.ts 的 idx_assets_thumb_status）。
 * thumb_ignored 为历史 NULL 的行按「未忽略」计，与旧 SQL 的 `= 0` 口径一致 ——
 * 这条边界容易写错，故导出本函数供单测直接验口径。
 */
export function countThumbFailures(db: ReturnType<typeof getDb>): {
  active: number
  ignored: number
} {
  const rows = db
    .prepare(
      `SELECT thumb_ignored AS ignored, COUNT(*) AS count
       FROM assets WHERE thumb_status = 'error' GROUP BY thumb_ignored`,
    )
    .all() as { ignored: number | null; count: number }[]
  let active = 0
  let ignored = 0
  for (const row of rows) {
    if (row.ignored === 1) ignored = row.count
    else active += row.count
  }
  return { active, ignored }
}

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /**
   * 体积缓存（逻辑见 stats/sizeCache.ts）。
   *
   * 三条规则决定它什么时候真的去遍历磁盘：
   *   ① 扫描 / 导入 / 同步在跑时不遍历（否则扫描期间资产数每 200 条一变，
   *      等于每 5 秒把 2 万文件重走一遍）；
   *   ② contextKey 绑定库，切库即失效，落盘前再校验一次归属；
   *   ③ 单飞 + 脏标记，过期期间返回旧值而不是 null。
   *
   * 注意 isQuiet **不包含**缩略图生成：体积统计的是源文件字节数，跟缩略图无关，
   * 否则新库首次扫描后要等缩略图全生成完（可能数小时）体积才更新。
   */
  const sizeCache = createSizeCache({
    contextKey: () => `${config.dbPath}|${config.libraryRoot}`,
    libraryRoot: () => config.libraryRoot,
    cachePath: statsCachePath,
    countAssets: () => (db.prepare(`SELECT COUNT(*) AS c FROM assets`).get() as { c: number }).c,
    scanRunId: () => scanProgress.runId,
    isQuiet: () =>
      scanProgress.status !== 'scanning' &&
      importState.status !== 'running' &&
      syncState.status !== 'running' &&
      syncState.status !== 'waiting_retry',
    walk: (dir, shouldAbort) => walkSize(dir, 256, shouldAbort),
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, data)
    },
    now: Date.now,
    log: (message, err) => console.error(message, err),
  })

  // 启动即尝试恢复落盘缓存；未命中且当前无任务时后台开算（不阻塞任何请求）
  sizeCache.ensure()

  app.get('/api/stats', async (_req, reply) => {
    const byType = db
      .prepare(`SELECT type, COUNT(*) AS count FROM assets GROUP BY type`)
      .all() as { type: string; count: number }[]

    const counts: Record<string, number> = { photo: 0, video: 0, live: 0 }
    for (const r of byType) counts[r.type] = r.count

    const total = counts.photo + counts.video + counts.live

    // 资产数 / 扫描轮次变化只标记过期；真正重算要等没有任务在跑
    sizeCache.touch(total)
    sizeCache.ensure()
    const bytes = sizeCache.bytes

    const thumbnailProgress = getThumbnailProgress()
    const { active: activeThumbnailFailures, ignored: ignoredThumbnailFailures } =
      countThumbFailures(db)
    const adjustedThumbnailProgress = {
      ...thumbnailProgress,
      failed: activeThumbnailFailures,
    }

    return reply.send({
      assets: total,
      photos: counts.photo,
      videos: counts.video,
      livePhotos: counts.live,
      totalBytes: bytes, // null = 后台计算中（前端尚未消费该字段，可安全为 null）
      totalSizeGB: bytes === null ? null : Number((bytes / 1024 ** 3).toFixed(1)),
      thumbQueue: queueSize(),
      // 前端缩略图调度器的并发上限以此值为准（前端通过 /api/stats 读取，
      // 避免前后端两个"8"各自硬编码、漂移后排队/浪费吞吐）
      thumbConcurrency: config.thumbConcurrency,
      // F-02 诊断指标：运行中 / 交互运行中 / 交互等待 / 已跳过（客户端断开被拦下的请求）
      thumbQueueMetrics: getQueueMetrics(),
      thumbnails: adjustedThumbnailProgress,
      // 已忽略失败项计数（F-07 系列）：浮层入口三态展示用
      ignoredThumbnails: ignoredThumbnailFailures,
      scan: { ...scanProgress },
      // P0 新增：当前激活库与 icloudpd 同步任务状态（前端 status 组件轮询展示）
      library: (() => {
        const lib = getCurrentLibrary()
        if (!lib) return null
        // account 脱敏（is***@domain 形式）后再返回给前端
        // 本地单机应用：账号原样返回（与 /api/libraries 一致，供设置中心/认证弹窗完整显示与固定邮箱）
        return { id: lib.id, name: lib.name, account: lib.account, authStatus: lib.auth_status, lastSyncAt: lib.last_sync_at }
      })(),
      sync: {
        status: syncState.status,
        libraryId: syncState.libraryId,
        kind: syncState.kind,
        message: syncState.message,
        downloaded: syncState.downloaded,
        startedAt: syncState.startedAt,
        finishedAt: syncState.finishedAt,
        // 日志截断返回最近 200 行（stats 5s 轮询，控制响应体积）
        log: syncState.log.slice(-200),
      },
      // 导入本地目录任务状态（前端 ImportDialog 轮询展示进度/失败清单）
      import: publicImportState(),
    })
  })

  app.post('/api/scan', async (_req, reply) => {
    if (scanProgress.status === 'scanning') {
      return reply.code(409).send({ error: 'scan already running', scan: scanProgress })
    }
    // 不阻塞请求：后台执行扫描，前端轮询 /api/stats 看进度
    void runScan().catch((err) => {
      scanProgress.status = 'error'
      scanProgress.message = (err as Error).message
      console.error('[scan] failed:', err)
    })
    return reply.send({ started: true, scan: scanProgress })
  })

  app.get('/api/dates', async (_req, reply) => {
    const groups = db
      .prepare(
        `SELECT ym, COUNT(*) AS cnt,
                MAX(CASE WHEN rn = 1 THEN id END) AS thumb_id,
                MAX(CASE WHEN rn = 1 THEN file_mtime END) AS thumb_rev
         FROM (
           SELECT substr(date_taken, 1, 7) AS ym, id, file_mtime,
                  ROW_NUMBER() OVER (
                    PARTITION BY substr(date_taken, 1, 7)
                    ORDER BY date_taken DESC, id DESC
                  ) AS rn
           FROM assets
         )
         GROUP BY ym ORDER BY ym DESC`,
      )
      .all() as { ym: string; cnt: number; thumb_id: number | null; thumb_rev: number | null }[]

    // 累加出每月全局偏移（倒序：最新月 offset=0，其后顺延）→ 前端点月份即可 offset 跳页
    let acc = 0
    const items = groups.map((g) => {
      const item = {
        ym: g.ym,
        label: `${Number(g.ym.slice(0, 4))}年${Number(g.ym.slice(5))}月`,
        count: g.cnt,
        offset: acc,
        thumbId: g.thumb_id, // 该月代表缩略图（可能为 null，理论上每月都有资产故非空）
        thumbRev: g.thumb_rev ?? 0, // 代表缩略图的缓存版本（覆盖后联动前端 URL，避免月份小图被浏览器旧缓存锁死）
      }
      acc += g.cnt
      return item
    })
    return reply.send({ unit: 'month', items })
  })
}
