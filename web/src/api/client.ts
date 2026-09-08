/**
 * API 客户端
 *
 * 所有后端请求集中在这里，页面组件只调用这些函数。
 * 返回类型统一用 Promise<T>，失败抛错由调用方处理。
 */
import type { AssetDetail, AssetDto, MonthGroup, PageResult, Stats, ThumbSize } from '../types'

const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

/** 照片墙分页：游标续载（滚动）或 offset 跳页（日期定位） */
export function fetchAssets(opts: { cursor?: string | null; offset?: number; limit?: number } = {}): Promise<PageResult> {
  const limit = opts.limit ?? 120
  let q = `?limit=${limit}`
  if (opts.offset != null && opts.offset > 0) q += `&offset=${opts.offset}`
  else if (opts.cursor) q += `&cursor=${encodeURIComponent(opts.cursor)}`
  return get<PageResult>(`/assets${q}`)
}

/** 单个资产详情 + 邻居 */
export function fetchAsset(id: number): Promise<AssetDetail> {
  return get<AssetDetail>(`/assets/${id}`)
}

/** 库统计（也返回扫描进度） */
export function fetchStats(): Promise<Stats> {
  return get<Stats>('/stats')
}

/** 年月分组（日期快速定位条数据源） */
export function fetchDates(): Promise<{ unit: string; items: MonthGroup[] }> {
  return get('/dates')
}

/** FTS5 搜索（文件名 / 日期子串，至少 3 字符） */
export function searchAssets(q: string, limit = 100): Promise<{ query: string; items: AssetDto[] }> {
  return get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`)
}

/** 触发扫描 */
export function triggerScan(): Promise<{ started: boolean }> {
  return fetch(`${BASE}/scan`, { method: 'POST' }).then((r) => r.json())
}

/** 缩略图 URL（网格/详情/占位） */
export function thumbUrl(id: number, size: ThumbSize = 'grid'): string {
  return `${BASE}/thumb/${id}?size=${size}`
}

/** 视频流 URL（Range 由浏览器自动带） */
export function videoStreamUrl(id: number): string {
  return `${BASE}/video/${id}/stream`
}

/** 视频封面 URL */
export function videoPosterUrl(id: number): string {
  return `${BASE}/video/${id}/poster`
}

/** 给对象 URL 加防缓存参数（本地 dev 调试用，生产可去掉） */
export function withCacheBust(url: string, t: number): string {
  return `${url}&_=${t}`
}

export type { AssetDto }
