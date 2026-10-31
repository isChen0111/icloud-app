/**
 * 上传链路工具：临时目录管理 + 相对路径清洗（防目录穿越）
 *
 * 「上传」与「本机迁移」的区别只在「来源获取」：上传把其它设备的文件经 HTTP 流式写到
 * 一个临时目录（保留相对路径），之后把这个临时目录当成本机目录，走同一套 importDirectory
 * 流水线，结束后清理临时目录。这里只提供临时目录与路径清洗的工具，流式落盘在路由层内联。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 上传临时目录根名（相对库 cache_dir，且不在 library_root 下，避免触发 watcher） */
const IMPORT_TMP_DIRNAME = 'import-tmp'

/**
 * 清洗上传带来的相对路径（前端 webkitRelativePath），防止目录穿越。
 * 规则：
 *   - 归一化分隔符（Windows 反斜杠 → 正斜杠）
 *   - 拒绝绝对路径（/ 开头或盘符 C:）
 *   - 拒绝含 .. 段（目录穿越）
 *   - 去掉空段与 . 段
 * @throws 非法路径时抛错
 */
export function sanitizeRelPath(p: string): string {
  const norm = path.normalize(p).replace(/\\/g, '/')
  if (norm.startsWith('/') || /^[a-z]:/i.test(norm)) {
    throw new Error(`非法相对路径（绝对路径）: ${p}`)
  }
  const segs = norm.split('/')
  if (segs.some((s) => s === '..')) {
    throw new Error(`非法相对路径（目录穿越）: ${p}`)
  }
  const cleaned = segs.filter((s) => s !== '' && s !== '.')
  if (cleaned.length === 0) throw new Error(`非法相对路径（空）: ${p}`)
  return cleaned.join('/')
}

/** 生成一次上传会话的临时目录绝对路径（唯一，避免并发上传互相覆盖） */
export function importTempDir(cacheDir: string, sessionId: string): string {
  return path.join(cacheDir, IMPORT_TMP_DIRNAME, sessionId)
}

/**
 * 解析前端上传时附带的时间戳 JSON：`{ relPath: File.lastModified(毫秒) }`。
 * key 统一走 sanitizeRelPath 归一化（与落盘文件名一致），非法/非正值跳过。
 * 解析失败（JSON 坏、非对象）返回空对象，不抛错——缺失时间戳只退化为「上传时刻」兜底。
 */
export function parseUploadMtimes(json: string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  if (!json) return out
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return out
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const ms = Number(v)
    if (!Number.isFinite(ms) || ms <= 0) continue
    let key = k
    try {
      key = sanitizeRelPath(k)
    } catch {
      continue // 非法 key（目录穿越/绝对路径）直接忽略
    }
    out[key] = ms
  }
  return out
}

/**
 * 把 lastModified 回设到已落盘的临时文件。
 * 写盘会触发操作系统把 mtime 更新成「现在」，无 EXIF 的文件后续 resolveDate 就会
 * 落到上传时刻（日期错）。这里按前端带来的 File.lastModified 还原 mtime。
 */
export async function applyUploadMtimes(
  written: { dest: string; rel: string }[],
  mtimesJson: string | undefined,
): Promise<void> {
  const map = parseUploadMtimes(mtimesJson)
  for (const { dest, rel } of written) {
    const ms = map[rel]
    if (!ms) continue
    const t = new Date(ms)
    await fs.promises.utimes(dest, t, t)
  }
}

/**
 * 计算 @fastify/multipart 的 fileSize 限制。
 * ⚠️ 「不限」（maxUploadBytes<=0）必须返回 Infinity，不能返回 undefined——
 * @fastify/multipart 内部对 undefined 会 `?? fastify.initialConfig.bodyLimit`
 * 回落到 Fastify 默认 1 MiB，导致正常照片/视频也报「request file too large」（413）。
 * 这是 2026-10-31 实测踩过的坑，故此抽成函数并加单测防止回归。
 */
export function resolveMultipartFileSize(maxUploadBytes: number): number {
  return maxUploadBytes > 0 ? maxUploadBytes : Infinity
}

/** 生成唯一会话 id（时间戳 + 随机串） */
export function newImportSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 清理单个上传临时目录（幂等，force 忽略不存在） */
export async function cleanImportTempDir(tmpDir: string): Promise<void> {
  await fs.promises.rm(tmpDir, { recursive: true, force: true })
}

/**
 * 清理残留的上传临时目录（服务启动时调用，仿缩略图的 cleanStaleTempFiles）。
 * 超过 maxAgeMs（默认 24h）未清理的 import-tmp/<sessionId> 视为上次异常退出留下的垃圾，直接删。
 */
export async function cleanStaleImportTemp(cacheDir: string, maxAgeMs = 24 * 3600 * 1000): Promise<void> {
  const base = path.join(cacheDir, IMPORT_TMP_DIRNAME)
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true })
  } catch {
    return // import-tmp 目录不存在，无需清理
  }
  const now = Date.now()
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(base, e.name)
    try {
      const st = await fs.promises.stat(full)
      if (now - st.mtimeMs > maxAgeMs) await fs.promises.rm(full, { recursive: true, force: true })
    } catch {
      // 单个目录 stat/删除失败不影响其它残留清理
    }
  }
}
