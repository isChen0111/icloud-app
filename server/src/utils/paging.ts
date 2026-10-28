/**
 * 分页参数解析（/api/assets 与 /api/search 共用）
 *
 * R-23：旧实现 `Math.max(0, Math.floor(Number(x))) || 0` 对 `?offset=Infinity`
 * 或 `?offset=1e999` 会得到 Infinity（Infinity 是 truthy，`|| 0` 兜不住），
 * 直接绑定到 SQLite 的 OFFSET 会抛 "datatype mismatch" → 500。
 * 这里先过 Number.isFinite：非有限值（NaN / ±Infinity）一律归 0。
 */

/** 单页最大起始偏移（与 search 路由原有的 1e6 上限一致，避免深翻页暴力扫描） */
export const MAX_OFFSET = 1_000_000

/**
 * 解析 offset 查询参数：
 * - 缺省 / 非数字 / NaN / ±Infinity → 0
 * - 负数 → 0（SQLite 不允许负 OFFSET）
 * - 小数 → 向下取整
 * - 超过 MAX_OFFSET → 钳到上限
 */
export function parseOffset(raw: string | number | undefined | null, max = MAX_OFFSET): number {
  const n = Number(raw ?? 0)
  if (!Number.isFinite(n)) return 0
  return Math.min(max, Math.max(0, Math.floor(n)))
}
