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
  fetchThumbnailFailures,
  retryThumbnailFailures,
  setThumbnailFailuresIgnored,
  fetchLibraries,
  switchLibrary,
} from './api/client'
import { useAssetStore } from './stores/assets'
import { useSearchStore } from './stores/search'
import { useSelectionStore } from './stores/selection'
import { useTaskStore } from './stores/tasks'
import { useThemeStore } from './stores/theme'
import type { ThumbnailFailure, LibraryInfo } from './types'
import { useRoute, useRouter } from 'vue-router'
import OnboardingView from './components/OnboardingView.vue'
import AuthDialog from './components/AuthDialog.vue'
import SettingsView from './components/SettingsView.vue'
import SyncButton from './components/SyncButton.vue'

/** 全局任务状态（stats / 扫描 / 同步 / 导入）由 tasks store 统一持有与轮询 */
const tasks = useTaskStore()
const stats = computed(() => tasks.stats)
const route = useRoute()
const router = useRouter()
const assetStore = useAssetStore()
const searchStore = useSearchStore()
const selectionStore = useSelectionStore()

/** P0：照片库引导 / 认证 / 同步按钮 */
const onboardingOpen = ref(false)
const authDialogOpen = ref(false)
const librariesChecked = ref(false)
const syncPick = ref<'full' | 'inc' | null>(null)
/**
 * 顶栏操作错误提示（R-30）。
 * 以前这个 ref 只赋值、模板从未渲染 → 「同步中切库被 409 拒绝」等失败完全静默：
 * 菜单直接关掉、库名没变，用户只会反复点。现在由顶栏下方的浮层提示呈现。
 */
const syncError = ref('')
let syncErrorTimer: number | undefined
/** 自动消失延时：后端文案偏长（如「同步任务执行中，请先等待完成或取消后再切换照片库」），
 *  8 秒是「能读完但不至于一直挂着」的折中；鼠标悬停时会暂停计时 */
const SYNC_ERROR_TTL = 8000

/** 启动（或重启）自动消失计时 */
function armSyncErrorTimer(): void {
  window.clearTimeout(syncErrorTimer)
  syncErrorTimer = window.setTimeout(() => {
    syncError.value = ''
  }, SYNC_ERROR_TTL)
}

watch(syncError, (msg) => {
  window.clearTimeout(syncErrorTimer)
  if (!msg) return
  armSyncErrorTimer()
})

/** 鼠标移入浮层：暂停自动消失（长文案不会读到一半就消失） */
function holdSyncError(): void {
  window.clearTimeout(syncErrorTimer)
}

/** 鼠标移出浮层：重新计满 8 秒 */
function resumeSyncError(): void {
  if (syncError.value) armSyncErrorTimer()
}

/** P0：右上角库切换下拉 + 设置中心 */
const settingsOpen = ref(false)
const libMenuOpen = ref(false)
const libraries = ref<LibraryInfo[]>([])
/** 认证面板目标库（主界面重新链接 / 设置中心重新链接共用） */
const authTarget = ref<{ id: number; name: string; account: string | null; autoStart: boolean } | null>(null)

/** 拉取库列表（右上角下拉数据源） */
async function refreshLibraries(): Promise<void> {
  try {
    libraries.value = (await fetchLibraries()).libraries
  } catch {
    // 后端未就绪，保持旧列表
  }
}

function toggleLibMenu(): void {
  libMenuOpen.value = !libMenuOpen.value
  if (libMenuOpen.value) void refreshLibraries()
}

/**
 * 视图重建纪元：+1 等价于「把整棵视图树重新挂一遍」。
 *
 * 后端切库是热切换（停旧 watcher → 清缩略图队列 → 关旧 DB → 重开新库 → 扫新库 → 启 watcher），
 * 原先前端靠 location.reload() 对齐——但整页刷新会把设置页一起关掉，用户切完库就"被弹出"，
 * 想接着改另一张卡的配置还得重新点进来。现在改为就地重建，刷新能重置的状态逐一手动重置
 * （见 applyLibrarySwitch），挂到 KeepAlive 的 key 上是为了**连 KeepAlive 缓存一起丢弃**：
 * 只给 <component> 加 key 会把旧 GridView 实例留在缓存里，反复切库会累积 N 份已加载数据。
 */
const libraryEpoch = ref(0)

/**
 * 切库后的前端重建（替代 location.reload）。
 *
 * 刷新页面能重置的东西分四类，缺任何一类都会出现「后端已换库、页面还是旧库」的错位：
 *  ① 路由——详情页 /photo/:id 的 id 属于旧库，切库后大概率不存在 → 先回照片墙
 *  ② 全局 store——assets（月份骨架 + 页缓存）、search（结果集与词）、selection（选中集）
 *  ③ 组件内部状态——GridView 的搜索词/hasSearched、GridScroller 的滚动位置与日期面板，靠 epoch 重建
 *  ④ 顶层快照——顶栏库列表、tasks 的 stats
 *
 * 顺序不能反：先回路由（否则被重建的是详情页），再清 store（否则重建后的 init 会命中旧缓存，
 * 照片墙继续显示旧库），最后 epoch++。
 */
async function applyLibrarySwitch(): Promise<void> {
  if (route.name === 'detail') {
    await router.replace({ name: 'grid' }).catch(() => {
      // 已在该路由 / 导航被打断：忽略，后续重建照常进行
    })
  }
  assetStore.reset()
  searchStore.setQuery('')
  selectionStore.clearSelection()
  libraryEpoch.value += 1
  await Promise.all([refreshLibraries(), tasks.refresh({ force: true })])
}

/** 切换激活库（顶栏下拉）：成功后就地重建，不再整页刷新 */
async function pickLibrary(id: number): Promise<void> {
  libMenuOpen.value = false
  try {
    await switchLibrary(id)
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
    void tasks.refresh({ force: true })
    return
  }
  await applyLibrarySwitch()
}

function openSettings(): void {
  settingsOpen.value = true
}

/**
 * 打开「导入进度」：导入弹窗的唯一宿主是设置中心（那边还负责启动前切库确认），
 * 所以这里不能自己再挂一个实例，而是把「请打开该库的导入弹窗」这个请求传给设置页。
 *
 * 用自增 seq 而不是只传 libId：同一个库连点两次时 id 不变，设置页的 watch 就不会再触发；
 * 每次都是新对象则天然可靠。设置页还会处理「库列表尚未加载完」的时序（见其 pendingImportLibId）。
 */
