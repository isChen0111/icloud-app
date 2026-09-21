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
    if (!Number.isInteger(suffix) || suffix <= 0 || total <= 0) return null
    return { start: Math.max(0, total - suffix), end: total - 1 }
  }
  const start = Number(startStr)
  if (!Number.isInteger(start) || start < 0 || start >= total) return null
  const requestedEnd = endStr === '' ? total - 1 : Number(endStr)
  if (!Number.isInteger(requestedEnd) || requestedEnd < start) return null
  const end = Math.min(requestedEnd, total - 1)
  return { start, end }
}

/**
 * 创建读流并挂上 error 处理器。
 * 修复（审查 P1-B2）：旧实现 createReadStream 无 error 监听，响应发出 206 后
 * 文件被删/IO 错误 → Node 触发 unhandled 'error' → 进程崩溃。
 * 现在：记录日志 + 终止挂起的响应连接（浏览器侧会自行报错/重试，进程不再崩）。
 */
function createSafeStream(abs: string, reply: { raw: import('node:http').ServerResponse }, opts?: { start: number; end: number }): fs.ReadStream {
  const stream = fs.createReadStream(abs, opts)
  stream.on('error', (err) => {
    console.error(`[video] 流读取错误 ${abs}:`, err.message)
    // 响应头已发出（206/200），无法改状态码；销毁连接让浏览器感知中断
    if (!reply.raw.destroyed) reply.raw.destroy(err)
  })
  return stream
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

    // 有 Range 头但解析失败/起始越界 → 416 Range Not Satisfiable（RFC 7233）
    if (!range && req.headers.range) {
      return reply.code(416).header('Content-Range', `bytes */${total}`).send()
    }

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
        .send(createSafeStream(abs, reply, { start, end }))
    }

    // —— 整文件响应 200 ——
    return reply.header('Content-Length', total).send(createSafeStream(abs, reply))
  })
}
