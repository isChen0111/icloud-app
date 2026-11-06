/**
 * MP4/MOV 容器直读：不启动 ffprobe，直接在 JS 里解析 box 结构。
 *
 * 为什么需要它：`ffprobe` 每次调用都要 spawn 一个新进程，实测启动就占 127ms，
 * 真正读文件只多 2ms。首扫万级视频时，探测 UUID + 读取尺寸时长会把这项启动开销
 * 重复支付上万次（8 并发下仍需约 12 分钟）。同一批数据纯 JS 解析只要 2.5ms/个。
 *
 * 读取范围：只碰文件头 1MB，moov 不在头部时读尾部 4MB（MOV 常把 moov 放在末尾），
 * 绝不读视频数据本体。
 *
 * 覆盖内容（一次遍历全拿到，避免「只换 UUID 反而更慢」）：
 *   - moov/mvhd          → duration、creationTime
 *   - moov/trak/tkhd     → width、height、rotation
 *   - moov/meta/keys+ilst → com.apple.quicktime.content.identifier（实况 UUID）
 *
 * 解析不出来（moov 不在头尾、文件损坏、非 ISO BMFF 容器）一律返回 null，
 * 由调用方退回 ffprobe —— 结果与纯 JS 路径语义一致，零回归风险。
 */
import fs from 'node:fs'
import type { VideoMeta } from './index.js'

/** UUID 形态（8-4-4-4-12，十六进制）——实况标识必须严格符合，否则判解析错位 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export interface Mp4Probe {
  contentIdentifier: string | null
  duration: number | null
  width: number | null
  height: number | null
  /** ISO8601（UTC），与 ffprobe 的 creation_time 同语义 */
  creationTime: string | null
  /** 视频轨道旋转角（0/90/180/270），来自 tkhd matrix。ffprobe 不给这个值 */
  rotation: number
}

/** 实况内容标识在 keys 表里的键名（Apple 私有约定） */
const CID_KEY = 'com.apple.quicktime.content.identifier'

/** moov 读取上限：正常 mov 的 moov 只有几百 KB，超这个量级多半是 size 字段损坏 */
const MAX_MOOV_BYTES = 64 * 1024 * 1024

/** Mac HFS 纪元（1904-01-01）与 Unix 纪元的秒差 */
const MAC_EPOCH_OFFSET = 2_082_844_800

interface Box {
  type: string
  /** box 起点（含 size 字段） */
  start: number
  /** 内容起点（跳过 size + type + 可能的 64 位长度） */
  bodyStart: number
  end: number
}

/** 读一个 box 头；结构不合法返回 null（数据错位时立即停止遍历，不猜） */
function readBox(buf: Buffer, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null
  let size = buf.readUInt32BE(offset)
  const type = buf.toString('latin1', offset + 4, offset + 8)
  let headerSize = 8
  if (size === 1) {
    // 64 位长度：size=1 时后 8 字节才是真实大小（超大 MOV 才会用到）
    if (offset + 16 > limit) return null
    const hi = buf.readUInt32BE(offset + 8)
    const lo = buf.readUInt32BE(offset + 12)
    size = hi * 2 ** 32 + lo
    headerSize = 16
  } else if (size === 0) {
    // size=0 表示「一直到文件结尾」
    size = limit - offset
  }
  if (size < headerSize || offset + size > limit) return null
  return { type, start: offset, bodyStart: offset + headerSize, end: offset + size }
}

/** 按顺序遍历同级 box */
function* walk(buf: Buffer, start: number, end: number): Generator<Box> {
  let offset = start
  while (offset + 8 <= end) {
    const box = readBox(buf, offset, end)
    if (!box) return
    yield box
    if (box.end <= offset) return // 防御 size=0 造成的死循环
    offset = box.end
  }
}

/**
 * 在 [start, end) 内找指定类型的 box，可递归进容器。
 * 深度限制 4 层：moov → trak → mdia → minf 足够覆盖 tkhd/mvhd/udta/meta 的位置。
 */
