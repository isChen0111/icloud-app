<script setup lang="ts">
/**
 * 新建照片库引导（P0 首次引导 / 手动新建共用）
 *
 * 两步：
 *   ① 设置照片库名字（createLibrary）
 *   ② 添加照片 —— 两条来源并列、互相独立，可都做 / 只做一条 / 都不做
 *        · 从 iCloud 拉取：链接 Apple ID → 全量拉取
 *        · 导入本地照片目录：本机迁移 / 其他设备上传（复用 ImportDialog）
 *
 * 为什么步骤②不再是「链接 iCloud → 全量拉取」的线性流程（2026-11-02 重构）：
 * 照片库本质上有两条来源，用户可能只用其中一条。原先把「链接 iCloud」写成必经步骤、
 * 把「导入本地目录」塞成它旁边的支路，导致：导入完回到步骤②又被要求链接 iCloud，
 * 分支没有出口；步骤③也只能由链接 iCloud 进入。改成两张可选卡片后，两条来源地位对等，
 * 跳过也是正常选择（库已建好，之后在设置中心补）。
 *
 * 切库时机：导入/拉取接口只接受「当前激活库」，而新建的库在已有其他库时不会被激活
 * （后端刻意不激活，避免建库就把用户当前照片墙换掉）。因此：
 *   - 打开导入弹窗、打开认证弹窗都不切库；
 *   - 只有用户真正点「开始导入 / 开始上传 / 开始全量拉取」时才切，并且先弹确认说明后果。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { createLibrary, switchLibrary } from '../api/client'
import { useTaskStore } from '../stores/tasks'
import AuthDialog from './AuthDialog.vue'
import ImportDialog from './ImportDialog.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const emit = defineEmits<{
  close: []
  /** 引导期间切换了激活库（R-22）：App 关闭引导时要整页刷新，否则页面数据仍是旧库 */
  switched: []
}>()

const tasks = useTaskStore()

const step = ref<1 | 2>(1)
const name = ref('')
const nameError = ref('')
const creating = ref(false)
/** 照片库创建成功（先展示成功提示，再手动进入下一步） */
const created = ref(false)
const libraryId = ref<number | null>(null)
/** 该库创建后是否就是激活库（已有其他库时后端不激活新库，R-22） */
const libActive = ref(true)

/* ===== 卡片一：iCloud ===== */
const authOpen = ref(false)
const authDone = ref(false)
const syncing = ref(false)
/** 同步任务快照（仅当归属本库时才有值；避免看到别的库的任务） */
const sync = computed(() => {
  const s = tasks.sync
  return s && s.libraryId === libraryId.value ? s : null
})
const syncError = ref('')

/* ===== 卡片二：本地目录 ===== */
const importOpen = ref(false)
const imported = ref<{ processed: number; skipped: number; failed: number } | null>(null)

/** 轮询订阅释放函数（引导页打开期间把任务频率提到活跃档） */
let releaseTasks: (() => void) | null = null

/* ===== 切库确认 ===== */
interface AskState {
  title: string
  desc: string
  confirmText: string
  resolve: (ok: boolean) => void
}
const ask = ref<AskState | null>(null)

function confirmAsk(title: string, desc: string, confirmText: string): Promise<boolean> {
  return new Promise((resolve) => {
    ask.value = { title, desc, confirmText, resolve }
  })
}

function settleAsk(ok: boolean): void {
  const cur = ask.value
  ask.value = null
  cur?.resolve(ok)
}

/** ESC 关闭引导（不想继续可直接退出；若已建库，库保留，稍后在设置中心继续） */
function onKeydown(e: KeyboardEvent): void {
  // R-27：认证弹窗 / 导入弹窗 / 切库确认打开时，Esc 归它们自己处理。若这里也响应，
  // 会连带把整个引导关掉 → 子弹窗被卸载 → icloudpd 子进程留在后台占着 8080。
  if (e.key === 'Escape' && !authOpen.value && !importOpen.value && !ask.value) emit('close')
}
/** 步骤 ①：创建照片库并激活（成功后展示成功提示，再手动进入下一步） */

