/**
 * 统计与扫描路由
 *
 * GET /api/stats  ：库规模统计（照片/视频/实况数量、体积、缩略图队列积压）
 * POST /api/scan  ：触发一次全量扫描（幂等增量），扫描中重复调用返回进行中状态
 * GET  /api/dates ：按「年-月」分组：{ ym, label, count, offset } 倒序；
 *                   offset = 该月首资产在倒序流中的全局位置（日期快速定位跳转用）
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { config } from '../config.js'
import { runScan, scanProgress } from '../scanner/index.js'
import { queueSize } from '../pipeline/queue.js'

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /** 库体积缓存（-1 表示未计算） */
  let totalBytesCache = -1

  app.get('/api/stats', async (_req, reply) => {
    const byType = db
      .prepare(`SELECT type, COUNT(*) AS count FROM assets GROUP BY type`)
      .all() as { type: string; count: number }[]

    const counts: Record<string, number> = { photo: 0, video: 0, live: 0 }
    for (const r of byType) counts[r.type] = r.count

    const total = counts.photo + counts.video + counts.live

    // 库体积：遍历 20k+ 文件较慢，只在首次调用时计算并缓存（进程生命周期内）
    if (totalBytesCache < 0) {
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name)
          if (e.isDirectory()) walk(full)
          else if (e.isFile()) totalBytesCache += fs.statSync(full).size
        }
      }
      walk(config.libraryRoot)
    }

    return reply.send({
      assets: total,
      photos: counts.photo,
      videos: counts.video,
      livePhotos: counts.live,
      totalBytes: totalBytesCache,
      totalSizeGB: Number((totalBytesCache / 1024 ** 3).toFixed(1)),
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
