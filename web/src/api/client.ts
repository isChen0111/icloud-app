/**
 * API 客户端
 *
 * 所有后端请求集中在这里，页面组件只调用这些函数。
 * 返回类型统一用 Promise<T>，失败抛错由调用方处理。
 */
import type {
  AssetDetail,
  AssetDto,
  AssetInfo,
  AuthSession,
  LibrariesResult,
  LibraryInfo,
  MonthGroup,
  PageResult,
  SearchResult,
  Stats,
  SyncState,
  ThumbnailFailuresResult,
  ThumbSize,
} from '../types'

const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const error = (await res.json()) as { error?: unknown }
    throw new Error(typeof error.error === 'string' ? error.error : `API ${path} → ${res.status}`)
  }
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

/** 单个资产详情 + 邻居 + 序号/总数 */
export function fetchAsset(id: number): Promise<AssetDetail> {
  return get<AssetDetail>(`/assets/${id}`)
}

/** 资产信息（详情页「信息」面板：实时解析原文件 EXIF/ffprobe，低频） */
export function fetchAssetInfo(id: number): Promise<AssetInfo> {
  return get<AssetInfo>(`/assets/${id}/info`)
}

/** 库统计（也返回扫描进度） */
export function fetchStats(): Promise<Stats> {
  return get<Stats>('/stats')
}

export function fetchThumbnailFailures(): Promise<ThumbnailFailuresResult> {
  return get<ThumbnailFailuresResult>('/thumbnails/failed')
}

export function retryThumbnailFailures(selection: { ids: number[] } | { all: true }): Promise<{ retried: number }> {
  return post('/thumbnails/retry', selection)
}

export function setThumbnailFailuresIgnored(
  selection: { ids: number[] } | { all: true },
  ignored: boolean,
): Promise<{ updated: number }> {
  return post('/thumbnails/ignore', { ...selection, ignored })
}

/** 年月分组（日期快速定位条数据源） */
export function fetchDates(): Promise<{ unit: string; items: MonthGroup[] }> {
  return get('/dates')
}

/** FTS5 搜索（文件名 / 日期子串，至少 3 字符；offset 跳页 = 匹配流照片墙化分页） */
export async function searchAssets(q: string, opts: { offset?: number; limit?: number } = {}): Promise<SearchResult> {
  const limit = opts.limit ?? 200
  let path = `/search?q=${encodeURIComponent(q)}&limit=${limit}`
  if (opts.offset != null && opts.offset > 0) path += `&offset=${opts.offset}`
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) {
    // R-18：后端对「索引/库文件损坏」返回 code=DB_CORRUPT + 可操作文案（如「请重建索引」），
    // 直接透出给用户，否则用户会把损坏当成「没搜到这个关键词」。
    // 其余失败沿用统一文案（搜索失败重试即可）。
    let message = '搜索失败，请重试'
    try {
      const body = (await res.json()) as { message?: string; error?: string }
      if (body.message) message = body.message
      else if (body.error) message = body.error
    } catch {
      // 响应不是 JSON（如代理返回的 HTML 错误页）→ 保留统一文案
    }
    throw new Error(message)
  }
  return res.json() as Promise<SearchResult>
}

/** 触发扫描 */
export function triggerScan(): Promise<{ started: boolean }> {
  return fetch(`${BASE}/scan`, { method: 'POST' }).then((r) => r.json())
}

