<script setup lang="ts">
/**
 * 根组件
 *
 * 结构对标 iCloud 网页端：
 * - 顶部细标题栏（当前显示照片统计 + 主题切换按钮）
 * - 主体 = 路由出口（网格 / 详情）
 * - 启动时拉一次统计并自动开始首页加载
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchStats } from './api/client'
import { useAssetStore } from './stores/assets'
import { useThemeStore } from './stores/theme'
import type { Stats } from './types'
import { useRoute } from 'vue-router'

const stats = ref<Stats | null>(null)
const route = useRoute()
const assetStore = useAssetStore()

const backendReady = ref(false)
const statusDetailsOpen = ref(false)
const statusRoot = ref<HTMLElement | null>(null)
const numberFormat = new Intl.NumberFormat('zh-CN')
const photoCount = computed(() => (stats.value ? stats.value.photos + stats.value.livePhotos : 0))
const videoCount = computed(() => stats.value?.videos ?? 0)

const statusSummary = computed(() => {
  if (!stats.value) return backendReady.value ? '资源状态暂不可用' : '正在连接照片库…'

  const { scan, thumbnails } = stats.value
  if (scan.status === 'idle') return '等待照片库检查'
  if (scan.status === 'scanning') {
    return `正在扫描 · 已检查 ${numberFormat.format(scan.scannedFiles)} 个文件`
  }
  if (scan.status === 'error') return '照片库扫描失败'
  if (scan.status === 'done' && thumbnails.status === 'preparing') {
    const percent = thumbnails.total > 0
      ? Math.floor((thumbnails.processed / thumbnails.total) * 100)
      : 100
    return `正在准备预览图 · ${percent}%`
  }
  if (scan.status === 'done' && thumbnails.status === 'done' && thumbnails.failed > 0) {
    return `预览图处理完成 · 失败 ${numberFormat.format(thumbnails.failed)} 项`
  }
  if (scan.status === 'done') return '资源已更新'
  return '照片库状态'
})

const statusTone = computed(() => {
  if (!stats.value) return 'idle'
  if (stats.value?.scan.status === 'idle') return 'idle'
  if (stats.value?.scan.status === 'error') return 'error'
  if (stats.value?.scan.status === 'scanning' || stats.value?.thumbnails.status === 'preparing') {
    return 'active'
  }
  if (stats.value?.thumbnails.status === 'done' && stats.value.thumbnails.failed > 0) return 'warning'
  return 'done'
})

const thumbnailPercent = computed(() => {
  const thumbnails = stats.value?.thumbnails
  if (!thumbnails || thumbnails.total === 0) return 100
  return Math.min(100, Math.floor((thumbnails.processed / thumbnails.total) * 100))
})

/** 主题：切换深浅（localStorage 持久化，见 stores/theme.ts） */
const themeStore = useThemeStore()
// store 值 ↔ 根元素 [data-theme] 双向同步：
// index.html 内联脚本已在首屏设置初值，这里保证 store 与 DOM 一致并响应切换
watch(
  () => themeStore.theme,
  (t) => {
    document.documentElement.dataset.theme = t
  },
  { immediate: true },
)

/** 重连轮询定时器句柄 */
let retryTimer: number | undefined
let pollInProgress = false
let disposed = false
let lastScanRunId = -1
let lastScanStatus: Stats['scan']['status'] = 'idle'

/**
 * 拉取统计；失败则每 5 秒重试直到连上（修复审查 P1-F4）。
 * 旧实现只重试一次：先开前端、后开后端的常见顺序下会永久停在
 * "等待后端启动"，必须手动刷新。现在持续轮询，后端就绪自动恢复。
 */
