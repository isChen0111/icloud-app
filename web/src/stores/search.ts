/**
 * Pinia Store：搜索结果（照片墙化数据源，与 assets store 同构）
 *
 * 设计背景（搜索照片墙化）：
 * 搜索结果 = 按拍摄时间倒序的「匹配资产流」。这与照片墙的「全库倒序流」在
 * 数据结构上完全一致（月份分组 + 全局 offset + 按页拉取），只是数据源不同：
 * 照片墙用 assets store（/api/assets + /api/dates），搜索用本 store（/api/search）。
 * 因此本 store 实现与 assets store 完全相同的接口（GridDataSource），
 * GridScroller 抽象后可直接复用作搜索结果的虚拟滚动照片墙。
 *
 * 与 assets store 的差异：
 *  - 查询词变化 → 旧响应作废（searchSeq 版本守卫）：快速连续输入不会串结果
 *  - total/months 来自搜索 API 的匹配集聚合（首次响应带回并缓存，幂等）
 *  - 搜索态不做删除：selectedIds 恒空、clearSelection 为 noop（GridScroller 接口需要）
 */
import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { searchAssets } from '../api/client'
import type { AssetDto, MonthGroup } from '../types'

/** 缓存页大小（条）。与 assets store 一致：120 一条，页起点 = PAGE 整数倍 */
const PAGE = 120

export const useSearchStore = defineStore('search', () => {
  /** 当前查询词（GridView 搜索框 v-model → setQuery 写入） */
  const query = ref('')
  /** 匹配集月份分组（搜索 API 返回，骨架数据源） */
  const months = ref<MonthGroup[]>([])
  /** 匹配总数（搜索 API 返回 COUNT *；滚动条长度 + 「共 N 项」） */
  const totalCount = ref(0)

  /** 页缓存：key = 匹配流全局起点（PAGE 整数倍），value = 该页资产 */
  const pages = reactive(new Map<number, AssetDto[]>())
  /** 加载中的页起点集合（并发去重） */
  const pageLoading = reactive(new Set<number>())
  /** 是否有任一请求进行中（工具栏「加载中…」提示） */
  const loading = ref(false)
  /** 失败页起点集合（失败后静默，滚动离开再回来重试） */
  const failed = reactive(new Set<number>())

  /** 搜索态不做删除：选中集合恒空（GridDataSource 接口需要） */
  const selectedIds = ref(new Set<number>())
  const selectedCount = computed(() => 0)

  /** 当前已加载资产数（调试信息） */
  const loadedCount = computed(() => {
    let n = 0
    for (const arr of pages.values()) n += arr.length
    return n
  })

  /** 查询词版本守卫：换词后一切在途响应作废（防止串结果） */
  let searchSeq = 0

  /** 设置查询词并重置（GridView 防抖后调用）；不自动发请求，由 init() 驱动 */
  function setQuery(q: string): void {
    searchSeq++
    query.value = q
  }

  /** 初始化（GridScroller onMounted / 数据源切换时调用）：
   * 清空旧结果缓存 → 拉第一页（响应带回 total/months，骨架自动就绪） */
  async function init(): Promise<void> {
    pages.clear()
    pageLoading.clear()
    failed.clear()
    totalCount.value = 0
    months.value = []
    if (query.value.trim().length >= 3) ensureRange(0, PAGE)
  }

  /** 取 [start, end) 区间的匹配资产；缺页返回 null（调用方渲染占位并调 ensureRange） */
  function getRange(start: number, end: number): AssetDto[] | null {
    const out: AssetDto[] = []
    for (let p = Math.floor(start / PAGE) * PAGE; p < end; p += PAGE) {
      const arr = pages.get(p)
      if (!arr) return null
      const from = Math.max(0, start - p)
      const to = Math.min(arr.length, end - p)
      if (from < to) out.push(...arr.slice(from, to))
    }
    return out
  }

  /** 确保 [start, end) 区间已加载：缺页发起搜索请求（幂等 + 加载中去重） */
  function ensureRange(start: number, end: number): void {
    const need: number[] = []
    for (let p = Math.floor(start / PAGE) * PAGE; p < end; p += PAGE) {
      if (!pages.has(p) && !pageLoading.has(p)) need.push(p)
    }
    if (need.length === 0) return
    loading.value = true
    for (const p of need) {
      pageLoading.add(p)
      const seq = searchSeq
      searchAssets(query.value, { offset: p, limit: PAGE })
        .then((res) => {
          if (seq !== searchSeq) return // 查询词已变 → 丢弃过期响应
          pages.set(p, res.items)
          failed.delete(p)
          // 骨架数据（total/months）以最新响应为准，幂等写入
          totalCount.value = res.total
          if (res.months.length > 0) months.value = res.months
        })
        .catch(() => {
          if (seq === searchSeq) failed.add(p)
        })
        .finally(() => {
          pageLoading.delete(p)
          if (pageLoading.size === 0) loading.value = false
        })
    }
  }

  /** 搜索态无删除/选中：noop（GridDataSource 接口需要） */
  function clearSelection(): void {}

  return {
    months,
    totalCount,
    pages,
    loading,
    loadedCount,
    selectedIds,
    selectedCount,
    getRange,
    ensureRange,
    clearSelection,
    setQuery,
    init,
  }
})