/**
 * 缩略图内容版本号（cache-busting）
 *
 * 为什么需要：缩略图接口响应头为 `Cache-Control: public, max-age=31536000`
 * （一年强缓存）。缩略图内容一旦因生成参数修复/缓存重建而变化，浏览器仍会
 * 命中旧缓存、永远不重新请求——URL 相同则旧内容不可见。
 *
 * 规则：**任何改变缩略图内容的变更后 +1**（生成参数、解码链路、缓存重建等）；
 * 不改变内容的改动（如仅调响应头）不需要 bump。bump 后旧 URL 自动失效，
 * 浏览器重新拉取，新 URL 继续享受长缓存。
 *
 * 版本历史：
 *  - v1 初始
 *  - v2 2026-09-08：修复早期 JPG 竖拍照片缩略图方向错误（sharp 构造选项
 *    rotate:true 失效 → 横图缓存；代码已改链式 .rotate() 并重建服务器缓存，
 *    但浏览器旧横图被一年强缓存锁定，bump 强制重新拉取）
 *  - v3 2026-09-21：保留输入媒体 ICC 色彩配置，避免广色域照片转 WebP 后
 *    颜色变淡；服务端同步重建缩略图缓存
 *
 * 注意：此常量只表达「生成链路版本」，单个源文件被覆盖由其 file_mtime 表达。
 * 最终 URL 的 rev 参数由 revParam() 拼成 "内容版本-文件mtime"（见下），
 * 二者任一变化都会使 URL 变化——不要让调用点直接传 THUMB_REV 覆盖 mtime
 * （2026-10-07 体检修复：旧实现两套逻辑并存，漏传的调用点悄悄降级为默认值，
 * 导致详情预取永不命中、视频封面与内容 bump 机制失效）。
 */
const THUMB_REV = 3

/**
 * 拼缓存版本参数：格式 "内容版本-文件mtime"，如 "3-1700000000123"。
 * - 内容版本 bump（生成参数/解码链路变化）→ 全部资产 URL 变化
 * - 文件 mtime 变化（源文件被覆盖）→ 该资产 URL 变化
 * 后端不读 rev（thumb.ts 只按 id+size 出图），rev 纯粹是浏览器缓存键。
 */
function revParam(mtime: number): string {
  return `${THUMB_REV}-${mtime}`
}

/** 缩略图 URL（网格/详情/占位）；mtime = 资产 file_mtime（未知时传 0） */
export function thumbUrl(id: number, size: ThumbSize = 'grid', mtime: number = 0): string {
  return `${BASE}/thumb/${id}?size=${size}&rev=${revParam(mtime)}`
}

/** 视频流 URL（Range 由浏览器自动带） */
export function videoStreamUrl(id: number): string {
  return `${BASE}/video/${id}/stream`
}

/** 视频封面 URL（size=detail 用于详情页播放前的大封面；mtime 同缩略图机制：源视频覆盖后强制刷新长缓存） */
export function videoPosterUrl(id: number, size: ThumbSize = 'grid', mtime: number = 0): string {
  return `${BASE}/video/${id}/poster?size=${size}&rev=${revParam(mtime)}`
}

/** 给对象 URL 加防缓存参数（本地 dev 调试用，生产可去掉） */
export function withCacheBust(url: string, t: number): string {
  return `${url}&_=${t}`
}


/** 批量删除资产（客户端删除：DB 行 + 缓存 + 磁盘源文件，不可逆）
 * 详情页删除单张 = 传 [id]；照片墙多选删除 = 传选中集合 */
export interface DeleteAssetsResult {
  /** 已连 DB 记录一起删除的资产数 */
  deleted: number
  missing: number
  /** 数据库记录未删除、源文件因权限/占用等原因未能删除的文件数（R-15：这些资产保留） */
  unlinkFail: number
  /** 删除失败明细（id 与文件路径），前端据此只从本地列表移除真正删掉的那些 */
  failed?: { id: number; path: string; code: string }[]
}

