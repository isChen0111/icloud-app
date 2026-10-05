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
import {
  fetchStats,
  fetchThumbnailFailures,
  notifyThumbnailBrowsing,
  retryThumbnailFailures,
  setThumbnailFailuresIgnored,
} from './api/client'
import { useAssetStore } from './stores/assets'
import { useThemeStore } from './stores/theme'
import type { Stats, ThumbnailFailure } from './types'
import { useRoute } from 'vue-router'

const stats = ref<Stats | null>(null)
const route = useRoute()
const assetStore = useAssetStore()

const backendReady = ref(false)
const statusDetailsOpen = ref(false)
const statusRoot = ref<HTMLElement | null>(null)
const failureDialogOpen = ref(false)
const failureItems = ref<ThumbnailFailure[]>([])
const failureActiveCount = ref(0)
const failureIgnoredCount = ref(0)
const failureFilter = ref<'active' | 'ignored'>('active')
const failureLoading = ref(false)
const failureLoaded = ref(false)
const failureActionRunning = ref(false)
const failureDialogError = ref('')
const numberFormat = new Intl.NumberFormat('zh-CN')
const photoCount = computed(() => (stats.value ? stats.value.photos + stats.value.livePhotos : 0))
const videoCount = computed(() => stats.value?.videos ?? 0)
const visibleFailures = computed(() =>
  failureItems.value.filter((item) => (failureFilter.value === 'ignored' ? item.ignored === 1 : item.ignored === 0)),
)
const thumbnailIconTone = computed(() => {
  if (!stats.value || stats.value.scan.status !== 'done') return 'neutral'
  if (stats.value.thumbnails.status === 'preparing') return 'active'
  return stats.value.thumbnails.failed > 0 ? 'warning' : 'neutral'
})

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
    return `正在生成预览图 · ${percent}%`
  }
  if (scan.status === 'done' && thumbnails.status === 'done' && thumbnails.failed > 0) {
    return `预览图待处理 · ${numberFormat.format(thumbnails.failed)} 项`
  }
  if (scan.status === 'done') return '照片库已同步'
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
let lastBrowsingSignalAt = 0

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
  if (event.key === 'Escape') {
    if (failureDialogOpen.value) failureDialogOpen.value = false
    else statusDetailsOpen.value = false
  }
}

function signalThumbnailBrowsing(): void {
  if (document.visibilityState !== 'visible' || Date.now() - lastBrowsingSignalAt < 10_000) return
  lastBrowsingSignalAt = Date.now()
  void notifyThumbnailBrowsing().catch((err: unknown) => {
    console.warn('[app] 浏览活动通知失败:', err)
  })
}

async function loadThumbnailFailures(): Promise<void> {
  if (!failureLoaded.value) failureLoading.value = true
  failureDialogError.value = ''
  try {
    const result = await fetchThumbnailFailures()
    failureItems.value = result.items
    failureActiveCount.value = result.activeCount
    failureIgnoredCount.value = result.ignoredCount
    failureLoaded.value = true
  } catch (err) {
    failureDialogError.value = err instanceof Error ? err.message : String(err)
  } finally {
    failureLoading.value = false
  }
}

async function openFailureDialog(): Promise<void> {
  statusDetailsOpen.value = false
  failureFilter.value = 'active'
  failureDialogOpen.value = true
  await loadThumbnailFailures()
}

async function retryFailures(ids?: number[]): Promise<void> {
  failureActionRunning.value = true
  failureDialogError.value = ''
  try {
    await retryThumbnailFailures(ids ? { ids } : { all: true })
    await Promise.all([loadThumbnailFailures(), pollStats()])
  } catch (err) {
    failureDialogError.value = err instanceof Error ? err.message : String(err)
  } finally {
    failureActionRunning.value = false
  }
}

