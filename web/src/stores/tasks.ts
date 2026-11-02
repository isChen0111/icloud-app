/**
 * 全局任务状态 store —— 前端唯一的 /api/stats 轮询源
 *
 * 为什么需要它：
 *   改造前有 5 个各自为政的轮询（App 5s 拉 stats、设置页 5s 拉库列表、
 *   引导页 2s 拉 sync、导入弹窗 2s 拉 import、认证弹窗 1s 拉 auth），
 *   彼此节奏不一致、状态来自不同时间点，且全都没有「页面在后台就停表」。
 *   更麻烦的是 App 的 pollInProgress 防重入会**吞掉**手动刷新：
 *   runSync 之后 `await pollStats()` 若撞上在飞请求会立即返回，
 *   调用方以为已刷新，UI 实际没变 —— 设置中心那个「启动中…」占位态
 *   就是为补这个洞而生的。
 *
 * 现在：
 *   - 只有一个定时器（递归 setTimeout，每轮按当时状态重算间隔，天然不堆积）
 *   - 任务状态由「轮询 + 动作写回」共同维护；写回不吞、不假刷新
 *   - 弹窗只 subscribe 提升频率，不再自己发请求
 *   - 页面隐藏即停表，回到前台立刻补拉一次
 *
 * 约定：只有 App.vue 调 start()/stop()。弹窗用 subscribe()，**App 不要订阅** ——
 * 否则空闲档永远是 1.5 秒，自适应就失去意义了。
 */
import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  fetchStats,
  startSync as apiStartSync,
  cancelSync as apiCancelSync,
  startLocalImport as apiStartLocalImport,
  cancelImport as apiCancelImport,
} from '../api/client'
import type { Stats, SyncState, ImportState } from '../types'
import { useAssetStore } from './assets'

/** 有任务在跑（或弹窗打开）时的轮询间隔：进度条要跟得上 */
export const ACTIVE_INTERVAL_MS = 1500
/** 空闲间隔：只维持顶栏计数与任务是否新起的感知 */
export const IDLE_INTERVAL_MS = 15_000
/** 请求失败后的重试间隔（后端重启中要能自己回来） */
export const OFFLINE_INTERVAL_MS = 5_000
/** 连续失败这么多次后放宽到空闲间隔，避免长时间连不上时一直 5 秒打空 */
export const OFFLINE_SLOW_AFTER = 10
/** 发现「响应比本地写回旧」时，隔这么久再补拉一次 */
const STALE_RETRY_MS = 300