function findBox(buf: Buffer, start: number, end: number, type: string, depth = 4): Box | null {
  for (const box of walk(buf, start, end)) {
    if (box.type === type) return box
  }
  if (depth === 0) return null
  const containers = ['moov', 'trak', 'mdia', 'minf', 'udta', 'stbl', 'edts', 'dinf']
  for (const box of walk(buf, start, end)) {
    if (!containers.includes(box.type)) continue
    const found = findBox(buf, box.bodyStart, box.end, type, depth - 1)
    if (found) return found
  }
  return null
}

/**
 * 按 4 字节类型签名在 [from, to) 内定位 box，**不依赖沿途 box 的 size 是否正确**。
 *
 * 为什么需要这个而不是 findBox：iPhone 写出的 moov 内部有些 box 的 size 字段并不严格
 * 合规（典型是 meta 少了 version/flags），一旦用 walk 逐层校验，会在错位处直接停下，
 * 后面的 meta/keys/ilst 永远走不到。签名定位只看「这里是不是一个 size + type 头」，
 * 容错强得多；代价是理论上可能命中数据区里的巧合字节，因此限定在 moov 范围内搜索。
 */
function findBySignature(buf: Buffer, from: number, to: number, type: string): Box | null {
  const sig = Buffer.from(type, 'latin1')
  let idx = buf.indexOf(sig, from)
  while (idx !== -1 && idx + 4 <= to) {
    const start = idx - 4
    if (start >= from) {
      const size = buf.readUInt32BE(start)
      // size 必须能覆盖自己的头部，且不越出搜索区
      if (size >= 8 && start + size <= to) {
        return { type, start, bodyStart: idx + 4, end: start + size }
      }
    }
    idx = buf.indexOf(sig, idx + 1)
  }
  return null
}

/** 把 Mac 纪元秒数转成 ISO8601；0 或明显越界视为缺失 */
function macTimeToIso(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const unix = seconds - MAC_EPOCH_OFFSET
  // 1990-2100 之外的值基本是「字段没写」或解析错位
  if (unix < 631_152_000 || unix > 4_102_444_800) return null
  return new Date(unix * 1000).toISOString()
}

/** 解析 moov/mvhd：时长与创建时间 */
function parseMvhd(buf: Buffer, box: Box): { duration: number | null; creationTime: string | null } {
  const v = buf[box.bodyStart]
  // FullBox 布局（跳过 version+flags 共 4 字节）
  const base = box.bodyStart + 4
  if (v === 1) {
    // v1：creation(8) modification(8) timescale(4) duration(8)
    if (base + 28 > box.end) return { duration: null, creationTime: null }
    const creation = Number(buf.readBigUInt64BE(base))
    const timescale = buf.readUInt32BE(base + 16)
    const duration = Number(buf.readBigUInt64BE(base + 20))
    return {
      duration: timescale > 0 && duration > 0 ? duration / timescale : null,
      creationTime: macTimeToIso(creation),
    }
  }
  // v0：creation(4) modification(4) timescale(4) duration(4)
  if (base + 16 > box.end) return { duration: null, creationTime: null }
  const creation = buf.readUInt32BE(base)
  const timescale = buf.readUInt32BE(base + 8)
  const duration = buf.readUInt32BE(base + 12)
  return {
    duration: timescale > 0 && duration > 0 ? duration / timescale : null,
    creationTime: macTimeToIso(creation),
  }
}

/** 解析 tkhd：显示宽高（16.16 定点）与 matrix 推出的旋转角 */
function parseTkhd(
  buf: Buffer,
  box: Box,
): { width: number | null; height: number | null; rotation: number } {
  const v = buf[box.bodyStart]
  // width/height 在 tkhd 尾部固定 8 字节，matrix（36 字节）紧接在它们之前。
  // v0: version+flags(4) creation(4) mod(4) trackId(4) reserved(4) duration(4)
  //     reserved(8) layer(2) altGroup(2) volume(2) reserved(2) → matrix 起于 +40
  // v1: creation/mod/duration 各 8 字节 → matrix 起于 +52
  const matrixOffset = v === 1 ? 52 : 40
  const widthOffset = matrixOffset + 36
  if (box.bodyStart + widthOffset + 8 > box.end) return { width: null, height: null, rotation: 0 }
  const width = buf.readUInt32BE(box.bodyStart + widthOffset) / 65536
  const height = buf.readUInt32BE(box.bodyStart + widthOffset + 4) / 65536
  // matrix 前四个 16.16 定点数决定旋转：90° 时 a=0,b=1,c=-1,d=0
  const a = buf.readInt32BE(box.bodyStart + matrixOffset) / 65536
  const b = buf.readInt32BE(box.bodyStart + matrixOffset + 4) / 65536
  const c = buf.readInt32BE(box.bodyStart + matrixOffset + 12) / 65536
  const d = buf.readInt32BE(box.bodyStart + matrixOffset + 16) / 65536
  let rotation = 0
  if (Math.abs(b) > 0.5 && Math.abs(c) > 0.5) rotation = b > 0 ? 90 : 270
  else if (a < -0.5 && d < -0.5) rotation = 180
  const usable = width >= 1 && height >= 1
  return {
    width: usable ? Math.round(width) : null,
    height: usable ? Math.round(height) : null,
    rotation,
  }
}

