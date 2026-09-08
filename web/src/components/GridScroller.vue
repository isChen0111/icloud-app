<script setup lang="ts">
/**
 * GridScroller —— 虚拟滚动照片墙（核心组件）
 *
 * 设计对标 iCloud 网页端的实测结论：
 *   滚动容器 scrollHeight 高达 157 万 px，但 DOM 中常驻只有 ~168 个节点。
 *   它的秘密就是"按行虚拟化"：只渲染视口附近的若干行，其余行用占位高度撑起滚动条。
 *
 * 本实现分层：
 *   ① 列数控制（顶部滑块 3~9 列，对标 iCloud 的 ToolbarSlider）
 *   ② 行虚拟化（@tanstack/vue-virtual：count=总行数，estimateSize=按行类型返回高度）
 *   ③ 数据分页（Pinia store 游标翻页，滚近底部自动拉下一页）
 *   ④ 图片懒加载（GridItem 内部 IntersectionObserver，进视口才请求）
 *   ⑤ 日期分组定位（P1）：
 *      - 行模型 = 「月份头行 + 资产行」混合，月份变化时插一行头
 *      - 顶部吸顶月份指示器（随滚动实时更新，对标 iCloud GridHeader）
 *      - 日期导航（方案 C）：工具栏「日期」按钮 → 弹出 DateNavPanel
 *        （左侧年份 + 右侧月份缩略图，点月份 → offset 跳页加载 → 归零滚动即到该月）
 *
 * 数学关系（重点理解）：
 *   itemWidth   = (容器宽 - (列数-1)*间距) / 列数
 *   rowHeight   = itemWidth + 间距        （方形网格）
 *   totalRows   = ceil(总资产数 / 列数)
 *   scrollHeight ≈ totalRows * rowHeight  （这就是浏览器滚动条的长度）
 */
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useAssetStore } from '../stores/assets'
import { fetchDates } from '../api/client'
import type { MonthGroup } from '../types'
import GridItem from './GridItem.vue'
import DateNavPanel from './DateNavPanel.vue'

const store = useAssetStore()

/** 滚动容器 DOM 引用 */
const scrollEl = ref<HTMLElement | null>(null)
/** 容器当前宽度（ResizeObserver 维护） */
const viewportWidth = ref(0)

/** 列数档位（3~9，对标 iCloud 实测的 columnCountMin=3 / Max=9 / 默认8） */
const colCount = ref(8)
const MIN_COLS = 3
const MAX_COLS = 9

/** 网格间距（px） */
const GAP = 8
/** 月份头行高度（px） */
const MONTH_HEADER_H = 34

/** 计算格子宽度：容器宽减去所有间距后均分 */
const itemWidth = computed(() => {
  const w = viewportWidth.value
  if (w <= 0) return 200
  return Math.max(80, Math.floor((w - (colCount.value - 1) * GAP) / colCount.value))
})

/** 行高 = 格子宽 + 间距（方形缩略图） */
const rowHeight = computed(() => itemWidth.value + GAP)

/** '2018-05' → '2018年5月'（月份头/吸顶指示器共用） */
function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-')
  return `${Number(y)}年${Number(m)}月`
}

/** 虚拟滚动行模型：月份头行 或 资产行 */
interface GridRow {
  key: string
  type: 'header' | 'asset'
  month: string // 'YYYY-MM'
  label?: string // header 显示文本
  start: number // asset: items 切片起点
  end: number // asset: items 切片终点（不含）
}

/**
 * 从已加载资产生成行数组：按列数切行；资产月份与上一行不同时，先插一行月份头。
 * 注意：这是全量 items 的线性重算（每页加载后只跑一次，非每帧），11009 条约 2000 行，
 * 一次 map 仅毫秒级，可接受。
 */
const rows = computed<GridRow[]>(() => {
  const out: GridRow[] = []
  const cols = colCount.value
  const items = store.items
  let curMonth = ''
  for (let i = 0; i < items.length; i += cols) {
    const m = items[i].dateTaken.slice(0, 7)
    if (m !== curMonth) {
      out.push({ key: `h-${m}`, type: 'header', month: m, label: fmtMonth(m), start: i, end: i })
      curMonth = m
    }
    out.push({
      key: `r-${i}`,
      type: 'asset',
      month: m,
      start: i,
      end: Math.min(i + cols, items.length),
    })
  }
  return out
})

/** 行虚拟器：只实例化视口附近的行
 * 注意（坑，踩过）：
 *  - useVirtualizer 返回的是 ref（shallowRef 包装），script 中必须 .value 访问，模板自动解包
 *  - count 必须用 getter（`get count()`）：对象展开时求值为数字；
 *    若直接传 ref 或函数，core 里 `0 < count` 恒 false → 虚拟项恒为空（virt=0）
 */
