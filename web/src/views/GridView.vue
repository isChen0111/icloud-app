<script setup lang="ts">
/**
 * GridView —— 照片墙视图（路由 '/'）
 *
 * 两个状态（数据源切换，组件不销毁）：
 *  ① 默认：GridScroller + assets store（全库虚拟滚动照片墙）
 *  ② 搜索：GridScroller + search store（搜索结果照片墙：匹配集虚拟滚动 +
 *     月份分组 + 吸顶日期，与照片墙同一套渲染模型，见 search store 注释）
 *
 * 设计要点：
 *  - 搜索框常驻顶部，聚焦即进入搜索态；Esc / 清除按钮退出并恢复照片墙。
 *  - 防抖 300ms：避免每个按键都请求后端。
 *  - 搜索结果不再固定 100 条截断：后端分页（offset）+ total，搜索 store
 *    按页拉取全量匹配流，虚拟滚动浏览（搜「2025」几千条也流畅）。
 *  - 删除仅照片墙态（搜索态无删除，search store 选中集恒空）。
 */
import { computed, ref, watch } from 'vue'
import { deleteAssets } from '../api/client'
import { useAssetStore } from '../stores/assets'
import { useSearchStore } from '../stores/search'
import DeleteConfirm from '../components/DeleteConfirm.vue'
import GridScroller from '../components/GridScroller.vue'

/** 组件名：供 KeepAlive include 匹配（见 App.vue），缓存后返回详情页不重建照片墙 */
defineOptions({ name: 'GridView' })

const assetStore = useAssetStore()
const searchStore = useSearchStore()

/** 搜索关键词（输入框 v-model） */
const query = ref('')
/** 是否已执行过搜索（区分「未搜索」与「搜索无结果」，避免初始态误报无结果） */
const hasSearched = ref(false)
/** 删除确认弹框 + 删除请求进行中 */
const confirmDeleteOpen = ref(false)
const deleting = ref(false)
const emit = defineEmits<{ deleted: [] }>()
/** 防抖计时器句柄 */
let debounceTimer: number | undefined

/** 是否处于搜索态：有输入或有搜索结果（输入即切换视图） */
const searchActive = computed(() => query.value.trim().length > 0 || hasSearched.value)

/** 搜索词是否过短（trigram 需要至少 3 字符） */
const tooShort = computed(() => query.value.trim().length > 0 && query.value.trim().length < 3)

/** 输入监听：防抖 300ms 后执行（对标搜索框"边输边出"体验） */
watch(query, (q) => {
  window.clearTimeout(debounceTimer)
  const t = q.trim()
  if (t.length === 0) {
    // 清空输入 → 立即退出搜索态（数据源切回照片墙，search store 保留待下次）
    hasSearched.value = false
    searchStore.setQuery('')
    return
  }
  debounceTimer = window.setTimeout(() => {
    hasSearched.value = true
    searchStore.setQuery(t)
    void searchStore.init() // 重置缓存 + 拉第一页（响应带回 total/months）
  }, 300)
})

/** 删除确认 → API → store 同步 → 通知 App 刷新顶栏统计 */
async function onConfirmDelete(): Promise<void> {
  const ids = [...assetStore.selectedIds]
  if (ids.length === 0) return
  deleting.value = true
  try {
    await deleteAssets(ids)
    assetStore.removeAssets(ids)
    confirmDeleteOpen.value = false
    emit('deleted')
  } catch {
    alert('删除失败，请检查后端服务')
  } finally {
    deleting.value = false
  }
}

/** 清除搜索并退出（Esc / ✕ 按钮） */
function clearSearch(): void {
  window.clearTimeout(debounceTimer)
  query.value = ''
  hasSearched.value = false
  searchStore.setQuery('')
}

/** Esc 退出搜索 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && searchActive.value) {
    clearSearch()
    ;(e.target as HTMLInputElement)?.blur?.()
  }
}
</script>

<template>
  <div class="grid-view" @keydown="onKeydown">
    <!-- 顶部搜索条（常驻） -->
    <div class="search-bar">
      <span class="search-icon">⌕</span>
      <input
        v-model="query"
        class="search-input"
        type="text"
        placeholder="搜索文件名或日期，如 IMG_9188、2024-09"
        spellcheck="false"
      />
      <button v-if="searchActive" class="search-clear" title="清除并退出搜索" @click="clearSearch">✕</button>
      <!-- 删除按钮（仅照片墙态显示）：无选中灰禁，选中亮蓝；位置=搜索栏一行 -->
      <span v-if="!searchActive && assetStore.selectedCount > 0" class="sel-count">已选 {{ assetStore.selectedCount }} 项</span>
      <button
        v-if="!searchActive"
        class="del-btn"
        :disabled="assetStore.selectedCount === 0 || deleting"
        :title="assetStore.selectedCount > 0 ? `删除选中的 ${assetStore.selectedCount} 个项目` : '未选中项目'"
        @click="confirmDeleteOpen = true"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <!-- 搜索态提示条：搜索中 / 无结果 / 结果计数（照片墙态隐藏） -->
    <div v-if="searchActive" class="search-meta">
      <span v-if="tooShort" class="dim">请至少输入 3 个字符</span>
      <span v-else-if="!hasSearched || searchStore.loading" class="dim">搜索中…</span>
      <span v-else-if="searchStore.totalCount === 0" class="dim">没有找到匹配「{{ query }}」的内容</span>
      <span v-else class="dim">搜索「{{ query }}」· 共 {{ searchStore.totalCount }} 项</span>
    </div>

    <!-- 照片墙 / 搜索结果：同一 GridScroller，数据源切换（组件不销毁，照片墙状态保留） -->
    <GridScroller :data-source="searchActive ? searchStore : assetStore" class="scroller" />

    <!-- 删除确认弹框（照片墙多选删除） -->
    <DeleteConfirm
      v-if="confirmDeleteOpen"
      :count="assetStore.selectedCount"
      :deleting="deleting"
      @confirm="onConfirmDelete"
      @cancel="confirmDeleteOpen = false"
    />
  </div>
</template>

<style scoped>
.grid-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 搜索条 */
.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}
.search-icon {
  color: var(--text-2);
  font-size: 15px;
}
.search-input {
  flex: 1;
  max-width: 420px;
  background: var(--bg-field);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 7px 12px;
  color: var(--text-1);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}
.search-input::placeholder { color: var(--text-3); }
.search-input:focus {
  background: var(--bg-field-hover);
  border-color: rgba(10, 132, 255, 0.6);
}
.search-clear {
  border: none;
  background: var(--bg-hover);
  color: var(--text-1);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}
.search-clear:hover { background: var(--bg-hover-strong); }

/* 搜索态提示条（吸顶日期上方，轻量信息） */
.search-meta {
  flex-shrink: 0;
  padding: 6px 16px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.dim { color: var(--text-2); }

.scroller { flex: 1; min-height: 0; }

/* 删除按钮（搜索栏行右侧）：无选中灰禁，选中后图标+底亮蓝（iCloud 风格） */
.del-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, transform 0.15s;
  margin-left: auto;
}
.del-btn:hover:not(:disabled) { background: var(--bg-field-hover); }
.del-btn:not(:disabled) { color: #0a84ff; background: rgba(10, 132, 255, 0.12); }
.del-btn:disabled { opacity: 0.35; cursor: default; }
.sel-count {
  font-size: 12px;
  font-weight: 600;
  color: #0a84ff;
  margin-left: auto;
  white-space: nowrap;
}
</style>
