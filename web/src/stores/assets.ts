/**
 * Pinia Store：资产区间缓存（照片墙「全量骨架 + 按需加载」的数据层）
 *
 * 设计背景（C 方案：滚动条 = 全库精确高度，跳转后上下自由）：
 * 照片墙的总行数/总高度可由「月份分组 + 列数」精确预计算（见 GridScroller），
 * 滚动条因此覆盖整个库；本 store 负责「按需拉取任意全局位置区间」并缓存：
 *
 *   1. 缓存按「页」组织：全局倒序流以 PAGE 条为一页，页起点为键
 *      （页起点恒为 PAGE 的整数倍，任意区间请求都能复用到整页）
 *   2. getRange(start, end)：命中返回数组；缺页返回 null（网格渲染占位骨架）
 *   3. ensureRange(start, end)：缺页则发起请求（幂等 + 加载中去重，滚动风暴安全）
 *   4. 跳转 = 设置目标位置后滚动到对应行，可视区自动触发 ensureRange，
 *      不再需要「重置 items + 归零」的旧模型
 */
import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { fetchAssets, fetchDates } from '../api/client'
import type { AssetDto, MonthGroup } from '../types'

/** 缓存页大小（条）。越大越省请求但首屏越重；120 与旧分页一致 */
const PAGE = 120

