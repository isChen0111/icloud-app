/**
 * 日期字符串工具（扫描入库与 FTS 回填共用，R-26）
 *
 * date_compact 是给 FTS5 trigram 用的「去标点日期」，让用户能搜 "202409" 这类紧凑写法。
 * 原先有两个实现、结果不一致：
 *   - scanner 入库：`iso.replace(/[^0-9a-zA-Z]/g, '')` → "20240913T084028"（保留 T）
 *   - db 启动回填：SQL 四次 replace 依次去掉 - : . T → "20240913084028"（删掉 T）
 * 同一资产因此有两种索引表示，搜 "20240913T0840" 只命中前者、搜 "202409130840" 只命中后者。
 * 现在统一走这里，db 回填也改成读完行在 JS 里算（万级行毫秒级，回填本就只在行数不符时发生）。
 */

/**
 * ISO 时间 → 紧凑形式：只留字母数字（去 - : . 空格），并截掉毫秒与时区后缀。
 *
 * 为什么要截时区（R-08 之后）：date_taken 统一存「本地时间 + 偏移」（`2024-09-13T08:40:28+08:00`），
 * 若只做「去非字母数字」，偏移会被压成尾巴数字 → `20240913T0840280800`，搜索串里凭空多出 `0800`。
 * 截掉秒以下与时区后，同一时刻无论写成 `...Z` 还是 `...+08:00` 都得到同一个紧凑值
 * （`20240913T084028`），这才是 R-26 想要的「同一资产只有一种索引表示」。
 */
export function toDateCompact(iso: string | null | undefined): string {
  if (!iso) return ''
  return iso.replace(/(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/, '').replace(/[^0-9a-zA-Z]/g, '')
}

/**
 * Date → 「本地时间 + 时区偏移」的 ISO8601 表示，如 `2026-10-25T16:47:15+08:00`。
 *
 * 为什么统一成这个表示（审查 R-08）：
 *   `date_taken` 原先混着两种基准——EXIF 走 `toISOString()`（UTC，`...Z`），
 *   目录兜底走硬编码的 `T00:00:00+08:00`（本地零点）。两种基准混在一列里有两个后果：
 *     ① `ORDER BY date_taken` 比的是字符串，同一时刻的两种写法不相等 → 排序错位；
 *     ② 按月分组用 `substr(date_taken, 1, 7)`，切出来的是 **UTC 月份**，
 *        本地 11-01 03:00 的照片（UTC 10-31 19:00）会被算进 10 月。
 *   本地偏移表示让「字符串序 = 本地时间序 = 真实顺序」，`substr` 取到的也是本地月份，
 *   且 ISO 自描述（以后换时区，`new Date()` 解析历史行依然正确）。
 *
 * 不带毫秒：EXIF 精度只到秒，统一两位对齐，避免同一列出现 `.000` 与无毫秒两种写法。
 */
export function toLocalIso(d: Date): string | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  // getTimezoneOffset 返回「本地比 UTC 晚多少分钟」的相反数（东八区 = -480），取负得 +480
  const offsetMin = -d.getTimezoneOffset()
  const abs = Math.abs(offsetMin)
  const sign = offsetMin >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * 是否已经是「带时区偏移」的表示（`+08:00` / `-05:00`）。
 * 迁移时用它判断某行是否已完成转换；`...Z`（UTC）与无偏移的裸时间都算未迁移。
 */
export function hasTimezoneOffset(iso: string): boolean {
  return /[+-]\d{2}:\d{2}$/.test(iso)
}