const rowVirtualizer = useVirtualizer({
  get count() {
    return rows.value.length
  },
  getScrollElement: () => scrollEl.value,
  // 按行类型返回高度：月份头行矮、资产行高 → 滚动条长度精确
  estimateSize: (index) => (rows.value[index]?.type === 'header' ? MONTH_HEADER_H : rowHeight.value),
  overscan: 6, // 视口外多渲染 6 行预热，滚动不掉帧
  getItemKey: (index) => rows.value[index]?.key ?? index,
})

/** 顶部吸顶月份：取第一个可视行的月份（header 行直接用，asset 行看首资产） */
const currentMonthLabel = computed(() => {
  const vs = rowVirtualizer.value?.getVirtualItems() ?? []
  if (vs.length === 0) return ''
  const r = rows.value[vs[0].index]
  if (!r) return ''
  if (r.type === 'header') return r.label ?? ''
  return fmtMonth(r.month)
})

/** 日期导航面板数据（一次拉全，~100 个月份） */
const months = ref<MonthGroup[]>([])
/** 当前可视月份（面板当前月高亮） */
const currentYm = computed(() => {
  const vs = rowVirtualizer.value?.getVirtualItems() ?? []
  if (vs.length === 0) return ''
  return rows.value[vs[0].index]?.month ?? ''
})

/** 方案 C：日期导航面板开关 */
const dateNavOpen = ref(false)

/** 面板选择月份 → 关闭面板 + offset 跳页 */
function onNavSelect(offset: number): void {
  dateNavOpen.value = false
  void jumpToMonth(offset)
}

/** 点月份 → offset 跳页加载 → 滚动归零（后端保证该页以目标月开头） */
async function jumpToMonth(offset: number): Promise<void> {
  if (offset === store.baseOffset) return // 已在目标位置
  await store.jumpToOffset(offset)
  if (scrollEl.value) scrollEl.value.scrollTop = 0
  requestAnimationFrame(() => {
    rowVirtualizer.value?.measure()
    // 目标月资产很少（不足一屏）时滚动条不存在 → onScroll 永不触发 → 卡死。
    // 跳转后主动检查并自动补载下一页，直到撑满视口或加载到底。
    autoFillIfNeeded()
  })
}

/**
 * 内容不足一屏时自动续载（修复审查 P1-③ 死区）：
 * 跳到资产稀疏的月份后，网格高度 < 视口高度 → 没有滚动条 → loadMore 永不触发，
 * 用户会被卡在这几行里看不到后续内容。本函数在 items 变化/跳转后检查，
 * 未撑满视口（含 800px 预取余量）就继续加载，直到填满或 exhausted。
 */
function autoFillIfNeeded(): void {
  const el = scrollEl.value
  if (!el) return
  if (store.loading || !store.hasMore) return
  if (el.scrollHeight <= el.clientHeight + 800) {
    void store.loadMore().then(() => {
      requestAnimationFrame(() => {
        rowVirtualizer.value?.measure()
        autoFillIfNeeded() // 一页仍不够 → 递归补载
      })
    })
  }
}

/** 列数变化 → 行高/行数变化 → 让虚拟器重新测量 */
watch(colCount, () => rowVirtualizer.value?.measure())

/** 容器宽度监听 */
function observeWidth(): void {
  if (!scrollEl.value) return
  const ro = new ResizeObserver(() => {
    viewportWidth.value = scrollEl.value?.clientWidth ?? 0
  })
  ro.observe(scrollEl.value)
  viewportWidth.value = scrollEl.value.clientWidth
}

/** 滚近底部 800px 内 → 预取下一页（幂等，loading 自动忽略） */
function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  savedScrollTop = el.scrollTop // 持续记录：KeepAlive 恢复时写回
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 800) {
    void store.loadMore()
  }
}

/**
 * KeepAlive 缓存（App.vue 对 GridView 启用 include）：
 * 恢复 = 缓存激活（返回照片墙）时写回 savedScrollTop，并派发 scroll 事件让
 * @tanstack/vue-virtual 与 onScroll 重新计算可视窗口与续载。
 * 保存 = 不做"离开瞬间"捕获（实测路由切换时 DOM 已移出文档，读不到真值），
 * 改为 onScroll 持续记录最后滚动位置（见 onScroll），任何时刻离开都有准确值。
 */
let savedScrollTop = 0
onActivated(() => {
  const el = scrollEl.value
  if (!el) return
  el.scrollTop = savedScrollTop
  el.dispatchEvent(new Event('scroll'))
  rowVirtualizer.value?.measure()
})

