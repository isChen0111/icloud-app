<script setup lang="ts">
/**
 * GridScroller —— 虚拟滚动照片墙（核心组件，C 方案：全量骨架 + 区间懒加载）
 *
 * 数据源抽象（搜索照片墙化）：
 *   组件只依赖 GridDataSource 接口（months/totalCount/getRange/ensureRange/init…），
 *   照片墙传 assets store、搜索结果传 search store —— 两个 store 实现同一接口。
 *   数据源切换 = watch(props.dataSource) → 重置骨架 + 滚动归零 + init 重新拉取；
 *   组件实例不销毁（KeepAlive 缓存照片墙滚动位置/虚拟器状态不受搜索影响）。
 *
 * 设计对标 iCloud 网页端的实测结论：
 *   滚动容器 scrollHeight 高达 157 万 px，但 DOM 中常驻只有 ~168 个节点。
 *   它的秘密就是"按行虚拟化"：只渲染视口附近的若干行，其余行用占位高度撑起滚动条。
 *
 * 本实现分层（C 方案重构要点）：
 *   ① 列数控制（顶部滑块 4~12 列；值存 theme store，照片墙与搜索共享）
 *   ② 全量行骨架：总行数/总高度由「月份分组 + 列数」精确预计算，
 *      滚动条 = 全库高度 → 日期跳转后上下双向自由滚动（不再有"单向流"死角）
 *   ③ 区间懒加载：数据源按页缓存全局位置区间；可视行未命中时渲染
 *      占位骨架并自动请求（滚动风暴由 store 幂等/去重兜底）
 *   ④ 图片懒加载（GridItem 内部 IntersectionObserver，进视口才请求）
 *   ⑤ 日期分组定位：头行插在"行首月份跳变处"（跨行切片，组尾行可能混入
 *      相邻月资源 → 头行标签显示真实月份区间，如「2021年4月-3月」）
 *   ⑥ 吸顶日期跨度：视口内首末资产日期（倒序流上新下旧 → 新→旧直出，
 *      如「2021年5月30日 - 5月11日」）
 *
 * 数学关系（重点理解）：
 *   itemWidth   = (容器宽 - (列数-1)*间距) / 列数
 *   rowHeight   = itemWidth + 间距        （方形网格）
 *   总行数      = Σ(1 + ceil(月资产数 / 列数))   ← 精确（月份分组已知）
 *   总高度      = Σ(头行 34 + 资产行行高)         ← 精确 → 滚动条真实覆盖全库
 */
import { computed, onActivated, onDeactivated, onMounted, ref, watch } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useThemeStore } from '../stores/theme'
import { formatDateRange, formatMonthRange } from '../utils/format'
import type { AssetDto, GridDataSource, MonthGroup } from '../types'
import GridItem from './GridItem.vue'
import DateNavPanel from './DateNavPanel.vue'

/** 数据源：照片墙 assets store 或 搜索结果 search store（实现 GridDataSource 接口） */
const props = defineProps<{ dataSource: GridDataSource }>()

const themeStore = useThemeStore()

/** 滚动容器 DOM 引用 */
const scrollEl = ref<HTMLElement | null>(null)
/** 容器当前宽度（ResizeObserver 维护） */
const viewportWidth = ref(0)

/** 列数档位（4~12；值存 theme store，照片墙/搜索共享，持久化） */
const MIN_COLS = 4
const MAX_COLS = 12
const colCount = computed(() => themeStore.thumbnailCols)

/** 网格间距（px） */
const GAP = 8
/** 月份头行高度（px） */
const MONTH_HEADER_H = 34
/** .grid-row 水平 padding（两侧共 24px）；itemWidth 必须扣除，否则 12 列时行宽溢出容器 */
const ROW_PAD = 24

