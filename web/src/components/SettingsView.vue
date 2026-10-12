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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchLibraries, startSync, cancelSync, deleteLibrary } from '../api/client'
import type { LibraryInfo, Stats } from '../types'
import SyncButton from './SyncButton.vue'

const props = defineProps<{ stats: Stats | null }>()
const emit = defineEmits<{
  close: []
  'open-auth': [lib: { id: number; name: string; account: string | null }]
  'new-library': []
  'library-deleted': [payload: { id: number; wasActive: boolean }]
  /** 请求 App 立即刷新 stats（任务启动/取消后即时反馈，与主界面 await pollStats 同效） */
  'need-stats-refresh': []
}>()

type Tab = 'libs' | 'about'
const tab = ref<Tab>('libs')
const libraries = ref<LibraryInfo[]>([])
const loading = ref(false)
/** 每库已选待执行：{ [libId]: 'full'|'inc' } */
const pick = ref<Record<number, 'full' | 'inc' | null>>({})
/** 展开「照片库配置」的库 id（点击库卡片的配置下拉展开/收起） */
const configOpen = ref<number | null>(null)
/** 展开「运行日志」的库 id（点击折叠展开/收起） */
const logOpen = ref<number | null>(null)
/** icloudpd 原始输出日志行（全局单任务，仅当 stats.sync.libraryId 匹配该库时展示） */
const syncLogLines = computed(() => props.stats?.sync.log ?? [])
/** 任务刚启动、stats 轮询尚未确认前的本地占位态（防止连点/误开菜单） */
const starting = ref<Record<number, boolean>>({})
const syncError = ref('')
/** 删除确认弹窗（仅本地删除；复选框决定是否连同本地照片副本一起删） */
const deleteTarget = ref<LibraryInfo | null>(null)
/** 默认勾选「同时删除本地照片副本」（每次打开弹窗重置为 true） */
const removePhotos = ref(true)
const deleting = ref(false)
const deleteError = ref('')

function openDelete(lib: LibraryInfo): void {
  deleteTarget.value = lib
  removePhotos.value = true
  deleteError.value = ''
}

