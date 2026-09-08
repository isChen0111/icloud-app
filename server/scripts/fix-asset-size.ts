/**
 * 一次性数据修正：重建 assets 表的 width/height（审查 P1-②）
 *
 * 背景：旧版 /api/thumb 曾在宽高为空时用「缩略图 metadata」回填，
 * 把 320/1600/32 这类缩略图尺寸写进了原图宽高字段（竖图被当横图）。
 * 本脚本遍历全部资产，按「原文件」重新读取像素尺寸并覆盖：
 *   - photo：sharp 直接读；HEIC/HEIF（sharp 无 HEVC 解码）→ ffprobe 兜底
 *   - video：ffprobe 读视频流分辨率
 *
 * 用法：npm run fix-size   （server 目录下；依赖已装、库已扫描）
 */
import fs from 'node:fs'
import path from 'node:path'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'
import { getDb } from '../src/db/index.js'
import { config } from '../src/config.js'

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath)
  process.env.FFPROBE_PATH = path.join(path.dirname(ffmpegPath), 'ffprobe.exe')
}

/** ffprobe 读分辨率（视频 / HEIC 等 sharp 读不了的格式） */
function probeSize(abs: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(abs, (err, data) => {
      if (err || !data?.streams) {
        resolve(null)
        return
      }
      const s = data.streams.find((st) => st.codec_type === 'video' || st.codec_type === 'image')
      resolve(s?.width && s?.height ? { width: s.width, height: s.height } : null)
    })
  })
}

async function main(): Promise<void> {
  const db = getDb()
  const rows = db.prepare(`SELECT id, file_path, type FROM assets ORDER BY id`).all() as {
    id: number
    file_path: string
    type: string
  }[]

  console.log(`待重算：${rows.length} 条资产`)
  let fixed = 0
  let skipped = 0
  let failed = 0
  const update = db.prepare(`UPDATE assets SET width=?, height=? WHERE id=?`)

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const abs = path.join(config.libraryRoot, r.file_path)
    let size: { width: number; height: number } | null = null

    if (!fs.existsSync(abs)) {
      failed++
      continue
    }
    if (r.type === 'video') {
      size = await probeSize(abs)
    } else {
      try {
        const meta = await sharp(abs, { failOn: 'none' }).metadata()
        if (meta.width && meta.height) size = { width: meta.width, height: meta.height }
      } catch {
        /* fallthrough */
      }
      if (!size) size = await probeSize(abs) // HEIC/HEIF 兜底
    }

    if (size) {
      update.run(size.width, size.height, r.id)
      fixed++
    } else {
      failed++
    }
    skipped++

    if ((i + 1) % 500 === 0 || i === rows.length - 1) {
      console.log(`进度 ${i + 1}/${rows.length} · 已修复 ${fixed} · 失败 ${failed}`)
    }
  }

  console.log(`\n完成：修复 ${fixed} 条，失败 ${failed} 条（文件缺失/无法解析）`)
}

main().catch((err) => {
  console.error('fix-size 执行失败:', err)
  process.exit(1)
})