/** 计算格子宽度：容器宽减去行内 padding 与所有间距后均分 */
const itemWidth = computed(() => {
  const w = viewportWidth.value
  if (w <= 0) return 200
  return Math.max(56, Math.floor((w - ROW_PAD - (colCount.value - 1) * GAP) / colCount.value))
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
  month: string // 'YYYY-MM'（行首资产月份；header 为其分组月份）
  label?: string // header 显示文本（真实月份区间，可能跨月）
  start: number // 全局倒序流中的位置起点
  end: number // 全局位置终点（不含）
}

/**
 * 行高函数 —— 【原比例缩略图扩展点】
 * 当前返回固定方形行高；未来做「按原比例显示」时，只需让资产行返回
 *   max(该行资产 height/width) × itemWidth + GAP
 * （assets 列表已带 width/height），骨架/虚拟化/跳转定位全部复用此函数，零改动。
 */
function getRowHeight(row: GridRow): number {
  return row.type === 'header' ? MONTH_HEADER_H : rowHeight.value
}

/**
 * 全量行骨架（C 方案核心）：
 * 基于「月份分组 + 列数」精确生成全量行序列，与已加载数据无关——
 *   行 = 全局倒序流按列数连续切片（跨行切片，与旧实现视觉一致）
 *   头行插在「行首月份跳变处」（该月第一个行首前）
 *   头行标签 = 该组真实月份区间：组尾行可能混入相邻月资源，
 *              因此用 [头行位置, 下一头行位置) 的首末月份生成「4月-3月」式标签
 * 总行数/总高度精确 → 滚动条真实覆盖全库。
 * （搜索态：dataSource.months 为匹配集月份分组，骨架即「搜索结果照片墙」）
 */
const rows = computed<GridRow[]>(() => {
  const cols = colCount.value
  const ms = props.dataSource.months
  const out: GridRow[] = []
  const total = props.dataSource.totalCount
  if (ms.length === 0 || total === 0) return out

  // 位置 pos 的资产所属月份（ms 倒序且 offset 单调递增 → 二分）
  const monthAt = (pos: number): string => {
    let lo = 0
    let hi = ms.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (ms[mid].offset <= pos) lo = mid
      else hi = mid - 1
    }
    return ms[lo].ym
  }

  // ① 头行插入点：行首月份跳变处（第一行必插 = 最新月）
  const headers: { ym: string; pos: number }[] = []
  {
    let cur = ''
    for (let s = 0; s < total; s += cols) {
      const m = monthAt(s)
      if (m !== cur) {
        headers.push({ ym: m, pos: s })
        cur = m
      }
    }
  }

  // ② 组标签：组 = [头行位置, 下一头行位置)；组尾月份 = 区间最后一张的月份
  const labelOf = new Map<string, string>()
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    const tailPos = (i + 1 < headers.length ? headers[i + 1].pos : total) - 1
    const tailYm = tailPos >= h.pos ? monthAt(tailPos) : h.ym
    labelOf.set(h.ym, formatMonthRange(h.ym, tailYm))
  }

  // ③ 行序列：头行（若当前行首是跳变点）+ 资产行
  let hi = 0
  for (let s = 0; s < total; s += cols) {
    const h = headers[hi]
    if (h && h.pos === s) {
      out.push({
        key: `h-${h.ym}`,
        type: 'header',
        month: h.ym,
        label: labelOf.get(h.ym) ?? fmtMonth(h.ym),
        start: s,
        end: s,
      })
      hi++
    }
    out.push({
      key: `r-${s}`,
      type: 'asset',
      month: monthAt(s),
      start: s,
      end: Math.min(s + cols, total),
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
  estimateSize: (index) => getRowHeight(rows.value[index]!),
  overscan: 6, // 视口外多渲染 6 行预热（≈780px），滚动不掉帧也不闪空白
  getItemKey: (index) => rows.value[index]?.key ?? index,
})

/** 取某资产行的数据；未加载返回 null（模板渲染占位骨架） */
function rowAssets(index: number): AssetDto[] | null {
  const r = rows.value[index]
  if (!r || r.type !== 'asset') return null
  return props.dataSource.getRange(r.start, r.end)
}

/**
 * 可视行变化 → 确保其数据已加载（C 方案加载引擎）：
 * 任何滚动/跳转/尺寸变化都会改变虚拟行集合，这里对「可视 + overscan」行
 * 逐个 ensureRange；store 内部幂等 + 并发去重，快速拖动不会产生请求风暴。
 */
watch(
  () =>
    (rowVirtualizer.value?.getVirtualItems() ?? [])
      .map((v) => v.index)
      .join(','),
  () => {
    for (const v of rowVirtualizer.value?.getVirtualItems() ?? []) {
      const r = rows.value[v.index]
      if (r && r.type === 'asset') props.dataSource.ensureRange(r.start, r.end)
    }
  },
  { flush: 'post' },
)

/**
 * 顶部吸顶日期跨度（对标 iCloud GridHeader）：
 * 视口内第一个与最后一个「资产行」的首末资产日期，**倒序流直出（新 → 旧）**，
 * 如「2021年5月30日 - 5月11日」；数据未加载或视口无资产行时退化为月份显示。
 */
/** 吸顶日期兜底：虚拟器 measure 异步瞬间 getVirtualItems 可能短暂为空，
 * 若直接返回 '' 会触发 v-show 隐藏 → 滚动中闪一下。缓存最后一次有效值。 */
const lastRange = ref('')

const viewDateRange = computed(() => {
  const vs = rowVirtualizer.value?.getVirtualItems() ?? []
  if (vs.length === 0) return lastRange.value
  // 过滤 overscan 预热行：只取与滚动窗口 [scrollTop, scrollTop+容器高] 有交集的行。
  // ⚠️ v.start/v.end 是相对滚动内容的绝对坐标，不是相对视口——
  //   旧实现用 v.start < clientHeight 比较，scrollTop 超过一屏后 inView 恒空 → 吸顶消失
  const ch = scrollEl.value?.clientHeight ?? 0
  const st = scrollEl.value?.scrollTop ?? 0
  const inView = ch > 0 ? vs.filter((v) => v.end > st && v.start < st + ch) : vs
  if (inView.length === 0) return lastRange.value
  const first = inView.find((v) => rows.value[v.index]?.type === 'asset')
  const last = [...inView].reverse().find((v) => rows.value[v.index]?.type === 'asset')
  if (!first || !last) return currentMonthLabel.value
  const fRow = rows.value[first.index]
  const lRow = rows.value[last.index]
  if (!fRow || !lRow) return currentMonthLabel.value
  const fAssets = props.dataSource.getRange(fRow.start, fRow.end)
  const lAssets = props.dataSource.getRange(lRow.start, lRow.end)
  const startIso = fAssets?.[0]?.dateTaken
  const endIso = lAssets?.[lAssets.length - 1]?.dateTaken
  if (!startIso || !endIso) return currentMonthLabel.value
  const text = formatDateRange(startIso, endIso)
  lastRange.value = text
  return text
})

/** 顶部吸顶的退化显示：第一个可视行的月份（header 行直接用，asset 行看首资产） */
const currentMonthLabel = computed(() => {
  const vs = rowVirtualizer.value?.getVirtualItems() ?? []
  if (vs.length === 0) return ''
  // 只取与滚动窗口有交集的行（过滤上方 overscan 预热行，避免退化显示偏旧）
  const ch = scrollEl.value?.clientHeight ?? 0
  const st = scrollEl.value?.scrollTop ?? 0
  const inView = ch > 0 ? vs.filter((v) => v.end > st && v.start < st + ch) : vs
  const r = rows.value[inView[0]?.index ?? -1]
  if (!r) return ''
  if (r.type === 'header') return r.label ?? fmtMonth(r.month)
  return fmtMonth(r.month)
})

/** 日期导航面板数据源（照片墙 = 全库月份；搜索 = 匹配集月份） */
const months = computed<MonthGroup[]>(() => props.dataSource.months)
/** 当前可视月份（面板当前月高亮） */
const currentYm = computed(() => {
  const vs = rowVirtualizer.value?.getVirtualItems() ?? []
  if (vs.length === 0) return ''
  // 与 viewDateRange 同口径：过滤 overscan 预热行，面板高亮与视口首行一致
  const ch = scrollEl.value?.clientHeight ?? 0
  const st = scrollEl.value?.scrollTop ?? 0
  const inView = ch > 0 ? vs.filter((v) => v.end > st && v.start < st + ch) : vs
  const r = rows.value[inView[0]?.index ?? -1]
  return r?.month ?? ''
})

/** 日期导航面板开关 */
const dateNavOpen = ref(false)

/** 面板选择月份 → 关闭面板 + 滚动定位（不再重置数据/归零） */
function onNavSelect(offset: number): void {
  dateNavOpen.value = false
  jumpToMonth(offset)
}

/**
 * 跳转到全局 offset（目标月首资产位置）：
 * 滚动条 = 全量骨架 → 直接滚动到「包含 offset 的行」顶部即可，
 * 目标行未加载时可视行 watch 会自动拉取（占位 → 图片）。
 * offset 为列数整数倍时该行正好从目标月头行开始；否则该行行首为上一月
 * 尾行（跨行切片），目标月资产在行尾，吸顶跨度如实显示混行区间。
 */
function jumpToMonth(offset: number): void {
  const el = scrollEl.value
  if (!el) return
  const rowStart = Math.floor(offset / colCount.value) * colCount.value
  let top = 0
  for (const r of rows.value) {
    if (r.type === 'asset' && r.start >= rowStart) break
    top += getRowHeight(r)
  }
  el.scrollTop = top
  requestAnimationFrame(() => rowVirtualizer.value?.measure())
}

/** 列数变化 → 骨架/行高重算 → 重新测量（滚动位置保持） */
watch(colCount, () => rowVirtualizer.value?.measure())

/** 容器宽度监听 */
function observeWidth(): void {
  if (!scrollEl.value) return
  const ro = new ResizeObserver(() => {
    // 忽略 0：KeepAlive 缓存期间组件 DOM 被移出文档，clientWidth 变为 0，
    // 若写入会让 itemWidth 走兜底值 200 → 虚拟器按错误行高测量 → 返回后行错位（重叠/间距异常）
    const w = scrollEl.value?.clientWidth ?? 0
    if (w > 0) viewportWidth.value = w
  })
  ro.observe(scrollEl.value)
  viewportWidth.value = scrollEl.value.clientWidth
}

/** 滚动：持续记录位置（KeepAlive 恢复时写回）；加载由可视行 watch 驱动 */
function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  savedScrollTop = el.scrollTop
}

/** 清空选中：点击空白区域（GridItem 的 click 已 stopPropagation，
 *  这里收到的 click 必然不是缩略图本身） */
function onScrollAreaClick(): void {
  props.dataSource.clearSelection()
}

/**
 * KeepAlive 缓存（App.vue 对 GridView 启用 include）：
 * 恢复 = 缓存激活（返回照片墙）时写回 savedScrollTop，并派发 scroll 事件让
 * @tanstack/vue-virtual 与可视行 watch 重新计算可视窗口与按需加载。
 * 保存 = onScroll 持续记录最后滚动位置，任何时刻离开都有准确值。
 */
let savedScrollTop = 0

/** Esc 清空选中（KeepAlive 下用 activated/deactivated 管理，避免详情页残留监听） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') props.dataSource.clearSelection()
}
onDeactivated(() => window.removeEventListener('keydown', onKeydown))
onActivated(() => {
  window.addEventListener('keydown', onKeydown)
  const el = scrollEl.value
  if (!el) return
  el.scrollTop = savedScrollTop
  // 先等一帧：DOM 重新插入 + ResizeObserver 把真实宽度写回后，
  // measure 用真实 rowHeight 重算 measurements，再派发 scroll 更新可视窗口，
  // 否则会用 deactivate 期间被污染的兜底行高（200px）测量 → 行与行重叠/间距异常
  requestAnimationFrame(() => {
    rowVirtualizer.value?.measure()
    el.dispatchEvent(new Event('scroll'))
  })
})

/**
 * 数据源切换（照片墙 ↔ 搜索）：组件实例不销毁，只换数据 + 重置视图。
 *  - 骨架/吸顶缓存清零，滚动归零（搜索从顶部开始）
 *  - init() 重新拉取骨架 + 首屏；完成后 measure + 派发 scroll 驱动加载
 */
watch(
  () => props.dataSource,
  () => {
    lastRange.value = ''
    savedScrollTop = 0
    dateNavOpen.value = false
    if (scrollEl.value) scrollEl.value.scrollTop = 0
    void props.dataSource.init().then(() => {
      rowVirtualizer.value?.measure()
      scrollEl.value?.dispatchEvent(new Event('scroll'))
    })
  },
)

onMounted(async () => {
  observeWidth()
  // 数据源初始化（照片墙：/api/dates + 首屏；搜索：匹配集骨架 + 首屏）
  await props.dataSource.init()
  // 关键：虚拟器在 setup 时初始化，当时滚动容器还没挂载（getScrollElement 返回 null），
  // 必须在元素就绪 + 数据就绪后手动 measure 一次，虚拟行才会填充
  rowVirtualizer.value.measure()
})
</script>

<template>
  <div class="grid-shell">
    <!-- 顶部控制条：日期导航按钮 + 缩放滑块（对标 iCloud 顶部工具栏） -->
    <div class="toolbar">
      <!-- 日期导航入口（复刻 iCloud 左上角导航按钮） -->
      <button class="date-nav-btn" title="按日期跳转" @click="dateNavOpen = !dateNavOpen">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" stroke-width="1.8" />
          <path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <span>日期</span>
      </button>

      <span class="label">缩略图尺寸</span>
      <input
        :value="colCount"
        @input="themeStore.thumbnailCols = Number(($event.target as HTMLInputElement).value)"
        type="range"
        :min="MIN_COLS"
        :max="MAX_COLS"
        step="1"
        class="slider"
      />
      <span class="label dim">{{ colCount }} 列 · {{ itemWidth }}px</span>
      <span class="spacer" />
      <span class="label dim"
        >items={{ dataSource.loadedCount }} rows={{ rows.length }} virt={{ rowVirtualizer.getVirtualItems().length }}</span
      >
      <span v-if="dataSource.loading" class="label dim">加载中…</span>
    </div>

    <!-- 吸顶日期跨度指示器：随滚动实时更新（对标 iCloud GridHeader 的日期范围） -->
    <div v-show="viewDateRange" class="month-sticky">
      <span class="month-dot" />{{ viewDateRange }}
      <span class="dim" style="margin-left: 8px; font-weight: 400">共 {{ dataSource.totalCount }} 项</span>
    </div>

    <!-- 滚动容器：唯一真正的滚动条载体（高度 = 全量骨架，双向自由滚动） -->
    <div ref="scrollEl" class="grid-scroll" @scroll.passive="onScroll" @click="onScrollAreaClick">
      <!-- 撑高容器：height = 全量总高度（虚拟化的"纸"） -->
      <div
        class="grid-space"
        :style="{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }"
      >
        <!-- 只渲染可视行（月份头行 / 资产行混合；类型信息在 rows[row.index]） -->
        <template v-for="row in rowVirtualizer.getVirtualItems()" :key="row.index">
          <!-- 月份头行（标签 = 真实月份区间，如「2021年4月-3月」） -->
          <div
            v-if="rows[row.index]?.type === 'header'"
            class="month-row"
            :style="{ transform: `translateY(${row.start}px)` }"
          >
            <span class="month-label">{{ rows[row.index]?.label }}</span>
          </div>
          <!-- 资产行：已加载 → GridItem；未加载 → 占位骨架（自动触发加载） -->
          <div
            v-else
            class="grid-row"
            :style="{
              transform: `translateY(${row.start}px)`,

              height: `${rowHeight}px`,
            }"
          >
            <template v-if="rowAssets(row.index)">
              <GridItem
                v-for="asset in rowAssets(row.index)"
                :key="asset.id"
                :asset="asset"
                :width="itemWidth"
                :selected="dataSource.selectedIds.has(asset.id)"
              />
            </template>
            <template v-else>
              <div
                v-for="i in rows[row.index]!.end - rows[row.index]!.start"
                :key="`sk-${i}`"
                class="cell-skeleton"
                :style="{ width: `${itemWidth}px`, height: `${itemWidth}px` }"
              />
            </template>
          </div>
        </template>
      </div>
    </div>

    <!-- 日期导航面板（左年份 + 右月份缩略图；搜索态显示匹配集月份） -->
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

/* 日期导航按钮（工具栏最左侧） */
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

/* 吸顶日期跨度指示器 */
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

/* 未加载行的占位骨架（灰块；数据到达后自动替换为 GridItem） */
.cell-skeleton {
  flex-shrink: 0;
  border-radius: 2px;
  background: var(--bg-field);
}
</style>
