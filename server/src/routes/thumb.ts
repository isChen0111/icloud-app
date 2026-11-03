/**
 * 缩略图路由
 *
 * GET /api/thumb/:id?size=grid|detail
 *   - 懒生成：缓存不存在 → 现场生成（sharp/ffmpeg）→ 写盘
 *   - 长缓存：缩略图路径含资产 id，可安全长缓存（max-age 1 年）；不用 immutable，
 *     留刷新协商通道（见下方修复注释）
 *   - ETag：基于文件 mtime+size 的弱校验，省重复传输
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fs from 'node:fs'
import { getCurrentLibrary } from '../context.js'
import { getDb } from '../db/index.js'
import { registerThumbnailCancelled, runInteractiveThumbnail } from '../pipeline/queue.js'
import { ensureThumbnail, ensureSize, isCacheUsable, type ThumbSize } from '../pipeline/thumbnails.js'

const VALID_SIZES = new Set<ThumbSize>(['grid', 'detail'])

/**
 * F-02 轻量版：客户端连接是否已断开。
 * 快速滚动时虚拟列表销毁离屏图片组件，浏览器可能已中止/关闭请求连接；
 * 任务从队列取出、真正开始生成前检查一次，断开则跳过生成（不白占队列资源）。
 * req.raw.destroyed 在连接关闭后为 true；req.raw.aborted 兼容旧语义。
 */
function clientDisconnected(req: FastifyRequest): boolean {
  return req.raw.destroyed || req.raw.aborted
}

/** 简单 ETag：由文件信息生成（无需读内容） */
function etagFor(filePath: string): string {
  const st = fs.statSync(filePath)
  return `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`
}

/**
 * 库作用域校验（前端在 URL 上带 `lib`，见 web/src/api/client.ts 的 setThumbLibrary）。
 *
 * 为什么需要：资产 id 是**库内自增**，`/api/thumb/:id` 只按 id 查当前库的 DB。
 * 切库瞬间在途的、以及详情页 `new Image()` 预加载发出的请求不带库语义，落库以后
 * 会命中新库的同 id 资产，返回一张毫不相干的照片，还要被浏览器按这个 URL 缓存一年。
 *
 * `lib` 缺省时**不校验**：前端在拿到第一份 /api/stats 之前并不知道库 id，那段窗口
 * 必须能正常出图（宁可退回旧的共享缓存，也不能让整面墙 404）。
 *
 * 抽成纯函数（当前库 id 由调用方传入）是为了能单测：判定逻辑不该被 meta.db 绑住。
 */
export function libMismatch(lib: string | undefined, currentLibraryId: number | null): boolean {
  if (lib === undefined) return false
  const id = Number(lib)
  return !Number.isInteger(id) || id !== currentLibraryId
}

export async function registerThumbRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/api/thumb/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const query = req.query as { size?: string; lib?: string }
    const size = (query.size ?? 'grid') as ThumbSize
    if (!VALID_SIZES.has(size)) {
      return reply.code(400).send({ error: `size must be one of: ${[...VALID_SIZES].join(',')}` })
    }
    if (libMismatch(query.lib, getCurrentLibrary()?.id ?? null)) {
      return reply.code(404).send({ error: 'asset not in current library' })
    }

    const assetId = Number(id)
    if (!Number.isInteger(assetId) || assetId <= 0) return reply.code(400).send({ error: 'invalid id' })
    const row = db.prepare(`SELECT type, width, height FROM assets WHERE id = ?`).get(assetId) as
      | { type: string; width: number | null; height: number | null }
      | undefined
    if (!row) return reply.code(404).send({ error: 'asset not found' })

    // 懒生成（内部已处理"已存在则直接返回"）
    const outPath = await runInteractiveThumbnail<string | null>(() => {
      // F-02 轻量版：任务开始执行时客户端已断开 → 跳过生成，仅计数（快速滚动离屏请求）
      if (clientDisconnected(req)) {
        registerThumbnailCancelled()
        return Promise.resolve(null)
      }
      return ensureThumbnail(assetId, size)
    })
    if (!outPath || !isCacheUsable(outPath)) {
      // 断开与真失败区分：客户端已断开时静默结束，不算生成失败（不进失败清单）
      if (clientDisconnected(req)) return reply.raw.end()
      // P2-4：切库代际空转也会走到这里（runInteractiveThumbnail 返回 null），
      // 此时资产已随切库不在当前库——查不到就返回 404（语义=资源不在当前库，
      // 前端刷新后重新请求即得新库数据），而非 500（误导为生成错误且不触发重试）。
      const stillExists = db.prepare(`SELECT 1 FROM assets WHERE id = ?`).get(assetId)
      if (!stillExists) return reply.code(404).send({ error: 'asset not found' })
      return reply.code(500).send({ error: 'thumbnail generation failed' })
    }

    // 若该资产至今没有尺寸信息，用原文件尺寸回填（宽高比占位用）。
    // 修复（审查 P1-②）：必须读「原文件」而非缩略图——旧实现用 sharp 读
    // 刚生成的缩略图 metadata，把 320/1600/32 等缩略图尺寸写进了原图宽高，
    // 导致竖图被当横图、宽高比占位全错。ensureSize 内部已对 HEIC 用 ffprobe 兜底。
    // 修复（审查 B2）：条件改为非 video——实况照片（HEIC）同样可能读不出
    // 像素尺寸（如 IMG_0137 width/height 为 null），漏掉 live 则宽高永远为空，
    // 影响前端宽高比占位与原比例显示的预留扩展点。
    if (!row.width && !row.height && row.type !== 'video') {
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

  // 视频封面帧 = 视频缩略图（生成路径里对 video 自动走 ffmpeg 抽帧）
  // size 参数（修复：详情页播放前封面小——poster 默认 grid 档 320px，在详情舞台
  // 只有 180x320 一小块；传 size=detail 抽 1600px 帧，播放前显示清晰大封面）
  app.get('/api/video/:id/poster', async (req, reply) => {
    const { id } = req.params as { id: string }
    const query = req.query as { size?: string; lib?: string }
    const size = (query.size ?? 'grid') as ThumbSize
    if (!VALID_SIZES.has(size)) {
      return reply.code(400).send({ error: `size must be one of: ${[...VALID_SIZES].join(',')}` })
    }
    if (libMismatch(query.lib, getCurrentLibrary()?.id ?? null)) {
      return reply.code(404).send({ error: 'asset not in current library' })
    }
    const assetId = Number(id)
    if (!Number.isInteger(assetId) || assetId <= 0) return reply.code(400).send({ error: 'invalid id' })
    const outPath = await runInteractiveThumbnail<string | null>(() => {
      // F-02 轻量版：任务开始执行时客户端已断开 → 跳过抽帧，仅计数
      if (clientDisconnected(req)) {
        registerThumbnailCancelled()
        return Promise.resolve(null)
      }
      return ensureThumbnail(assetId, size)
    })
    if (!outPath || !isCacheUsable(outPath)) {
      // 断开与真失败区分：客户端已断开时静默结束，不算封面生成失败
      if (clientDisconnected(req)) return reply.raw.end()
      return reply.code(404).send({ error: 'poster not found' })
    }
    // 长缓存 + ETag 协商（与缩略图同策略：封面内容修复后走 if-none-match 刷新）
    const etag = etagFor(outPath)
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    return reply
      .header('Cache-Control', 'public, max-age=31536000')
      .header('ETag', etag)
      .type('image/webp')
      .send(fs.createReadStream(outPath))
  })
}
