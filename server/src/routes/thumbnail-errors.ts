import type { FastifyInstance, FastifyReply } from 'fastify'
import { getDb } from '../db/index.js'
import { beginThumbnailBatch, enqueueAsset, getThumbnailProgress, type EnqueueItem } from '../pipeline/queue.js'
import { scanProgress } from '../scanner/index.js'

interface Selection {
  all: boolean
  ids: number[]
}

interface FailedAsset {
  id: number
  filename: string
  filePath: string
  type: 'photo' | 'video' | 'live'
  error: string | null
  ignored: number
}

function readSelection(body: unknown): Selection | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const input = body as Record<string, unknown>
  if (input.all === true && input.ids === undefined) return { all: true, ids: [] }
  if (!Array.isArray(input.ids) || input.ids.length > 1000) return null
  if (!input.ids.every((id) => Number.isSafeInteger(id) && Number(id) > 0)) return null
  return { all: false, ids: [...new Set(input.ids as number[])] }
}

function sendBusy(reply: FastifyReply): boolean {
  if (scanProgress.status === 'scanning') {
    void reply.code(409).send({ error: '资源扫描中，暂不能处理预览图失败项' })
    return true
  }
  if (getThumbnailProgress().status === 'preparing') {
    void reply.code(409).send({ error: '预览图正在处理中，请完成后再操作失败项' })
    return true
  }
  return false
}

function getFailedAssets(selection: Selection, ignored: boolean): FailedAsset[] {
  const db = getDb()
  const condition = `thumb_status = 'error' AND thumb_ignored = ?`
  const fields = `SELECT id, filename, file_path AS filePath, type,
                         thumb_error AS error, thumb_ignored AS ignored
                  FROM assets WHERE ${condition}`
  if (selection.all) {
    return db.prepare(`${fields} ORDER BY file_path`).all(Number(ignored)) as FailedAsset[]
  }
  if (selection.ids.length === 0) return []
  const placeholders = selection.ids.map(() => '?').join(',')
  return db
    .prepare(`${fields} AND id IN (${placeholders}) ORDER BY file_path`)
    .all(Number(ignored), ...selection.ids) as FailedAsset[]
}

export async function registerThumbnailErrorRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/api/thumbnails/failed', async (_req, reply) => {
    const items = db
      .prepare(
        `SELECT id, filename, file_path AS filePath, type,
                thumb_error AS error, thumb_ignored AS ignored
         FROM assets WHERE thumb_status = 'error' ORDER BY thumb_ignored, file_path`,
      )
      .all() as FailedAsset[]
    const counts = db
      .prepare(
        `SELECT thumb_ignored AS ignored, COUNT(*) AS count
         FROM assets WHERE thumb_status = 'error' GROUP BY thumb_ignored`,
      )
      .all() as { ignored: number; count: number }[]
    const activeCount = counts.find((row) => row.ignored === 0)?.count ?? 0
    const ignoredCount = counts.find((row) => row.ignored === 1)?.count ?? 0
    return reply.send({ items, activeCount, ignoredCount })
  })

  app.post('/api/thumbnails/retry', async (req, reply) => {
    if (sendBusy(reply)) return
    const selection = readSelection(req.body)
    if (!selection) return reply.code(400).send({ error: 'body must contain all=true or up to 1000 positive asset ids' })

    const assets = getFailedAssets(selection, false)
    if (assets.length === 0) return reply.send({ retried: 0 })

    const update = db.prepare(
      `UPDATE assets SET thumb_status = 'pending', thumb_error = NULL, thumb_ignored = 0
       WHERE id = ? AND thumb_status = 'error'`,
    )
    db.transaction(() => {
      for (const asset of assets) update.run(asset.id)
    })()

    const remainingFailed = (
      db.prepare(`SELECT COUNT(*) AS count FROM assets WHERE thumb_status = 'error' AND thumb_ignored = 0`).get() as {
        count: number
      }
    ).count
    beginThumbnailBatch(assets.length, remainingFailed)
    for (const asset of assets) {
      const item: EnqueueItem = {
        id: asset.id,
        relPath: asset.filePath,
        type: asset.type,
        liveVideo: null,
      }
      enqueueAsset(item)
    }
    return reply.send({ retried: assets.length })
  })

  app.post('/api/thumbnails/ignore', async (req, reply) => {
    if (sendBusy(reply)) return
    const selection = readSelection(req.body)
    if (!selection || typeof (req.body as Record<string, unknown>).ignored !== 'boolean') {
      return reply.code(400).send({ error: 'body must contain all=true or ids and an ignored boolean' })
    }
    const ignored = (req.body as { ignored: boolean }).ignored
    const assets = getFailedAssets(selection, !ignored)
    if (assets.length === 0) return reply.send({ updated: 0 })

    const update = db.prepare(`UPDATE assets SET thumb_ignored = ? WHERE id = ? AND thumb_status = 'error'`)
    db.transaction(() => {
      for (const asset of assets) update.run(Number(ignored), asset.id)
    })()

    const counts = db
      .prepare(
        `SELECT thumb_status AS status, COUNT(*) AS count
         FROM assets WHERE thumb_status = 'pending' OR (thumb_status = 'error' AND thumb_ignored = 0)
         GROUP BY thumb_status`,
      )
      .all() as { status: string; count: number }[]
    beginThumbnailBatch(
      counts.find((row) => row.status === 'pending')?.count ?? 0,
      counts.find((row) => row.status === 'error')?.count ?? 0,
    )
    return reply.send({ updated: assets.length })
  })
}
