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
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { config } from '../config.js'
import { runScan, scanProgress } from '../scanner/index.js'
import { queueSize } from '../pipeline/queue.js'

/** 体积缓存文件（落盘，避免每次启动重算） */
const statsCacheFile = path.join(config.cacheDir, 'stats.json')

/** 异步分片遍历一个目录树，累加所有文件字节数；每批让出事件循环，避免阻塞其他请求 */
async function walkSize(dir: string, batchSize = 256): Promise<number> {
  let total = 0
  const stack = [dir]
  let pending = 0 // 本批已 stat 的文件数，用于周期性让出事件循环
  while (stack.length > 0) {
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

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /** 内存中的体积缓存（null = 尚未算出） */
  let totalBytesCache: number | null = null
  /** 后台计算任务（防止并发触发多次全库遍历） */
  let computing: Promise<void> | null = null

  /** 从落盘缓存恢复体积；文件内容与当前库路径不匹配时忽略 */
  function loadCacheFromDisk(): void {
    try {
      if (!fs.existsSync(statsCacheFile)) return
      const data = JSON.parse(fs.readFileSync(statsCacheFile, 'utf8')) as {
        libraryRoot: string
        totalBytes: number
      }
      if (data.libraryRoot === config.libraryRoot && typeof data.totalBytes === 'number') {
        totalBytesCache = data.totalBytes
      }
    } catch {
      /* 缓存损坏/版本不符：忽略，触发重算 */
    }
  }

  /** 后台计算体积并落盘（幂等：同时只跑一个） */
  function ensureSizeComputed(): void {
    if (totalBytesCache !== null || computing) return
    computing = (async () => {
      try {
        const bytes = await walkSize(config.libraryRoot)
        totalBytesCache = bytes
        // 落盘：下次进程重启直接读取
        fs.mkdirSync(config.cacheDir, { recursive: true })
        fs.writeFileSync(statsCacheFile, JSON.stringify({ libraryRoot: config.libraryRoot, totalBytes: bytes }))
      } catch (err) {
        console.error('[stats] 体积计算失败:', err)
      } finally {
        computing = null
      }
    })()
  }

  // 启动即恢复缓存 + 若未命中立即后台开算（不阻塞任何请求）
  loadCacheFromDisk()
  ensureSizeComputed()

  app.get('/api/stats', async (_req, reply) => {
    const byType = db
      .prepare(`SELECT type, COUNT(*) AS count FROM assets GROUP BY type`)
      .all() as { type: string; count: number }[]

    const counts: Record<string, number> = { photo: 0, video: 0, live: 0 }
    for (const r of byType) counts[r.type] = r.count

    const total = counts.photo + counts.video + counts.live

    // 若尚未算完（进程启动后第一次），后台继续算，本次返回 null 给前端
    ensureSizeComputed()
    const bytes = totalBytesCache

    return reply.send({
      assets: total,
      photos: counts.photo,
      videos: counts.video,
      livePhotos: counts.live,
      totalBytes: bytes, // null = 后台计算中（前端尚未消费该字段，可安全为 null）
      totalSizeGB: bytes === null ? null : Number((bytes / 1024 ** 3).toFixed(1)),
      thumbQueue: queueSize(),
      scan: { ...scanProgress },
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
      .prepare(`SELECT substr(date_taken, 1, 7) AS ym, COUNT(*) AS cnt FROM assets GROUP BY ym ORDER BY ym DESC`)
      .all() as { ym: string; cnt: number }[]

    // 累加出每月全局偏移（倒序：最新月 offset=0，其后顺延）→ 前端点月份即可 offset 跳页
    let acc = 0
    const items = groups.map((g) => {
      const item = {
        ym: g.ym,
        label: `${Number(g.ym.slice(0, 4))}年${Number(g.ym.slice(5))}月`,
        count: g.cnt,
        offset: acc,
      }
      acc += g.cnt
      return item
    })
    return reply.send({ unit: 'month', items })
  })
}
