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
import { fetchAssets } from '../api/client'
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

  /** 选中集合（客户端删除功能）：asset id 集合。
   * 放 store 而非组件：虚拟滚动销毁/重建 DOM 不影响选中记忆，
   * 滚动走远再回来，GridItem 查 selectedIds.has(id) 恢复选框。 */
  const selectedIds = ref(new Set<number>())
  /** 已选数量（删除按钮可用态 + 顶栏计数） */
  const selectedCount = computed(() => selectedIds.value.size)

  /** 当前已加载资产数（调试信息） */
  const loadedCount = computed(() => {
    let n = 0
    for (const arr of pages.values()) n += arr.length
    return n
  })

  /** 初始化月份分组（首次进入照片墙时由 GridScroller 调用） */
  function initMonths(list: MonthGroup[]): void {
    if (list.length > 0) months.value = list
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
    for (let p = Math.floor(start / PAGE) * PAGE; p < end; p += PAGE) {
      if (!pages.has(p) && !pageLoading.has(p)) need.push(p)
    }
    if (need.length === 0) return
    loading.value = true
    for (const p of need) {
      pageLoading.add(p)
      fetchAssets({ offset: p, limit: PAGE })
        .then((res) => {
          pages.set(p, res.items)
          failed.delete(p)
        })
        .catch(() => failed.add(p))
        .finally(() => {
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


  /** 单选/多选切换（Ctrl+单击追加多选，普通单击切换单选） */
  /** 单选：普通单击 = 只选中这一个（替换当前集合；已是唯一选中则保持） */
  function selectOnly(id: number): void {
    const s = selectedIds.value
    if (s.size === 1 && s.has(id)) return
    selectedIds.value = new Set([id])
  }

  function toggleSelect(id: number): void {
    const s = new Set(selectedIds.value)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    selectedIds.value = s
  }

  /** 清空全部选中（点空白 / Esc / 进详情 / 删除成功） */
  function clearSelection(): void {
    if (selectedIds.value.size === 0) return
    selectedIds.value = new Set()
  }

  /** 删除成功后同步本地状态：
   *  ① 已加载页缓存移除被删资产
   *  ② 月份分组 count 减 + offset 重算（骨架行数/总高度自动变化）
   *  ③ 清空选中
   *  调用方负责调 API；这里只做前端一致性。 */
  function removeAssets(ids: number[]): void {
    const idSet = new Set(ids)
    if (idSet.size === 0) return

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
    if (ymDelta.size > 0) {
      let acc = 0
      months.value = months.value
        .map((m) => ({ ...m, count: m.count - (ymDelta.get(m.ym) ?? 0) }))
        .filter((m) => m.count > 0) // 整月删光 → 移除该月（不再产生空头行）
        .map((m) => ({ ...m, offset: (acc += m.count) - m.count }))
    }

    // ② 页缓存处理（审查 B1：删除后全局位置流前移，删除点之后的页缓存
    //    内容全部错位——旧实现只移除被删 id，向下滚动会看到"删除前"的旧内容）
    //    - 找到包含被删资产的最小页起点（最先受影响的页）
    //    - 该页 filter 移除被删 id（页内索引 slice 恰好对上，无需重拉）
    //    - 该页之后的所有页清空（内容已整体错位），滚动到那里时按需重拉
    let minPage = Infinity
    for (const [p, arr] of pages) {
      for (const a of arr) {
        if (idSet.has(a.id)) {
          minPage = Math.min(minPage, p)
          break
        }
      }
    }
    if (minPage !== Infinity) {
      const affected = pages.get(minPage)
      if (affected) {
        const next = affected.filter((a) => !idSet.has(a.id))
        pages.set(minPage, next)
      }
      for (const p of [...pages.keys()]) {
        if (p > minPage) pages.delete(p)
      }
    }

    // ③ 清空选中
    clearSelection()
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
    selectedIds,
    selectedCount,
    selectOnly,
    toggleSelect,
    clearSelection,
    removeAssets,
    loadFirstPage,
  }
})