async function updateFailureIgnored(ids: number[], ignored: boolean): Promise<void> {
  failureActionRunning.value = true
  failureDialogError.value = ''
  try {
    await setThumbnailFailuresIgnored({ ids }, ignored)
    await Promise.all([loadThumbnailFailures(), pollStats()])
  } catch (err) {
    failureDialogError.value = err instanceof Error ? err.message : String(err)
  } finally {
    failureActionRunning.value = false
  }
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
  document.addEventListener('pointerdown', signalThumbnailBrowsing, { passive: true })
  document.addEventListener('wheel', signalThumbnailBrowsing, { passive: true })
  document.addEventListener('keydown', signalThumbnailBrowsing, { passive: true })
  document.addEventListener('touchstart', signalThumbnailBrowsing, { passive: true })
  document.addEventListener('input', signalThumbnailBrowsing, { passive: true })
  document.addEventListener('visibilitychange', signalThumbnailBrowsing)
  signalThumbnailBrowsing()
  void pollStats()
})
onBeforeUnmount(() => {
  disposed = true
  document.removeEventListener('pointerdown', closeStatusDetailsOnOutsideClick)
  document.removeEventListener('keydown', closeStatusDetailsOnEscape)
  document.removeEventListener('pointerdown', signalThumbnailBrowsing)
  document.removeEventListener('wheel', signalThumbnailBrowsing)
  document.removeEventListener('keydown', signalThumbnailBrowsing)
  document.removeEventListener('touchstart', signalThumbnailBrowsing)
  document.removeEventListener('input', signalThumbnailBrowsing)
  document.removeEventListener('visibilitychange', signalThumbnailBrowsing)
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
          <svg class="status-chevron" :class="{ expanded: statusDetailsOpen }" viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
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
            <span class="popover-icon tone-neutral" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <rect x="2" y="2.5" width="12" height="9" rx="1.6" />
                <path d="M5 13.5h6M8 11.5v2" />
              </svg>
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
                          ? '照片库已同步'
                          : '照片库已同步'
                        : '正在连接照片库'
                }}
              </strong>
              <span v-if="stats?.scan.status === 'scanning'">
                已检查 {{ numberFormat.format(stats.scan.scannedFiles) }} 个媒体文件。
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
            <div v-if="stats" class="popover-count-area">
              <div class="popover-counts">
                <b>{{ numberFormat.format(photoCount) }}</b> 张照片<br>
                <b>{{ numberFormat.format(videoCount) }}</b> 个视频
              </div>
              <button
                class="count-info"
                type="button"
                aria-label="照片和视频数量口径说明"
                data-tooltip="照片数包含普通照片和实况照片；视频数不含实况照片附带的视频片段。"
              >
                !
              </button>
            </div>
          </div>

          <div class="status-row">
            <span class="row-icon tone-neutral" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <rect x="2" y="3" width="9" height="7" rx="1.3" />
                <path d="M5 12.5h8.5a.5.5 0 0 0 .5-.5V6.5" />
                <circle cx="5" cy="5.7" r=".8" />
                <path d="m3 9 2.2-2 1.5 1.2 1.6-1.5 1.7 1.6" />
              </svg>
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
              <template v-if="stats?.scan.status === 'scanning'">
                <span class="spinner" />
                {{ numberFormat.format(stats.scan.scannedFiles) }} 个文件
              </template>
              <template v-else-if="stats?.scan.status === 'error'">未完成</template>
              <template v-else-if="stats?.scan.status === 'idle'">等待启动</template>
              <template v-else>
                <svg class="row-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
                完成
              </template>
            </span>
          </div>

          <div class="status-row thumbnail-row">
            <span class="row-icon" :class="`tone-${thumbnailIconTone}`" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.8" />
                <circle cx="6" cy="6" r="1.15" />
                <path d="m3.5 11 3-3 2.1 2 1.5-1.5 2.4 2.5" />
              </svg>
            </span>
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
                          ? '部分预览图未生成'
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
                          ? '下方失败数量可查看文件、重试或忽略提醒'
                          : '无需生成的项目会直接跳过'
                }}
              </small>
            </span>
            <span class="row-value">
              <template v-if="stats?.scan.status === 'scanning' || stats?.scan.status === 'error' || stats?.scan.status === 'idle'">
                扫描后统计
              </template>
              <template v-else-if="stats?.thumbnails.status === 'preparing'">
                <span class="spinner" />
                {{ thumbnailPercent }}%
              </template>
              <template v-else-if="stats?.thumbnails.failed">
                <span class="row-warning-dot" />
                需处理
              </template>
              <template v-else-if="stats?.thumbnails.total">
                <svg class="row-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
                完成
              </template>
              <template v-else>无需处理</template>
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
              <button
                v-if="stats.thumbnails.failed > 0"
                class="failure-link"
                type="button"
                @click="openFailureDialog"
              >
                失败 <b>{{ numberFormat.format(stats.thumbnails.failed) }}</b> 项 ›
              </button>
              <span v-else>失败 <b>0</b></span>
            </div>
          </template>
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

    <div
      v-if="failureDialogOpen"
      class="failure-backdrop"
      role="presentation"
      @pointerdown.stop
      @click.self="failureDialogOpen = false"
    >
      <section
        class="failure-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="failure-dialog-title"
      >
        <header class="failure-dialog-header">
          <div>
            <h2 id="failure-dialog-title">预览图失败</h2>
            <p>这只影响照片墙预览，不会删除或修改原始照片、视频。</p>
          </div>
          <button class="dialog-close" type="button" aria-label="关闭" @click="failureDialogOpen = false">×</button>
        </header>
        <div class="failure-toolbar">
          <div class="failure-tabs" role="tablist" aria-label="失败项目筛选">
            <button
              type="button"
              role="tab"
              :aria-selected="failureFilter === 'active'"
              :class="{ selected: failureFilter === 'active' }"
              @click="failureFilter = 'active'"
            >
              待处理 {{ numberFormat.format(failureActiveCount) }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="failureFilter === 'ignored'"
              :class="{ selected: failureFilter === 'ignored' }"
              @click="failureFilter = 'ignored'"
            >
              已忽略 {{ numberFormat.format(failureIgnoredCount) }}
            </button>
          </div>
          <button
            v-if="failureFilter === 'active' && failureActiveCount > 0"
            class="action-button primary"
            type="button"
            :disabled="failureActionRunning"
            @click="retryFailures()"
          >
            全部重试
          </button>
        </div>
        <p v-if="failureDialogError" class="failure-error" role="alert">{{ failureDialogError }}</p>
        <div class="failure-list" aria-live="polite">
          <p v-if="failureLoading" class="failure-empty">正在读取失败项目…</p>
          <p v-else-if="visibleFailures.length === 0" class="failure-empty">
            {{ failureFilter === 'active' ? '没有待处理的失败项目。' : '没有已忽略的项目。' }}
          </p>
          <article v-for="failure in visibleFailures" v-else :key="failure.id" class="failure-item">
            <div class="failure-item-copy">
              <strong>{{ failure.filename }}</strong>
              <code>{{ failure.filePath }}</code>
              <span class="failure-reason">
                {{ failure.error || '失败时未记录详细原因；可以尝试重新生成预览图。' }}
              </span>
            </div>
            <div class="failure-item-actions">
              <template v-if="failure.ignored === 0">
                <button
                  class="action-button primary"
                  type="button"
                  :disabled="failureActionRunning"
                  @click="retryFailures([failure.id])"
                >
                  重试
                </button>
                <button
                  class="action-button"
                  type="button"
                  :disabled="failureActionRunning"
                  @click="updateFailureIgnored([failure.id], true)"
                >
                  忽略提醒
                </button>
              </template>
              <button
                v-else
                class="action-button"
                type="button"
                :disabled="failureActionRunning"
                @click="updateFailureIgnored([failure.id], false)"
              >
                恢复提醒
              </button>
            </div>
          </article>
        </div>
        <footer class="failure-dialog-footer">
          忽略只会从待处理提醒中移除该项目，不会删除文件；仍可在“已忽略”中恢复提醒。
        </footer>
      </section>
    </div>
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
.status-trigger.tone-done { color: var(--text-1); }
.status-trigger.tone-warning { color: #a87515; }
.status-summary { overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.status-chevron {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.18s ease;
}
.status-chevron.expanded { transform: rotate(180deg); }
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
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 12px 34px rgb(0 0 0 / 22%);
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
  color: var(--text-2);
  font-size: 10px;
  line-height: 1.65;
  text-align: right;
  white-space: nowrap;
}
.popover-counts b { color: var(--text-1); font-size: 11px; }
.popover-count-area {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  flex: 0 0 auto;
}
.count-info {
  display: inline-grid;
  width: 14px;
  height: 14px;
  place-items: center;
  margin-top: 1px;
  padding: 0;
  border: 1px solid var(--text-3);
  border-radius: 50%;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 9px;
  font-weight: 650;
  line-height: 1;
  cursor: help;
}
.count-info::after {
  position: absolute;
  z-index: 5;
  top: calc(100% + 8px);
  right: 0;
  width: max-content;
  max-width: min(270px, calc(100vw - 64px));
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 5px 18px rgb(0 0 0 / 16%);
  color: var(--text-1);
  content: attr(data-tooltip);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.5;
  text-align: left;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-3px);
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.count-info:hover::after,
.count-info:focus-visible::after {
  opacity: 1;
  transform: translateY(0);
}
.count-info:focus-visible { outline: 2px solid #4384ee; outline-offset: 2px; }
.status-row { display: flex; align-items: center; gap: 10px; padding-top: 13px; }
.row-icon {
  width: 27px;
  height: 27px;
  border-radius: 8px;
  background: var(--bg-field);
}
.row-icon.tone-active { background: rgb(67 132 238 / 12%); }
.row-icon.tone-done { background: rgb(44 154 97 / 12%); }
.row-icon.tone-warning { background: rgb(199 138 32 / 12%); }
.row-icon.tone-error { background: rgb(208 82 69 / 12%); }
.row-copy { display: grid; min-width: 0; flex: 1; gap: 3px; }
.row-copy strong { font-size: 11px; font-weight: 650; }
.row-copy small { color: var(--text-2); font-size: 10px; line-height: 1.45; }
.row-value {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  flex: 0 0 auto;
  color: var(--text-2);
  font-size: 10px;
  text-align: right;
}
.row-value .spinner { width: 11px; height: 11px; }
.row-check {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: #2c9a61;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.row-warning-dot { width: 6px; height: 6px; border-radius: 50%; background: #c78a20; }
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
.failure-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: #d05245;
  font: inherit;
  cursor: pointer;
}
.failure-link b { font: inherit; font-weight: 650; }
.failure-link:hover { text-decoration: underline; }
.failure-backdrop {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(0 0 0 / 42%);
}
.failure-dialog {
  display: flex;
  flex-direction: column;
  width: min(660px, 100%);
  max-height: min(720px, 90vh);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 18px 54px rgb(0 0 0 / 28%);
}
.failure-dialog-header,
.failure-toolbar,
.failure-dialog-footer { flex: 0 0 auto; }
.failure-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 19px 20px 14px;
}
.failure-dialog-header h2 { margin: 0 0 4px; font-size: 16px; }
.failure-dialog-header p,
.failure-dialog-footer { color: var(--text-2); font-size: 11px; line-height: 1.5; }
.dialog-close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 7px;
  background: var(--bg-field);
  color: var(--text-2);
  font-size: 21px;
  line-height: 1;
  cursor: pointer;
}
.failure-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 20px 12px;
  border-bottom: 1px solid var(--border);
}
.failure-tabs { display: flex; gap: 6px; }
.failure-tabs button {
  padding: 6px 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.failure-tabs button.selected {
  border-color: var(--border);
  background: var(--bg-field);
  color: var(--text-1);
}
.action-button {
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.action-button.primary { border-color: #4384ee; background: #4384ee; color: #fff; }
.action-button:disabled { opacity: 0.55; cursor: wait; }
.failure-error {
  flex: 0 0 auto;
  margin: 10px 20px 0;
  color: #d05245;
  font-size: 11px;
}
.failure-list { min-height: 100px; overflow: auto; overscroll-behavior: contain; }
.failure-empty { padding: 28px 20px; color: var(--text-2); font-size: 12px; text-align: center; }
.failure-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}
.failure-item-copy { display: grid; min-width: 0; gap: 4px; }
.failure-item-copy strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.failure-item-copy code,
.failure-reason {
  overflow-wrap: anywhere;
  color: var(--text-2);
  font-size: 10px;
  line-height: 1.45;
}
.failure-item-copy code { font-family: ui-monospace, Consolas, monospace; }
.failure-item-actions { display: flex; flex: 0 0 auto; gap: 6px; }
.failure-dialog-footer { padding: 11px 20px; border-top: 1px solid var(--border); }

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
  .failure-backdrop { padding: 10px; }
  .failure-dialog-header,
  .failure-toolbar { padding-right: 14px; padding-left: 14px; }
  .failure-item { align-items: flex-start; flex-direction: column; gap: 8px; padding: 11px 14px; }
  .failure-dialog-footer { padding-right: 14px; padding-left: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }
  .progress-track > span { transition: none; }
}
</style>