async function confirmDelete(): Promise<void> {
  const lib = deleteTarget.value
  if (!lib || deleting.value) return
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

let pollTimer: number | undefined

/** 全局同步任务是否忙碌（主界面与设置中心共享同一 stats 轮询源） */
function globalBusy(): boolean {
  const s = props.stats?.sync
  return s?.status === 'running' || s?.status === 'waiting_retry'
}
/** 某库自己是否正在执行任务 */
function thisLibBusy(id: number): boolean {
  return globalBusy() && props.stats?.sync.libraryId === id
}
/** 其他库正在执行（本库点执行会进入等待执行） */
function otherBusy(id: number): boolean {
  return globalBusy() && props.stats?.sync.libraryId !== id
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

/** 5s 轮询：同步全局任务状态；解除本地「启动中」占位（确认执行中→交执行中态；任务已结束→回空闲） */
function pollStats(): void {
  void loadLibraries()
  for (const idStr of Object.keys(starting.value)) {
    const id = Number(idStr)
    if (thisLibBusy(id) || !globalBusy()) {
      starting.value = { ...starting.value, [id]: false }
    }
  }
}

function pickSync(libId: number, kind: 'full' | 'inc'): void {
  pick.value = { ...pick.value, [libId]: kind }
  syncError.value = ''
}

async function runSync(libId: number): Promise<void> {
  const kind = pick.value[libId]
  if (!kind) return
  syncError.value = ''
  try {
    await startSync(libId, kind)
    pick.value = { ...pick.value, [libId]: null }
    // 启动成功 → 请求 App 立即刷新 stats；本地「启动中」占位兜底（轮询确认 running 后转执行中/取消）
    starting.value = { ...starting.value, [libId]: true }
    emit('need-stats-refresh')
  } catch (err) {
    // 失败（全局已有 icloudpd 任务占用 / 非激活库等）：保留已选操作并提示，用户可稍后重试
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

async function cancelSyncRun(libId: number): Promise<void> {
  syncError.value = ''
  try {
    await cancelSync(libId)
    syncError.value = ''
    emit('need-stats-refresh')
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(() => {
  void loadLibraries()
  pollTimer = window.setInterval(pollStats, 5000)
})
onBeforeUnmount(() => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
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
        <div class="settings-panel">
          <template v-if="tab === 'libs'">
            <div class="settings-title">照片库管理</div>
            <div class="settings-sub">每库独立照片目录、缩略图缓存、数据库与会话</div>

            <p v-if="loading && libraries.length === 0" class="settings-empty">正在读取照片库…</p>
            <p v-else-if="libraries.length === 0" class="settings-empty">
              还没有照片库。
              <button class="settings-link" type="button" @click="emit('new-library')">新建照片库</button>
            </p>

            <article v-for="lib in libraries" :key="lib.id" class="lib-card">
              <div class="lib-card-head">
                <div class="lib-card-title-wrap">
                  <strong class="lib-card-name">{{ lib.name }}</strong>
                  <span v-if="lib.active" class="pill current">当前</span>
                  <span class="pill" :class="lib.authStatus === 'authed' ? 'ok' : 'warn'">
                    {{ lib.authStatus === 'authed' ? '已链接' : lib.authStatus === 'expired' ? '会话过期' : '未链接' }}
                  </span>
                </div>
                <div class="lib-card-actions">
                  <button class="btn-ghost" type="button" @click="emit('open-auth', { id: lib.id, name: lib.name, account: lib.account })">
                    {{ lib.authStatus === 'none' ? '新建链接' : '刷新链接' }}
                  </button>
                  <button class="btn-ghost danger" type="button" @click="openDelete(lib)">删除</button>
                </div>
              </div>
              <div class="lib-card-count">{{ lib.photos }} 张照片 · {{ lib.videos }} 个视频</div>
              <div class="lib-card-meta">
                <div class="meta-row"><span class="meta-key">账号</span><code>{{ lib.account ?? '—' }}</code></div>
                <div class="meta-row"><span class="meta-key">目录</span><code>{{ lib.libraryRoot ?? '—' }}</code></div>
                <div class="meta-row"><span class="meta-key">缓存</span><code>{{ lib.cacheDir ?? '—' }}</code></div>
                <div class="meta-row"><span class="meta-key">会话</span><code>{{ lib.cookieDir ?? '—' }}</code></div>
                <div class="meta-row"><span class="meta-key">最近同步</span><code>{{ lib.lastSyncAt ? new Date(lib.lastSyncAt).toLocaleString('zh-CN') : '从未' }}</code></div>
              </div>

              <!-- 照片库配置（按官方默认值锁死只读，代码预留；删除类参数不提供） -->
              <button
                class="config-toggle"
                type="button"
                :aria-expanded="configOpen === lib.id"
                @click="configOpen = configOpen === lib.id ? null : lib.id"
              >
                照片库配置
                <svg class="chev" :class="{ open: configOpen === lib.id }" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m3 4.5 3 3 3-3" />
                </svg>
              </button>
              <div v-if="configOpen === lib.id" class="lib-config">
                <div class="config-row"><span class="config-key">命令模式</span><code>download（只下载，不删除云端照片）</code></div>
                <div class="config-row"><span class="config-key">区域</span><code>--domain cn（中国大陆区）</code></div>
                <div class="config-row"><span class="config-key">目录结构</span><code>%Y/%m/%d（固定不可更改，代码按此读取）</code></div>
                <div class="config-row"><span class="config-key">EXIF</span><code>--set-exif-datetime（写入拍摄时间标签）</code></div>
                <div class="config-row"><span class="config-key">增量同步</span><code>--until-found 20</code></div>
                <div class="config-row"><span class="config-key">会话</span><code>cookie 存于各库 cookies 目录，过期后在主界面/本页重新链接</code></div>
                <div class="config-note">后续需要自定义参数时，再按官方实际可用命令逐项开放（先出方案确认）。</div>
              </div>

              <!-- 每库同步：共享组件 SyncButton（与主界面视觉/状态机完全一致），全局单任务 -->
              <div class="lib-sync-row">
                <SyncButton
                  :busy="thisLibBusy(lib.id)"
                  :kind="props.stats?.sync.kind ?? 'full'"
                  :starting="!!starting[lib.id]"
                  :picked="pick[lib.id] ?? null"
                  :disabled="otherBusy(lib.id)"
                  @pick="(k) => pickSync(lib.id, k)"
                  @run="runSync(lib.id)"
                  @cancel="cancelSyncRun(lib.id)"
                />
                <span v-if="syncError && (pick[lib.id] || starting[lib.id] || thisLibBusy(lib.id))" class="sync-note err"><i class="sync-dot" aria-hidden="true" />{{ syncError }}</span>
                <span v-else-if="thisLibBusy(lib.id)" class="sync-note" :class="syncStatusClass(props.stats!.sync.status)"><i class="sync-dot" aria-hidden="true" />{{ props.stats!.sync.message }}</span>
                <span v-else-if="props.stats?.sync.status === 'done' && props.stats.sync.libraryId === lib.id" class="sync-note ok">
                  <i class="sync-dot" aria-hidden="true" />同步完成，本次下载 {{ props.stats.sync.downloaded }} 项
                </span>
                <span v-else-if="otherBusy(lib.id) && pick[lib.id]" class="sync-note warn">
                  <i class="sync-dot" aria-hidden="true" />其他库同步中，请等待完成后再执行
                </span>
              </div>
              <!-- icloudpd 运行日志（该库任务输出，按钮下方独立整行，随 stats 轮询更新） -->
              <div v-if="props.stats?.sync.libraryId === lib.id && syncLogLines.length" class="lib-log">
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

            <button class="add-lib-btn" type="button" @click="emit('new-library')">
              <span>+</span> 添加照片库（新建库 → 链接 → 全量拉取）
            </button>
          </template>

          <template v-else>
            <div class="settings-title">关于</div>
            <div class="settings-sub">iCloud 本地照片应用 · P0 照片库同步迭代</div>
            <div class="config-card">
              <div class="config-row"><span class="config-key">照片墙</span><code>本地浏览，缩略图按需生成</code></div>
              <div class="config-row"><span class="config-key">同步</span><code>icloudpd 官方 exe（1.32.3，免 Python）</code></div>
              <div class="config-row"><span class="config-key">数据</span><code>SQLite（better-sqlite3）+ meta.db 多库注册表</code></div>
            </div>
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
          <input v-model="removePhotos" type="checkbox" />
          <span>同时删除本地已下载的照片副本（<code>{{ deleteTarget.libraryRoot ?? '—' }}</code>）</span>
        </label>
        <p v-if="deleteError" class="delete-error" role="alert">{{ deleteError }}</p>
        <footer class="delete-actions">
          <button class="onboard-btn" type="button" @click="deleteTarget = null">取消</button>
          <button class="onboard-btn danger" type="button" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? '删除中…' : '确认删除' }}
          </button>
        </footer>
      </section>
    </div>
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
.settings-empty { color: var(--text-2); font-size: 12px; }
.settings-link { border: 0; background: transparent; color: #4384ee; font: inherit; font-size: 12px; cursor: pointer; }

.lib-card {
  margin-bottom: 10px;
  padding: 13px 15px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-panel);
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
.lib-card-actions { display: flex; gap: 6px; flex-shrink: 0; }
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
.btn-ghost.danger { color: #d05245; }
.btn-ghost.danger:hover { background: rgb(208 82 69 / 9%); color: #d05245; }
.btn-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
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
/* 照片/视频数：普通灰色小字，不做胶囊标签 */
.lib-card-count {
  margin-top: 4px;
  color: var(--text-3);
  font-size: 11.5px;
}

/* 照片库配置展开区 */
.config-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 9px;
  padding: 3px 2px;
  border: 0;
  background: transparent;
  color: #4384ee;
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
.config-toggle .chev {
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
  padding: 12px 14px 4px;
  border: 1px solid rgb(67 132 238 / 16%);
  border-radius: 10px;
  background: rgb(67 132 238 / 5%);
}
.lib-sync-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}
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
.delete-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 16px; }
.onboard-btn {
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
.onboard-btn:disabled { opacity: 0.55; cursor: wait; }
</style>
