<script setup lang="ts">
/**
 * DateNavPanel —— 日期导航面板（方案 C，复刻 iCloud 截图布局）
 *
 * 结构对标 iCloud 网页端实测截图：
 *   ┌────────────┬──────────────────────────┐
 *   │  2015      │  2016                    │  ← 选中年份标题
 *   │  2016 ▸    │  ┌──────┐  3月 · 45 项   │
 *   │  2018      │  │ 缩略图 │               │
 *   │  ...       │  └──────┘                │
 *   │  2026      │  ...                     │
 *   └────────────┴──────────────────────────┘
 *   左栏：年份列表（有照片的年份，缺失年份自然空置）
 *   右栏：选中年份的月份缩略图（大图 + 月份名 + 数量）
 *
 * 交互：
 *   - 打开时默认选中当前可视年份
 *   - 点左栏年份 → 右栏切换为该年月份
 *   - 点月份 → emit select(offset)（父组件跳转并关闭面板）
 *   - 关闭：右上 × / 点遮罩 / Esc
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { thumbUrl } from '../api/client'
import type { MonthGroup } from '../types'

/** 面板数据源：月份分组（含每月代表缩略图 thumbId） */
const props = defineProps<{
  months: MonthGroup[]
  /** 当前可视月份（用于默认选中年份 + 当前月高亮） */
  currentYm: string
}>()

/** 月份选中 → 父组件跳转 */
const emit = defineEmits<{
  select: [offset: number]
  close: []
}>()

/** 年份聚合：months 为倒序，每年第一项（最新月）的代表图即年份代表图。
 *  仅用于展示年份是否可点；**按 iCloud 惯例升序排列**（2015 在上 → 2026 在下）。 */
const years = computed(() => {
  const out: string[] = []
  for (const m of props.months) {
    const y = m.ym.slice(0, 4)
    if (out[out.length - 1] !== y) out.push(y)
  }
  return out.reverse()
})

/** 当前展开的年份（默认 = 当前可视年份；无可视年份则取最新年份） */
const viewYear = ref(
  props.currentYm.slice(0, 4) ||
    years.value[0] ||
    '',
)

/** 当前可视年份变化时跟随（浏览到哪年，面板打开就显示哪年） */
watch(
  () => props.currentYm,
  (ym) => {
    if (ym) viewYear.value = ym.slice(0, 4)
  },
)

/** 右栏：选中年份的月份列表（有照片的月份；**升序** = 1月在上，对标 iCloud） */
const yearMonths = computed(() =>
  props.months
    .filter((m) => m.ym.startsWith(viewYear.value))
    .sort((a, b) => (a.ym < b.ym ? -1 : 1)),
)

/** 当前可视月份（高亮用） */
const currentYm = computed(() => props.currentYm)

/** Esc 关闭 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- 全屏遮罩：点空白处关闭（@click.self 只命中遮罩本身，不命中面板） -->
  <div class="dn-overlay" @click.self="emit('close')">
    <div class="dn-panel" role="dialog" aria-label="日期导航">
      <!-- 面板头 -->
      <header class="dn-header">
        <span class="dn-title">日期导航</span>
        <button class="dn-close" title="关闭" @click="emit('close')">×</button>
      </header>

      <div class="dn-body">
        <!-- 左栏：年份列表 -->
        <nav class="dn-years">
          <button
            v-for="y in years"
            :key="y"
            class="dn-year"
            :class="{ active: y === viewYear }"
            @click="viewYear = y"
          >
            {{ y }}
          </button>
        </nav>

        <!-- 右栏：选中年份的月份缩略图 -->
        <div class="dn-months">
          <!-- 年份标题（对标截图右侧大标题） -->
          <h3 class="dn-year-title">{{ viewYear }}</h3>

          <div class="dn-month-grid">
            <button
              v-for="m in yearMonths"
              :key="m.ym"
              class="dn-month"
              :class="{ active: m.ym === currentYm }"
              :title="`${m.label} · ${m.count} 项`"
              @click="emit('select', m.offset)"
            >
              <img
                v-if="m.thumbId"
                :src="thumbUrl(m.thumbId, 'grid')"
                alt=""
                loading="lazy"
                decoding="async"
                class="dn-month-img"
              />
              <span class="dn-month-meta">
                <span class="dn-month-name">{{ Number(m.ym.slice(5)) }}月</span>
                <span class="dn-month-count">{{ m.count }} 项</span>
              </span>
            </button>

            <!-- 该年无照片（理论不发生，防御性空态） -->
            <div v-if="yearMonths.length === 0" class="dn-empty">该年暂无照片</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩：全屏半透明 + 模糊，覆盖在照片墙之上 */
.dn-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(6px);
}

/* 面板本体：深色卡片，尺寸自适应 */
.dn-panel {
  display: flex;
  flex-direction: column;
  width: min(880px, 92vw);
  height: min(640px, 82vh);
  background: #1c1c1f;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
}

/* 面板头 */
.dn-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.dn-title {
  font-size: 15px;
  font-weight: 600;
  color: #f5f5f7;
}
.dn-close {
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: #f5f5f7;
  font-size: 18px;
  line-height: 1;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}
.dn-close:hover { background: rgba(255, 255, 255, 0.18); }

/* 主体：左右两栏 */
.dn-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 左栏：年份列表 */
.dn-years {
  width: 108px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}
.dn-year {
  border: none;
  background: transparent;
  color: rgba(245, 245, 247, 0.6);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, color 0.15s;
}
.dn-year:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #f5f5f7;
}
.dn-year.active {
  background: rgba(10, 132, 255, 0.22);
  color: #fff;
}

/* 右栏：月份缩略图 */
.dn-months {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 14px 18px 20px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}
.dn-year-title {
  margin: 0 0 12px;
  font-size: 22px;
  font-weight: 700;
  color: #f5f5f7;
}

/* 月份网格：自适应换行，不写死列数 */
.dn-month-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
}
.dn-month {
  border: none;
  background: transparent;
  padding: 0;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
  transition: transform 0.15s, box-shadow 0.15s;
}
.dn-month:hover {
  transform: scale(1.04);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.55);
}
.dn-month.active {
  box-shadow: 0 0 0 2px #0a84ff;
}
.dn-month-img {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
}
.dn-month-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 7px 9px;
  background: rgba(255, 255, 255, 0.04);
}
.dn-month-name {
  font-size: 13px;
  font-weight: 600;
  color: #f5f5f7;
}
.dn-month-count {
  font-size: 11px;
  color: rgba(245, 245, 247, 0.5);
}
.dn-empty {
  padding: 24px;
  color: rgba(245, 245, 247, 0.4);
  font-size: 13px;
  grid-column: 1 / -1;
  text-align: center;
}
</style>