const importRequest = ref<{ libId: number; seq: number } | null>(null)
let importRequestSeq = 0

function openImportProgress(): void {
  const lib = stats.value?.library
  if (!lib) return
  statusDetailsOpen.value = false
  importRequest.value = { libId: lib.id, seq: ++importRequestSeq }
  settingsOpen.value = true
}

/**
 * 关闭设置中心（必须顺手清掉 importRequest）。
 * 不清的话，下次用户手动打开设置页时组件重新挂载、watch 带 immediate 会看到这条旧请求，
 * 一进设置页就莫名其妙弹出导入窗。
 */
function closeSettings(): void {
  settingsOpen.value = false
  importRequest.value = null
}

/** 删除库后的处理：删激活库 → 整页刷新；删非激活库 → 仅从主界面库切换下拉移除 */
function onLibraryDeleted(payload: { id: number; wasActive: boolean }): void {
  if (payload.wasActive) {
    location.reload()
    return
  }
  libraries.value = libraries.value.filter((l) => l.id !== payload.id)
}

/** 打开认证面板（目标库 = stats 当前库 / 设置中心指定库；account 已链接则固定邮箱直接进入认证） */
function openAuth(lib: { id: number; name: string; account?: string | null }): void {
  // 已有 account = 刷新链接：弹窗打开后直接开始认证（免二次点击）；无 account = 新建链接：先输邮箱
  authTarget.value = { id: lib.id, name: lib.name, account: lib.account ?? null, autoStart: !!lib.account }
  authDialogOpen.value = true
}

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
/** 预览图行图标配色：跟随 thumbPhase（不是 scan.status）——同步期间批次照常在跑时
 *  要亮成活跃蓝，否则「正在生成」配一个静默灰点，正是本次要修的错位感。
 *  ready 走 done（绿底）：完成态若还是灰点，右侧却是绿色对勾，两个信号自相矛盾 */
const thumbnailIconTone = computed(() => {
  switch (thumbPhase.value) {
    case 'preparing': return 'active'
    case 'failed': return 'warning'
    case 'ready': return 'done'
    // scanning（批次还没建立）/ empty（没有要生成的项目）都不是「完成」，保持中性
    default: return 'neutral'
  }
})

/** 落库中：导入归置（本地导入/上传）或 iCloud 下载。这两段都没有扫描在跑，
 *  但磁盘上的照片确实在增加——顶栏与扫描行都必须照实说「在忙什么」 */
const landingBusy = computed(() => tasks.importBusy || tasks.syncBusy)

/* ---------- 导入进度（2026-11-03） ----------
 *
 * 为什么必须有这块：导入弹窗是可以关掉的，而**关窗不等于取消**——后端流水线照跑，
 * 大目录（几万张）能跑几十分钟。关窗后此前唯一能看到的只有顶栏一句「正在归置新照片」，
 * 既没有总数也没有进度，用户以为任务已经停了（实测反馈就是「一开始我不知道」）。
 * 现在把导入做成和同步同级的一等任务：顶栏摘要带百分比、状态浮层有独立一行 + 进度条，
 * 并提供「查看导入详情 / 取消导入」两个出口。
 */
const importState = computed(() => tasks.importState)

/**
 * 导入百分比。null = 还不知道总数（归置前要先遍历源目录，大目录这一步就要几十秒），
 * 此时显示「准备中」而不是 0%——0% 会让人以为卡住了。
 */
const importPercent = computed<number | null>(() => {
  const i = importState.value
  if (!i || i.totalFiles <= 0) return null
  return Math.min(100, Math.floor((i.processedFiles / i.totalFiles) * 100))
})

/** 落库阶段（文件已归置完，正在 runScan 入库）：不可取消，进度也不归它管 */
const importScanning = computed(() => importState.value?.phase === 'scanning')
/** 已请求取消、后端流水线还在收尾（文件可能正卡在一个大文件的拷贝中） */
const importCancelling = computed(() => importState.value?.cancelRequested === true)

/** 导入阶段文案（顶栏摘要与浮层标题同源，避免两处措辞打架） */
const importPhaseText = computed(() => {
  const i = importState.value
  if (!i) return '正在导入新照片'
  // 落库阶段只报「归置的结果」，过程交给扫描行——此前这里写「正在写入照片库 /
  // 正在建立索引」，与扫描行的「照片库扫描中 / 更新图库」是同一个 runScan 的两套措辞
  if (i.phase === 'scanning') return '照片已归置完成'
  if (i.cancelRequested) return '正在取消导入'
  if (importPercent.value === null) return '正在准备导入'
  return '正在导入新照片'
})

/** 顶栏摘要：写入照片库阶段没有百分比（全库遍历的进度在扫描行里） */
const importSummary = computed(() => {
  const pct = importPercent.value
  if (importPhaseText.value !== '正在导入新照片' || pct === null) return importPhaseText.value
  return `正在导入新照片 · ${pct}%`
})

/** 浮层导入行的说明文字：总数、已处理、跳过、失败一目了然 */
const importCountText = computed(() => {
  const i = importState.value
  if (!i) return ''
  // 落库阶段只给结果（共导入多少），进度看扫描行，避免同一件事两处各说一遍
  if (i.phase === 'scanning') return `共 ${numberFormat.format(i.processedFiles)} 个文件`
  if (i.totalFiles <= 0) return '正在遍历源目录，统计待导入的文件'
  const parts = [
    `${numberFormat.format(i.processedFiles)} / ${numberFormat.format(i.totalFiles)}`,
  ]
  if (i.skipped > 0) parts.push(`跳过 ${numberFormat.format(i.skipped)}`)
  if (i.failedCount > 0) parts.push(`失败 ${numberFormat.format(i.failedCount)}`)
  return parts.join(' · ')
})

/** 可取消：落库阶段后端会 409，已请求取消时按钮也该锁住（否则用户会反复点） */
const importCanCancel = computed(
  () => tasks.importBusy && !importScanning.value && !importCancelling.value,
)