async function submitName(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) {
    nameError.value = '请填写照片库名字'
    return
  }
  creating.value = true
  nameError.value = ''
  try {
    const res = await createLibrary(trimmed)
    libraryId.value = res.library.id
    // 已有其他库时后端只建库不激活（不打断当前照片墙），真正切库推迟到用户点动作按钮那一刻
    libActive.value = res.library.active
    created.value = true
  } catch (err) {
    nameError.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

/**
 * 确保目标库是激活库：不是则先确认、再切换。
 *
 * 返回 false 表示用户放弃（或切换失败），调用方必须中止动作。
 * 只在「用户已经点了具体动作」时调用，不在打开弹窗时调用。
 */
async function ensureActive(action: string): Promise<boolean> {
  if (libraryId.value == null) return false
  if (libActive.value) return true
  const ok = await confirmAsk(
    `切换到「${name.value}」并${action}？`,
    `「${name.value}」还不是当前照片库。继续会立即把它切换为当前库，主界面的照片墙也会换成它`
      + `（之后随时可以在顶部库名菜单或设置中心切回）。`,
    `切换并${action}`,
  )
  if (!ok) return false
  try {
    await switchLibrary(libraryId.value)
    libActive.value = true
    emit('switched')
    return true
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
    return false
  }
}

/** ImportDialog 的启动前钩子：真正点「开始导入 / 开始上传」时才切库 */
function beforeImportStart(mode: 'local' | 'upload'): Promise<boolean> {
  return ensureActive(mode === 'local' ? '开始导入' : '开始上传')
}

function onAuthDone(): void {
  authOpen.value = false
  authDone.value = true
}

function onImportDone(payload: { processed: number; skipped: number; failed: number }): void {
  imported.value = payload
}

/** 卡片一：手动触发全量拉取（用户确认切库后再启动） */
async function startFullSync(): Promise<void> {
  if (libraryId.value == null) return
  syncError.value = ''
  if (!(await ensureActive('开始全量拉取'))) return
  syncing.value = true
  try {
    // 返回值即 running 状态，store 写回后下面的 syncRunning() 立刻为真
    await tasks.startSync(libraryId.value, 'full')
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  } finally {
    syncing.value = false
  }
}

async function cancelFullSync(): Promise<void> {
  if (libraryId.value == null) return
  try {
    await tasks.cancelSync(libraryId.value)
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

const syncRunning = (): boolean => sync.value?.status === 'running' || sync.value?.status === 'waiting_retry'
const syncDone = (): boolean => sync.value?.status === 'done'
/** 实际归置进来的文件数（处理数里含跳过与失败） */
const importLanded = (): number => {
  const r = imported.value
  if (!r) return 0
  return Math.max(0, r.processed - r.skipped - r.failed)
}

/** 两条来源是否已有一条完成（决定底部按钮文案） */
const anyAdded = computed(() => syncDone() || imported.value != null)
/**
 * 底部按钮文案按真实状态说话：
 *   - 拉取中：「后台继续」——关闭引导不会中断服务端任务，先讲清楚再让人点
 *   - 已完成过任一条：「完成」
 *   - 一条都没做：「稍后再说」——避免让「完成」暗示用户必须做点什么
 */
const finishLabel = computed(() => {
  if (syncRunning()) return '后台继续，进入照片库'
  return anyAdded.value ? '完成，进入照片库' : '稍后再说，进入照片库'
})

function finish(): void {
  emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // 引导页打开期间把任务频率提到活跃档；同步进度直接读 store，不再自己拉 /sync
  releaseTasks = tasks.subscribe()
  void tasks.refresh()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  releaseTasks?.()
})
</script>

<template>
  <div class="onboard-backdrop" role="presentation">
    <section class="onboard-card" aria-label="新建照片库">
      <header class="onboard-header">
        <span class="onboard-brand">iCloud本地照片</span>
        <h1>新建照片库</h1>
        <p>把 iCloud 照片或你已有的本地照片归置进来，离线浏览、永不丢失。</p>
        <button class="onboard-close" type="button" aria-label="关闭" title="关闭（已创建的库会保留，可稍后在设置中心继续）" @click="emit('close')">×</button>
      </header>

      <!-- 步骤条 -->
      <ol class="onboard-steps" :class="`step-${step}`">
        <li :class="{ current: step === 1, done: step > 1 }"><span>1</span>设置照片库</li>
        <li :class="{ current: step === 2 }"><span>2</span>添加照片</li>
      </ol>

      <!-- ① 库名 -->
      <form v-if="step === 1 && !created" class="onboard-body" @submit.prevent="submitName">
        <label class="onboard-field">
          <span>照片库名字</span>
          <input
            v-model="name"
            type="text"
            maxlength="32"
            placeholder="例如：我的相册"
            :disabled="creating"
            autofocus
          />
          <small>最多 32 个字符；照片会存放到程序目录下与该名字对应的文件夹，按 年/月/日 归置。</small>
        </label>
        <p v-if="nameError" class="onboard-error" role="alert">{{ nameError }}</p>
        <footer class="onboard-actions">
          <button class="onboard-btn primary" type="submit" :disabled="creating">
            <span v-if="creating" class="spinner" />
            {{ creating ? '创建中…' : '创建照片库' }}
          </button>
        </footer>
      </form>

      <!-- ①′ 创建成功提示 -->
      <div v-else-if="step === 1 && created" class="onboard-body">
        <div class="onboard-success">
          <span class="success-icon">
            <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          </span>
          <strong>照片库「{{ name }}」已创建</strong>
          <small>下一步把照片放进来。两种来源互相独立，可以都做，也可以先跳过。</small>
        </div>
        <footer class="onboard-actions">
          <button class="onboard-btn primary" type="button" @click="step = 2">下一步：添加照片</button>
        </footer>
      </div>

      <!-- ② 添加照片：两条来源并列、独立 -->
      <div v-else class="onboard-body">
        <p class="onboard-lead">
          下面两种方式都可以用，也可以都不选——库已经建好，之后在设置中心的库卡片里随时补。
        </p>

        <p v-if="!libActive" class="onboard-notice">
          「{{ name }}」还不是当前照片库。开始导入或拉取时会先询问是否切换过去。
        </p>

        <!-- 卡片一：iCloud -->
        <section class="src-card" :class="{ done: syncDone() }">
          <header class="src-head">
            <span class="src-ico" :class="{ ok: syncDone() }">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6.8 18a4.3 4.3 0 0 1-.7-8.5A5.6 5.6 0 0 1 17.3 10a3.9 3.9 0 0 1-.3 8" />
                <path d="M12 11.6v6.2" />
                <path d="m9.2 14.8 2.8-2.8 2.8 2.8" />
              </svg>
            </span>
            <div class="src-text">
              <strong>从 iCloud 拉取</strong>
              <small>登录 Apple ID，把 iCloud 里的照片和视频下载到本机</small>
            </div>
            <span v-if="syncDone()" class="src-tag ok">已完成</span>
            <span v-else-if="authDone" class="src-tag">已链接</span>
          </header>

          <div class="src-body">
            <button v-if="!authDone" class="onboard-btn" type="button" @click="authOpen = true">
              链接 iCloud
            </button>

            <template v-else>
              <div v-if="sync && sync.status !== 'idle'" class="onboard-sync">
                <div class="onboard-sync-line">
                  <span class="spinner" v-if="syncRunning()" />
                  <svg v-else-if="sync.status === 'done'" class="sync-check" viewBox="0 0 16 16"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
                  <svg v-else class="sync-err" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1L8 1.5Z" /><path d="M8 5.2v4.2M8 11.7v.1" /></svg>
                  <strong>{{ sync.message }}</strong>
                </div>
                <p v-if="sync.downloaded > 0" class="onboard-sync-count">已下载 {{ sync.downloaded }} 项</p>
              </div>

              <button v-if="syncRunning()" class="onboard-btn" type="button" @click="cancelFullSync">取消拉取</button>
              <button
                v-else-if="sync?.status === 'done'"
                class="onboard-btn"
                type="button"
                :disabled="syncing"
                @click="startFullSync"
              >再拉取一次</button>
              <button v-else class="onboard-btn primary" type="button" :disabled="syncing" @click="startFullSync">
                {{ syncing ? '启动中…' : (sync?.status === 'error' || sync?.status === 'cancelled' ? '重新拉取' : '开始全量拉取') }}
              </button>
              <p v-if="!sync || sync.status === 'idle'" class="src-note">
                首次拉取会下载全部 iCloud 照片，耗时取决于数量和网络，可随时取消，已下载的不会重复下载。
              </p>
            </template>
          </div>
        </section>

        <!-- 卡片二：本地目录 -->
        <section class="src-card" :class="{ done: imported != null }">
          <header class="src-head">
            <span class="src-ico" :class="{ ok: imported != null }">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.5 7.6A2 2 0 0 1 5.5 5.6h3.1l1.8 2.2h8.1a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
              </svg>
            </span>
            <div class="src-text">
              <strong>导入本地照片目录</strong>
              <small>把其他磁盘、旧电脑或手机导出的照片，按拍摄日期归置进来</small>
            </div>
            <span v-if="imported != null" class="src-tag ok">已完成</span>
          </header>

          <div class="src-body">
            <p v-if="imported != null" class="src-result">
              已归置 {{ importLanded() }} 个文件
              <template v-if="imported.skipped > 0"> · 跳过 {{ imported.skipped }}</template>
              <template v-if="imported.failed > 0"> · 失败 {{ imported.failed }}</template>
            </p>
            <button class="onboard-btn" type="button" @click="importOpen = true">
              {{ imported != null ? '再导入一次' : '选择本地目录' }}
            </button>
          </div>
        </section>

        <p v-if="syncError" class="onboard-error" role="alert">{{ syncError }}</p>
        <p v-if="syncRunning()" class="onboard-lead">拉取在后台进行，关闭引导不会中断，可在设置中心的库卡片里查看进度。</p>

        <footer class="onboard-actions">
          <button class="onboard-btn primary" type="button" @click="finish">{{ finishLabel }}</button>
        </footer>
      </div>
    </section>

    <AuthDialog
      v-if="authOpen && libraryId != null"
      :library-id="libraryId"
      :library-name="name"
      @done="onAuthDone"
      @close="authOpen = false"
    />

    <ImportDialog
      v-if="importOpen && libraryId != null"
      :library-id="libraryId"
      :library-name="name"
      :before-start="beforeImportStart"
      @close="importOpen = false"
      @done="onImportDone"
    />

    <ConfirmDialog
      v-if="ask"
      :title="ask.title"
      :desc="ask.desc"
      :confirm-text="ask.confirmText"
      @confirm="settleAsk(true)"
      @cancel="settleAsk(false)"
    />
  </div>
</template>

<style scoped>
.onboard-backdrop {
  position: fixed;
  z-index: 110;
  inset: 0;
  display: grid;
  place-items: center;
  overflow: auto;
  padding: 24px;
  background: rgb(0 0 0 / 32%);
}
.onboard-card {
  position: relative;
  width: min(480px, 100%);
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 20px 60px rgb(0 0 0 / 20%);
}
.onboard-header {
  position: relative;
  padding: 26px 26px 16px;
  border-bottom: 1px solid var(--border);
  text-align: center;
}
.onboard-close {
  position: absolute;
  top: 12px;
  right: 14px;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.onboard-close:hover { background: var(--bg-field-hover); color: var(--text-1); }
.onboard-brand {
  display: block;
  margin-bottom: 10px;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
}
.onboard-header h1 { margin: 0 0 6px; font-size: 21px; }
.onboard-header p { margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.55; }
.onboard-steps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 16px 26px 4px;
  list-style: none;
}
.onboard-steps li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
}
.onboard-steps li span {
  display: inline-grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border: 1.5px solid var(--text-3);
  border-radius: 50%;
  font-size: 10px;
}
.onboard-steps li.current { color: #4384ee; }
.onboard-steps li.current span { border-color: #4384ee; }
.onboard-steps li.done { color: #2c9a61; }
.onboard-steps li.done span { border-color: #2c9a61; background: #2c9a61; color: #fff; }
.onboard-steps li + li::before {
  content: '';
  width: 18px;
  height: 1.5px;
  background: var(--border);
}
.onboard-body { display: grid; gap: 13px; padding: 20px 26px 24px; }
.onboard-field { display: grid; gap: 6px; }
.onboard-field span { color: var(--text-1); font-size: 12px; font-weight: 600; }
/* 与认证弹窗输入框同款三态：默认白底+边框；聚焦蓝边框+光晕；禁用浅灰底 */
.onboard-field input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.onboard-field input::placeholder { color: var(--text-3); }
.onboard-field input:focus { border-color: #4384ee; box-shadow: 0 0 0 3px rgb(67 132 238 / 14%); }
.onboard-field input:disabled { background: #f5f6f8; color: var(--text-3); cursor: wait; }
.onboard-field small { color: var(--text-2); font-size: 10px; line-height: 1.5; }

/* 创建成功提示 */
.onboard-success {
  display: grid;
  gap: 6px;
  justify-items: center;
  padding: 12px 6px 6px;
  text-align: center;
}
.success-icon {
  display: grid;
  width: 46px;
  height: 46px;
  place-items: center;
  border-radius: 50%;
  background: rgb(44 154 97 / 12%);
  color: #2c9a61;
  animation: onboard-pop 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.4);
}
.success-icon svg {
  width: 26px;
  height: 26px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.onboard-success strong { font-size: 14px; }
.onboard-success small { color: var(--text-2); font-size: 11px; line-height: 1.55; max-width: 320px; }
@keyframes onboard-pop {
  0% { transform: scale(0.4); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}
/* 步骤② 引言：先说清「可都做、可都不做」，避免用户以为必须选一条 */
.onboard-lead { margin: 0; color: var(--text-2); font-size: 11.5px; line-height: 1.6; }
/* 非激活库提示：提前告知「等会儿会问你切不切」，而不是等到点了才知道 */
.onboard-notice {
  margin: 0;
  padding: 8px 11px;
  border: 1px solid rgb(168 117 21 / 24%);
  border-radius: 9px;
  background: rgb(168 117 21 / 7%);
  color: #8a6212;
  font-size: 11px;
  line-height: 1.55;
}

/* 来源卡片：一张卡 = 一条独立来源，卡内所有状态自洽，不跨卡依赖 */
.src-card {
  display: grid;
  gap: 11px;
  padding: 13px 14px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-panel);
  transition: border-color 0.2s ease, background 0.2s ease;
}
.src-card.done { border-color: rgb(44 154 97 / 34%); background: rgb(44 154 97 / 4%); }
.src-head { display: flex; align-items: flex-start; gap: 10px; }
.src-ico {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  background: rgb(67 132 238 / 10%);
  color: #3577dc;
  transition: background 0.2s ease, color 0.2s ease;
}
.src-ico.ok { background: rgb(44 154 97 / 13%); color: #2c9a61; }
.src-ico svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.src-text { display: grid; gap: 3px; min-width: 0; }
.src-text strong { font-size: 12.5px; }
.src-text small { color: var(--text-3); font-size: 11px; line-height: 1.5; }
.src-tag {
  margin-left: auto;
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 20px;
  background: rgb(67 132 238 / 10%);
  color: #3577dc;
  font-size: 10px;
  font-weight: 600;
}
.src-tag.ok { background: rgb(44 154 97 / 13%); color: #2c9a61; }
.src-body { display: grid; gap: 9px; }
.src-body > .onboard-btn { width: 100%; }
.src-note { margin: 0; color: var(--text-3); font-size: 10.5px; line-height: 1.55; }
.src-result { margin: 0; color: var(--text-2); font-size: 11px; }

.onboard-warn { color: #a87515 !important; }
.onboard-error { margin: 0; color: #d05245; font-size: 11px; line-height: 1.5; }
.onboard-actions { display: flex; justify-content: flex-end; gap: 9px; }
.onboard-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 13px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.onboard-btn:hover { border-color: rgb(67 132 238 / 45%); }
.onboard-btn .spinner { width: 12px; height: 12px; }
.onboard-btn.primary { border-color: #4384ee; background: #4384ee; color: #fff; }
.onboard-btn.primary:hover { background: #3577dc; border-color: #3577dc; }
.onboard-btn:disabled { opacity: 0.55; cursor: wait; }
.onboard-sync { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-field); }
.onboard-sync-line { display: flex; align-items: center; gap: 8px; }
.onboard-sync-line strong { font-size: 12px; font-weight: 650; }
.onboard-sync-count { margin: 0; color: var(--text-2); font-size: 11px; }
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: onboard-spin 0.8s linear infinite;
  flex: 0 0 auto;
}
@keyframes onboard-spin { to { transform: rotate(360deg); } }
.sync-check {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: #2c9a61;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sync-err {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: #d05245;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
