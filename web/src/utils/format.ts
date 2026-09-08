/**
 * 时间/数值格式化工具（详情页顶栏 + 信息面板共用）
 *
 * dateTaken 是 ISO8601（扫描时已归一化，如 "2025-02-17T18:55:12+08:00"），
 * new Date() 解析后按本地时区显示，保证与拍摄当地感受一致。
 */

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 顶栏短格式："2026年8月31日 15:45"（对齐 iCloud 顶栏） */
export function formatTakenShort(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 信息面板完整格式："2026年8月31日 星期一 15:45"（对齐 iCloud 信息面板） */
export function formatTakenFull(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 日期跨度（照片墙顶部吸顶指示器，对标 iCloud GridHeader 的日期范围显示）。
 * 输入视口内首张与末张资产的 dateTaken（ISO8601），按 iCloud 规则缩写：
 *   同年跨月/同月  "2021年4月22日 - 5月15日" / "2021年4月22日 - 4月30日"（第二个年份省略）
 *   跨年           "2025年12月31日 - 2026年1月2日"
 *   同一天         "2021年4月22日"
 * 无论传入顺序（照片墙为倒序流，上新下旧），内部都按「较早 → 较晚」输出，
 * 保证跨度读感与 iCloud 一致（日期始终前进）。解析失败时原样返回第一个参数。
 */
export function formatDateRange(isoA: string, isoB: string): string {
  let s = new Date(isoA)
  let e = new Date(isoB)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return isoA
  if (s.getTime() > e.getTime()) {
    const t = s
    s = e
    e = t
  }
  const y1 = s.getFullYear()
  const m1 = s.getMonth() + 1
  const d1 = s.getDate()
  const y2 = e.getFullYear()
  const m2 = e.getMonth() + 1
  const d2 = e.getDate()
  if (y1 === y2 && m1 === m2 && d1 === d2) return `${y1}年${m1}月${d1}日`
  if (y1 === y2) return `${y1}年${m1}月${d1}日 - ${m2}月${d2}日`
  return `${y1}年${m1}月${d1}日 - ${y2}年${m2}月${d2}日`
}

/** 文件大小："1.3 MB" / "45.2 MB" / "2.1 GB" */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 快门："1/25 秒"（<1s）或 "2 秒"（>=1s） */
export function formatShutter(seconds: number | null): string {
  if (seconds == null) return ''
  if (seconds >= 1) return `${seconds} 秒`
  const den = Math.round(1 / seconds)
  return `1/${den} 秒`
}

/** 光圈："f2.4" */
export function formatAperture(f: number | null): string {
  if (f == null) return ''
  return `f${f}`
}

/** 曝光补偿："-1 ev" / "+0.5 ev" */
export function formatExposureBias(ev: number | null): string {
  if (ev == null) return ''
  return `${ev > 0 ? '+' : ''}${ev} ev`
}

/** 码率（bps）→ "8.5 Mbps" */
export function formatBitRate(bps: number | null): string {
  if (bps == null || bps <= 0) return ''
  return `${(bps / 1e6).toFixed(1)} Mbps`
}

/** 时长："0:42" */
export function formatDuration(seconds: number | null): string {
  if (seconds == null) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 像素行："3024 × 4032" */
export function formatPixels(w: number | null, h: number | null): string {
  if (w == null || h == null) return ''
  return `${w} × ${h}`
}
