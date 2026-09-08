<script setup lang="ts">
/**
 * GridView —— 照片墙视图（路由 '/'）
 *
 * 两个状态：
 *  ① 默认：挂载 GridScroller（虚拟滚动照片墙，见组件内部）
 *  ② 搜索：顶部搜索框防抖输入 → FTS5 搜索 → 结果以普通网格渲染（复用 GridItem）
 *
 * 设计要点：
 *  - 搜索框常驻顶部，聚焦即进入搜索态；Esc / 清除按钮退出并恢复照片墙。
 *  - 防抖 300ms：避免每个按键都请求后端。
 *  - 结果用 flex-wrap 网格（最多 100 条，DOM 量小无需虚拟化），点击条目走同一详情路由。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

/** 组件名：供 KeepAlive include 匹配（见 App.vue），缓存后返回详情页不重建照片墙 */
defineOptions({ name: 'GridView' })
import { searchAssets } from '../api/client'
import GridScroller from '../components/GridScroller.vue'
import GridItem from '../components/GridItem.vue'
import type { AssetDto } from '../types'

/** 搜索关键词（输入框 v-model） */
const query = ref('')
/** 搜索结果（空数组 = 搜索过但无结果；null = 尚未搜索） */
const results = ref<AssetDto[] | null>(null)
/** 防抖计时器句柄 */
let debounceTimer: number | undefined
/** 搜索请求序号守卫：输入/退出时递增，让在途响应作废（修复审查 P1-F5 竞态） */
let searchSeq = 0
/** 结果区容器引用（计算格子宽度） */
const resultsEl = ref<HTMLElement | null>(null)
/** 结果区宽度（ResizeObserver 维护） */
const resultsWidth = ref(0)

/** 是否处于搜索态：有输入或有结果 */
const searchActive = computed(() => query.value.trim().length > 0 || results.value !== null)

/** 搜索词是否过短（trigram 需要至少 3 字符） */
const tooShort = computed(() => query.value.trim().length > 0 && query.value.trim().length < 3)

/** 搜索无结果 */
const noResult = computed(() => results.value !== null && results.value.length === 0)

/** 结果网格列宽：容器宽均分 5 列（结果最多 100 条，固定 5 列足够） */
const itemWidth = computed(() => {
  const w = resultsWidth.value
  if (w <= 0) return 160
  return Math.max(80, Math.floor((w - 4 * 8) / 5))
})

/** 防抖执行搜索：清空旧结果 → 请求 → 写回（过期响应被 seq 守卫丢弃） */
async function runSearch(q: string): Promise<void> {
  const seq = ++searchSeq
  results.value = null // 先清空：避免旧结果残留误导
  if (q.length < 3) return // 后端也会拦截，这里提前短路
  try {
    const res = await searchAssets(q, 100)
    if (seq !== searchSeq) return // 已被新搜索/退出取代 → 丢弃过期结果
    results.value = res.items
  } catch {
    if (seq !== searchSeq) return
    results.value = []
  }
}

/** 输入监听：防抖 300ms 后执行（对标搜索框"边输边出"体验） */
watch(query, (q) => {
  window.clearTimeout(debounceTimer)
  searchSeq++ // 使一切在途响应作废（含 Esc 退出场景：旧请求晚返回也不能覆写搜索态）
  const t = q.trim()
  if (t.length === 0) {
    results.value = null // 清空输入 → 立即退出搜索态
    return
  }
  debounceTimer = window.setTimeout(() => void runSearch(t), 300)
})

/** 退出搜索：清空输入与结果，恢复照片墙 */
function clearSearch(): void {
  query.value = ''
  results.value = null
}

/** Esc 退出搜索 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && searchActive.value) {
    clearSearch()
    ;(e.target as HTMLInputElement)?.blur?.()
  }
}

/** 结果区宽度监听（复用 GridScroller 的做法） */
function observeResultsWidth(): void {
  if (!resultsEl.value) return
  const ro = new ResizeObserver(() => {
    resultsWidth.value = resultsEl.value?.clientWidth ?? 0
  })
  ro.observe(resultsEl.value)
  resultsWidth.value = resultsEl.value.clientWidth
}

onBeforeUnmount(() => window.clearTimeout(debounceTimer))
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
    </div>

    <!-- 默认态：虚拟滚动照片墙 -->
    <GridScroller v-if="!searchActive" class="scroller" />

    <!-- 搜索态：结果统计 + 普通网格 -->
    <div v-else class="search-results" ref="resultsEl">
      <div class="results-meta">
        <span v-if="tooShort" class="dim">请至少输入 3 个字符</span>
        <span v-else-if="noResult" class="dim">没有找到匹配「{{ query }}」的内容</span>
        <span v-else-if="results" class="dim">搜索「{{ query }}」· 共 {{ results.length }} 项</span>
        <span v-else class="dim">搜索中…</span>
      </div>
      <!-- 结果网格：flex-wrap，复用 GridItem（点击进详情同一套逻辑） -->
      <div v-if="results && results.length" class="results-grid">
        <GridItem v-for="a in results" :key="a.id" :asset="a" :width="itemWidth" />
      </div>
    </div>
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

.scroller { flex: 1; min-height: 0; }

/* 搜索结果区 */
.search-results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 16px 24px;
  scrollbar-width: thin;
  scrollbar-color: var(--text-2) transparent;
}
.results-meta {
  padding: 6px 2px 12px;
  font-size: 12px;
}
.dim { color: var(--text-2); }
.results-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