/**
 * 解析 keys 表。
 *
 * 坑：iPhone 导出的 meta/keys 是 FullBox，但有些写入器会省略 version/flags。
 * 不靠固定偏移，而是两种起点各试一次，取能完整走完 entry 列表的那个。
 */
function parseKeys(buf: Buffer, box: Box): string[] {
  for (const skip of [4, 0]) {
    const p = box.bodyStart + skip
    if (p + 4 > box.end) continue
    const count = buf.readUInt32BE(p)
    if (count <= 0 || count > 512) continue
    const keys: string[] = []
    let offset = p + 4
    let ok = true
    for (let i = 0; i < count; i++) {
      if (offset + 8 > box.end) {
        ok = false
        break
      }
      const size = buf.readUInt32BE(offset)
      if (size < 8 || offset + size > box.end) {
        ok = false
        break
      }
      // 每条 = size(4) + namespace(4) + key 名（UTF-8）
      keys.push(buf.toString('utf8', offset + 8, offset + size))
      offset += size
    }
    if (ok && keys.length === count) return keys
  }
  return []
}

/**
 * 在 ilst 中取出第 index 条（1 起）的值。
 *
 * ilst 的子 box 没有类型字符串，而是「4 字节的 1-based 索引」，指向 keys 里的同名条目；
 * 每个子 box 内是一个 `data` box，其内容 = 4 字节类型/标志 + 4 字节 locale + 值。
 */
function parseIlstValue(buf: Buffer, ilst: Box, index: number): string | null {
  for (const item of walk(buf, ilst.bodyStart, ilst.end)) {
    if (buf.readUInt32BE(item.start + 4) !== index) continue
    for (const data of walk(buf, item.bodyStart, item.end)) {
      if (data.type !== 'data') continue
      const payload = data.bodyStart + 8
      if (payload > data.end) return null
      const text = buf.toString('utf8', payload, data.end).replace(/\0+$/, '').trim()
      return text || null
    }
  }
  return null
}

/** 在同一段缓冲区里解析 moov（found 的偏移是缓冲区内的绝对位置） */
function parseMoov(buf: Buffer, moov: Box): Mp4Probe {
  const mvhd = findBox(buf, moov.bodyStart, moov.end, 'mvhd')
  const { duration, creationTime } = mvhd ? parseMvhd(buf, mvhd) : { duration: null, creationTime: null }

  // 视频轨的 tkhd：moov 下可能有多个 trak（音轨/字幕），取第一个带有效宽高的
  let width: number | null = null
  let height: number | null = null
  let rotation = 0
  for (const trak of walk(buf, moov.bodyStart, moov.end)) {
    if (trak.type !== 'trak') continue
    const tkhd = findBox(buf, trak.bodyStart, trak.end, 'tkhd', 3)
    if (!tkhd) continue
    const parsed = parseTkhd(buf, tkhd)
    if (parsed.width != null) {
      width = parsed.width
      height = parsed.height
      rotation = parsed.rotation
      break
    }
  }

  let contentIdentifier: string | null = null
  // meta 走签名定位而不是 findBox：iPhone 的 meta 常省略 ISO 要求的 version/flags，
  // 用严格遍历会在错位处直接返回 null，后面的 keys/ilst 永远够不着（2026-11-05 实测
  // 就是这一点导致万级实况视频全部退回 ffprobe）。
  const meta = findBySignature(buf, moov.bodyStart, moov.end, 'meta')
  if (meta) {
    const keys = findBySignature(buf, meta.start, meta.end, 'keys')
    const keyNames = keys ? parseKeys(buf, keys) : []
    const keyIndex = keyNames.indexOf(CID_KEY)
    if (keyIndex >= 0) {
      const ilst = findBySignature(buf, meta.start, meta.end, 'ilst')
      if (ilst) contentIdentifier = parseIlstValue(buf, ilst, keyIndex + 1)
    }
  }

  return {
    contentIdentifier,
    duration,
    width,
    height,
    creationTime,
    rotation,
  }
}

