/**
 * 实况照片配对（导入源目录专用，独立于 scanner）
 *
 * 与 scanner 的配对规则一致（scanner/index.ts 294-334 行）：按「目录 + 配对基名」分组，
 * 图片永远是主资产，同基名的第一个视频作为实况视频；同基名多余图片/视频不丢弃，独立入库。
 * 独立实现的原因：导入源目录结构多样，且这里只关心「配对关系」，不写 DB。
 */
import path from 'node:path'
import { baseName } from '../metadata/index.js'

/** 源目录里一个待导入的媒体文件 */
export interface RawImportFile {
  /** 绝对路径 */
  absPath: string
  /** 相对源目录的路径（用于配对键与失败清单展示） */
  relPath: string
  fileName: string
  kind: 'image' | 'video'
  size: number
  mtimeMs: number
}

/** 一个导入资产：主资产（图片或独立视频）+ 可选实况视频 */
export interface ImportAsset {
  /** 主资产：图片（实况/普通照片）或独立视频 */
  image: RawImportFile
  /** 实况配对视频（仅当 image 是图片且同基名找到配对视频时非 null） */
  liveVideo: RawImportFile | null
}

/** 与 scanner 一致的配对键：目录 + 去扩展名基名（视频去掉 _HEVC 后缀） */
function pairKey(f: RawImportFile): string {
  let base = baseName(f.fileName)
  if (f.kind === 'video' && base.endsWith('_HEVC')) base = base.slice(0, -'_HEVC'.length)
  const dir = path.posix.dirname(f.relPath.replace(/\\/g, '/'))
  return `${dir}/${base}`
}

/**
 * 把扁平文件列表组装成资产列表。
 * 规则（对齐 scanner）：
 *   - 组内有图片：第一张图片为主资产，第一个视频为实况视频；多余图片、多余视频独立入库。
 *   - 组内只有视频：每个视频都是独立视频资产。
 */
export function groupByPair(files: RawImportFile[]): ImportAsset[] {
  const byKey = new Map<string, RawImportFile[]>()
  for (const f of files) {
    const key = pairKey(f)
    const arr = byKey.get(key) ?? []
    arr.push(f)
    byKey.set(key, arr)
  }

  const assets: ImportAsset[] = []
  for (const group of byKey.values()) {
    const images = group.filter((f) => f.kind === 'image')
    const videos = group.filter((f) => f.kind === 'video')
    if (images.length > 0) {
      assets.push({ image: images[0], liveVideo: videos[0] ?? null })
      for (const extra of images.slice(1)) assets.push({ image: extra, liveVideo: null })
      for (const extra of videos.slice(1)) assets.push({ image: extra, liveVideo: null })
    } else {
      for (const v of videos) assets.push({ image: v, liveVideo: null })
    }
  }
  return assets
}
