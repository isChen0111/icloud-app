/**
 * Pinia Store：资产分页缓存
 *
 * 设计目标（对标 iCloud 的"滚动即加载、回头不重拉"）：
 * 1. 分页游标翻页：滚动到底部自动拉下一页
 * 2. 已加载的页用 Map 缓存（id → 资产），重访同一段不重新请求
 * 3. 网格渲染时先查本地缓存，命中则秒出；miss 才发请求
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchAssets } from '../api/client'
import type { AssetDto } from '../types'

export const useAssetStore = defineStore('assets', () => {
  /** 已加载的全部资产（按列表顺序，id 为键做缓存） */
  const items = ref<AssetDto[]>([])
  /** 是否还有下一页 */
  const hasMore = ref(true)
  /** 下一页游标 */
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  /** 是否已完整加载（网格总高度计算用） */
  const exhausted = ref(false)
  /** items[0] 在全局倒序流中的位置（滚动续载时恒为 0；日期跳转后为该月偏移） */
  const baseOffset = ref(0)
  /** 跳转期间被再次点击的目标偏移（连点合并：跳完一个接着跳最新目标） */
  const pendingOffset = ref<number | null>(null)

  /** 首次加载或重置 */
  async function loadFirstPage(): Promise<void> {
    if (items.value.length > 0) return
    await loadMore()
  }

  /** 拉取下一页（幂等：loading 时忽略；游标无缝续载） */
  async function loadMore(): Promise<void> {
    if (loading.value || !hasMore.value) return
    loading.value = true
    try {
      const page = await fetchAssets({ cursor: nextCursor.value })
      items.value.push(...page.items)
      nextCursor.value = page.nextCursor
      hasMore.value = page.nextCursor !== null
      if (!page.nextCursor) exhausted.value = true
    } finally {
      loading.value = false
      // 加载期间用户点了月份定位条 → 补执行跳转（否则 loading 解锁后跳转丢失）
      void drainPendingJump()
    }
  }

  /**
   * 跳到全局 offset 位置（日期快速定位）。
   * 后端保证「该页以目标月第一资产开头」，所以跳转后 items[0] 即目标月首条，
   * 网格把滚动位置归零即可让月份头出现在顶部。
   *
   * 修复（审查 P1-⑤）：旧实现 loading 时直接 return，快速连点两个月只会
   * 跳第一个。现在 loading 期间的新目标记入 pendingOffset，当前跳转完成后
   * 自动续跳，最终 await 返回时已位于最新目标月。
   */
  async function jumpToOffset(offset: number): Promise<void> {
    if (loading.value) {
      pendingOffset.value = offset
      return
    }
    loading.value = true
    try {
      while (true) {
        const page = await fetchAssets({ offset })
        items.value = page.items
        baseOffset.value = offset
        nextCursor.value = page.nextCursor
        hasMore.value = page.nextCursor !== null
        exhausted.value = page.nextCursor === null
        // 跳转期间又被点了月份 → 用最新目标继续跳（连点合并）
        if (pendingOffset.value !== null) {
          offset = pendingOffset.value
          pendingOffset.value = null
          continue
        }
        break
      }
    } finally {
      loading.value = false
    }
  }

  /** 补执行 pending 的跳转（由 loadMore/jumpToOffset 完成时调用） */
  async function drainPendingJump(): Promise<void> {
    const target = pendingOffset.value
    if (target === null) return
    pendingOffset.value = null
    await jumpToOffset(target)
  }

  /** 按 id 查缓存 */
  function getById(id: number): AssetDto | undefined {
    return items.value.find((a) => a.id === id)
  }

  return {
    items,
    hasMore,
    loading,
    exhausted,
    nextCursor,
    baseOffset,
    pendingOffset,
    loadFirstPage,
    loadMore,
    jumpToOffset,
    getById,
  }
})
