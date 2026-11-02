/**
 * Pinia Store：全局选中集（跨数据源共享）
 *
 * 设计背景（审查 C-17）：
 * 选中记录的是 asset.id，是「照片实体」的属性，与「照片墙 / 搜索结果」哪个视图无关。
 * 早期把它塞进 assets store（照片墙），GridItem 硬编码 useAssetStore，导致搜索结果里
 * 点选写进了照片墙的选中集、却没有视觉反馈，清空搜索后顶栏冒出「已选 N 项」并可能
 * 误删从未主动选的照片。
 *
 * 因此选中集独立成全局单例：照片墙与搜索（以及任何未来视图）都读写同一份 selectedIds，
 * 搜索态同样支持多选与批量删除；切换数据源时选中自然保留（按 id 恢复高亮）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useSelectionStore = defineStore('selection', () => {
  /** 选中集合（asset id 集合）。放全局 store 而非组件：
   *  虚拟滚动销毁/重建 DOM 不影响选中记忆，切换数据源也不丢失。 */
  const selectedIds = ref(new Set<number>())
  /** 已选数量（删除按钮可用态 + 顶栏计数） */
  const selectedCount = computed(() => selectedIds.value.size)

  /** 单选：普通单击 = 只选中这一个（替换当前集合；已是唯一选中则保持） */
  function selectOnly(id: number): void {
    const s = selectedIds.value
    if (s.size === 1 && s.has(id)) return
    selectedIds.value = new Set([id])
  }

  /** 追加/取消多选（Ctrl/⌘+单击） */
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

  return { selectedIds, selectedCount, selectOnly, toggleSelect, clearSelection }
})
