/**
 * 一次性重建：EXIF 方向错误的缩略图缓存（修复早期照片横着显示）
 *
 * 背景（已实测确认）：
 *   sharp 0.33.5 的构造选项 `rotate: true` 不生效（输出仍是未旋转的横向像素），
 *   而链式 `.rotate()` 才生效。初始版本 JPG 分支用的正是失效写法，导致所有
 *   JPG/PNG 竖拍照片（orientation 2~8）生成的缩略图未应用 EXIF 方向：
 *   - orientation 5/6/7/8（需旋转 90°）→ 竖图渲染成横图
 *   - orientation 2/3/4（镜像/180°）→ 内容倒置
 *   HEIC 分支走 ffmpeg 解码（libheif 自动应用方向），不受影响。
 *   后续代码已改为链式 .rotate()（正确），但已生成的缓存不会自动重建。
 *
 * 本脚本：找出非 HEIC + orientation 2~8 的照片 → 删除其 grid/detail/blur
 * 缓存 → 用当前（正确）pipeline 重新生成。
 *
 * 用法：npm run fix-thumbs   （server 目录下；需库已扫描、后端可离线运行）
 */
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../src/db/index.js'
import { config } from '../src/config.js'
import { ensureThumbnail } from '../src/pipeline/thumbnails.js'

/** 缓存文件绝对路径（与 pipeline 保持一致） */
function cachePath(size: 'grid' | 'detail' | 'blur', assetId: number): string {
  return path.join(config.cacheDir, 'thumbs', size, `${assetId}.webp`)
}

async function main(): Promise<void> {
  const db = getDb()

  // ① 找出受影响资产：非 HEIC/HEIF（sharp 直解分支）且 orientation 2~8 的照片/实况
  const rows = db
    .prepare(
      `SELECT a.id, a.orientation, a.filename
       FROM assets a
       WHERE a.type IN ('photo','live')
         AND a.orientation BETWEEN 2 AND 8
         AND lower(a.file_path) NOT LIKE '%.heic'
         AND lower(a.file_path) NOT LIKE '%.heif'
       ORDER BY a.date_taken, a.id`,
    )
    .all() as { id: number; orientation: number; filename: string }[]

  console.log(`受影响资产：${rows.length} 张（非 HEIC + orientation 2~8）`)

  let deleted = 0 // 实际删掉的旧缓存数（存在才删）
  let rebuilt = 0 // 重建成功数（任一档）
  let failed = 0 // 三档全部失败数

  for (let i = 0; i < rows.length; i++) {
    const { id, orientation, filename } = rows[i]

    // ② 删除旧缓存（存在才删；已存在是"错误方向"的旧文件，必须移除才会重新生成）
    for (const size of ['grid', 'detail', 'blur'] as const) {
      const p = cachePath(size, id)
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true })
        deleted++
      }
    }

    // ③ 用当前 pipeline 重建三档（ensureThumbnail 内部有 in-flight 去重）
    const results = await Promise.all(
      (['grid', 'detail', 'blur'] as const).map((size) => ensureThumbnail(id, size)),
    )
    if (results.some((r) => r !== null)) {
      rebuilt++
    } else {
      failed++
      console.warn(`[fix-thumbs] 重建失败 #${id} ${filename}（orientation=${orientation}）`)
    }

    if ((i + 1) % 20 === 0 || i === rows.length - 1) {
      console.log(`进度 ${i + 1}/${rows.length} · 删除旧缓存 ${deleted} · 重建成功 ${rebuilt} · 失败 ${failed}`)
    }
  }

  console.log(`\n完成：删除旧缓存 ${deleted} 个文件，重建 ${rebuilt} 张，失败 ${failed} 张`)
}

main().catch((err) => {
  console.error('fix-thumbs 执行失败:', err)
  process.exit(1)
})
