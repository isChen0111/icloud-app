/**
 * 实况照片配对（导入源目录专用）
 *
 * 判据与扫描链路完全共用一份实现（scanner/pair.ts）：UUID 优先、文件名兜底、
 * 两侧 UUID 冲突则不配。这里只负责把结果适配成导入用的类型，不再维护第二套规则。
 *
 * 为什么导入阶段不查 UUID：
 *   源目录里每个文件随后都要为 resolveDate 读一次元数据（图片 exifr / 视频 ffprobe），
 *   配对阶段再读一遍就是双倍 IO；而**配对结果最终由扫描决定**——文件落库后
 *   `type` / `live_video` 每轮重算，扫描用的是全局 UUID 索引，跨目录也能接上。
 *   导入阶段判错的唯一后果是实况视频落进了别的日期目录，落库时会被 UUID 配回来。
 *   等哪天真的需要「导入时就按 UUID 拆组」，把这里换成真正的查询函数即可，
 *   规则本身不用动。
 */
import { pairLiveAssets } from '../scanner/pair.js'

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
  /** 实况配对视频（仅当 image 是图片且找到配对视频时非 null） */
  liveVideo: RawImportFile | null
}

/**
 * 把扁平文件列表组装成资产列表。
 * 规则见 scanner/pair.ts：组内有图片时第一张为主资产、第一个候选视频为实况视频；
 * 多余图片、多余视频独立入库，不丢弃。
 */
export function groupByPair(files: RawImportFile[]): ImportAsset[] {
  return pairLiveAssets(files, () => null).assets
}
