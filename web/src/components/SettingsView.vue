<script setup lang="ts">
/**
 * 设置中心（设计稿 ④）
 *
 * 左侧导航：照片库管理（默认）/ 下载与同步 / 关于
 * - 照片库管理：每库一张卡片（库名、「当前」、链接状态、账号/目录/缓存、重新链接、
 *   删除按钮[仅样式，功能待定]、每库同步四态按钮——与主界面共享全局单任务状态）
 * - 下载与同步：icloudpd 默认参数只读展示（按官方默认值锁死，代码预留、暂不可编辑；
 *   删除类参数不提供）
 * - 关于：应用信息
 *
 * 多库约束：icloudpd 同步全局单任务——某库执行时其他库点「执行」→ 后端 409 → 提示等待已有任务完成（不排队）；
 * 态（disabled），全局任务释放后自动恢复。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchLibraries, deleteLibrary, updateLibraryConfig, switchLibrary } from '../api/client'
import { useTaskStore } from '../stores/tasks'
import type { LibraryInfo } from '../types'
import SyncButton from './SyncButton.vue'
import ImportDialog from './ImportDialog.vue'
import { version as appVersion } from '../../package.json'

/**
 * 任务状态（同步进度、全局是否忙碌）统一从 tasks store 读 ——
 * 以前靠 App 用 props 传 stats 下来，不仅多一条数据通道，
 * 同步状态还只有 5 秒轮询粒度；现在订阅 store 即可拿到 1.5 秒的活跃频率。
 */
const tasks = useTaskStore()
const stats = computed(() => tasks.stats)

const props = withDefaults(defineProps<{
  /**
   * 认证纪元：App 在「认证成功 / 认证面板关闭」时 +1。
   *
   * 为什么需要它：本页的库列表刷新依赖 taskSignature，而 stats.library 只返回
   * **当前激活库**。在非激活库上完成认证时，后端已经把 auth_status 改成 authed，
   * 但签名不变 → 列表不重拉 → 卡片继续显示「未链接」，要切库才恢复
   * （2026-11-03 修复的「认证成功仍显示未链接」就是这条）。
   */
  authEpoch?: number
  /**
   * App 发来的「打开该库的导入弹窗」请求（顶栏/浮层点「查看导入详情」）。
   *
   * 为什么用对象而不是 libId：同一个库连点两次时 id 不变，watch 不会触发；
   * 每次都是新对象（带自增 seq）则天然可靠。App 关闭设置页时会把请求清空，
   * 否则下次手动打开设置页（组件重新挂载 + watch immediate）会莫名其妙弹出导入窗。
   */
  importRequest?: { libId: number; seq: number } | null
}>(), {
  authEpoch: 0,
  importRequest: null,
})

const emit = defineEmits<{
  close: []
  'open-auth': [lib: { id: number; name: string; account: string | null }]
  'new-library': []
  'library-deleted': [payload: { id: number; wasActive: boolean }]
  /**
   * 已切到另一个库：由 App 完成视图重建（photos 墙/搜索/选中/任务快照），本页不自己刷新。
   * 设置页只是「发起点」，重建责任必须留在 App——设置页卸载/重挂时不该影响照片墙。
   */
  'library-switched': [payload: { id: number; name: string }]
}>()

type Tab = 'libs' | 'about'
const tab = ref<Tab>('libs')
const libraries = ref<LibraryInfo[]>([])
const loading = ref(false)
/**
 * 渲染顺序：当前库恒排第一。
 *
 * 高亮只解决「看到之后好不好认」，没解决「还得先滚到它」。库一多（3 个以上）当前库
 * 就落到折叠线以外，用户仍然要先滚一遍再找——这正是「每次都得找那个当前标签」的根因。
 * 置顶的副作用是切库瞬间卡片会跳到顶部：这里当成正向反馈，「它跑上来了 = 切成功了」。
 */
const orderedLibraries = computed(() => {
  const active = libraries.value.filter((l) => l.active)
  if (active.length === 0) return libraries.value
  return [...active, ...libraries.value.filter((l) => !l.active)]
})
/** 每库已选待执行：{ [libId]: 'full'|'inc' } */
const pick = ref<Record<number, 'full' | 'inc' | null>>({})
/** 展开「iCloud 同步设置」的库 id（点击库卡片的配置下拉展开/收起） */
const configOpen = ref<number | null>(null)
/** 展开「运行日志」的库 id（点击折叠展开/收起） */
const logOpen = ref<number | null>(null)
/** icloudpd 原始输出日志行（全局单任务，仅当 stats.sync.libraryId 匹配该库时展示） */
const syncLogLines = computed(() => stats.value?.sync.log ?? [])
const syncError = ref('')
/** 删除确认弹窗（仅本地删除；复选框决定是否连同本地照片副本一起删） */
const deleteTarget = ref<LibraryInfo | null>(null)
/** 「同时删除本地照片副本」默认不勾选（R-21：安全默认值，每次打开弹窗重置） */
const removePhotos = ref(false)
/** 勾选删照片后的二次确认：第一次点「删除」只做武装，第二次才真正执行 */
const photoConfirmArmed = ref(false)
const deleting = ref(false)
const deleteError = ref('')
/** 正在切换的库 id（「切换照片库」按钮的 loading 态，兼防连点） */const switchingId = ref<number | null>(null)
/** 最近一次切换失败的库 id（把 409 文案挂到该库卡片下） */
const switchFailId = ref<number | null>(null)

/**
 * 刚切换成功的库 id（1.4 秒后自动清空），只用于给那张卡片补一次高亮脉冲。
 *
 * 为什么需要它：切库成功后本页做的其实是「重拉列表 → 胶囊换字 + 提示条换按钮行」，
 * 两个变化都发生在文字层。而当前库恒排第一，卡片是瞬移的——没有位移参照，
 * 用户会以为没点动（2026-11-04 实测反馈：「差点以为没切换过去」）。
 * 主反馈交给 TransitionGroup 的 move 位移，这个状态负责第二层：视线停在哪都能看到一圈扩散。
 */
const justSwitchedId = ref<number | null>(null)
let pulseTimer: number | undefined

/** 设置面板的滚动容器：切库后卡片被重排到顶部，必须把它带回视野，否则动画发生在视口外 */
const panelEl = ref<HTMLElement | null>(null)
/** 待导入的照片库（打开 ImportDialog；null=关闭） */
const importTarget = ref<LibraryInfo | null>(null)

/** 配置区草稿（每库一份）：展开配置时初始化，保存成功后回写 libraries */
type ConfigDraft = { untilFound: number; recentLimit: number; saving: boolean; saved: boolean }
const drafts = ref<Record<number, ConfigDraft>>({})

function openConfig(lib: LibraryInfo): void {
  configOpen.value = configOpen.value === lib.id ? null : lib.id
  if (configOpen.value === lib.id && !drafts.value[lib.id]) {
    drafts.value[lib.id] = {
      untilFound: lib.untilFound ?? 20,
      recentLimit: lib.recentLimit ?? 0,
      saving: false,
      saved: false,
    }
  }
}