async function pollStats(): Promise<void> {
  if (pollInProgress) return
  pollInProgress = true
  try {
    const nextStats = await fetchStats()
    const scan = nextStats.scan
    const scanFinished =
      (scan.status === 'done' || scan.status === 'error') &&
      (scan.runId !== lastScanRunId || lastScanStatus === 'scanning')
    stats.value = nextStats
    backendReady.value = true
    if (scanFinished) {
      try {
        await assetStore.refresh()
      } catch (err) {
        console.error('[app] 扫描后刷新照片墙失败:', err)
        return
      }
    }
    lastScanRunId = scan.runId
    lastScanStatus = scan.status
  } catch {
    backendReady.value = false
    stats.value = null
  } finally {
    pollInProgress = false
    scheduleStatsPoll()
  }
}

function scheduleStatsPoll(): void {
  if (disposed) return
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined
    void pollStats()
  }, 5000)
}

function closeStatusDetailsOnOutsideClick(event: PointerEvent): void {
  if (event.target instanceof Node && !statusRoot.value?.contains(event.target)) {
    statusDetailsOpen.value = false
  }
}

function closeStatusDetailsOnEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') statusDetailsOpen.value = false
}

/** 回到照片墙时刷新统计（详情页删除后返回，顶栏计数保持准确） */
watch(
  () => route.name,
  (n) => {
    if (n === 'grid') void pollStats()
  },
)
onMounted(() => {
  document.addEventListener('pointerdown', closeStatusDetailsOnOutsideClick)
  document.addEventListener('keydown', closeStatusDetailsOnEscape)
  void pollStats()
})
onBeforeUnmount(() => {
  disposed = true
  document.removeEventListener('pointerdown', closeStatusDetailsOnOutsideClick)
  document.removeEventListener('keydown', closeStatusDetailsOnEscape)
  if (retryTimer !== undefined) {
    window.clearTimeout(retryTimer)
    retryTimer = undefined
  }
})
</script>

