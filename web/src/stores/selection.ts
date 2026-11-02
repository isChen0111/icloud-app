/**
 * Pinia Store：选中集（生命周期 = 当前数据集）
 *
 * 设计背景（审查 C-17，2026-11-03 修订生命周期）：
 * 早期选中集塞在 assets store 里，GridItem 硬编码 useAssetStore，于是搜索结果里点选
 * 写进了照片墙的选中集、却没有视觉反馈，清空搜索后顶栏冒出「已选 N 项」并可能误删
 * 从未主动选的照片。故把选中集抽出来独立持有。
 *
 * ⚠️ 独立出来解决的是「**存放位置**」问题，不是「跨数据集共享」：
 *  ① 虚拟滚动会销毁/重建 DOM，选中必须活在组件之外（滚走再滚回仍要恢复勾选）；
 *  ② 顶栏计数与删除按钮在 GridView、勾选交互在 GridItem，两者隔着 GridScroller；
 *  ③ 删除流程要读 selectedIds。
 * 若退回「每个数据源 store 各存一份」，上述三点照样成立，只是把 40 行选中逻辑复制
 * 两份、并把「切数据集清空」的责任拆到两个地方——漏一处就是 C-17 那类污染。
 *
 * 生命周期：**选中只在当前数据集内有意义**。照片墙 ↔ 搜索结果、以及搜索换词，
 * 墙上的内容整体换了，旧选中要么根本不在视野里（删了都不知道删的是什么）、要么
 * 淹没在成千上万张里（看不到自己选了什么）。因此数据集一变就整批清空，
 * 清空点统一在 GridView 的 datasetKey watch（唯一一处）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useSelectionStore = defineStore('selection', () => {
  /** 选中集合（asset id 集合）。放 store 而非组件：
   *  虚拟滚动销毁/重建 DOM 不影响选中记忆。 */
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

  /** 清空全部选中（点空白 / Esc / 进详情 / 删除成功 / 切换数据集） */
  function clearSelection(): void {
    if (selectedIds.value.size === 0) return
    selectedIds.value = new Set()
  }

  return { selectedIds, selectedCount, selectOnly, toggleSelect, clearSelection }
})