export function deleteAssets(ids: number[]): Promise<DeleteAssetsResult> {
  return fetch(`${BASE}/assets`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then(async (r) => {
    if (!r.ok) {
      // 后端会返回可读文案（如「照片库扫描进行中，请稍候再删除照片」），优先透出
      let message = `API /assets DELETE → ${r.status}`
      try {
        const body = (await r.json()) as { error?: unknown }
        if (typeof body.error === 'string') message = body.error
      } catch {
        // 非 JSON 响应，用状态码兜底
      }
      throw new Error(message)
    }
    return r.json() as Promise<DeleteAssetsResult>
  })
}

export type { AssetDto }

/* ============ P0 照片库（icloudpd 同步） ============ */

/** 库列表（account 脱敏） */
export function fetchLibraries(): Promise<LibrariesResult> {
  return get<LibrariesResult>('/libraries')
}

/** 新建照片库并激活（首次引导「设置库名」步骤） */
export function createLibrary(name: string): Promise<{ ok: boolean; library: LibraryInfo; note?: string }> {
  return post('/libraries', { name })
}

/** 切换激活库（热切换：停旧库资源 → 重扫新库） */
export function switchLibrary(id: number): Promise<{ ok: boolean; activeId: number; unchanged?: boolean }> {
  return fetch(`${BASE}/libraries/${id}/active`, { method: 'PATCH' }).then(async (r) => {
    if (!r.ok) {
      const error = (await r.json()) as { error?: unknown }
      throw new Error(typeof error.error === 'string' ? error.error : `API /libraries/${id}/active → ${r.status}`)
    }
    return r.json() as Promise<{ ok: boolean; activeId: number; unchanged?: boolean }>
  })
}

/** 更新单库同步参数：untilFound（增量连续 N 个已存在则停）/ recentLimit（0=全量不限） */
export function updateLibraryConfig(
  id: number,
  patch: { untilFound: number; recentLimit: number },
): Promise<{ ok: boolean; config: { untilFound: number; recentLimit: number } }> {
  return fetch(`${BASE}/libraries/${id}/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(async (r) => {
    if (!r.ok) {
      const error = (await r.json()) as { error?: unknown }
      throw new Error(typeof error.error === 'string' ? error.error : `API /libraries/${id}/config → ${r.status}`)
    }
    return r.json() as Promise<{ ok: boolean; config: { untilFound: number; recentLimit: number } }>
  })
}

/**
 * 删除照片库（仅本地；云端 iCloud 原片不受影响）。
 * removePhotos=true 时连同本地已下载照片副本一起删，否则仅删注册 + 缓存。
 */
export function deleteLibrary(
  id: number,
  removePhotos: boolean,
): Promise<{ ok: boolean; activeId: number | null; remaining: number }> {
  return fetch(`${BASE}/libraries/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removePhotos }),
  }).then(async (r) => {
    if (!r.ok) {
      const error = (await r.json()) as { error?: unknown }
      throw new Error(typeof error.error === 'string' ? error.error : `API /libraries/${id} DELETE → ${r.status}`)
    }
    return r.json() as Promise<{ ok: boolean; activeId: number | null; remaining: number }>
  })
}

/** 启动认证（auth-only；返回会话，前端轮询 fetchAuth） */
export function startAuth(libraryId: number, username: string): Promise<{ ok: boolean; auth: AuthSession }> {
  return post('/auth', { libraryId, username })
}

/** 喂入密码 / 验证码 */
export function sendAuthInput(value: string): Promise<{ ok: boolean; auth: AuthSession }> {
  return post('/auth/input', { value })
}

/** 查询认证会话状态（轮询） */
export function fetchAuth(): Promise<{ auth: AuthSession | null }> {
  return get('/auth')
}

/** 取消认证 */
export function cancelAuth(): Promise<{ ok: boolean }> {
  return fetch(`${BASE}/auth/cancel`, { method: 'POST' }).then((r) => r.json())
}

/** 启动同步任务（kind: full 全量拉取 / inc 增量同步） */
export function startSync(libraryId: number, kind: 'full' | 'inc'): Promise<{ ok: boolean; sync: SyncState }> {
  return post(`/library/${libraryId}/sync`, { kind })
}

/** 同步任务状态（轮询） */
export function fetchSync(libraryId: number): Promise<{ sync: SyncState }> {
  return get(`/library/${libraryId}/sync`)
}

/** 取消同步任务 */
export function cancelSync(libraryId: number): Promise<{ ok: boolean; sync: SyncState }> {
  return fetch(`${BASE}/library/${libraryId}/sync`, { method: 'DELETE' }).then((r) => r.json())
}
