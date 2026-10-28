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

/** ISO 时间 → 紧凑形式：只留字母数字（去 - : . 空格 + 偏移），如 2024-09-13T08:40:28+08:00 → 20240913T0840280800 */
export function toDateCompact(iso: string | null | undefined): string {
  if (!iso) return ''
  return iso.replace(/[^0-9a-zA-Z]/g, '')
}
