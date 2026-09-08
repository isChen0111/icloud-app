/**
 * 缩略图路由
 *
 * GET /api/thumb/:id?size=grid|detail|blur
 *   - 懒生成：缓存不存在 → 现场生成（sharp/ffmpeg）→ 写盘
 *   - 长缓存：缩略图路径含资产 id，可安全长缓存（max-age 1 年）；不用 immutable，
 *     留刷新协商通道（见下方修复注释）
 *   - ETag：基于文件 mtime+size 的弱校验，省重复传输
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import { getDb } from '../db/index.js'
import { ensureThumbnail, ensureSize, type ThumbSize } from '../pipeline/thumbnails.js'

const VALID_SIZES = new Set<ThumbSize>(['grid', 'detail', 'blur'])

/** 简单 ETag：由文件信息生成（无需读内容） */
function etagFor(filePath: string): string {
  const st = fs.statSync(filePath)
  return `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`
}

export async function registerThumbRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/api/thumb/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const query = req.query as { size?: string }
    const size = (query.size ?? 'grid') as ThumbSize
    if (!VALID_SIZES.has(size)) {
      return reply.code(400).send({ error: `size must be one of: ${[...VALID_SIZES].join(',')}` })
    }

    const assetId = Number(id)
    const row = db.prepare(`SELECT type, width, height FROM assets WHERE id = ?`).get(assetId) as
      | { type: string; width: number | null; height: number | null }
      | undefined
    if (!row) return reply.code(404).send({ error: 'asset not found' })

    // 懒生成（内部已处理"已存在则直接返回"）
    const outPath = await ensureThumbnail(assetId, size)
    if (!outPath || !fs.existsSync(outPath)) {
      return reply.code(500).send({ error: 'thumbnail generation failed' })
    }

    // 若该资产至今没有尺寸信息，用原文件尺寸回填（宽高比占位用）。
    // 修复（审查 P1-②）：必须读「原文件」而非缩略图——旧实现用 sharp 读
    // 刚生成的缩略图 metadata，把 320/1600/32 等缩略图尺寸写进了原图宽高，
    // 导致竖图被当横图、宽高比占位全错。ensureSize 内部已对 HEIC 用 ffprobe 兜底。
    if (!row.width && !row.height && row.type === 'photo') {
      await ensureSize(assetId)
    }

    // 长缓存 + ETag 协商。
    // 修复（审查 P2-*）：曾用 `max-age=31536000, immutable`——immutable 会让
    // 浏览器连刷新都不重新验证，缩略图内容一旦因生成参数修复/缓存重建而变化
    // （如 EXIF 方向修复），旧内容会被永久锁死。去掉 immutable：强缓存期间
    // 零请求，刷新时走 if-none-match 协商（ETag 基于文件 mtime+size，内容变
    // 则返回 200 新图），配合前端 thumbUrl 的 rev 版本参数（URL 变化强制
    // 重新拉取）形成完整缓存失效链路。
    const etag = etagFor(outPath)
    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send()
    }
    return reply
      .header('Cache-Control', 'public, max-age=31536000')
      .header('ETag', etag)
      .type('image/webp')
      .header('Content-Length', fs.statSync(outPath).size)
      .send(fs.createReadStream(outPath))
  })

  // 视频封面帧 = 视频的 grid 缩略图（生成路径里对 video 自动走 ffmpeg 抽帧）
  app.get('/api/video/:id/poster', async (req, reply) => {
    const { id } = req.params as { id: string }
    const outPath = await ensureThumbnail(Number(id), 'grid')
    if (!outPath || !fs.existsSync(outPath)) return reply.code(404).send({ error: 'poster not found' })
    return reply.type('image/webp').send(fs.createReadStream(outPath))
  })
}
