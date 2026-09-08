/**
 * 资产查询路由
 *
 * GET /api/assets?cursor=<base64>&limit=100
 *   照片墙分页：按 拍摄时间倒序 稳定分页（滚动续载）。
 *   游标 = base64("date_taken|id")，比「offset 偏移」更稳（新增照片不会错位）。
 *
 * GET /api/assets?offset=<N>&limit=100
 *   按全局序号跳页（日期快速定位用）：offset = 该位置之前的资产总数。
 *   跳转后 nextCursor 仍有效，可无缝接续滚动。
 *
 * （月份聚合见 /api/dates，位于 stats.ts）
 *
 * GET /api/assets/:id
 *   单个资产详情 + 前后邻居 id（详情页轮播预加载用）。
 */
import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/index.js'
import { config } from '../config.js'

/** 输出给前端的资产结构（不含内部状态字段） */
export interface AssetDto {
  id: number
  type: 'photo' | 'video' | 'live'
  filename: string
  dateTaken: string
  width: number | null
  height: number | null
  duration: number | null
  orientation: number | null
  gpsLat: number | null
  gpsLon: number | null
  /** 前端缩略图 URL 前缀（由前端拼 size 参数） */
  thumbUrl: string
}

/** 数据库行类型（assets 表，better-sqlite3 的 .all() 返回 unknown[]，需显式断言） */
export interface AssetRow {
  id: number
  type: string
  filename: string
  date_taken: string
  width: number | null
  height: number | null
  duration: number | null
  orientation: number | null
  gps_lat: number | null
  gps_lon: number | null
}

/** 输出给前端的资产结构（不含内部状态字段）；导出供 search 路由复用 */
export function toDto(row: AssetRow): AssetDto {
  return {
    id: row.id,
    type: row.type as AssetDto['type'],
    filename: row.filename,
    dateTaken: row.date_taken,
    width: row.width,
    height: row.height,
    duration: row.duration,
    orientation: row.orientation,
    gpsLat: row.gps_lat,
    gpsLon: row.gps_lon,
    thumbUrl: `/api/thumb/${row.id}`,
  }
}

/** 编码分页游标 */
function encodeCursor(dateTaken: string, id: number): string {
  return Buffer.from(`${dateTaken}|${id}`).toString('base64url')
}

/** 解码分页游标；失败返回 null（视为首页） */
function decodeCursor(cursor: string | undefined): { dateTaken: string; id: number } | null {
  if (!cursor) return null
  try {
    const [dateTaken, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    if (!dateTaken || !id) return null
    return { dateTaken, id: Number(id) }
  } catch {
    return null
  }
}

export async function registerAssetRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  /** 照片墙分页：返回 { items, nextCursor, offset } */
  app.get('/api/assets', async (req, reply) => {
    const query = req.query as { cursor?: string; limit?: string; offset?: string }
    const limit = Math.min(Number(query.limit ?? config.pageSize) || config.pageSize, 500)
    const cursor = decodeCursor(query.cursor)
    const offset = Number(query.offset ?? 0) || 0

    // 优先游标模式（滚动续载）；提供 offset 时走跳页模式（日期定位）
    const rows = (
      cursor
        ? db
            .prepare(
              `SELECT * FROM assets
               WHERE (date_taken < ?) OR (date_taken = ? AND id < ?)
               ORDER BY date_taken DESC, id DESC LIMIT ?`,
            )
            .all(cursor.dateTaken, cursor.dateTaken, cursor.id, limit + 1)
        : db
            .prepare(`SELECT * FROM assets ORDER BY date_taken DESC, id DESC LIMIT ? OFFSET ?`)
            .all(limit + 1, offset)
    ) as AssetRow[]

    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]

    return reply.send({
      items: page.map(toDto),
      offset, // 本页在全局倒序流中的起始位置（前端跳转后记录，供下一次续载定位）
      // 还有下一页时，用本页最后一条的位置编码游标（offset 跳页后同样无缝接续）
      nextCursor: hasMore && last ? encodeCursor(last.date_taken, last.id) : null,
    })
  })


  /** 单个资产详情 + 前后邻居 id */
  app.get('/api/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(Number(id)) as
      | (ReturnType<typeof toDto> extends never ? never : Record<string, unknown> & { id: number; date_taken: string })
      | undefined

    if (!row) {
      return reply.code(404).send({ error: 'asset not found' })
    }

    // 前一张 = 更新的一张；(date_taken, id) 字典序更大
    const prev = db
      .prepare(
        `SELECT id FROM assets WHERE (date_taken > ?) OR (date_taken = ? AND id > ?)
         ORDER BY date_taken ASC, id ASC LIMIT 1`,
      )
      .get(row.date_taken as string, row.date_taken as string, row.id) as { id: number } | undefined

    // 后一张 = 更旧的一张
    const next = db
      .prepare(
        `SELECT id FROM assets WHERE (date_taken < ?) OR (date_taken = ? AND id < ?)
         ORDER BY date_taken DESC, id DESC LIMIT 1`,
      )
      .get(row.date_taken as string, row.date_taken as string, row.id) as { id: number } | undefined

    // 实况照片的播放视频相对路径（供前端拼 /api/video/stream）
    const liveVideo = (row.live_video as string | null) ?? null

    // 序号 / 总数（顶栏 "第 N / total 项"）：照片墙按 (date_taken DESC, id DESC) 倒序流，
    // 排在该资产之前（更新）的数量 = 序号 - 1。走 idx_assets_date 索引，毫秒级。
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM assets`).get() as { c: number }).c
    const before = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM assets WHERE (date_taken > ?) OR (date_taken = ? AND id > ?)`,
      )
      .get(row.date_taken as string, row.date_taken as string, row.id) as { c: number }).c

    return reply.send({
      ...toDto(row as never),
      liveVideo,
      prevId: prev?.id ?? null,
      nextId: next?.id ?? null,
      position: before + 1,
      total,
    })
  })
}
