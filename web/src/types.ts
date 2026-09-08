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

/** 详情项（含实况视频路径 + 前后邻居 id + 序号/总数） */
export interface AssetDetail extends AssetDto {
  liveVideo: string | null
  prevId: number | null
  nextId: number | null
  /** 在全库倒序流中的序号（1-based，与照片墙滚动顺序一致） */
  position: number
  /** 全库资产总数（顶栏 "第 N / total 项"） */
  total: number
}

/** 资产信息面板数据（GET /api/assets/:id/info，实时解析原文件 EXIF/ffprobe） */
export interface AssetInfo {
  id: number
  type: AssetType
  filename: string
  /** 拍摄时间（ISO8601，可空） */
  takenAt: string | null
  /** 拍摄设备，如 "Apple iPhone X" */
  device: string | null
  /** 格式，如 HEIF / JPEG / MOV */
  format: string | null
  /** 镜头描述 */
  lens: string | null
  width: number | null
  height: number | null
  /** 视频时长（秒） */
  duration: number | null
  /** 文件大小（字节） */
  sizeBytes: number
  /** 百万像素（照片） */
  megaPixels: number | null
  iso: number | null
  /** 焦距（毫米） */
  focalLength: number | null
  /** 光圈值 */
  fNumber: number | null
  /** 快门（秒） */
  exposureTime: number | null
  /** 曝光补偿（EV） */
  exposureBias: number | null
  /** 视频编码 */
  codec: string | null
  /** 视频码率（bps） */
  bitRate: number | null
  gpsLat: number | null
  gpsLon: number | null
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
  /** 该月代表缩略图资产 id（倒序首资产，后端 /api/dates 提供；缩略图导航条用） */
  thumbId?: number
}

/** 缩略图档位 */
export type ThumbSize = 'grid' | 'detail' | 'blur'