async function saveConfig(lib: LibraryInfo): Promise<void> {
  const d = drafts.value[lib.id]
  if (!d || d.saving) return
  const untilFound = Math.max(1, Math.floor(Number(d.untilFound) || 20))
  const recentLimit = Math.max(0, Math.floor(Number(d.recentLimit) || 0))
  d.saving = true
  d.saved = false
  try {
    await updateLibraryConfig(lib.id, { untilFound, recentLimit })
    d.saving = false
    d.saved = true
    // 回写本地列表
    const idx = libraries.value.findIndex((l) => l.id === lib.id)
    if (idx >= 0) {
      libraries.value[idx] = { ...libraries.value[idx], untilFound, recentLimit }
    }
    window.setTimeout(() => { d.saved = false }, 1500)
  } catch (err) {
    d.saving = false
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

function openDelete(lib: LibraryInfo): void {
  deleteTarget.value = lib
  // 安全默认值（R-21）：每次打开都从「不删照片副本」开始，删整库原片必须手动勾选 + 二次确认
  removePhotos.value = false
  photoConfirmArmed.value = false
  deleteError.value = ''
}

async function confirmDelete(): Promise<void> {
  const lib = deleteTarget.value
  if (!lib || deleting.value) return
  // 勾选了「同时删除照片副本」→ 第一次点击只是二次确认（防一次误点递归删掉整库原片）
  if (removePhotos.value && !photoConfirmArmed.value) {
    photoConfirmArmed.value = true
    return
  }
  deleting.value = true
  deleteError.value = ''
  try {
    const wasActive = lib.active
    await deleteLibrary(lib.id, removePhotos.value)
    // 删除激活库 → 整页刷新（切库/回无库，前端状态全重置）
    // 删除非激活库 → 主页数据不受影响，仅本地移除，不刷新主页
    if (wasActive) {
      location.reload()
      return
    }
    libraries.value = libraries.value.filter((l) => l.id !== lib.id)
    deleteTarget.value = null
    deleteError.value = ''
    deleting.value = false
    emit('library-deleted', { id: lib.id, wasActive: false })
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : String(err)
    deleting.value = false
  }
}

/** 全局同步任务是否忙碌（主界面与设置中心共享同一份任务快照） */
function globalBusy(): boolean {
  return tasks.syncBusy
}
/** 某库自己是否正在执行任务 */
function thisLibBusy(id: number): boolean {
  return globalBusy() && stats.value?.sync.libraryId === id
}
/** 其他库正在执行（本库点执行会进入等待执行） */
function otherBusy(id: number): boolean {
  return globalBusy() && stats.value?.sync.libraryId !== id
}
/** 本库能否发起同步：未链接 / 会话过期一律前端锁死（后端也会 409，但没必要让用户白点） */
function authLocked(lib: LibraryInfo): boolean {
  return lib.authStatus !== 'authed'
}
function authLockHint(lib: LibraryInfo): string {
  return lib.authStatus === 'expired'
    ? 'iCloud 会话已过期，请重新登录后再同步'
    : '尚未链接 iCloud，请先登录后再同步'
}
/** 状态行颜色：蓝=进行中 黄=等待 绿=完成 红=失败 */
function syncStatusClass(status?: string): string {
  if (status === 'running') return 'info'
  if (status === 'waiting_retry') return 'warn'
  if (status === 'done') return 'ok'
  if (status === 'error') return 'err'
  return ''
}

async function loadLibraries(): Promise<void> {
  loading.value = true
  try {
    libraries.value = (await fetchLibraries()).libraries
  } catch {
    // 后端未就绪，保持旧列表
  } finally {
    loading.value = false
  }
}

/**
 * 库列表的刷新时机：不再 5 秒死循环拉一次。
 *
 * 旧实现每 5 秒调一次 /api/libraries，而后端要为**每个库**开一次只读 SQLite 连接
 * 跑 COUNT（含非激活库），纯粹是为了「解除启动中占位 + 跟上同步状态」。
 * 现在同步状态直接来自 tasks store，库列表只在「可能真的变了」时重拉：
 * 扫描轮次/状态、同步状态与归属、导入状态、激活库变化。
 * 300ms 防抖是为了合并「导入结束 → 立刻触发全库扫描」这种连续跳变。
 */
const taskSignature = computed(() => {
  const s = stats.value
  if (!s) return ''
  return [
    s.library?.id ?? 0,
    s.library?.authStatus ?? '',
    s.scan.runId,
    s.scan.status,
    s.sync.status,
    s.sync.libraryId,
    s.import.status,
  ].join('|')
})

let reloadTimer: number | undefined
watch(taskSignature, (next, prev) => {
  // 首次快照不算「变化」：onMounted 已经主动拉过一次，避免打开设置页就请求两遍
  if (!next || !prev || next === prev) return
  window.clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => void loadLibraries(), 300)
})

/**
 * 认证纪元变化 → 直接重拉库列表（不防抖）。
 * 认证成功/关闭面板是低频且明确的「列表一定变了」事件，等下一次 stats 签名变化
 * 在非激活库场景下根本等不到（见 props.authEpoch 注释）。
 */
watch(() => props.authEpoch, () => void loadLibraries())

function pickSync(libId: number, kind: 'full' | 'inc'): void {
  pick.value = { ...pick.value, [libId]: kind }
  syncError.value = ''
}

async function runSync(libId: number): Promise<void> {
  const kind = pick.value[libId]
  if (!kind) return
  syncError.value = ''
  try {
    // 后端返回的就是「已开始」的状态，store 直接写回快照 →
    // 按钮这一刻就进「取消」态，不再需要「启动中…」占位
    await tasks.startSync(libId, kind)
    pick.value = { ...pick.value, [libId]: null }
  } catch (err) {
    // 失败（全局已有 icloudpd 任务占用 / 非激活库等）：保留已选操作并提示，用户可稍后重试
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 切换照片库（只切换，不启动同步）。
 *
 * 与顶栏下拉的 pickLibrary 同一语义：后端热切换（停旧 watcher → 清缩略图队列 → 关旧 DB → 覆写 config
 * → 重开 DB → 扫新库 → 启 watcher）。
 *
 * 成功后**不再 location.reload()**：以前刷新会把设置页一起关掉，用户切完库就被弹回照片墙，
 * 想接着调另一张卡的配置得重新点进来。现在只通知 App 做视图重建（见 applyLibrarySwitch），
 * 本页自己把库列表重拉一遍，并给重排补上位移 + 一次性高亮（见 justSwitchedId 的注释）。
 *
 * 之所以单独给一个按钮：有时用户只想切过去看看，并不想拉取；同步中/扫描中后端会 409，
 * 文案挂在对应卡片下。
 */
async function switchTo(lib: LibraryInfo): Promise<void> {
  if (switchingId.value != null) return
  switchingId.value = lib.id
  switchFailId.value = null
  syncError.value = ''
  try {
    await switchLibrary(lib.id)
  } catch (err) {
    // 同步执行中 / 扫描中会有 409 文案，就地提示
    syncError.value = err instanceof Error ? err.message : String(err)
    switchFailId.value = lib.id
    switchingId.value = null
    return
  }
  // 先通知 App（它会重建照片墙并重新拉 stats），再重拉本页列表。
  // 不 await 通知里的刷新：那是 App 的活，本页只要自己这份数据是新的
  emit('library-switched', { id: lib.id, name: lib.name })
  await loadLibraries()
  // 列表已按「当前库置顶」重排完，再决定「看不看得见这次重排」：
  // 用户很可能是在第 3 张卡上点的切换，卡片滑到顶部却在视口外——动画白做
  await nextTick()
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  panelEl.value?.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
  // 脉冲与位移并行：位移说明「它上来了」，脉冲说明「就是这一张」
  window.clearTimeout(pulseTimer)
  justSwitchedId.value = lib.id
  pulseTimer = window.setTimeout(() => { justSwitchedId.value = null }, 1400)
  switchingId.value = null
}

/**
 * 打开「导入本地照片目录」弹窗。
 * 导入只允许对当前激活库执行（后端 runScan 只能扫激活库）。非激活库的按钮已禁用，
 * 这里保留守卫防止其他入口误调。
 */
function openImport(lib: LibraryInfo): void {
  if (!lib.active) return
  importTarget.value = lib
}

/**
 * 待打开的导入请求（顶栏点「查看导入详情」时 App 会先打开本页）。
 * 库列表是异步拉的，这一刻 libraries 可能还是空数组——先记下来，加载完再开。
 * 不是激活库就继续等（导入只允许对激活库执行，App 传来的库里也只有激活库）。
 */
const pendingImportLibId = ref<number | null>(null)

function tryOpenPendingImport(): void {
  const id = pendingImportLibId.value
  if (id == null) return
  const lib = libraries.value.find((l) => l.id === id)
  if (!lib || !lib.active) return
  pendingImportLibId.value = null
  importTarget.value = lib
}

watch(
  () => props.importRequest,
  (req) => {
    if (!req) return
    pendingImportLibId.value = req.libId
    tryOpenPendingImport()
  },
  { immediate: true },
)

watch(libraries, tryOpenPendingImport)

/**
 * 「导入照片」按钮的文案：该库正在导入时直接显示进度。
 *
 * 这是关掉导入弹窗后最容易被发现的落点——用户到设置页想再导入一次，看到按钮上写着
 * 「导入中 37%」就知道任务还在跑，点一下即可回到进度视图（弹窗会自己识别进行中）。
 */
function importButtonText(lib: LibraryInfo): string {
  const i = stats.value?.import
  if (!i || i.libraryId !== lib.id) return '导入照片'
  const busy = i.status === 'running' || (i.status === 'cancelled' && i.finishedAt == null)
  if (!busy) return '导入照片'
  if (i.phase === 'scanning') return '正在入库…'
  if (i.totalFiles > 0) {
    return `导入中 ${Math.min(100, Math.floor((i.processedFiles / i.totalFiles) * 100))}%`
  }
  return '导入中…'
}

/** 刚复制了哪个字段（`libId:root|cache|cookie`），用于按钮上「已复制」的短暂反馈 */
const copiedKey = ref('')

/**
 * 复制库相关路径到剪贴板（目录 / 缓存 / 会话）。
 *
 * 只做「复制」不提供「在资源管理器中打开」：后端可能就是另一台机器（上传导入正是这个场景），
 * 在服务端点开只会在那台机器上弹窗，本机用户看不到，反而误导。复制后粘到地址栏最稳。
 * localhost 属于安全上下文可用 clipboard API；局域网 IP 访问时退回 execCommand。
 */
async function copyPath(lib: LibraryInfo, field: 'root' | 'cache' | 'cookie'): Promise<void> {
  const text = field === 'root' ? lib.libraryRoot : field === 'cache' ? lib.cacheDir : lib.cookieDir
  if (!text) return
  const key = `${lib.id}:${field}`
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    copiedKey.value = key
    window.setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = ''
    }, 1600)
  } catch {
    // 复制失败不阻断：路径文本本身可手动选中
  }
}