/**
 * 直接解析 MP4/MOV 容器元数据。
 *
 * 读取策略：先用 16 字节 seek 逐个跳过顶层 box（ftyp / free / mdat …），
 * 命中 moov 后按它声明的长度精确读一次。全程不碰视频数据本体，
 * 也不像「盲读 1MB」那样在 moov 体积大于预读量时误判成解析失败。
 *
 * 返回 null 表示「这个文件读不出来，请用 ffprobe」——不抛异常，调用方无需 try/catch。
 */
export async function probeMp4(absPath: string): Promise<Mp4Probe | null> {
  let fd: number | null = null
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile() || stat.size < 16) return null
    fd = fs.openSync(absPath, 'r')

    // 顶层 box 逐个跳（每个只读 16 字节头），找到 moov 就精确读它的完整内容
    let offset = 0
    while (offset + 8 <= stat.size) {
      const head = Buffer.allocUnsafe(Math.min(16, stat.size - offset))
      const read = fs.readSync(fd, head, 0, head.length, offset)
      if (read < 8) return null
      let size = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let headerSize = 8
      if (size === 1) {
        if (read < 16) return null
        size = head.readUInt32BE(8) * 2 ** 32 + head.readUInt32BE(12)
        headerSize = 16
      } else if (size === 0) {
        size = stat.size - offset
      }
      if (size < headerSize) return null

      if (type === 'moov') {
        const len = Math.min(size, MAX_MOOV_BYTES, stat.size - offset)
        const buf = Buffer.allocUnsafe(len)
        const got = fs.readSync(fd, buf, 0, len, offset)
        if (got < headerSize) return null
        const view = buf.subarray(0, got)
        const moov = readBox(view, 0, view.length)
        if (!moov) return null
        return parseMoov(view, moov)
      }
      offset += size
    }
    return null
  } catch {
    // 权限、文件被占用、读到一半被删……一律交给 ffprobe 兜底
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

/**
 * L1 自洽校验：把 probeMp4 的原始结果映射成 VideoMeta，任一字段越界按规则处置。
 *
 * 返回 null 表示「这份结果不可信，整文件退回 ffprobe」——只对 UUID 用这个力度：
 * contentIdentifier 非 null 但不符合 8-4-4-4-12 形态，说明 meta/keys/ilst 解析错位，
 * 这种错值会静默把不相关的 HEIC/MOV 配成一组，必须整体作废。
 *
 * 其余字段越界只置 null（不影响实况配对，只是该字段退化），不整文件判失败：
 *   - 宽高不在 (0, 100000) 内 → null（box 错位 / 读取越界）
 *   - 时长不在 [0, 24h] 内 → null（mvhd 错位）
 *   - 拍摄年份不在 [1990, 明年] 内 → null（Mac 纪元换算错位）
 */
export function validateProbe(p: Mp4Probe): VideoMeta | null {
  if (p.contentIdentifier != null && !UUID_RE.test(p.contentIdentifier)) return null

  const width = p.width != null && p.width > 0 && p.width < 100000 ? p.width : null
  const height = p.height != null && p.height > 0 && p.height < 100000 ? p.height : null
  const duration = p.duration != null && p.duration >= 0 && p.duration <= 24 * 3600 ? p.duration : null

  let creationTime = p.creationTime
  if (creationTime != null) {
    const year = Number(creationTime.slice(0, 4))
    if (!Number.isFinite(year) || year < 1990 || year > new Date().getFullYear() + 1) {
      creationTime = null
    }
  }

  return { duration, width, height, creationTime, contentIdentifier: p.contentIdentifier }
}
