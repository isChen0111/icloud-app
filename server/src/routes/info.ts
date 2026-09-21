/**
 * 资产信息路由（详情页「信息」面板数据源）
 *
 * GET /api/assets/:id/info
 *   实时解析原文件元数据（低频操作：点开信息面板才请求）：
 *   - 图片（photo/live）：exifr 全量解析 → 设备/镜头/ISO/光圈/快门/焦距/曝光补偿
 *   - 视频（video）：ffprobe → 编码/码率/时长/分辨率 + 文件大小
 *   - 像素尺寸直接用数据库值（扫描时已修正），文件大小用 fs.stat
 *
 * 设计：不落库、不改 schema——信息面板低频，实时解析一次 ~100-300ms 可接受，
 * 避免为低频功能重扫全库（11k 资产）。
 */
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/index.js'
import { config } from '../config.js'
import { readImageFullMeta, readVideoFullMeta } from '../metadata/index.js'

/** 扩展名 → 用户可读格式名（iCloud 信息面板同款口径） */
const EXT_FORMAT: Record<string, string> = {
  HEIC: 'HEIF',
  HEIF: 'HEIF',
  JPG: 'JPEG',
  JPEG: 'JPEG',
  PNG: 'PNG',
  GIF: 'GIF',
  MOV: 'MOV',
  MP4: 'MP4',
  M4V: 'M4V',
  AVI: 'AVI',
}

export async function registerInfoRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/api/assets/:id/info', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(Number(id)) as
      | (Record<string, unknown> & { id: number; type: string; filename: string; file_path: string; date_taken: string; width: number | null; height: number | null; duration: number | null })
      | undefined
    if (!row) return reply.code(404).send({ error: 'asset not found' })

    const absPath = path.join(config.libraryRoot, row.file_path)
    // 原文件被移动/删除时优雅降级（不 500）
    let sizeBytes = 0
    try {
      sizeBytes = fs.statSync(absPath).size
    } catch {
      sizeBytes = 0
    }

    const ext = path.extname(row.filename).replace('.', '').toUpperCase()
    const format = (EXT_FORMAT[ext] ?? ext) || null

    // 按类型走不同解析器
    if (row.type === 'video') {
      const m = await readVideoFullMeta(absPath)
      return reply.send({
        id: row.id,
        type: row.type,
        filename: row.filename,
        takenAt: m.creationTime,
        device: null,
        format,
        lens: null,
        width: row.width ?? m.width,
        height: row.height ?? m.height,
        duration: row.duration ?? m.duration,
        sizeBytes,
        megaPixels: null,
        iso: null,
        focalLength: null,
        fNumber: null,
        exposureTime: null,
        exposureBias: null,
        codec: m.codec,
        bitRate: m.bitRate,
        gpsLat: null,
        gpsLon: null,
      })
    }

    // 照片 / 实况照片：exifr 全量解析
    const m = await readImageFullMeta(absPath)
    // 实况照片的拍摄时间以 EXIF 为准，缺失时回退库值（date_taken 兜底链路已保证非空）
    return reply.send({
      id: row.id,
      type: row.type,
      filename: row.filename,
      takenAt: m.takenAt ?? row.date_taken,
      device: m.make && m.model ? (m.make === m.model ? m.model : `${m.make} ${m.model}`) : (m.make ?? m.model ?? null),
      format,
      lens: m.lens,
      width: row.width,
      height: row.height,
      duration: null,
      sizeBytes,
      // 12 MP • 3024 × 4032：由前端按宽高计算，这里只给原始数字
      megaPixels: row.width && row.height ? (row.width * row.height) / 1e6 : null,
      iso: m.iso,
      focalLength: m.focalLength,
      fNumber: m.fNumber,
      exposureTime: m.exposureTime,
      exposureBias: m.exposureBias,
      codec: null,
      bitRate: null,
      gpsLat: m.gps?.lat ?? null,
      gpsLon: m.gps?.lon ?? null,
    })
  })
}
