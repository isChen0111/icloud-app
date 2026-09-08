/**
 * 缩略图路由
 *
 * GET /api/thumb/:id?size=grid|detail|blur
 *   - 懒生成：缓存不存在 → 现场生成（sharp/ffmpeg）→ 写盘
 *   - 长缓存：缩略图内容不可变（路径含资产 id），CDN/浏览器可无限期缓存
 *   - ETag：基于文件 mtime+size 的弱校验，省重复传输
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { ensureThumbnail, thumbCachePath, type ThumbSize } from '../pipeline/thumbnails.js'

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

    // 若该资产至今没有尺寸信息，顺手用生成的缩略图回填（宽高比占位用）
    if (!row.width && !row.height) {
      try {
        const { default: sharp } = await import('sharp')
        const meta = await sharp(outPath).metadata()
        if (meta.width && meta.height) {
          db.prepare(`UPDATE assets SET width=?, height=? WHERE id=?`).run(meta.width, meta.height, assetId)
        }
      } catch {
        /* 忽略 */
      }
    }

    // 长缓存 + ETag 校验（缩略图内容由 assetId 唯一决定，永不变化）
    const etag = etagFor(outPath)
    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send()
    }
    return reply
      .header('Cache-Control', 'public, max-age=31536000, immutable')
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

  // 保留：缓存目录兜底静态服务（某些场景可直接访问文件）
  void path
}
