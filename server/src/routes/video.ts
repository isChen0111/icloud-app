/**
 * 视频流路由（核心：HTTP Range 流式）
 *
 * GET /api/video/:id/stream
 *   - type='video'：返回主文件（file_path）
 *   - type='live' ：返回实况视频（live_video 字段）
 *   - 支持 Range 请求 → 206 + Content-Range，浏览器 video 拖动进度条就是靠它
 *
 * 实现要点（学习重点）：
 *   1. 解析请求头 Range: bytes=start-end
 *   2. 用 stat 拿到文件总大小
 *   3. fs.createReadStream(path, { start, end }) 只读取请求的字节段
 *   4. 返回 206 Partial Content + Accept-Ranges: bytes
 *   —— 这正是 iCloud 网页端播放视频的底层机制（实测 HTTP 206）。
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { config } from '../config.js'

/** 解析 "bytes=start-end" 请求头 → { start, end }，不合法返回 null（回退整文件） */
function parseRange(rangeHeader: string | undefined, total: number): { start: number; end: number } | null {
  if (!rangeHeader) return null
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
  if (!m) return null
  const [, startStr, endStr] = m
  // 支持 "bytes=-500"（末尾 500 字节）与 "bytes=100-"（100 到结尾）
  if (startStr === '') {
    const suffix = Number(endStr)
    if (!suffix) return null
    return { start: Math.max(0, total - suffix), end: total - 1 }
  }
  const start = Number(startStr)
  if (Number.isNaN(start) || start >= total) return null
  const end = endStr === '' ? total - 1 : Math.min(Number(endStr), total - 1)
  return { start, end }
}

/** 根据资产类型解析要播放的视频文件相对路径 */
function resolvePlaybackPath(type: string, filePath: string, liveVideo: string | null): string | null {
  if (type === 'video') return filePath
  if (type === 'live' && liveVideo) return liveVideo
  return null
}

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/api/video/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.prepare(`SELECT type, file_path, live_video FROM assets WHERE id = ?`).get(Number(id)) as
      | { type: string; file_path: string; live_video: string | null }
      | undefined

    const rel = row ? resolvePlaybackPath(row.type, row.file_path, row.live_video) : null
    if (!rel) return reply.code(404).send({ error: 'not a video asset' })

    // 相对路径 → 库根下的绝对路径
    const abs = path.join(config.libraryRoot, rel)
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: 'file missing' })

    const stat = fs.statSync(abs)
    const total = stat.size
    const range = parseRange(req.headers.range as string | undefined, total)

    // 按扩展名给更准确的 MIME（mov 容器 ≠ mp4 容器）
    const mime = path.extname(abs).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4'

    // 设置浏览器可 Range 的声明 + 视频 MIME
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Content-Type', mime)

    if (range) {
      // —— 分段响应 206 ——
      const { start, end } = range
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${total}`)
        .header('Content-Length', end - start + 1)
        .send(fs.createReadStream(abs, { start, end }))
    }

    // —— 整文件响应 200 ——
    return reply.header('Content-Length', total).send(fs.createReadStream(abs))
  })
}