export const useAssetStore = defineStore('assets', () => {
  /** 月份分组（倒序：最新在前），来自 /api/dates；骨架/总数/跳转定位的数据源 */
  const months = ref<MonthGroup[]>([])
  /** 全库资产总数（= Σ months.count；照片墙「共 N 项」与骨架行数用） */
  const totalCount = computed(() => months.value.reduce((s, m) => s + m.count, 0))

  /** 页缓存：key = 页全局起点（PAGE 整数倍），value = 该页资产（倒序流切片） */
  const pages = reactive(new Map<number, AssetDto[]>())
  /** 加载中的页起点集合（并发去重：同页只发一个请求） */
  const pageLoading = reactive(new Set<number>())
  /** 是否有任一请求进行中（工具栏「加载中…」提示） */
  const loading = ref(false)
  /** 失败页起点集合（请求失败后静默，滚动离开再回来会重试） */
  const failed = reactive(new Set<number>())
  /** 失败页的失败时刻（ms）。配合 failed 做冷却：失败后 COOLDOWN 内不自动重试，
   *  否则 ensureRange 每次滚动都会重发同一页 —— 某页 500 后就是请求风暴（审查 C-20） */
  const failedAt = new Map<number, number>()
  const FAILED_RETRY_COOLDOWN_MS = 15000
  /** 删除等数据变更后，使变更前发出的分页响应失效，避免旧数据回写缓存 */
  let dataVersion = 0
  let monthsRequestSequence = 0
  let requestSequence = 0
  const activeRequests = new Map<number, number>()

  /** 当前已加载资产数（调试信息） */
  const loadedCount = computed(() => {
    let n = 0
    for (const arr of pages.values()) n += arr.length
    return n
  })

  /** 初始化月份分组（首次进入照片墙时由 GridScroller 调用） */
  function initMonths(list: MonthGroup[]): void {
    months.value = list
  }

  /** 取 [start, end) 区间的资产；缺页返回 null（调用方渲染占位并调 ensureRange） */
  function getRange(start: number, end: number): AssetDto[] | null {
    const out: AssetDto[] = []
    for (let p = Math.floor(start / PAGE) * PAGE; p < end; p += PAGE) {
      const arr = pages.get(p)
      if (!arr) return null // 任缺一页 → 整体视为未加载
      const from = Math.max(0, start - p)
      const to = Math.min(arr.length, end - p)
      if (from < to) out.push(...arr.slice(from, to))
    }
    return out
  }

  /** 确保 [start, end) 区间已加载：缺页发起请求（幂等；已加载/加载中/失败重试均处理） */
  function ensureRange(start: number, end: number): void {
    const need: number[] = []
    const now = Date.now()
    for (let p = Math.floor(start / PAGE) * PAGE; p < end; p += PAGE) {
      if (pages.has(p) || pageLoading.has(p)) continue
      // C-20：失败的页在冷却期内跳过（不随每次滚动重发），冷却结束才允许重试
      if (failed.has(p) && now - (failedAt.get(p) ?? 0) < FAILED_RETRY_COOLDOWN_MS) continue
      need.push(p)
    }
    if (need.length === 0) return
    loading.value = true
    for (const p of need) {
      pageLoading.add(p)
      const requestVersion = dataVersion
      const requestId = ++requestSequence
      activeRequests.set(p, requestId)
      fetchAssets({ offset: p, limit: PAGE })
        .then((res) => {
          if (requestVersion !== dataVersion || activeRequests.get(p) !== requestId) return
          pages.set(p, res.items)
          failed.delete(p)
          failedAt.delete(p)
        })
        .catch(() => {
          if (requestVersion === dataVersion && activeRequests.get(p) === requestId) {
            failed.add(p)
            failedAt.set(p, Date.now())
          }
        })
        .finally(() => {
          if (activeRequests.get(p) !== requestId) return
          activeRequests.delete(p)
          pageLoading.delete(p)
          if (pageLoading.size === 0) loading.value = false
        })
    }
  }

  /** 首次加载：拉第 0 页（照片墙顶部 = 最新） */
  async function loadFirstPage(): Promise<void> {
    if (pages.has(0) || pageLoading.has(0)) return
    ensureRange(0, PAGE)
  }

  /** 初始化：拉月份分组（全量骨架数据源，决定滚动条长度）→ 首屏数据。
   * 由 GridScroller onMounted / 数据源切换时调用；幂等（已加载页跳过）。
   * 照片墙与搜索结果共用同一入口（各自 store 实现同一接口）。 */
  async function init(): Promise<void> {
    const requestId = ++monthsRequestSequence
    try {
      const res = await fetchDates()
      if (requestId !== monthsRequestSequence) return
      initMonths(res.items)
    } catch {
      if (requestId !== monthsRequestSequence) return
      // 首次拉取失败时保留已有骨架，避免临时网络错误让缓存视图塌空。
    }
    await loadFirstPage()
  }

  /** 扫描完成后刷新骨架和已缓存页，保留用户当前滚动位置。 */
  async function refresh(): Promise<void> {
    const requestId = ++monthsRequestSequence
    const res = await fetchDates()
    if (requestId !== monthsRequestSequence) return
    const ranges = new Set([...pages.keys(), ...pageLoading, ...activeRequests.keys()])
    if (ranges.size === 0) ranges.add(0)

    dataVersion++
    activeRequests.clear()
    pageLoading.clear()
    failed.clear()
    failedAt.clear()
    pages.clear()
    loading.value = false

    initMonths(res.items)
    const total = res.items.reduce((sum, month) => sum + month.count, 0)
    for (const start of ranges) {
      if (start < total || (start === 0 && total === 0)) ensureRange(start, start + PAGE)
    }
  }


  /** 删除成功后同步本地状态（调用方负责调 API 与清空选中，这里只做缓存一致性）：
   *  ① 已加载页缓存移除被删资产（找不到 → 整体失效，靠下次 init 重拉）
   *  ② 月份分组 count 减 + offset 重算（骨架行数/总高度自动变化）
   *  ③ 受影响页及其后页失效重拉，保证全局位置流对齐 */
  function removeAssets(ids: number[]): void {
    const idSet = new Set(ids)
    if (idSet.size === 0) return
    dataVersion++
    const retryPages = [...activeRequests.keys()]
    for (const p of retryPages) {
      activeRequests.delete(p)
      pageLoading.delete(p)
    }
    loading.value = pageLoading.size > 0

    // ① 月份统计必须在页清理之前：页清理会把被删 id 从 pages 移除，
    //    之后再遍历就永远匹配不到（B1 修复曾先清理后统计，导致月份 count 不更新）
    const ymDelta = new Map<string, number>()
    for (const arr of pages.values()) {
      for (const a of arr) {
        if (idSet.has(a.id)) {
          const ym = a.dateTaken.slice(0, 7)
          ymDelta.set(ym, (ymDelta.get(ym) ?? 0) + 1)
        }
      }
    }

    // ② 找到包含被删资产的最小页起点（最先受影响的页）
    let minPage = Infinity
    for (const [p, arr] of pages) {
      for (const a of arr) {
        if (idSet.has(a.id)) {
          minPage = Math.min(minPage, p)
          break
        }
      }
    }

    // 跨数据源删除：被删资产不在本 store 已加载缓存里（照片在另一个视图删除，
    // 本视图尚未滚到/加载它）。删除使全局位置流前移，本缓存里「删除点之后」的页
    // 与骨架月份 count 都已错位且无法定位删除点 → 整体失效，靠下次 init 重拉。
    if (minPage === Infinity) {
      pages.clear()
      pageLoading.clear()
      failed.clear()
      failedAt.clear()
      loading.value = false
      months.value = []
      return
    }

    if (ymDelta.size > 0) {
      let acc = 0
      months.value = months.value
        .map((m) => ({ ...m, count: m.count - (ymDelta.get(m.ym) ?? 0) }))
        .filter((m) => m.count > 0) // 整月删光 → 移除该月（不再产生空头行）
        .map((m) => ({ ...m, offset: (acc += m.count) - m.count }))
    }

    // ③ 页缓存处理（审查 B1：删除后全局位置流前移，删除点之后的页缓存
    //    内容全部错位——旧实现只移除被删 id，向下滚动会看到"删除前"的旧内容）
    //    - 该页整页丢弃并立即重拉（R-01），该页之后的所有页清空（内容已整体错位），滚动到那里时按需重拉
    // R-01 修复：受影响页必须整页丢弃，不能「filter 后原地保留」。
    // 页内少 k 条但页起点仍按 PAGE 对齐 → 该页之后的位置前移了 k 位却无人持有，
    // 页尾 k 个全局位置永久空白（滚动到底也不补，只能整页刷新）。
    pages.delete(minPage)
    for (const p of [...pages.keys()]) {
      if (p > minPage) pages.delete(p)
    }
    // 受影响页立即重拉（代价一次请求），保证位置流严格对齐
    retryPages.push(minPage)

    for (const p of retryPages) ensureRange(p, p + PAGE)
  }
  return {
    months,
    totalCount,
    pages,
    loading,
    loadedCount,
    initMonths,
    getRange,
    ensureRange,
    removeAssets,
    loadFirstPage,
    init,
    refresh,
  }
})