onMounted(async () => {
  observeWidth()
  await store.loadFirstPage()
  // 关键：虚拟器在 setup 时初始化，当时滚动容器还没挂载（getScrollElement 返回 null），
  // 必须在元素就绪 + 数据就绪后手动 measure 一次，虚拟行才会填充
  rowVirtualizer.value.measure()
  // 拉取月份列表（失败静默，导航面板无数据即打不开）
  try {
    const res = await fetchDates()
    months.value = res.items
  } catch {
    months.value = []
  }
})

// 翻页/跳转后行数变化 → 重新测量（让新行立即进入可滚范围）；
// 顺带检查是否需要自动补载（稀疏月死区修复）
watch(
  () => store.items.length,
  () =>
    requestAnimationFrame(() => {
      rowVirtualizer.value?.measure()
      autoFillIfNeeded()
    }),
)
</script>

<template>
  <div class="grid-shell">
    <!-- 顶部控制条：日期导航按钮 + 缩放滑块（对标 iCloud 顶部工具栏） -->
    <div class="toolbar">
      <!-- 方案 C：日期导航入口（复刻 iCloud 左上角导航按钮） -->
      <button class="date-nav-btn" title="按日期跳转" @click="dateNavOpen = !dateNavOpen">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" stroke-width="1.8" />
          <path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <span>日期</span>
      </button>

      <span class="label">缩略图尺寸</span>
      <input
        v-model.number="colCount"
        type="range"
        :min="MIN_COLS"
        :max="MAX_COLS"
        step="1"
        class="slider"
      />
      <span class="label dim">{{ colCount }} 列 · {{ itemWidth }}px</span>
      <span class="spacer" />
      <span class="label dim">items={{ store.items.length }} rows={{ rows.length }} virt={{ rowVirtualizer.getVirtualItems().length }}</span>
      <span v-if="store.loading" class="label dim">加载中…</span>
    </div>

    <!-- 吸顶月份指示器：随滚动实时更新（对标 iCloud GridHeader） -->
    <div v-if="currentMonthLabel" class="month-sticky">
      <span class="month-dot" />{{ currentMonthLabel }}
      <span class="dim" style="margin-left: 8px; font-weight: 400">共 {{ store.items.length }} 项</span>
    </div>

    <!-- 滚动容器：唯一真正的滚动条载体 -->
    <div ref="scrollEl" class="grid-scroll" @scroll.passive="onScroll">
      <!-- 撑高容器：height = 总行数 × 行高（虚拟化的"纸"） -->
      <div
        class="grid-space"
        :style="{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }"
      >
        <!-- 只渲染可视行（月份头行 / 资产行混合；类型信息在 rows[row.index]） -->
        <template v-for="row in rowVirtualizer.getVirtualItems()" :key="row.key">
          <!-- 月份头行 -->
          <div
            v-if="rows[row.index]?.type === 'header'"
            class="month-row"
            :style="{ transform: `translateY(${row.start}px)` }"
          >
            <span class="month-label">{{ rows[row.index]?.label }}</span>
          </div>
          <!-- 资产行 -->
          <div
            v-else
            class="grid-row"
            :style="{
              transform: `translateY(${row.start}px)`,

              height: `${rowHeight}px`,
            }"
          >
            <GridItem
              v-for="asset in store.items.slice(rows[row.index]!.start, rows[row.index]!.end)"
              :key="asset.id"
              :asset="asset"
              :width="itemWidth"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- 方案 C：日期导航面板（左年份 + 右月份缩略图） -->
    <DateNavPanel
      v-if="dateNavOpen"
      :months="months"
      :current-ym="currentYm"
      @select="onNavSelect"
      @close="dateNavOpen = false"
    />
  </div>
</template>

<style scoped>
.grid-shell {
  position: relative; /* 面板/定位条的定位上下文 */
  display: flex;
  flex-direction: column;
  height: 100%;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}
.label { font-size: 12px; color: var(--text-1); }
.dim { color: var(--text-2); }
.spacer { flex: 1; }
.slider { width: 180px; accent-color: #0a84ff; }

/* 方案 C：日期导航按钮（工具栏最左侧） */
.date-nav-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: var(--bg-field);
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
.date-nav-btn:hover { background: var(--bg-field-hover); }

/* 吸顶月份指示器 */
.month-sticky {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 16px;
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  background: var(--bg-float);
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(8px);
  z-index: 3;
}
.month-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #0a84ff;
}

.grid-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--text-2) transparent;
}

/* 月份头行：随行滚动（不吸顶，吸顶的是顶部指示器） */
.month-row {
  position: absolute;
  left: 0;
  top: 0;
  height: 34px;
  display: flex;
  align-items: flex-end;
  padding: 0 16px 5px;
  will-change: transform;
}
.month-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.grid-row {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  gap: 8px;
  padding: 0 12px;
  will-change: transform;
}
</style>