/**
 * iCloud 同步设置摘要（折叠状态下也显示）：把两个最常调、也最容易忘的参数摆在明面上。
 * - 连续命中数：只作用于增量同步（--until-found），是「停」的条件而不是数量；
 * - 下载限量：--recent，全量与增量都会追加，0 = 全部。
 */
function configBrief(lib: LibraryInfo): string {
  const untilFound = lib.untilFound ?? 20
  const recentLimit = lib.recentLimit ?? 0
  return `增量：命中 ${untilFound} 个即停 · 下载：${recentLimit > 0 ? `最近 ${recentLimit} 张` : '全部'}`
}

/** 摘要行的完整解释（hover 提示），把「作用范围」也讲清楚 */
function configBriefTitle(lib: LibraryInfo): string {
  const untilFound = lib.untilFound ?? 20
  const recentLimit = lib.recentLimit ?? 0
  const limitText = recentLimit > 0 ? `只处理最近 ${recentLimit} 张` : '全部（不限数量）'
  return `增量同步：往回扫描时连续遇到 ${untilFound} 个本地已存在的文件即停止。下载限量：${limitText}，全量与增量同步都生效。`
}

async function cancelSyncRun(libId: number): Promise<void> {
  syncError.value = ''
  try {
    // 取消是同步生效的（后端写完 cancelled 才返回），store 写回后按钮立刻回空闲
    await tasks.cancelSync(libId)
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 「更多」菜单：同时只允许一个库展开。
 *
 * 目的是把低频/危险操作（重新登录、删除）从标题行的按钮群里移出去——
 * 之前一行能挤四个按钮（切换 / 刷新链接 / 导入 / 删除），视觉上分不出主次，
 * 删除这种不可逆操作和「导入」并排也容易误点。
 */
const menuLibId = ref<number | null>(null)

function toggleMenu(id: number): void {
  menuLibId.value = menuLibId.value === id ? null : id
}

function closeMenu(): void {
  menuLibId.value = null
}

/** 关闭时释放订阅（任务在跑则仍按活跃频率轮询，不受影响） */
let releaseTasks: (() => void) | null = null

onMounted(() => {
  // 设置中心打开期间把轮询提到活跃档（1.5s），关闭后自然回落
  releaseTasks = tasks.subscribe()
  void loadLibraries()
  window.addEventListener('click', closeMenu)
})
onBeforeUnmount(() => {
  releaseTasks?.()
  window.clearTimeout(reloadTimer)
  window.clearTimeout(pulseTimer)
  window.removeEventListener('click', closeMenu)
})
</script>

<template>
  <div class="settings-backdrop" role="presentation" @click.self="emit('close')">
    <section class="settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings-header">
        <strong id="settings-title">设置</strong>
        <button class="settings-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <div class="settings-body">
        <!-- 左侧导航 -->
        <nav class="settings-nav">
          <div class="settings-nav-label">照片库</div>
          <button class="settings-nav-item" :class="{ selected: tab === 'libs' }" type="button" @click="tab = 'libs'">
            照片库管理
          </button>
          <div class="settings-nav-label gap">应用</div>
          <button class="settings-nav-item" :class="{ selected: tab === 'about' }" type="button" @click="tab = 'about'">
            关于
          </button>
        </nav>

        <!-- 右内容面板 -->
        <div ref="panelEl" class="settings-panel">
          <template v-if="tab === 'libs'">
            <div class="settings-title">照片库管理</div>
            <div class="settings-sub">每库独立照片目录、缩略图缓存、数据库与会话</div>

            <p v-if="loading && libraries.length === 0" class="settings-empty">正在读取照片库…</p>
            <p v-else-if="libraries.length === 0" class="settings-empty">
              还没有照片库。
              <button class="settings-link" type="button" @click="emit('new-library')">新建照片库</button>
            </p>

            <TransitionGroup name="lib-list" tag="div" class="lib-list">
              <article
                v-for="lib in orderedLibraries"
                :key="lib.id"
                class="lib-card"
                :class="{ current: lib.active, swapped: justSwitchedId === lib.id }"
              >
                <div class="lib-card-head">
                  <div class="lib-card-title-wrap">
                    <strong class="lib-card-name">{{ lib.name }}</strong>
                    <!-- 两个状态维度并列：是否当前库 / iCloud 是否已链接。
                         两边都有底色，多个库之间扫一眼就能比出差异 -->
                    <span class="pill" :class="lib.active ? 'current' : 'idle'">{{ lib.active ? '当前' : '未激活' }}</span>
                    <span class="pill" :class="lib.authStatus === 'authed' ? 'ok' : 'warn'">
                      {{ lib.authStatus === 'authed' ? '已链接' : lib.authStatus === 'expired' ? '会话过期' : '未链接' }}
                    </span>
                  </div>
                  <div class="lib-card-actions">
                    <!-- 从未链接 / 会话过期都把入口放在标题行：这两种状态下同步按钮是锁死的，
                         必须有一个就近的出口。已链接后的低频重登才收进「更多」 -->
                    <button
                      v-if="lib.authStatus !== 'authed'"
                      class="btn-ghost accent"
                      type="button"
                      :title="lib.authStatus === 'expired' ? 'iCloud 会话已过期，重新登录后才能继续同步' : '登录 Apple ID，之后才能从 iCloud 同步照片'"
                      @click="emit('open-auth', { id: lib.id, name: lib.name, account: lib.account })"
                    >
                      {{ lib.authStatus === 'expired' ? '重新登录' : '登录 iCloud' }}
                    </button>
                    <div class="more-wrap">
                      <button
                        class="btn-ghost more"
                        type="button"
                        :aria-expanded="menuLibId === lib.id"
                        aria-haspopup="menu"
                        title="更多操作"
                        @click.stop="toggleMenu(lib.id)"
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="3.4" cy="8" r="1.5" />
                          <circle cx="8" cy="8" r="1.5" />
                          <circle cx="12.6" cy="8" r="1.5" />
                        </svg>
                      </button>
                      <div v-if="menuLibId === lib.id" class="more-menu" role="menu">
                        <!-- 未链接/过期已经在标题行放了按钮，这里只留「已链接库的重登」入口 -->
                        <button
                          v-if="lib.authStatus === 'authed'"
                          type="button"
                          role="menuitem"
                          @click.stop="emit('open-auth', { id: lib.id, name: lib.name, account: lib.account }); closeMenu()"
                        >
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M6.2 2.2a5.8 5.8 0 1 0 3.6 10.6" />
                            <path d="M9.6 2.4h4.2v4.2" />
                            <path d="m13.6 2.6-5 5" />
                          </svg>
                          重新登录 iCloud
                        </button>
                        <button class="danger" type="button" role="menuitem" @click.stop="openDelete(lib); closeMenu()">
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M2.6 4.2h10.8" />
                            <path d="M6.2 4.2V2.9a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.3" />
                            <path d="M4 4.2v8.2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.2" />
                            <path d="M6.6 6.8v4M9.4 6.8v4" />
                          </svg>
                          删除照片库
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="lib-card-count">{{ lib.photos }} 张照片 · {{ lib.videos }} 个视频</div>
                <div class="lib-card-meta">
                  <div class="meta-row"><span class="meta-key">账号</span><code>{{ lib.account ?? '—' }}</code></div>
                  <!-- 展示这三条路径是为了让用户能翻找、备份（只读用途）。写入必须走导入，
                       否则库里会出现任意目录结构、任意 mtime、同名不同内容等无法判定的状态。
                       这句话不占一整行，收在「目录」旁的提示图标里 -->
                  <div class="meta-row">
                    <span class="meta-key">
                      目录
                      <span class="hint-wrap" tabindex="0" aria-label="目录说明">
                        <svg class="hint-ico" viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="8" cy="8" r="6.4" />
                          <path d="M8 7.2v4" />
                          <path d="M8 4.9v.1" />
                        </svg>
                        <span class="hint-pop" role="tooltip">
                          此目录由程序管理。要添加自己的照片请用「导入」——直接复制进来会导致日期取错、重复照片无法识别。
                        </span>
                      </span>
                    </span>
                    <code>{{ lib.libraryRoot ?? '—' }}</code>
                    <button v-if="lib.libraryRoot" class="meta-copy" type="button" @click="copyPath(lib, 'root')">
                      {{ copiedKey === `${lib.id}:root` ? '已复制' : '复制' }}
                    </button>
                  </div>
                  <div class="meta-row">
                    <span class="meta-key">缓存</span>
                    <code>{{ lib.cacheDir ?? '—' }}</code>
                    <button v-if="lib.cacheDir" class="meta-copy" type="button" @click="copyPath(lib, 'cache')">
                      {{ copiedKey === `${lib.id}:cache` ? '已复制' : '复制' }}
                    </button>
                  </div>
                  <div class="meta-row">
                    <span class="meta-key">会话</span>
                    <code>{{ lib.cookieDir ?? '—' }}</code>
                    <button v-if="lib.cookieDir" class="meta-copy" type="button" @click="copyPath(lib, 'cookie')">
                      {{ copiedKey === `${lib.id}:cookie` ? '已复制' : '复制' }}
                    </button>
                  </div>
                  <div class="meta-row"><span class="meta-key">最近同步</span><code>{{ lib.lastSyncAt ? new Date(lib.lastSyncAt).toLocaleString('zh-CN') : '从未' }}</code></div>
                </div>

                <!-- 激活库：一条动作栏 = 「往库里加东西」的两种方式。
                     导入照片（本地）与 iCloud 同步并排，右侧跟状态说明。
                     iCloud 接口只接受当前激活库，所以整条只对激活库渲染 -->
                <div v-if="lib.active" class="lib-sync-row">
                  <button
                    class="btn-ghost accent import"
                    type="button"
                    title="导入本地照片目录（本机迁移 / 其他设备上传）"
                    @click="openImport(lib)"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 2.6v7" />
                      <path d="m5.2 6.9 2.8 2.8 2.8-2.8" />
                      <path d="M3 11.4v1.4a.8.8 0 0 0 .8.8h8.4a.8.8 0 0 0 .8-.8v-1.4" />
                    </svg>
                    {{ importButtonText(lib) }}
                  </button>                <SyncButton
                    :busy="thisLibBusy(lib.id)"
                    :picked="pick[lib.id] ?? null"
                    :disabled="otherBusy(lib.id)"
                    :locked="authLocked(lib)"
                    :locked-hint="authLockHint(lib)"
                    @pick="(k) => pickSync(lib.id, k)"
                    @run="runSync(lib.id)"
                    @cancel="cancelSyncRun(lib.id)"
                  />
                  <span v-if="syncError && (pick[lib.id] || thisLibBusy(lib.id))" class="sync-note err"><i class="sync-dot" aria-hidden="true" />{{ syncError }}</span>
                  <span v-else-if="thisLibBusy(lib.id)" class="sync-note" :class="syncStatusClass(stats!.sync.status)"><i class="sync-dot" aria-hidden="true" />{{ stats!.sync.message }}</span>
                  <span v-else-if="stats?.sync.status === 'done' && stats.sync.libraryId === lib.id" class="sync-note ok">
                    <i class="sync-dot" aria-hidden="true" />同步完成，本次下载 {{ stats.sync.downloaded }} 项
                  </span>
                  <span v-else-if="otherBusy(lib.id) && pick[lib.id]" class="sync-note warn">
                    <i class="sync-dot" aria-hidden="true" />其他库同步中，请等待完成后再执行
                  </span>
                  <!-- 未链接/过期：按钮已锁死，旁边把「为什么点不动、下一步做什么」写清楚 -->
                  <span v-else-if="authLocked(lib)" class="sync-note warn">
                    <i class="sync-dot" aria-hidden="true" />{{ authLockHint(lib) }}
                  </span>
                </div>

                <!-- 非激活库：不再摆一排禁用按钮（锁定同步 + 锁定导入 + 切换，说明还各占一句），
                     改成一条说明 + 一个出口。锁定态本来就没法用，摆出来只是噪音 -->
                <div v-else class="lib-inactive-bar">
                  <div class="inactive-line">
                    <svg class="inactive-lock" viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
                      <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" />
                    </svg>
                    <span class="inactive-text">未激活，切换到此库后才能导入照片、同步 iCloud</span>
                    <button
                      class="btn-ghost switch"
                      type="button"
                      :disabled="switchingId === lib.id || globalBusy()"
                      :title="globalBusy() ? '有同步任务正在执行，请等待完成或取消后再切换' : '切换到这个照片库（不会启动同步）'"
                      @click="switchTo(lib)"
                    >
                      <span v-if="switchingId === lib.id" class="spinner" />
                      <svg v-else class="switch-ico" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M2.4 8h7.2" />
                        <path d="M7 5 10 8l-3 3" />
                        <path d="M13.2 3.4v9.2" />
                      </svg>
                      {{ switchingId === lib.id ? '切换中…' : '切换到此库' }}
                    </button>
                  </div>
                  <!-- 切库失败（如任务在跑 409）就地说清，否则点了没反应 -->
                  <p v-if="switchFailId === lib.id && syncError" class="inactive-err" role="alert">{{ syncError }}</p>
                </div>
                <!-- iCloud 同步设置：untilFound / recentLimit 可编辑；其他 icloudpd 官方参数按默认值锁死只读。
                     叫「照片库配置」会让人以为照片目录/缓存也能在这里改，实际这两项由程序按库名派生。
                     折叠状态下也显示当前两个关键参数，顺序为「标题 → 折叠箭头 → 参数摘要」 -->
                <button
                  class="config-toggle"
                  type="button"
                  :aria-expanded="configOpen === lib.id"
                  :title="configBriefTitle(lib)"
                  @click="openConfig(lib)"
                >
                  <span class="config-toggle-label">iCloud 同步设置</span>
                  <svg class="chev" :class="{ open: configOpen === lib.id }" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="m3 4.5 3 3 3-3" />
                  </svg>
                  <span class="config-brief">{{ configBrief(lib) }}</span>
                </button>
                <div v-if="configOpen === lib.id && drafts[lib.id]" class="lib-config">
                  <div class="config-edit-row">
                    <div class="config-edit-field">
                      <label class="config-edit-label" :for="`uf-${lib.id}`">增量 · 连续命中数</label>
                      <input
                        :id="`uf-${lib.id}`"
                        v-model.number="drafts[lib.id].untilFound"
                        type="number" min="1" max="999"
                        class="config-input"
                      >
                      <p class="config-hint">往回扫描时连续 N 个本地已存在就停。默认 20。</p>
                    </div>
                    <div class="config-edit-field">
                      <label class="config-edit-label" :for="`rl-${lib.id}`">下载限量</label>
                      <input
                        :id="`rl-${lib.id}`"
                        v-model.number="drafts[lib.id].recentLimit"
                        type="number" min="0" max="99999"
                        class="config-input"
                      >
                      <p class="config-hint">只处理最近 N 张。填 0 = 全量不限（推荐）。</p>
                    </div>
                    <div class="config-edit-actions">
                      <button
                        class="btn-ghost primary"
                        type="button"
                        :disabled="drafts[lib.id].saving"
                        @click="saveConfig(lib)"
                      >{{ drafts[lib.id].saving ? '保存中…' : drafts[lib.id].saved ? '已保存 ✓' : '保存' }}</button>
                    </div>
                  </div>

                  <div class="config-readonly">
                    <div class="config-row"><span class="config-key">命令模式</span><code>download（只下载，不删除云端照片）</code></div>
                    <div class="config-row"><span class="config-key">区域</span><code>--domain cn（中国大陆区）</code></div>
                    <div class="config-row"><span class="config-key">目录结构</span><code>%Y/%m/%d（固定不可更改，代码按此读取）</code></div>
                    <div class="config-row"><span class="config-key">EXIF</span><code>--set-exif-datetime（写入拍摄时间标签）</code></div>
                    <div class="config-row"><span class="config-key">会话</span><code>cookie 存于各库 cookies 目录，过期后在主界面/本页重新链接</code></div>
                  </div>
                </div>

                <!-- icloudpd 运行日志（该库任务输出，按钮下方独立整行，随任务快照更新） -->
                <div v-if="stats?.sync.libraryId === lib.id && syncLogLines.length" class="lib-log">
                  <button
                    type="button"
                    class="lib-log-toggle"
                    :aria-expanded="logOpen === lib.id"
                    @click="logOpen = logOpen === lib.id ? null : lib.id"
                  >
                    <span>运行日志（{{ syncLogLines.length }} 行）</span>
                    <svg class="chev" :class="{ open: logOpen === lib.id }" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="m3 4.5 3 3 3-3" />
                    </svg>
                  </button>
                  <pre v-if="logOpen === lib.id" class="lib-log-box">{{ syncLogLines.join('\n') }}</pre>
                </div>
              </article>
            </TransitionGroup>

            <button class="add-lib-btn" type="button" @click="emit('new-library')">
              <span>+</span> 添加照片库
              <small>新建后可从 iCloud 拉取，或导入本地照片目录</small>
            </button>
          </template>

          <template v-else>
            <!-- 关于页：身份卡式排版。标签承载功能概览，图标清单承载安全承诺，避免大段纯文字 -->
            <div class="about-hero">
              <div class="about-app">
                <span class="about-app-name">本地照片库</span>
                <span class="about-ver">v{{ appVersion }}</span>
              </div>
              <div class="about-tagline">部署在个人电脑或家庭局域网的照片管理应用</div>
            </div>

            <p class="about-intro">
              把 iCloud 拉取的照片和本地目录导入的照片收进同一个库，统一归置、检索、浏览。
            </p>

            <div class="about-label">功能</div>
            <div class="about-feats">
              <div class="feat">
                <svg class="feat-ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
                <div class="feat-body">
                  <div class="feat-t">照片墙</div>
                  <div class="feat-d">虚拟滚动覆盖全库，几万张也能流畅翻</div>
                </div>
              </div>
              <div class="feat">
                <svg class="feat-ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" /></svg>
                <div class="feat-body">
                  <div class="feat-t">月份分组</div>
                  <div class="feat-d">按拍摄时间归组，点年月直达任意一天</div>
                </div>
              </div>
              <div class="feat">
                <svg class="feat-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M6.5 5.5v5l4-2.5-4-2.5Z" /></svg>
                <div class="feat-body">
                  <div class="feat-t">实况照片</div>
                  <div class="feat-d">按住即播，带原声，松开即停</div>
                </div>
              </div>
              <div class="feat">
                <svg class="feat-ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="2" /><path d="M6.5 6v4l3.5-2-3.5-2Z" /></svg>
                <div class="feat-body">
                  <div class="feat-t">视频播放</div>
                  <div class="feat-d">流式播放不等待，进度随意拖</div>
                </div>
              </div>
              <div class="feat">
                <svg class="feat-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
                <div class="feat-body">
                  <div class="feat-t">全文检索</div>
                  <div class="feat-d">文件名与日期都能搜，3 字符片段即可命中</div>
                </div>
              </div>
              <div class="feat">
                <svg class="feat-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 11.5h6.8a2.4 2.4 0 0 0 .5-4.75 3.4 3.4 0 0 0-6.6-.85A2.6 2.6 0 0 0 4.5 11.5Z" /><path d="M8 6.8v4M6.5 9.3 8 10.8l1.5-1.5" /></svg>
                <div class="feat-body">
                  <div class="feat-t">iCloud 同步</div>
                  <div class="feat-d">icloudpd 增量拉取，登录凭据保存在本地</div>
                </div>
              </div>
              <div class="feat">
                <svg class="feat-ico" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="2" /><path d="M11 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h1" /></svg>
                <div class="feat-body">
                  <div class="feat-t">多照片库</div>
                  <div class="feat-d">各库独立目录与账号，家人各存各的</div>
                </div>
              </div>
              <div class="feat">
                <svg class="feat-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1Z" /><path d="M8 11V8M6.2 9.3 8 7.5l1.8 1.8" /></svg>
                <div class="feat-body">
                  <div class="feat-t">本地导入</div>
                  <div class="feat-d">自动按日期归置、补拍摄时间、配对实况</div>
                </div>
              </div>
            </div>

            <div class="about-label">数据与隐私</div>
            <ul class="about-points">
              <li>
                <svg class="pt-ico ok" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
                照片、索引、缩略图全部保存在本机
              </li>
              <li>
                <svg class="pt-ico ok" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" /></svg>
                无账号体系、无云端、无遥测
              </li>
              <li>
                <svg class="pt-ico warn" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 14.5 13.5H1.5L8 2.5Z" /><path d="M8 6.5v3M8 11.4v.1" /></svg>
                面向家庭网络设计，请勿暴露到公网
              </li>
            </ul>

            <div class="about-foot">技术栈：Vue 3 · Fastify · SQLite（FTS5）· sharp · ffprobe · icloudpd</div>
          </template>
        </div>
      </div>
    </section>

    <!-- 删除确认弹窗（仅本地；复选框决定是否连同本地照片副本删除） -->
    <div v-if="deleteTarget" class="delete-backdrop" role="presentation" @click.self="deleteTarget = null">
      <section class="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
        <h3 id="delete-dialog-title">删除照片库「{{ deleteTarget.name }}」</h3>
        <p class="delete-warn">以下内容将被删除（<b>均在本地，云端 iCloud 原片永不删除</b>）：</p>
        <ul class="delete-list">
          <li>照片库注册记录（从列表 / 切换 / 设置中移除）</li>
          <li>本地缓存目录（缩略图 / 数据库 / cookies 会话）</li>
        </ul>
        <label class="delete-check">
          <input v-model="removePhotos" type="checkbox" @change="photoConfirmArmed = false" />
          <span>同时删除本地已下载的照片副本（<code>{{ deleteTarget.libraryRoot ?? '—' }}</code>，含你手动放入该目录的任何文件）</span>
        </label>
        <!-- R-21：勾选后必须说清后果，并且要再点一次按钮才真正删（默认不勾选）。
             文案随二次确认状态切换，两段共用一个提示框（不在弹窗里堆两条红字） -->
        <p v-if="removePhotos" class="delete-danger" :class="{ armed: photoConfirmArmed }" role="alert">
          <template v-if="photoConfirmArmed">
            <b>已进入确认状态</b>：再点一次下方按钮，该目录内的全部文件（含你手动放入的）将被永久删除，且不进回收站、无法恢复。云端 iCloud 原片不受影响。
          </template>
          <template v-else>
            勾选后上述目录内的<b>全部文件（含你手动放入的）会被永久删除且不进回收站</b>，无法恢复。云端 iCloud 原片不受影响。
          </template>
        </p>
        <p v-if="deleteError" class="delete-error" role="alert">{{ deleteError }}</p>
        <footer class="delete-actions">
          <button class="onboard-btn" type="button" @click="deleteTarget = null">取消</button>
          <button
            class="onboard-btn danger"
            :class="{ 'armed-wait': removePhotos && !photoConfirmArmed, armed: photoConfirmArmed }"
            type="button"
            :disabled="deleting"
            @click="confirmDelete"
          >
            <svg v-if="photoConfirmArmed" class="armed-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.2 14.4 13.4H1.6L8 2.2Z" />
              <path d="M8 6.2v3.4M8 11.6v.1" />
            </svg>
            {{ deleting ? '删除中…' : photoConfirmArmed ? '确认永久删除照片' : removePhotos ? '删除照片副本并移除库' : '确认删除' }}
          </button>
        </footer>
      </section>
    </div>

    <!-- 导入本地照片目录弹窗（本机迁移 / 上传） -->
    <ImportDialog
      v-if="importTarget"
      :library-id="importTarget.id"
      :library-name="importTarget.name"
      @close="importTarget = null"
    />
  </div>
</template>

<style scoped>
.settings-backdrop {
  position: fixed;
  z-index: 105;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 32%);
  padding: 24px;
}
.settings-window {
  width: min(880px, 100%);
  max-height: min(680px, 92vh);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 20px 60px rgb(0 0 0 / 22%);
  overflow: hidden;
}
.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.settings-header strong { font-size: 14px; }
.settings-close {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
}
.settings-close:hover { background: var(--bg-field-hover); color: var(--text-1); }
.settings-body { display: flex; min-height: 0; }
.settings-nav {
  width: 170px;
  flex-shrink: 0;
  padding: 16px 12px;
  border-right: 1px solid var(--border);
  overflow: auto;
}
/* 分组标签：弱化为纯标题（与菜单项明显区分：小字、无按钮感） */
.settings-nav-label {
  padding: 0 10px;
  margin-bottom: 6px;
  color: var(--text-3);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.6px;
}
.settings-nav-label.gap { margin-top: 20px; }
.settings-nav-item {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.settings-nav-item:hover { background: rgb(67 132 238 / 8%); color: #4384ee; }
.settings-nav-item.selected { background: rgb(67 132 238 / 12%); color: #4384ee; font-weight: 600; }
.settings-panel { flex: 1; padding: 18px 22px 24px; overflow: auto; min-width: 0; }
.settings-title { font-size: 15px; font-weight: 700; }
.settings-sub { margin-top: 3px; margin-bottom: 14px; color: var(--text-2); font-size: 12px; }
/* ===== 关于页：身份卡式排版 ===== */
/* 应用名 + 版本徽章 + 一句话定位：名字略大于正文即可，不压过「关于」标题 */
.about-hero { margin: 2px 0 0; }
.about-app { display: flex; align-items: center; gap: 10px; }
.about-app-name { color: var(--text-1); font-size: 14.5px; font-weight: 700; }
.about-ver {
  padding: 2px 9px;
  border: 1px solid rgb(67 132 238 / 35%);
  border-radius: 999px;
  background: rgb(67 132 238 / 8%);
  color: #4384ee;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
}
.about-tagline { margin-top: 4px; color: var(--text-2); font-size: 12px; }

/* 简介：左侧蓝色竖线的引言形态，和上面的副标题拉开角色差 */
.about-intro {
  margin: 14px 0 18px;
  padding: 2px 0 2px 11px;
  border-left: 3px solid rgb(67 132 238 / 45%);
  color: var(--text-1);
  font-size: 12.5px;
  line-height: 1.7;
}

/* 小节标签 */
.about-label {
  margin: 0 0 9px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 2px;
}

/* 功能网格：两列，图标 + 标题 + 一行说明；无边框，靠图标提神 */
.about-feats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 16px;
  margin-bottom: 18px;
}
.feat { display: flex; align-items: flex-start; gap: 9px; padding: 5px 2px; }
.feat-ico {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  margin-top: 2px;
  fill: none;
  /* 中性灰描边：图标只做视觉锚点，不用主题蓝——蓝色太像可点击的按钮 */
  stroke: var(--text-3);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.feat-t { color: var(--text-1); font-size: 12.5px; font-weight: 600; }
.feat-d { margin-top: 1px; color: var(--text-2); font-size: 12px; line-height: 1.55; }

/* 数据与隐私：图标 + 文案的清单，绿勾表示承诺、黄三角表示提醒 */
.about-points { margin: 0; padding: 0; list-style: none; }
.about-points li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  color: var(--text-1);
  font-size: 12.5px;
}
.pt-ico { width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.pt-ico.ok { stroke: #34a853; }
.pt-ico.warn { stroke: #d29a04; }

/* 底部技术栈：整行弱化但保持可读 */
.about-foot {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--text-2);
  font-size: 11px;
  letter-spacing: 0.3px;
}
.settings-empty { color: var(--text-2); font-size: 12px; }
.settings-link { border: 0; background: transparent; color: #4384ee; font: inherit; font-size: 12px; cursor: pointer; }

.lib-card {
  position: relative;
  margin-bottom: 10px;
  padding: 13px 15px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-panel);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
/* 当前库：一层描边 + 一层淡底，扫视时不用读文字就能定位。
 *
 * 曾用「左侧 3px 蓝色竖条」做纵向扫视锚点，但它必然歪：
 *   ① absolute 条的宽度只有 3px，而它声明的水平圆角是 10px —— CSS 规定相邻两个圆角
 *      半径之和超过边的长度时按比例等比缩小所有半径，3px 宽的条最终被压成 <2px 的
 *      圆角，渲染出来近乎直角，与卡片的 11px 圆角错位（左上/左下冒出方角）；
 *   ② 竖条贴在 border 内侧，于是左边 = 1px 边框 + 3px 条 = 4px，其余三边 1px，
 *      四边粗细不匀，整圈描边看起来是「歪」的。
 * 现在改成 box-shadow 同心环：外扩 1px 且完全跟随 border-radius，四边绝对等宽，
 * 视觉上把 1px 边框加厚到 2px，既有存在感又不会出现任何对齐问题。 */
.lib-card.current {
  border-color: rgb(67 132 238 / 55%);
  box-shadow: 0 0 0 1px rgb(67 132 238 / 28%);
  background:
    linear-gradient(90deg, rgb(67 132 238 / 10%), rgb(67 132 238 / 3%) 52%, transparent 82%),
    var(--bg-panel);
}
/* ── 切库动效 ────────────────────────────────────────────────
 * 只换文字时用户会以为没点动（2026-11-04 反馈）。位移交给 TransitionGroup 的 FLIP：
 * 当前库恒排第一，切库时被切的卡滑到顶部、原当前库下滑——「它跑上来了」本身就是结果。
 * move 只在「位置真的变了」时发生，所以切库后那次签名兜底的二次重拉（数据等价、
 * 顺序不变）不会把动画重播一遍。 */
.lib-list { position: relative; }
.lib-list-move { transition: transform 0.34s cubic-bezier(0.22, 0.61, 0.36, 1); }
/* 新建 / 删除库：淡入淡出。leave 期必须脱离文档流，否则它一消失，后面的卡片会瞬间
   弹上来和 move 的位移叠成两次跳动；left/right 撑满是为了让淡出中的卡片不变窄 */
.lib-list-enter-active,
.lib-list-leave-active { transition: opacity 0.18s ease; }
.lib-list-leave-active { position: absolute; left: 0; right: 0; }
.lib-list-enter-from,
.lib-list-leave-to { opacity: 0; }

/* 一次性高亮脉冲：用伪元素而不是直接给 .lib-card 加动画，因为 .current 自己就在用
 * box-shadow 画同心环，两处抢同一个属性会互相清掉。inset:-1px 与那道环同宽。 */
.lib-card::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
}
.lib-card.swapped::after { animation: lib-swap-ring 1.3s ease-out; }
@keyframes lib-swap-ring {
  0% { opacity: 1; box-shadow: 0 0 0 0 rgb(67 132 238 / 45%); }
  100% { opacity: 0; box-shadow: 0 0 0 12px rgb(67 132 238 / 0%); }
}

.lib-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: space-between; }
.lib-card-title-wrap { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.lib-card-name { font-size: 14px; font-weight: 700; line-height: 1.3; }
.pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
}
/* 当前：蓝色实心胶囊，一眼识别激活库 */
.pill.current { background: #4384ee; color: #fff; }
.pill.ok { background: rgb(44 154 97 / 12%); color: #2c9a61; }
.pill.warn { background: rgb(255 159 10 / 14%); color: #a87515; }
/* 未激活：中性灰。与蓝色「当前」成对，但比橙色「未链接」安静——
   未激活只是「当前没在用」，不是需要处理的异常 */
.pill.idle { background: var(--bg-field); color: var(--text-2); }
.lib-card-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
/* 「更多」：把低频/危险操作收进菜单，标题行只剩一个入口 */
.more-wrap { position: relative; display: inline-flex; }
.btn-ghost.more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  padding: 0;
  color: var(--text-2);
}
.btn-ghost.more svg { width: 14px; height: 14px; fill: currentColor; }
.btn-ghost.more:hover { color: var(--text-1); }
.more-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  min-width: 158px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-panel);
  box-shadow: 0 10px 28px rgb(15 23 42 / 16%);
  animation: more-pop 0.12s ease;
}
@keyframes more-pop {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}
.more-menu button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 11.5px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.more-menu button svg {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.more-menu button:hover { background: rgb(67 132 238 / 9%); color: #3577dc; }
.more-menu button:hover svg { stroke: #3577dc; }
.more-menu button.danger { color: #d05245; }
.more-menu button.danger svg { stroke: #d05245; }
.more-menu button.danger:hover { background: rgb(208 82 69 / 9%); color: #d05245; }
.btn-ghost {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.btn-ghost:hover { background: var(--bg-field-hover); color: var(--text-1); }
/* 「切换照片库」：蓝色描边 + 图标，比灰描边的「刷新链接/删除」高一级，
   但不用实心块——卡片里已有蓝色「当前」徽标，再加实心按钮会打架 */
.btn-ghost.switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  border-color: #4384ee;
  color: #4384ee;
}
.btn-ghost.switch:hover { background: rgb(67 132 238 / 10%); color: #4384ee; }
.btn-ghost.switch:disabled { opacity: 0.5; cursor: not-allowed; }
.switch-ico {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.btn-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
/* 「链接 iCloud」「导入」：把照片弄进来的两条路径，是卡片里最主要的动作。
   淡蓝底 + 蓝字比灰描边高一级，又不用实心块——标题行已有蓝色「当前」胶囊，
   两个实心按钮会互相打架。同时这两个按钮带 inline-flex 以容纳锁图标 */
.btn-ghost.accent {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-color: rgb(67 132 238 / 40%);
  background: rgb(67 132 238 / 8%);
  color: #3577dc;
  font-weight: 600;
}
.btn-ghost.accent:hover {
  border-color: #4384ee;
  background: rgb(67 132 238 / 15%);
  color: #2f6ed0;
}
/* 信息列表：label 固定宽灰色，value 主色，扫读对齐 */
.lib-card-meta {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.meta-row { display: flex; align-items: baseline; gap: 10px; font-size: 11.5px; }
.meta-key {
  flex: 0 0 56px;
  color: var(--text-3);
  font-size: 11px;
}
.meta-row code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--text-2);
  word-break: break-all;
}
/* 路径行右侧的「复制」按钮：靠右对齐，弱化到不像主要操作 */
.meta-copy {
  margin-left: auto;
  flex: 0 0 auto;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 16px;
  cursor: pointer;
}
.meta-copy:hover { border-color: #4384ee; color: #4384ee; }
/* 目录说明：挂在「目录」二字旁的提示图标上，hover / 键盘聚焦时浮出气泡。
   不占一整行，也不与正文抢注意力 */
.hint-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  vertical-align: -1px;
  outline: none;
}
.hint-ico {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.6;
  stroke-linecap: round;
  cursor: help;
  transition: stroke 0.14s ease;
}
.hint-wrap:hover .hint-ico,
.hint-wrap:focus-visible .hint-ico { stroke: #4384ee; }
.hint-pop {
  position: absolute;
  left: -8px;
  top: calc(100% + 7px);
  z-index: 40;
  box-sizing: border-box;
  width: 238px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 8px 24px rgb(15 23 42 / 16%);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.55;
  white-space: normal;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-3px);
  transition: opacity 0.14s ease, transform 0.14s ease, visibility 0.14s;
  pointer-events: none;
}
.hint-wrap:hover .hint-pop,
.hint-wrap:focus-visible .hint-pop {
  opacity: 1;
  visibility: visible;
  transform: none;
}
/* 照片/视频数：普通灰色小字，不做胶囊标签 */
.lib-card-count {
  margin-top: 4px;
  color: var(--text-3);
  font-size: 11.5px;
}

/* iCloud 同步设置展开区 */
.config-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  margin-top: 9px;
  padding: 3px 2px;
  border: 0;
  background: transparent;
  color: #4384ee;
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.config-toggle-label { flex-shrink: 0; }
/* 参数摘要：跟在折叠箭头之后，灰字细体，靠颜色与字重区分层级；
   不做 flex:1 / 右对齐——那样会被中间留白拉成互不相干的左右两块。
   窄屏时先压缩这一段（ellipsis），保证标题与箭头始终可见 */
.config-brief {
  min-width: 0;
  margin-left: 4px;
  overflow: hidden;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.config-toggle .chev {
  flex-shrink: 0;
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.15s;
}
.config-toggle .chev.open { transform: rotate(180deg); }
.lib-config {
  margin-top: 8px;
  padding: 12px 14px 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-field);
}
/* 可编辑区 */
.config-edit-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 14px;
  padding-bottom: 10px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.config-edit-field { display: flex; flex-direction: column; gap: 4px; min-width: 140px; }
.config-edit-label { font-size: 11px; color: var(--text-3); font-weight: 600; line-height: 1.4; }
.config-input {
  width: 110px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 12px;
  box-sizing: border-box;
}
.config-input:focus { outline: none; border-color: #4384ee; box-shadow: 0 0 0 2px rgb(67 132 238 / 15%); }
.config-hint { margin: 0; font-size: 10.5px; color: var(--text-3); line-height: 1.4; max-width: 220px; min-height: 2.8em; }
.config-edit-actions { align-self: flex-end; padding-bottom: 1px; }
.btn-ghost.primary { height: 28px; padding: 0 14px; border-color: #4384ee; color: #4384ee; }
.btn-ghost.primary:hover { background: rgb(67 132 238 / 10%); }
.btn-ghost.primary:disabled { opacity: 0.6; cursor: default; }
/* 只读参数区 */
.config-readonly { padding-bottom: 4px; }
/* 激活库动作栏：「导入照片」与「iCloud 同步」并排——两者都是往库里加内容，
   放同一行比散落在标题行/卡片底部更容易理解。窄屏允许换行，状态说明自然落到下一步 */
.lib-sync-row {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}
/* 导入照片：与同步按钮等高，accent 语义与「往库里加内容」一致 */
.btn-ghost.accent.import {
  height: 26px;
  padding: 0 11px;
  gap: 5px;
  white-space: nowrap;
}
.btn-ghost.accent.import svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* 非激活库：一条说明 + 一个出口。原先这里是「锁定同步按钮 + 一句说明 + 锁定导入按钮」，
   三个东西都在说同一件事（先切换），现在合并成一条 */
.lib-inactive-bar {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  padding: 9px 11px;
  border: 1px dashed var(--border);
  border-radius: 9px;
  background: var(--bg-field);
}
.inactive-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.inactive-err { margin: 0; color: #d05245; font-size: 11px; line-height: 1.5; }
.inactive-lock {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.inactive-text { color: var(--text-2); font-size: 11px; line-height: 1.5; }
.inactive-line .btn-ghost.switch { margin-left: auto; flex-shrink: 0; }
/* 「切换到此库」按钮的加载指示（现在这个按钮在非激活提示条里，
   选择器要跟着一起改，否则 spinner 会退化成无样式的 span） */
.lib-inactive-bar .spinner {
  display: inline-block;
  width: 11px;
  height: 11px;
  margin-right: 6px;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: lib-switch-spin 0.8s linear infinite;
  vertical-align: -1px;
}
@keyframes lib-switch-spin { to { transform: rotate(360deg); } }
/* 运行日志折叠面板（同步按钮行下方独立整行） */
.lib-log { margin: 8px 0 2px; }
.lib-log-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 0;
  border: none;
  background: none;
  color: var(--text-2);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.lib-log-toggle:hover { color: var(--text-1); }
.lib-log-toggle .chev {
  width: 11px;
  height: 11px;
  margin-left: auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.15s;
}
.lib-log-toggle .chev.open { transform: rotate(180deg); }
.lib-log-box {
  margin: 6px 0 2px;
  max-height: 240px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-log, rgb(0 0 0 / 55%));
  color: #9cdcfe;
  font: 11px/1.5 Consolas, 'Courier New', monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 同步按钮本体样式统一在共享组件 SyncButton.vue（scoped），此处仅保留提示行 */
.sync-note { color: var(--text-2); font-size: 11px; display: inline-flex; align-items: center; }
.sync-note.err { color: var(--text-2); }
.sync-note.ok { color: var(--text-2); }
.sync-note.warn { color: var(--text-2); }
.sync-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
}
.sync-note.info .sync-dot { background: #4384ee; }
.sync-note.warn .sync-dot { background: #d97706; animation: sv-dot-pulse 1.6s ease-in-out infinite; }
.sync-note.ok .sync-dot { background: #16a34a; }
.sync-note.err .sync-dot { background: #d05245; }
@keyframes sv-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.add-lib-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 13px 15px;
  border: 1px dashed var(--border);
  border-radius: 11px;
  background: transparent;
  color: #4384ee;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.add-lib-btn:hover { background: rgb(67 132 238 / 5%); }
.add-lib-btn span { font-weight: 700; }
.add-lib-btn small { color: var(--text-3); font-size: 11px; font-weight: 400; }

.config-card {
  padding: 13px 15px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-panel);
}
.config-row { display: flex; gap: 12px; padding: 6px 0; font-size: 12px; }
.config-key { flex: 0 0 90px; color: #4384ee; font-weight: 600; }
.config-row code { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; word-break: break-all; }
.config-note { margin-top: 10px; color: var(--text-3); font-size: 11px; }

/* 删除确认弹窗 */
.delete-backdrop {
  position: fixed;
  z-index: 120;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 34%);
  padding: 24px;
}
.delete-dialog {
  width: min(420px, 100%);
  padding: 20px 22px 18px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 20px 60px rgb(0 0 0 / 22%);
}
.delete-dialog h3 { margin: 0 0 10px; font-size: 15px; }
.delete-warn { margin: 0 0 8px; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.delete-list { margin: 0 0 12px; padding-left: 18px; color: var(--text-2); font-size: 12px; line-height: 1.8; }
.delete-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-field);
  font-size: 12px;
  color: var(--text-1);
  line-height: 1.55;
  cursor: pointer;
}
.delete-check input { margin-top: 2px; }
.delete-check code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; word-break: break-all; }
.delete-error { margin: 10px 0 0; color: #d05245; font-size: 11px; }
/* 勾选「删除照片副本」后的后果说明（R-21：二次确认前置提示） */
.delete-danger {
  margin: 8px 0 0;
  padding: 8px 10px;
  border: 1px solid rgb(208 82 69 / 28%);
  border-radius: 8px;
  background: rgb(208 82 69 / 8%);
  color: #d05245;
  font-size: 11px;
  line-height: 1.6;
}
/* 进入二次确认：框线由淡红转实红、底色加深，与按钮的深红一起表达「已经进入下一步」 */
.delete-danger.armed { border-color: #d05245; background: rgb(208 82 69 / 16%); }
.delete-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 16px; }
.onboard-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 13px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.onboard-btn.danger { border-color: #d05245; background: #d05245; color: #fff; }
/* 预备态（勾选删副本后的第一次点击前）：描边而非实心，与最终确认拉开差异 */
.onboard-btn.danger.armed-wait { background: transparent; color: #d05245; }
.onboard-btn.danger.armed-wait:hover { background: rgb(208 82 69 / 9%); }
/* 最终确认态：只把底色加深 + 弹跳一次。
   不再加 box-shadow 外光环——那圈半透明红外扩会和按钮自身的 1px 边框叠成「双层框」，很显脏 */
.onboard-btn.armed {
  background: #b83c30;
  border-color: #b83c30;
  animation: armed-pop 0.32s ease-out;
}
.onboard-btn.armed:hover { background: #a5342a; border-color: #a5342a; }
@keyframes armed-pop {
  0% { transform: scale(0.96); }
  55% { transform: scale(1.03); }
  100% { transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .onboard-btn.armed { animation: none; }
  /* 切库动效同样遵守系统设置：位移与脉冲全关，滚动改瞬时（switchTo 里按同一媒体查询决定） */
  .lib-list-move,
  .lib-list-enter-active,
  .lib-list-leave-active { transition: none; }
  .lib-card.swapped::after { animation: none; }
}
.armed-ico {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.onboard-btn:disabled { opacity: 0.55; cursor: wait; }
</style>