/** 取消导入（与导入弹窗里的取消是同一个接口，返回「已取消但未收尾」的中间态） */
async function cancelImportRun(): Promise<void> {
  // 优先用任务自己记录的库：接口按 /libraries/:id/import 校验激活库，用错库会 409
  const libId = importState.value?.libraryId || stats.value?.library?.id
  if (!libId) return
  try {
    await tasks.cancelImport(libId)
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 落库中的一句话——顶栏摘要与浮层大标题的**唯一来源**。
 *
 * 之前「正在下载新照片」在 statusSummary 与 headingTitle 里各硬编码一次，靠人工
 * 保持一致；导入那边又是第三套（importPhaseText / importSummary）。这里收成一处：
 * 带百分比的给紧凑的顶栏，不带百分比的给大标题（大标题下还有同步按钮与状态行，
 * 再塞百分比会挤）。
 */
function landingSentence(withPercent: boolean): string {
  if (!tasks.importBusy) return '正在下载新照片'
  return withPercent ? importSummary.value : importPhaseText.value
}

const statusSummary = computed(() => {
  if (!stats.value) return tasks.online ? '资源状态暂不可用' : '正在连接照片库…'

  const { scan, thumbnails } = stats.value
  if (scan.status === 'scanning') {
    return `正在扫描 · 已检查 ${numberFormat.format(scan.scannedFiles)} 个文件`
  }
  if (scan.status === 'error') return '照片库扫描失败'
  // 落库优先于「已同步」：搬运文件时图库在变，不能显示成静止的已完成状态。
  // 导入要说清进度（关掉导入弹窗后，这行是唯一的常驻可见位置）
  if (landingBusy.value) return landingSentence(true)
  if (scan.status === 'idle') return '等待照片库检查'
  if (scan.status === 'done' && thumbnails.status === 'preparing') {
    const percent = thumbnails.total > 0
      ? Math.floor((thumbnails.processed / thumbnails.total) * 100)
      : 100
    return `正在生成预览图 · ${percent}%`
  }
  if (scan.status === 'done' && thumbnails.status === 'done' && thumbnails.failed > 0) {
    return `预览图失败 · ${numberFormat.format(thumbnails.failed)} 项`
  }
  if (scan.status === 'done') return '照片库已同步'
  return '照片库状态'
})

const statusTone = computed(() => {
  if (!stats.value) return 'idle'
  const { scan, thumbnails } = stats.value
  if (scan.status === 'error') return 'error'
  // 落库中（导入归置 / 同步下载）也算「有活儿在跑」，顶栏圆点要跟着亮，
  // 否则照片正在往库里拷、顶栏却是个静止的「已完成」勾
  if (scan.status === 'scanning' || landingBusy.value || thumbnails.status === 'preparing') {
    return 'active'
  }
  if (scan.status === 'idle') return 'idle'
  if (thumbnails.status === 'done' && thumbnails.failed > 0) return 'warning'
  return 'done'
})

/* ---------- 扫描行：四态 + 落库等待（2026-11-03 修） ----------
 *
 * ⚠️ 单独看 stats.scan.status 不足以描述「现在在干什么」：
 * 导入/同步都分两段——① 搬运文件（复制/下载）② 落库扫描。第①段根本没有扫描在跑，
 * 而 scanProgress 是模块级单例，会保留上一轮的 status='done' 与旧计数（「共检查 650 个」）。
 * 于是文件正往库里拷，界面却显示「照片库扫描完成 / 完成」，与实际状态相反。
 *
 * 现在把「落库中但还没开始扫描」单列成 waiting 态，并让完成态的数字明确标注是
 * 「最近一次扫描」——顺带消掉「650 个文件」与「367 张照片」看起来对不上的困惑
 * （实况照片由图片+视频两个文件组成，650 = 393 资产 + 257 个实况片段）。
 */
type ScanPhase = 'idle' | 'scanning' | 'waiting' | 'error' | 'done'

const scanPhase = computed<ScanPhase>(() => {
  const s = stats.value?.scan
  if (!s) return 'idle'
  if (s.status === 'scanning') return 'scanning'
  // 上一轮扫描出错比「正在落库」更值得提示：先让用户看到异常
  if (s.status === 'error') return 'error'
  if (landingBusy.value) return 'waiting'
  return s.status === 'idle' ? 'idle' : 'done'
})

const scanTitle = computed(() => {
  switch (scanPhase.value) {
    case 'scanning': return '照片库扫描中'
    case 'waiting': return '等待落库完成后扫描'
    case 'error': return '扫描未完成'
    case 'idle': return '等待扫描启动'
    default: return '照片库扫描完成'
  }
})

const scanHint = computed(() => {
  switch (scanPhase.value) {
    case 'scanning':
      return '检查本机文件变化并更新图库'
    case 'waiting':
      // 落库期间扫描行不再只说「待开始」：右侧值直接给「现在能看多少」，
      // 说明文字写清下一步会做什么
      return tasks.importBusy ? '导入的照片归置完成后会自动扫描' : '同步下载完成后会自动扫描'
    case 'error':
      return '本次扫描中断，资源计数可能尚未完整'
    case 'idle':
      return '后端启动后会自动检查照片库'
    default: {
      // 只有总量不够：用户刚导完一大批，最想知道的是「这次进去了多少」
      const scan = stats.value?.scan
      const added = scan?.assetsAdded ?? 0
      const base = `最近一次扫描共检查 ${numberFormat.format(scan?.totalFiles ?? 0)} 个媒体文件`
      return added > 0 ? `${base} · 新增 ${numberFormat.format(added)} 项` : base
    }
  }
})

const scanIconTone = computed(() => {
  if (scanPhase.value === 'scanning' || scanPhase.value === 'waiting') return 'active'
  if (scanPhase.value === 'error') return 'error'
  // 完成态用绿底：右侧本来就是绿色对勾，灰底 + 绿勾是两个互相矛盾的信号
  if (scanPhase.value === 'done') return 'done'
  return 'neutral' // idle：还没开始，保持中性
})

/* ---------- 预览图行：自己的生命期，不挂在 scanPhase 上（2026-11-03 修） ----------
 *
 * ⚠️ 上一版把这一行直接绑到 scanPhase，结果同步期间出现自相矛盾的界面：
 * 行文案写「等待扫描完成 / 扫描后统计」，而下面进度条正显示 11 项在生成。
 *
 * 根因是两者本就不同源：
 *   - 缩略图预热批次是每轮扫描**末尾**入队的（enqueueThumbnails），扫描一结束 batch 就在跑；
 *   - 而同步期间 watcher 是边下边扫，常见的稳态是「上一轮扫完、批次在跑、下一轮还没开始」，
 *     此时 landingBusy=true → scanPhase='waiting'，于是行文案被强行改写成「等待扫描完成」。
 * 用户滚动照片墙时还有按需生成的交互式缩略图同时在工作，进一步坐实「明明在生成」。
 *
 * 唯一真正相关的是 scanning：批次在扫描末尾才入队，扫描中统计不完整/不存在。
 */
type ThumbPhase = 'scanning' | 'preparing' | 'failed' | 'ready' | 'empty'

const thumbPhase = computed<ThumbPhase>(() => {
  const t = stats.value?.thumbnails
  if (!t) return 'scanning'
  // 直接看 scan.status，不绕 scanPhase：这一行只关心「批次建立了没有」，
  // 而 scanPhase 还夹着 landingBusy（落库中→waiting）这种与本行无关的语义
  if (stats.value?.scan.status === 'scanning') return 'scanning'
  if (t.status === 'preparing') return 'preparing'
  if (t.failed > 0) return 'failed'
  if (t.total > 0) return 'ready'
  return 'empty'
})

const thumbnailPercent = computed(() => {
  const thumbnails = stats.value?.thumbnails
  if (!thumbnails || thumbnails.total === 0) return 100
  return Math.min(100, Math.floor((thumbnails.processed / thumbnails.total) * 100))
})

const thumbTitle = computed(() => {
  switch (thumbPhase.value) {
    case 'scanning': return '预览图'
    case 'preparing': return '正在生成预览图'
    case 'failed': return '部分预览图未生成'
    case 'ready': return '预览图已就绪'
    // empty：库里确实没有待生成项。落库中说明新照片还没入库，
    // 说「已就绪」会像在敷衍，如实说「等待新照片入库」
    default: return landingBusy.value ? '等待新照片入库' : '暂无预览图任务'
  }
})

const thumbHint = computed(() => {
  switch (thumbPhase.value) {
    case 'scanning': return '浏览中的照片按需准备；其余项目在扫描结束后进入后台队列'
    case 'preparing': return '用于照片墙浏览，不会修改原始照片'
    case 'failed': return '下方失败数量可查看文件、重试或忽略提醒'
    case 'ready': return '无需生成的项目会直接跳过'
    default: return landingBusy.value ? '落库完成后会自动准备预览图' : '库里还没有需要生成预览图的项目'
  }
})

/** 浮层大标题（与顶栏 statusSummary 同口径：落库中要照实说在忙什么，见 landingSentence） */
const headingTitle = computed(() => {
  const scan = stats.value?.scan
  if (!scan) return '正在连接照片库'
  if (scan.status === 'scanning') return '正在扫描照片库'
  if (scan.status === 'error') return '照片库扫描失败'
  if (landingBusy.value) return landingSentence(false)
  if (scan.status === 'idle') return '等待扫描启动'
  if (thumbPhase.value === 'preparing') return '正在生成预览图'
  return '照片库已同步'
})

/* ---------- P0 同步按钮（视觉/状态机统一在共享组件 SyncButton.vue） ---------- */
const syncRunning = computed(() => tasks.syncBusy)

/**
 * 同步行标题。与导入行同构的一行——此前同步只有按钮下方那句 `sync-meta` 文字，
 * 而 `sync.downloaded` 这个一直在涨的计数根本没人展示（「到底下了多少」只能靠猜）。
 * 不画进度条：icloudpd 不报总数，硬算百分比是假的。
 */
const syncRowTitle = computed(() =>
  stats.value?.sync.status === 'waiting_retry' ? '同步等待重试' : '正在同步 iCloud 照片',
)

/**
 * 同步按钮锁定态：当前库未链接 iCloud / 会话过期时不放行。
 * 旧版只按「其他库任务占用」灰显，未登录的库也能点开菜单选「全量拉取」，
 * 而后端当时只校验 account（提交邮箱就写了），于是一个从未认证成功的库真的会去跑
 * icloudpd —— 拿着半截 cookie 直接要验证码。后端已改为校验 auth_status，
 * 这里再堵住入口，用户不用先收到一条 409 才知道。
 */
const syncLocked = computed(() => stats.value?.library?.authStatus !== 'authed')
const syncLockHint = computed(() => {
  const lib = stats.value?.library
  if (!lib) return '还没有可同步的照片库'
  return lib.authStatus === 'expired'
    ? 'iCloud 会话已过期，请重新登录后再同步'
    : '尚未链接 iCloud，请先登录后再同步'
})

/** 等待重试倒计时（后端 60 秒后自动重试，前端倒数让用户知道还要等多久） */
const retryCountdown = ref(0)
let syncRetryTimer: number | undefined
watch(() => stats.value?.sync.status, (status, prev) => {
  if (status === 'waiting_retry' && prev !== 'waiting_retry') {
    retryCountdown.value = 60
    syncRetryTimer = window.setInterval(() => {
      retryCountdown.value = Math.max(0, retryCountdown.value - 1)
      if (retryCountdown.value <= 0 && syncRetryTimer) window.clearInterval(syncRetryTimer)
    }, 1000)
  } else if (status !== 'waiting_retry' && syncRetryTimer) {
    window.clearInterval(syncRetryTimer)
    retryCountdown.value = 0
  }
})

/** 状态行文案：直接显示后端人话 message，done/cancelled 给本地总结 */
const syncDisplayText = computed(() => {
  const s = stats.value?.sync
  if (!s || s.status === 'idle') return ''
  if (s.status === 'done') return `同步完成，本次下载 ${s.downloaded} 项`
  if (s.status === 'cancelled') return '已取消'
  if (s.status === 'waiting_retry' && retryCountdown.value > 0) {
    return `${s.message} · ${retryCountdown.value} 秒后继续`
  }
  return s.message || ''
})
/** 状态行颜色：蓝=进行中 黄=等待 绿=完成 红=失败 */
const syncStatusClass = computed(() => {
  switch (stats.value?.sync.status) {
    case 'running': return 'info'
    case 'waiting_retry': return 'warn'
    case 'done': return 'ok'
    case 'error': return 'err'
    case 'cancelled': return 'muted'
    default: return ''
  }
})
/** 当前库是否需要重新链接 iCloud（文档「未链接/已过期」提示按钮） */
const authNeedsLink = computed(() => {
  const lib = stats.value?.library
  return lib != null && lib.authStatus !== 'authed'
})

/** 选择全量/增量后进入「执行」态（菜单开合由 SyncButton 内部管理） */
function pickSync(kind: 'full' | 'inc'): void {
  syncPick.value = kind
  syncError.value = ''
}

/** 执行同步（picked 态点击） */
async function runSync(): Promise<void> {
  const lib = stats.value?.library
  const kind = syncPick.value ?? 'full'
  if (!lib) return
  try {
    // store 内部把返回的状态直接写回快照，按钮立刻进「取消」态，无需再拉一次
    await tasks.startSync(lib.id, kind)
    syncPick.value = null
    syncError.value = ''
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

/** 取消同步（running 态点击） */
async function cancelSyncRun(): Promise<void> {
  const lib = stats.value?.library
  if (!lib) return
  try {
    await tasks.cancelSync(lib.id)
    syncError.value = ''
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

/** 是否正在查库列表（防重入，避免 online 连续变化时叠请求） */
const checkingLibraries = ref(false)

/**
 * 首次挂载检查照片库：无任何库 → 打开首次引导。
 *
 * 只在**成功**时置 librariesChecked。旧实现在 finally 里无条件置 true，
 * 于是「先开前端、后开后端」这个常见顺序下，首次请求必然失败、
 * librariesChecked 却已被标成 true，引导页永远不会自动弹出，只能手动新建库。
 * 现在失败保持 false，等 tasks.online 从 false 变 true 时自动重试。
 */
async function checkLibraries(): Promise<void> {
  if (librariesChecked.value || checkingLibraries.value) return
  checkingLibraries.value = true
  try {
    const { libraries } = await fetchLibraries()
    onboardingOpen.value = libraries.length === 0
    librariesChecked.value = true
  } catch {
    // 后端未就绪：保持 false，等 online 变 true 时由下面的 watch 再查
  } finally {
    checkingLibraries.value = false
  }
}

/** 后端就绪（含「先开前端后开后端」的恢复路径）→ 补查一次库列表 */
watch(
  () => tasks.online,
  (isOnline) => {
    if (isOnline) void checkLibraries()
  },
)

/** 引导期间是否切换过激活库（R-22）：切库后页面数据仍是旧库，关闭引导要整页刷新 */
let onboardingSwitched = false
function onOnboardingSwitch(): void {
  onboardingSwitched = true
}

function onOnboardingClose(): void {
  onboardingOpen.value = false
  if (onboardingSwitched) {
    // R-22：引导期间切过激活库 → 顶栏库名 / stats / 照片墙资产全是旧库的，
    // 必须整页初始化，否则会出现"后端已换库、页面还是旧库"的错位
    onboardingSwitched = false
    location.reload()
    return
  }
  void tasks.refresh({ force: true })
}

/**
 * 认证纪元：认证面板每次结束（成功或关闭）都 +1，设置页 watch 它重拉库列表。
 *
 * 存在的理由：设置页原先只按 /api/stats 的签名刷新，而 stats.library 只含
 * **当前激活库**。在非激活库上完成认证时后端早就改了 auth_status，签名却不变，
 * 卡片会一直显示「未链接」，切库后才恢复（2026-11-03 修复的 bug 就是这条）。
 */
const authEpoch = ref(0)

/** 认证成功：关闭面板并刷新统计（认证状态/库信息） */
function onAuthDone(): void {
  authDialogOpen.value = false
  authEpoch.value++
  void tasks.refresh({ force: true })
}

/** 关闭认证面板：同样要刷新——用户可能在 done 被轮询到之前就关掉了 */
function onAuthClose(): void {
  authDialogOpen.value = false
  authEpoch.value++
  void tasks.refresh({ force: true })
}

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

/**
 * 统计拉取与轮询调度已全部移交 stores/tasks.ts：
 * 那里统一处理间隔自适应（有任务 1.5s / 空闲 15s / 后台停表）、请求去重、
 * 失败退避，以及「扫描完成 → 刷新照片墙」的副作用。
 * 本组件只负责生命周期（start/stop）和在动作之后请求一次即时刷新。
 */

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
    await Promise.all([loadThumbnailFailures(), tasks.refresh({ force: true })])
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
    await Promise.all([loadThumbnailFailures(), tasks.refresh({ force: true })])
  } catch (err) {
    failureDialogError.value = err instanceof Error ? err.message : String(err)
  } finally {
    failureActionRunning.value = false
  }
}

/** 详情页删除照片后：强制刷新统计（顶栏计数/体积要立刻反映，不能等下一轮） */
function onAssetsDeleted(): void {
  void tasks.refresh({ force: true })
}

/** 回到照片墙时刷新统计（详情页删除后返回，顶栏计数保持准确） */
watch(
  () => route.name,
  (n) => {
    // 不 force：路由来回切换时复用可能在飞的请求即可
    if (n === 'grid') void tasks.refresh()
  },
)
onMounted(() => {
  document.addEventListener('pointerdown', closeStatusDetailsOnOutsideClick)
  document.addEventListener('keydown', closeStatusDetailsOnEscape)
  void checkLibraries()
  // 唯一轮询源启动（内部立刻拉一次，并按状态自适应频率）
  tasks.start()
})
onBeforeUnmount(() => {
  window.clearTimeout(syncErrorTimer)
  // 卸载时必须清掉倒计时，否则等待重试时会继续每秒递减（旧实现漏了这一步）
  window.clearInterval(syncRetryTimer)
  document.removeEventListener('pointerdown', closeStatusDetailsOnOutsideClick)
  document.removeEventListener('keydown', closeStatusDetailsOnEscape)
  tasks.stop()
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
              <strong>{{ headingTitle }}</strong>
              <!-- P0 同步按钮区（共享组件 SyncButton：主界面/设置中心视觉与状态机完全一致） -->
              <div style="position: relative; margin-top: 7px">
                <SyncButton
                  :busy="syncRunning"
                  :picked="syncPick"
                  :locked="syncLocked"
                  :locked-hint="syncLockHint"
                  @pick="pickSync"
                  @run="runSync"
                  @cancel="cancelSyncRun"
                />
              </div>
                <!-- 状态/提示行：按钮下方独立一行。颜色信号走前置小圆点，文字保持中性灰。
                     同步进行中隐藏这里——进度与计数由下面新增的同步行承担，否则同一句话出现两遍 -->
                <div v-if="!syncRunning || authNeedsLink" class="sync-meta">
                  <span v-if="syncDisplayText" class="sync-note" :class="syncStatusClass">
                    <i class="sync-dot" aria-hidden="true" />
                    {{ syncDisplayText }}
                  </span>
                  <!-- 同步按钮被锁时，这里就是出口：未链接 → 「登录 iCloud」，过期 → 「需要重新链接」。
                       以前统一写「需要重新链接」，对从未登录过的库是错的措辞 -->
                  <button
                    v-if="authNeedsLink && stats?.library"
                    class="relink-btn"
                    type="button"
                    @click="openAuth({ id: stats.library.id, name: stats.library.name, account: stats.library.account })"
                  >
                    {{ stats.library.authStatus === 'expired' ? '需要重新链接' : '登录 iCloud' }}
                  </button>
                </div>
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

          <!-- 导入行：只在导入进行中出现。关掉导入弹窗后，这里是进度与取消的唯一出口
               （顶栏摘要只有一句文案，看不出共多少、还剩多少） -->
          <template v-if="tasks.importBusy">
            <div class="status-row import-row">
              <span class="row-icon tone-active" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <path d="M8 2.6v7" />
                  <path d="m5.2 6.9 2.8 2.8 2.8-2.8" />
                  <path d="M3 11.4v1.4a.8.8 0 0 0 .8.8h8.4a.8.8 0 0 0 .8-.8v-1.4" />
                </svg>
              </span>
              <span class="row-copy">
                <strong>{{ importPhaseText }}</strong>
                <small>{{ importCountText }}</small>
              </span>
              <span class="row-value">
                <span class="spinner" />
                {{ importScanning ? '入库中' : importPercent === null ? '准备中' : `${importPercent}%` }}
              </span>
            </div>
            <div
              v-if="importPercent !== null && !importScanning"
              class="progress-track"
              role="progressbar"
              :aria-valuenow="importPercent"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span :style="{ width: `${importPercent}%` }" />
            </div>
            <div class="import-row-actions">
              <button class="row-action" type="button" @click="openImportProgress">
                查看导入详情 ›
              </button>
              <button v-if="importCanCancel" class="row-action danger" type="button" @click="cancelImportRun">
                取消导入
              </button>
              <span v-else-if="importCancelling" class="row-action muted">正在取消…</span>
              <span v-else-if="importScanning" class="row-action muted">入库阶段不可取消</span>
            </div>
          </template>

          <!-- 同步行：与导入行同构。不画进度条 —— icloudpd 不报总数，硬算百分比是假的；
               这里只回答「还在进」+「进了多少」。`downloaded` 后端一直在更新，
               以前却没有任何地方展示它 -->
          <div v-if="syncRunning" class="status-row sync-row">
            <span class="row-icon tone-active" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path d="M4.6 11.4a2.7 2.7 0 0 1-.5-5.3A3.7 3.7 0 0 1 11.4 5.7a2.3 2.3 0 0 1-.3 5.7" />
                <path d="M8 6.6v4.8M6.2 9.8 8 11.6l1.8-1.8" />
              </svg>
            </span>
            <span class="row-copy">
              <strong>{{ syncRowTitle }}</strong>
              <small>{{ syncDisplayText }}</small>
            </span>
            <span class="row-value">
              <span class="spinner" />
              已下载 {{ numberFormat.format(stats?.sync.downloaded ?? 0) }} 项
            </span>
          </div>

          <div class="status-row">
            <span class="row-icon" :class="`tone-${scanIconTone}`" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <rect x="2" y="3" width="9" height="7" rx="1.3" />
                <path d="M5 12.5h8.5a.5.5 0 0 0 .5-.5V6.5" />
                <circle cx="5" cy="5.7" r=".8" />
                <path d="m3 9 2.2-2 1.5 1.2 1.6-1.5 1.7 1.6" />
              </svg>
            </span>
            <span class="row-copy">
              <strong>{{ scanTitle }}</strong>
              <small>{{ scanHint }}</small>
            </span>
            <span class="row-value">
              <template v-if="scanPhase === 'scanning'">
                <span class="spinner" />
                {{ numberFormat.format(stats?.scan.scannedFiles ?? 0) }} 个文件
              </template>
              <!-- 落库中：这一格回答用户真正关心的问题——「现在能看多少张」。
                   不新增元素，就用原本写「待开始」的位置。口径是 assets 表行数
                   （照片+视频+实况），所以用「项」而不是「张」，否则含视频时会低报 -->
              <template v-else-if="scanPhase === 'waiting'">
                <span class="spinner" />
                已入库 {{ numberFormat.format(stats?.assets ?? 0) }} 项
              </template>
              <template v-else-if="scanPhase === 'error'">未完成</template>
              <template v-else-if="scanPhase === 'idle'">等待启动</template>
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
              <strong>{{ thumbTitle }}</strong>
              <small>{{ thumbHint }}</small>
            </span>
            <span class="row-value">
              <template v-if="thumbPhase === 'scanning'">
                扫描后统计
              </template>
              <template v-else-if="thumbPhase === 'preparing'">
                <span class="spinner" />
                {{ thumbnailPercent }}%
              </template>
              <template v-else-if="thumbPhase === 'failed'">
                <span class="row-warning-dot" />
                需处理
              </template>
              <template v-else-if="thumbPhase === 'ready'">
                <svg class="row-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
                完成
              </template>
              <template v-else>{{ landingBusy ? '等待入库' : '无需处理' }}</template>
            </span>
          </div>
          <template v-if="thumbPhase !== 'scanning' && stats && stats.thumbnails.total > 0">
            <div class="progress-track" role="progressbar" :aria-valuenow="thumbnailPercent" aria-valuemin="0" aria-valuemax="100">
              <span :style="{ width: `${thumbnailPercent}%` }" />
            </div>
            <div class="thumbnail-stats">
              <span>已处理 <b>{{ numberFormat.format(stats.thumbnails.processed) }} / {{ numberFormat.format(stats.thumbnails.total) }}</b></span>
              <span>已生成 <b>{{ numberFormat.format(stats.thumbnails.completed) }}</b></span>
              <span>待处理 <b>{{ numberFormat.format(stats.thumbnails.pending) }}</b></span>
              <!-- F-07 系列三态：有未忽略失败 →「失败 N 项 >」；无失败但有忽略项 →「已忽略 N 项 >」；都没有 →「失败 0」。
                   入口常驻保证忽略项始终可查看/取消忽略（否则 failed=0 时按钮消失，用户找不到忽略清单）。 -->
              <button
                v-if="stats.thumbnails.failed > 0"
                class="failure-link"
                type="button"
                @click="openFailureDialog"
              >
                失败 <b>{{ numberFormat.format(stats.thumbnails.failed) }}</b> 项 ›
              </button>
              <button
                v-else-if="stats.ignoredThumbnails > 0"
                class="failure-link"
                type="button"
                @click="openFailureDialog"
              >
                已忽略 <b>{{ numberFormat.format(stats.ignoredThumbnails) }}</b> 项 ›
              </button>
              <span v-else>失败 <b>0</b></span>
            </div>
          </template>

          <!-- F-02 队列指标：快速滚动/诊断用，只读展示，不影响任何逻辑 -->
          <div v-if="stats?.thumbQueueMetrics" class="queue-metrics">
            <span>运行 <b>{{ stats.thumbQueueMetrics.running }}</b></span>
            <span>交互运行 <b>{{ stats.thumbQueueMetrics.interactiveRunning }}</b></span>
            <span>交互等待 <b>{{ stats.thumbQueueMetrics.interactiveWaiting }}</b></span>
            <span>已跳过 <b>{{ stats.thumbQueueMetrics.cancelled }}</b></span>
            <button
              class="count-info"
              type="button"
              aria-label="队列指标口径说明"
              data-tooltip="队列 = 缩略图生成任务；交互 = 浏览中照片的生成请求（交互运行/等待越多，说明当前浏览加载越忙）；已跳过 = 客户端断开被拦下的请求（快速滚动离屏），不会进入失败清单。"
            >
              !
            </button>
          </div>

          <!-- 设计稿调整：库信息 / 新建照片库入口移至右上角下拉 + 设置中心，同步下拉不再展示 -->
        </section>
      </div>

      <span class="spacer" />

      <!-- P0 设计稿 §3：右上角库切换下拉（当前库名 ▾；切库 = 就地重建视图，不刷新整页） -->
      <div class="lib-menu-wrap">
        <button class="lib-trigger" type="button" :aria-expanded="libMenuOpen" @click="toggleLibMenu">
          <span class="lib-trigger-name">{{ stats?.library?.name ?? '照片库' }}</span>
          <svg class="chev" :class="{ open: libMenuOpen }" viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </button>
        <div v-if="libMenuOpen" class="lib-menu" role="menu">
          <div class="lib-menu-label">照片库</div>
          <button
            v-for="lib in libraries"
            :key="lib.id"
            class="lib-item"
            :class="{ current: lib.active }"
            type="button"
            role="menuitem"
            @click="pickLibrary(lib.id)"
          >
            <span v-if="lib.active" class="lib-check" aria-hidden="true">✓</span>
            <span class="lib-item-name">{{ lib.name }}</span>
          </button>
          <div class="lib-menu-sep" aria-hidden="true" />
          <button class="lib-item new" type="button" role="menuitem" @click="libMenuOpen = false; onboardingOpen = true">
            <span class="lib-plus" aria-hidden="true">+</span>
            新建照片库
          </button>
        </div>
      </div>

      <!-- P0 设计稿 §3/§4：设置中心入口（齿轮） -->
      <button class="theme-btn" :title="'设置'" type="button" @click="openSettings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.8" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
        </svg>
      </button>

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

    <!-- 操作失败提示（R-30）：同步中切库 / 启动同步被拒等后端文案在这里显示。
         固定定位浮层，不参与布局流——若做成顶栏下方的流内元素会把 .view-host 压矮，
         进而触发 GridScroller 的 ResizeObserver 重算行高/总高，照片墙会莫名抖一下。
         8 秒后自动消失，悬停暂停计时，也可点 × 立即关闭 -->
    <Transition name="toast">
      <div
        v-if="syncError"
        class="top-error"
        role="alert"
        @mouseenter="holdSyncError"
        @mouseleave="resumeSyncError"
      >
        <span class="top-error-dot" aria-hidden="true" />
        <span class="top-error-text">{{ syncError }}</span>
        <button class="top-error-close" type="button" aria-label="关闭提示" @click="syncError = ''">×</button>
      </div>
    </Transition>

    <!-- 路由出口：KeepAlive 仅缓存照片墙（返回详情页时保留滚动位置/已加载数据/搜索态），
         详情页不缓存（大图 DOM 无需常驻） -->
    <main class="view-host">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="['GridView']" :key="libraryEpoch">
          <component :is="Component" @deleted="onAssetsDeleted" />
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
              失败 {{ numberFormat.format(failureActiveCount) }}
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
            {{ failureFilter === 'active' ? '没有失败项目。' : '没有已忽略的项目。' }}
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
          忽略只会从失败提醒中移除该项目，不会删除文件；仍可在“已忽略”中恢复提醒。
        </footer>
      </section>
    </div>

    <!-- P0：无照片库时首次引导 / 手动新建照片库 -->
    <OnboardingView v-if="onboardingOpen" @close="onOnboardingClose" @switched="onOnboardingSwitch" />

    <!-- P0：iCloud 认证面板（首次链接 / cookie 过期重新链接 / 设置中心重新链接） -->
    <AuthDialog
      v-if="authDialogOpen && authTarget"
      :library-id="authTarget.id"
      :library-name="authTarget.name"
      :account="authTarget.account"
      :auto-start="authTarget.autoStart"
      @done="onAuthDone"
      @close="onAuthClose"
    />

    <!-- P0：设置中心（照片库管理 / 下载与同步 / 关于） -->
    <SettingsView
      v-if="settingsOpen"
      :auth-epoch="authEpoch"
      :import-request="importRequest"
      @close="closeSettings"
      @open-auth="openAuth"
      @new-library="closeSettings(); onboardingOpen = true"
      @library-deleted="onLibraryDeleted"
      @library-switched="applyLibrarySwitch"
    />
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
/* 操作失败提示浮层（R-30）：fixed 定位悬在照片墙上方，完全不参与布局流。
   早期版本是顶栏下的流内条，出现时会把 .view-host 压矮 30px 左右，
   触发 GridScroller 的 ResizeObserver → 重算行高 → 照片墙轻微跳动。
   层级 50：高于顶栏(10)与资源状态 popover(30)，低于设置中心(105)/引导(110)/认证(120) */
.top-error {
  position: fixed;
  top: 56px; /* 顶栏 44px + 12px 呼吸间距 */
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(620px, calc(100vw - 24px));
  padding: 9px 10px 9px 14px;
  border: 1px solid rgb(208 82 69 / 30%);
  border-radius: 10px;
  /* 兜底：不支持 color-mix 的浏览器直接用顶栏底色，仍可读 */
  background: var(--bg-topbar);
  background: color-mix(in srgb, var(--bg-topbar) 92%, #d05245 8%);
  box-shadow: 0 10px 28px rgb(0 0 0 / 22%);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: #d05245;
  font-size: 12px;
  line-height: 1.5;
}
/* 进出场动画：上方 6px 滑入/滑出 + 淡入淡出。
   注意 transform 必须带上 -50% 维持水平居中，否则动画期间会跳到左边 */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -6px);
}
.top-error-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.top-error-text { flex: 1; min-width: 0; word-break: break-word; }
.top-error-close {
  flex-shrink: 0;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: currentColor;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
}
.top-error-close:hover { opacity: 1; }
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
  transition: background 0.15s, color 0.15s;
}
.status-trigger:hover,
.status-trigger[aria-expanded='true'] {
  background: rgb(67 132 238 / 8%);
  color: #4384ee;
}
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
/* 导入行的两个出口（查看详情 / 取消）。与进度条同样左缩进 37px，对齐行图标右侧文字 */
.import-row-actions {
  display: flex;
  gap: 12px;
  margin: 8px 0 0 37px;
  font-size: 10px;
}
.row-action {
  padding: 0;
  border: 0;
  background: transparent;
  color: #4384ee;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.row-action:hover { text-decoration: underline; }
.row-action.danger { color: #d05245; }
.row-action.muted { color: var(--text-3); cursor: default; }
.row-action.muted:hover { text-decoration: none; }
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
/* F-02 队列指标行：与缩略图统计对齐（margin-left 37px），上边框虚线区分 */
.queue-metrics {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 5px 10px;
  margin: 10px 0 0 37px;
  padding-top: 9px;
  border-top: 1px dashed var(--border);
  color: var(--text-2);
  font-size: 10px;
}
.queue-metrics b { color: var(--text-1); font-weight: 600; }
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

/* ===== P0 同步按钮：按钮本体样式已移入共享组件 SyncButton.vue；此处仅保留状态提示行 ===== */
/* 状态/提示行：按钮下方独立一行，不再跟按钮横向挤 */
.sync-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  min-height: 15px;
}
.sync-note {
  min-width: 0;
  max-width: 260px;
  overflow: hidden;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-meta:empty { display: none; }
/* 状态行：文字中性灰，颜色信号走前置小圆点 */
.sync-note.info { color: var(--text-2); }
.sync-note.warn { color: var(--text-2); }
.sync-note.ok { color: var(--text-2); }
.sync-note.err { color: var(--text-2); }
.sync-note.muted { color: var(--text-3); }
.sync-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--text-3);
  vertical-align: 1px;
}
.sync-note.info .sync-dot { background: #4384ee; }
.sync-note.warn .sync-dot { background: #d97706; }
.sync-note.ok .sync-dot { background: #16a34a; }
.sync-note.err .sync-dot { background: #d05245; }
/* 进行中/等待时圆点 pulse 动画 */
.sync-note.info .sync-dot,
.sync-note.warn .sync-dot { animation: sync-dot-pulse 1.6s ease-in-out infinite; }
@keyframes sync-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

/* ===== P0 认证过期入口（同步按钮旁，仅 expired 显示） ===== */
.relink-btn {
  padding: 3px 8px;
  border: 1px solid #d9a13b;
  border-radius: 6px;
  background: rgb(255 159 10 / 9%);
  color: #a87515;
  font: inherit;
  font-size: 10px;
  white-space: nowrap;
  cursor: pointer;
}
.relink-btn:hover { background: rgb(255 159 10 / 16%); }

/* ===== P0 右上角库切换下拉 ===== */
.lib-menu-wrap { position: relative; }
.lib-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.lib-trigger:hover,
.lib-trigger[aria-expanded='true'] {
  background: rgb(67 132 238 / 8%);
  border-color: #4384ee;
  color: #4384ee;
}
.lib-trigger-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-trigger .chev {
  width: 11px;
  height: 11px;
  flex: 0 0 auto;
  fill: none;
  stroke: var(--text-2);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.15s;
}
.lib-trigger .chev.open { transform: rotate(180deg); }
.lib-menu {
  position: absolute;
  top: 36px;
  right: 0;
  z-index: 40;
  width: 210px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-panel);
  box-shadow: 0 12px 32px rgb(0 0 0 / 16%);
}
.lib-menu-label {
  padding: 4px 8px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 700;
}
.lib-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.lib-item:hover { color: #4384ee; }
/* 当前库：蓝色浅底 + 蓝色 ✓（唯一带底色的项，避免双底色） */
.lib-item.current { background: rgb(67 132 238 / 10%); }
.lib-check { color: #4384ee; font-weight: 700; width: 14px; flex: 0 0 auto; }
.lib-item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-item.new { color: #4384ee; }
.lib-item.new:hover { color: #356fd6; }
.lib-plus { font-weight: 700; width: 14px; flex: 0 0 auto; }
.lib-menu-sep { height: 1px; margin: 6px 0; background: var(--border); }

/* 主题切换按钮（顶栏最右） */
.theme-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, transform 0.15s;
}
.theme-btn:hover {
  background: rgb(67 132 238 / 8%);
  color: #4384ee;
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
