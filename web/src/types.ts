/**
 * 领域类型定义（与后端 API 返回结构一一对应）
 */

/** 资产类型：photo 普通照片 / video 普通视频 / live 实况照片 */
export type AssetType = 'photo' | 'video' | 'live'

/** 列表项（网格用） */
export interface AssetDto {
  id: number
  type: AssetType
  filename: string
  dateTaken: string
  width: number | null
  height: number | null
  duration: number | null
  orientation: number | null
  gpsLat: number | null
  gpsLon: number | null
  thumbUrl: string
}

/** 详情项（含实况视频路径 + 前后邻居 id） */
export interface AssetDetail extends AssetDto {
  liveVideo: string | null
  prevId: number | null
  nextId: number | null
}

/** 分页响应（offset 跳页模式也复用同一结构） */
export interface PageResult {
  items: AssetDto[]
  nextCursor: string | null
  /** 本页在全局倒序流中的起始位置（跳页模式返回） */
  offset: number
}

/** 库统计 */
export interface Stats {
  assets: number
  photos: number
  videos: number
  livePhotos: number
  totalBytes: number
  totalSizeGB: number
  thumbQueue: number
  scan: { status: string; totalFiles: number; scannedFiles: number; assetsFound: number; message: string }
}

/** 月份分组（日期快速定位条数据源；offset = 该月首资产在倒序流中的全局位置） */
export interface MonthGroup {
  ym: string
  label: string
  count: number
  offset: number
}

/** 缩略图档位 */
export type ThumbSize = 'grid' | 'detail' | 'blur'