export const useTaskStore = defineStore('tasks', () => {
  const assetStore = useAssetStore()

  /* ---------------- 状态 ---------------- */

  /**
   * 最近一次成功的服务端快照。
   * 用 shallowRef：整个对象一次性替换，且 sync.log / import.failures 各可达 200 条，
   * 没必要为它们建立深层响应式。
   */
  const snapshot = shallowRef<Stats | null>(null)
  /** 对外只读视图 */
  const stats = computed(() => snapshot.value)
  /** 最近一次请求是否成功（顶栏「正在连接照片库」判断、引导页重试用） */
  const online = ref(false)
  /** 连续失败次数（决定退避间隔） */
  const failures = ref(0)
  /** 当前打开的弹窗数量 */
  const subscriberCount = ref(0)

  /* ---------------- 派生 ---------------- */

  const sync = computed<SyncState | null>(() => snapshot.value?.sync ?? null)
  const importState = computed<ImportState | null>(() => snapshot.value?.import ?? null)
  const scan = computed(() => snapshot.value?.scan ?? null)
  const library = computed(() => snapshot.value?.library ?? null)

  const syncBusy = computed(() => {
    const s = sync.value
    return s?.status === 'running' || s?.status === 'waiting_retry'
  })
  /**
   * 导入是否仍在进行。
   * 「已取消但还没写 finishedAt」也算 —— 后端 cancelImport 只置 status='cancelled'，
   * 真正的收尾（含随后那次 runScan）要等流水线退出循环，此时进度还在变。
   */
  const importBusy = computed(() => {
    const i = importState.value
    if (!i) return false
    return i.status === 'running' || (i.status === 'cancelled' && i.finishedAt == null)
  })
  const scanBusy = computed(() => scan.value?.status === 'scanning')
  const thumbsBusy = computed(() => snapshot.value?.thumbnails.status === 'preparing')
  const hasActiveTask = computed(
    () => scanBusy.value || thumbsBusy.value || syncBusy.value || importBusy.value,
  )
  /** GridScroller 的并发上限（替代它自己 fetchStats 的那一次请求） */
  const thumbConcurrency = computed(() => snapshot.value?.thumbConcurrency ?? 8)

  /** 当前应使用的轮询间隔（每轮重新求值） */
  const pollInterval = computed(() => {
    if (!snapshot.value || !online.value) {
      return failures.value >= OFFLINE_SLOW_AFTER ? IDLE_INTERVAL_MS : OFFLINE_INTERVAL_MS
    }
    return hasActiveTask.value || subscriberCount.value > 0 ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS
  })

  /* ---------------- 定时器与请求状态（私有闭包） ---------------- */

  let started = false
  let hidden = typeof document !== 'undefined' && document.hidden
  let timer: number | undefined
  /** 当前定时器预计触发的时刻（提前重排时用，避免频繁 clearTimeout） */
  let timerDueAt = 0
  /** 正在飞的请求：默认让所有调用方共享它，而不是各自丢弃 */
  let inFlight: Promise<Stats | null> | null = null
  /** 请求序号：只有最后发起的那次响应能落地 */
  let sequence = 0
  /** 写回代数：任何本地写回 +1，用来识别「这份响应比我手里的旧」 */
  let stateEpoch = 0
  /** 扫描基线：首轮只建立基线，不当成「扫描完成」 */
  let baselineRunId: number | null = null
  let baselineStatus: Stats['scan']['status'] = 'idle'

  function clearTimer(): void {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
    timerDueAt = 0
  }

  function schedule(delay: number): void {
    if (!started || hidden) return
    clearTimer()
    timerDueAt = Date.now() + delay
    timer = window.setTimeout(() => {
      timer = undefined
      timerDueAt = 0
      void refresh()
    }, delay)
  }

  /**
   * 把下一次刷新提前到「不晚于 ms 之后」。已经更早就不动。
   * 不直接发请求 —— 否则状态一变化就递归拉取，会把定时器语义搞乱。
   */
  function ensureWithin(ms: number): void {
    if (!started || hidden) return
    if (timer === undefined) {
      schedule(ms)
      return
    }
    if (timerDueAt - Date.now() > ms) schedule(ms)
  }

  /* ---------------- 核心：拉取 ---------------- */

  /**
   * 拉一次快照。
   * - 默认：已有请求在飞就**共享同一个 Promise**，所有调用方 await 同一次请求
   *   并拿到同一份新快照（旧实现是直接 return，调用方以为刷新过了）
   * - force：强制另发一次（手动刷新 / 可见性恢复 / 动作后补拉）。旧请求的结果
   *   会被 sequence 守卫丢弃，所以 force 绝不会被旧数据覆盖
   * 永不 reject：失败只置 online=false，调用方不需要 try/catch。
   */
  function refresh(opts: { force?: boolean } = {}): Promise<Stats | null> {
    if (inFlight && opts.force !== true) return inFlight
    const seq = ++sequence
    const epoch = stateEpoch
    const request: Promise<Stats | null> = fetchStats()
      .then((next) => {
        if (seq !== sequence) return null // 已被更新的请求取代
        if (stateEpoch !== epoch) {
          // 期间本地写回过更新的任务状态，这份可能过期 → 丢弃并很快补拉
          ensureWithin(STALE_RETRY_MS)
          return null
        }
        applySnapshot(next)
        return next
      })
      .catch((err: unknown) => {
        if (seq !== sequence) return null
        failures.value += 1
        online.value = false
        // 保留 snapshot：顶栏计数不会因为一次抖动就闪成「等待后端启动…」
        console.warn('[tasks] 拉取 /api/stats 失败:', (err as Error).message)
        return null
      })
      .finally(() => {
        if (inFlight === request) inFlight = null
        if (seq === sequence) schedule(pollInterval.value)
      })
    inFlight = request
    return request
  }

  /* ---------------- 快照落地 ---------------- */

  function applySnapshot(next: Stats): void {
    const prev = snapshot.value
    snapshot.value = next
    online.value = true
    failures.value = 0

    // 后端热切换 / 删库后接管：库变了，扫描基线作废，
    // 否则新库的第一个快照会被误判成「扫描完成」而触发一次无谓的照片墙重建
    if (prev && prev.library?.id !== next.library?.id) baselineRunId = null

    detectScanCompletion(next)
    // 这一份快照可能刚显示出「有任务了」，把空闲档立刻提到活跃档
    ensureWithin(pollInterval.value)
  }

  /**
   * 扫描完成 → 刷新照片墙。
   * 这是原先耦合在 App 的 pollStats 里的副作用，移到「状态变化」处：
   * 它不该由「轮询到这个动作」触发，失败也不该像旧实现那样 return 掉基线推进。
   */
  function detectScanCompletion(next: Stats): void {
    const { runId, status } = next.scan
    const galleryEmpty = assetStore.totalCount === 0
    /** 本次扫描刚结束（runId 变了，或上一轮还在 scanning） */
    const justFinished =
      (status === 'done' || status === 'error') &&
      (runId !== baselineRunId || baselineStatus === 'scanning')
    /** 扫描进行中已入库一批、照片墙还是空的 → 先出一屏，不必等扫描结束 */
    const needFirstScreen = status === 'scanning' && next.assets > 0 && galleryEmpty
    /** 冷启动首份快照就是终态（后端先跑完扫描，前端才打开） */
    const firstBaseline =
      baselineRunId === null && galleryEmpty && (status === 'done' || status === 'error')

    baselineRunId = runId
    baselineStatus = status
    if (!justFinished && !needFirstScreen && !firstBaseline) return

    void assetStore.refresh().catch((err: unknown) => {
      console.error('[tasks] 扫描后刷新照片墙失败:', err)
      // 基线回退，下一轮重试（旧实现这里是 return，基线推进被静默跳过）
      baselineRunId = null
      baselineStatus = 'scanning'
    })
  }

  /* ---------------- 写回（动作返回值归位） ---------------- */

  /** 把动作返回的最新任务状态并进快照 */
  function patch(p: Partial<Stats>): void {
    stateEpoch += 1
    if (!snapshot.value) {
      // 还没有基准快照：不伪造，直接拉一次（后端已经生效，下一次 GET 就是真相）
      void refresh({ force: true })
      return
    }
    snapshot.value = { ...snapshot.value, ...p }
    ensureWithin(pollInterval.value)
  }

  /**
   * 启动同步。
   * 后端在 spawn 子进程之前就同步写好了 status='running'，所以这个返回值就是
   * 最新状态，直接写回即可 —— 这正是「启动中…」占位态可以删掉的原因。
   * 注意 /sync 的 publicState 不含 log，需要自己补（新一轮日志从空开始）。
   */
  async function startSync(libId: number, kind: 'full' | 'inc'): Promise<SyncState> {
    const res = await apiStartSync(libId, kind)
    const next: SyncState = { ...res.sync, log: [] }
    patch({ sync: next })
    return next
  }

  /** 取消同步：后端同步置 cancelled，返回值即终态；日志保留（用户常要回看） */
  async function cancelSync(libId: number): Promise<SyncState> {
    const res = await apiCancelSync(libId)
    const next: SyncState = { ...res.sync, log: snapshot.value?.sync.log ?? [] }
    patch({ sync: next })
    return next
  }

  /** 启动本机目录导入：返回时 totalFiles 仍为 0（真实总数要等遍历完源目录） */
  async function startLocalImport(
    libId: number,
    dirPath: string,
    mode: 'copy' | 'move',
  ): Promise<ImportState> {
    const res = await apiStartLocalImport(libId, dirPath, mode)
    patch({ import: res.import })
    return res.import
  }

  /** 取消导入：返回 cancelled 但 finishedAt 仍为 null（非终态，后续靠轮询收尾） */
  async function cancelImport(libId: number): Promise<ImportState> {
    const res = await apiCancelImport(libId)
    patch({ import: res.import })
    return res.import
  }

  /** 上传完成后由组件把状态交回来（上传本身带进度回调，不适合搬进 store） */
  function applyImport(next: ImportState): void {
    patch({ import: next })
  }

  /* ---------------- 订阅者 ---------------- */

  /**
   * 弹窗在 onMounted 里调用，拿到 release 在 onBeforeUnmount 里调用。
   * 计数 > 0 期间频率拉到活跃档；归零后不主动延长当前定时器，
   * 等下一轮自然回落（最多多打一次请求，比反复重排简单且安全）。
   */
  function subscribe(): () => void {
    subscriberCount.value += 1
    ensureWithin(ACTIVE_INTERVAL_MS)
    let released = false
    return () => {
      if (released) return
      released = true
      subscriberCount.value = Math.max(0, subscriberCount.value - 1)
    }
  }

  /* ---------------- 生命周期（只有 App 调） ---------------- */

  function onVisibilityChange(): void {
    const nextHidden = document.hidden
    if (nextHidden === hidden) return
    hidden = nextHidden
    if (hidden) {
      clearTimer()
      return
    }
    // 回到前台：立刻补拉一次，finally 里会按当下状态重排
    void refresh({ force: true })
  }

  function start(): void {
    if (started) return
    started = true
    hidden = typeof document !== 'undefined' && document.hidden
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (hidden) return // 后台标签页启动：等可见再说
    schedule(0) // 立刻拉一次
  }

  function stop(): void {
    if (!started) return
    started = false
    clearTimer()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  return {
    // 状态
    stats,
    online,
    failures,
    subscriberCount,
    // 派生
    sync,
    importState,
    scan,
    library,
    syncBusy,
    importBusy,
    scanBusy,
    thumbsBusy,
    hasActiveTask,
    thumbConcurrency,
    pollInterval,
    // 动作
    refresh,
    startSync,
    cancelSync,
    startLocalImport,
    cancelImport,
    applyImport,
    subscribe,
    start,
    stop,
  }
})