<template>
  <div class="app-shell">
    <!-- 顶栏：紧凑资源状态摘要，展开卡片不改变照片墙布局高度 -->
    <header class="topbar">
      <span class="brand">iCloud本地照片</span>
      <div ref="statusRoot" class="resource-status" @pointerdown.stop>
        <button
          class="status-trigger"
          :class="`tone-${statusTone}`"
          type="button"
          aria-controls="resource-status-details"
          :aria-expanded="statusDetailsOpen"
          @click="statusDetailsOpen = !statusDetailsOpen"
        >
          <span class="status-icon" aria-hidden="true">
            <span v-if="statusTone === 'active' || statusTone === 'idle'" class="spinner" />
            <svg v-else-if="statusTone === 'error' || statusTone === 'warning'" viewBox="0 0 16 16">
              <path d="M8 1.5 15 14H1L8 1.5Z" />
              <path d="M8 5.2v4.2M8 11.7v.1" class="icon-cutout" />
            </svg>
            <svg v-else viewBox="0 0 16 16">
              <path d="m3.1 8.1 3.1 3.1 6.7-6.7" />
            </svg>
          </span>
          <span class="status-summary">{{ statusSummary }}</span>
          <span class="status-chevron" aria-hidden="true">{{ statusDetailsOpen ? '⌃' : '⌄' }}</span>
        </button>
        <span class="status-divider" aria-hidden="true" />
        <span v-if="stats" class="stat asset-counts">
          <b>{{ numberFormat.format(photoCount) }}</b> 张照片 · <b>{{ numberFormat.format(videoCount) }}</b> 个视频
        </span>
        <span v-else class="stat warn">等待后端启动…</span>

        <section
          v-if="statusDetailsOpen"
          id="resource-status-details"
          class="status-popover"
          role="region"
          aria-label="资源状态详情"
        >
          <div class="popover-heading">
            <span class="popover-icon" :class="`tone-${statusTone}`">
              <span v-if="statusTone === 'active' || statusTone === 'idle'" class="spinner" />
              <svg v-else-if="statusTone === 'error' || statusTone === 'warning'" viewBox="0 0 16 16">
                <path d="M8 1.5 15 14H1L8 1.5Z" />
                <path d="M8 5.2v4.2M8 11.7v.1" class="icon-cutout" />
              </svg>
              <svg v-else viewBox="0 0 16 16"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
            </span>
            <div class="heading-copy">
              <strong>
                {{
                  stats?.scan.status === 'scanning'
                    ? '正在扫描照片库'
                    : stats?.scan.status === 'error'
                      ? '照片库扫描失败'
                      : stats?.scan.status === 'idle'
                        ? '等待扫描启动'
                      : stats?.scan.status === 'done'
                        ? stats.thumbnails.status === 'preparing'
                          ? '照片库已更新'
                          : '资源状态'
                        : '正在连接照片库'
                }}
              </strong>
              <span v-if="stats?.scan.status === 'scanning'">
                已检查 {{ numberFormat.format(stats.scan.scannedFiles) }} 个媒体文件；扫描期间不显示百分比。
              </span>
              <span v-else-if="stats?.scan.status === 'idle'">后端已连接，正在准备启动照片库检查。</span>
              <span v-else-if="stats?.scan.status === 'error'" class="error-message">
                {{ stats.scan.message || '扫描未能完成，请检查后端日志。' }}
              </span>
              <span v-else-if="stats?.scan.status === 'done'">
                共检查 {{ numberFormat.format(stats.scan.totalFiles) }} 个媒体文件。
              </span>
              <span v-else>等待后端返回照片库状态。</span>
            </div>
            <div v-if="stats" class="popover-counts">
              <b>{{ numberFormat.format(photoCount) }}</b> 张照片<br>
              <b>{{ numberFormat.format(videoCount) }}</b> 个视频
            </div>
          </div>

          <div class="status-row">
            <span class="row-icon" :class="`tone-${stats?.scan.status === 'scanning' || stats?.scan.status === 'idle' ? 'active' : stats?.scan.status === 'error' ? 'error' : 'done'}`">
              <span v-if="stats?.scan.status === 'scanning' || stats?.scan.status === 'idle'" class="spinner" />
              <svg v-else-if="stats?.scan.status === 'error'" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1L8 1.5Z" /><path d="M8 5.2v4.2M8 11.7v.1" class="icon-cutout" /></svg>
              <svg v-else viewBox="0 0 16 16"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
            </span>
            <span class="row-copy">
              <strong>{{ stats?.scan.status === 'scanning' ? '照片库扫描中' : stats?.scan.status === 'error' ? '扫描未完成' : stats?.scan.status === 'idle' ? '等待扫描启动' : '照片库扫描完成' }}</strong>
              <small>
                {{
                  stats?.scan.status === 'scanning'
                    ? '检查本机文件变化并更新图库'
                    : stats?.scan.status === 'error'
                      ? '本次扫描中断，资源计数可能尚未完整'
                      : stats?.scan.status === 'idle'
                        ? '后端启动后会自动检查照片库'
                      : `共检查 ${numberFormat.format(stats?.scan.totalFiles ?? 0)} 个媒体文件`
                }}
              </small>
            </span>
            <span class="row-value">
              {{ stats?.scan.status === 'scanning' ? `${numberFormat.format(stats.scan.scannedFiles)} 个文件` : stats?.scan.status === 'error' ? '需检查' : stats?.scan.status === 'idle' ? '等待启动' : '✓ 完成' }}
            </span>
          </div>

          <div class="status-row thumbnail-row">
            <span class="row-icon tone-neutral" aria-hidden="true">▧</span>
            <span class="row-copy">
              <strong>
                {{
                  stats?.scan.status === 'scanning'
                    ? '预览图'
                    : stats?.scan.status === 'error'
                      ? '预览图准备状态未知'
                      : stats?.scan.status === 'idle'
                        ? '等待照片库检查'
                      : stats?.thumbnails.status === 'preparing'
                        ? '正在准备预览图'
                        : stats?.thumbnails.failed
                          ? '预览图处理完成'
                          : '预览图已就绪'
                }}
              </strong>
              <small>
                {{
                  stats?.scan.status === 'scanning'
                    ? '浏览中的照片按需准备；其余项目在扫描结束后进入后台队列'
                    : stats?.scan.status === 'error'
                      ? '扫描未完成，暂不能统计本轮预览图任务'
                      : stats?.scan.status === 'idle'
                        ? '照片库检查后再统计需要准备的项目'
                      : stats?.thumbnails.status === 'preparing'
                        ? '用于照片墙浏览，不会修改原始照片'
                        : stats?.thumbnails.failed
                          ? '部分预览图未能生成，失败数量单独列出'
                          : '无需生成的项目会直接跳过'
                }}
              </small>
            </span>
            <span class="row-value">
              {{
                stats?.scan.status === 'scanning' || stats?.scan.status === 'error' || stats?.scan.status === 'idle'
                  ? '扫描后统计'
                  : stats?.thumbnails.status === 'preparing'
                    ? `${thumbnailPercent}%`
                    : stats?.thumbnails.total
                      ? '✓ 已处理'
                      : '无需处理'
              }}
            </span>
          </div>
          <template v-if="stats?.scan.status === 'done' && stats.thumbnails.total > 0">
            <div class="progress-track" role="progressbar" :aria-valuenow="thumbnailPercent" aria-valuemin="0" aria-valuemax="100">
              <span :style="{ width: `${thumbnailPercent}%` }" />
            </div>
            <div class="thumbnail-stats">
              <span>已处理 <b>{{ numberFormat.format(stats.thumbnails.processed) }} / {{ numberFormat.format(stats.thumbnails.total) }}</b></span>
              <span>已生成 <b>{{ numberFormat.format(stats.thumbnails.completed) }}</b></span>
              <span>待处理 <b>{{ numberFormat.format(stats.thumbnails.pending) }}</b></span>
              <span :class="{ 'error-message': stats.thumbnails.failed > 0 }">失败 <b>{{ numberFormat.format(stats.thumbnails.failed) }}</b></span>
            </div>
          </template>
          <p class="status-footnote">
            照片数包含普通照片和实况照片；视频数不含实况照片附带的视频片段。
          </p>
        </section>
      </div>

      <span class="spacer" />

      <!-- 主题切换：深色显示太阳（点→浅色），浅色显示月亮（点→深色） -->
      <button
        class="theme-btn"
        :title="themeStore.theme === 'dark' ? '切换到浅色' : '切换到深色'"
        @click="themeStore.toggleTheme()"
      >
        <svg v-if="themeStore.theme === 'dark'" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.8" />
          <path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
        </svg>
      </button>
    </header>

    <!-- 路由出口：KeepAlive 仅缓存照片墙（返回详情页时保留滚动位置/已加载数据/搜索态），
         详情页不缓存（大图 DOM 无需常驻） -->
    <main class="view-host">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="['GridView']">
          <component :is="Component" @deleted="pollStats" />
        </KeepAlive>
      </RouterView>
    </main>

  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.topbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 44px;
  padding: 0 16px;
  flex-shrink: 0;
  background: var(--bg-topbar);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  z-index: 10;
}
.brand {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.spacer { flex: 1; }
.stat {
  font-size: 12px;
  color: var(--text-2);
}
.asset-counts { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-counts b { color: var(--text-1); font-weight: 600; }
.warn { color: #ff9f0a; }
.resource-status {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.status-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: min(420px, 40vw);
  padding: 5px 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.status-trigger:hover,
.status-trigger[aria-expanded='true'] { background: var(--bg-field-hover); }
.status-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-chevron { flex: 0 0 auto; color: var(--text-3); font-size: 11px; }
.status-divider { width: 1px; height: 18px; flex: 0 0 1px; background: var(--border); }
.status-icon,
.popover-icon,
.row-icon { display: inline-grid; flex: 0 0 auto; place-items: center; }
.status-icon { width: 16px; height: 16px; }
.status-icon svg,
.popover-icon svg,
.row-icon svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.tone-active { color: #4384ee; }
.tone-idle { color: var(--text-3); }
.tone-done { color: #2c9a61; }
.tone-warning { color: #c78a20; }
.tone-error { color: #d05245; }
.tone-neutral { color: var(--text-3); }
.status-icon.tone-error svg path:first-child,
.popover-icon.tone-error svg path:first-child,
.row-icon.tone-error svg path:first-child { fill: currentColor; stroke: currentColor; }
.icon-cutout { stroke: #fff !important; }
.spinner {
  display: inline-block;
  width: 13px;
  height: 13px;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: resource-spin 0.8s linear infinite;
}
@keyframes resource-spin { to { transform: rotate(360deg); } }
.status-popover {
  position: absolute;
  z-index: 30;
  top: calc(100% + 9px);
  left: 0;
  width: min(410px, calc(100vw - 24px));
  padding: 15px 16px 13px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-topbar);
  color: var(--text-1);
  box-shadow: 0 12px 34px rgb(0 0 0 / 18%);
  backdrop-filter: blur(24px);
}
.popover-heading {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.popover-icon { width: 18px; height: 18px; margin-top: 1px; }
.heading-copy { display: grid; min-width: 0; flex: 1; gap: 4px; }
.heading-copy strong { font-size: 13px; font-weight: 650; }
.heading-copy > span { color: var(--text-2); font-size: 11px; line-height: 1.5; }
.heading-copy .error-message { color: #d05245; overflow-wrap: anywhere; }
.popover-counts {
  flex: 0 0 auto;
  color: var(--text-2);
  font-size: 10px;
  line-height: 1.65;
  text-align: right;
  white-space: nowrap;
}
.popover-counts b { color: var(--text-1); font-size: 11px; }
.status-row { display: flex; align-items: center; gap: 10px; padding-top: 13px; }
.row-icon {
  width: 27px;
  height: 27px;
  border-radius: 8px;
  background: var(--bg-field);
}
.row-icon.tone-active { background: rgb(67 132 238 / 12%); }
.row-icon.tone-done { background: rgb(44 154 97 / 12%); }
.row-icon.tone-error { background: rgb(208 82 69 / 12%); }
.row-copy { display: grid; min-width: 0; flex: 1; gap: 3px; }
.row-copy strong { font-size: 11px; font-weight: 650; }
.row-copy small { color: var(--text-2); font-size: 10px; line-height: 1.45; }
.row-value { flex: 0 0 auto; color: var(--text-2); font-size: 10px; text-align: right; }
.progress-track {
  height: 5px;
  margin: 11px 0 8px 37px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--bg-field);
}
.progress-track > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #4384ee;
  transition: width 0.35s ease;
}
.thumbnail-stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 5px 10px;
  margin-left: 37px;
  color: var(--text-2);
  font-size: 10px;
}
.thumbnail-stats b { color: var(--text-1); font-weight: 600; }
.thumbnail-stats .error-message,
.thumbnail-stats .error-message b { color: #d05245; }
.status-footnote {
  margin: 11px 0 0 37px;
  color: var(--text-3);
  font-size: 9px;
  line-height: 1.5;
}

/* 主题切换按钮（顶栏最右） */
.theme-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: var(--bg-field);
  color: var(--text-1);
  cursor: pointer;
  transition: background 0.15s, transform 0.15s;
}
.theme-btn:hover {
  background: var(--bg-field-hover);
  transform: scale(1.05);
}

.view-host {
  flex: 1;
  min-height: 0;
  position: relative;
}
@media (max-width: 760px) {
  .topbar { gap: 8px; padding: 0 10px; }
  .resource-status { gap: 5px; }
  .status-trigger { max-width: min(45vw, 300px); padding: 5px; font-size: 11px; }
  .status-divider { display: none; }
  .asset-counts { display: none; }
  .status-popover { left: auto; right: -38px; }
}
@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }
  .progress-track > span { transition: none; }
}
</style>
