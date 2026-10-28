<script setup lang="ts">
/**
 * 新建照片库引导（P0 首次引导 / 手动新建共用）
 *
 * 三步（设计稿）：
 *   ① 设置照片库名字（createLibrary → 后端热切换激活新库）
 *   ② 链接 iCloud（AuthDialog：邮箱 / 密码 / 验证码）
 *   ③ 全量拉取 —— 手动触发，用户确认后才执行（拉取有程序运行代价，
 *      由用户决定什么时候拉）；完成后进入照片库。
 *
 * 触发：无任何照片库时自动显示（首次启动引导）；有库时可由状态组件「新建照片库」打开。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createLibrary, startSync, fetchSync, cancelSync, switchLibrary } from '../api/client'
import type { SyncState } from '../types'
import AuthDialog from './AuthDialog.vue'

const emit = defineEmits<{
  close: []
  /** 引导期间切换了激活库（R-22）：App 关闭引导时要整页刷新，否则页面数据仍是旧库 */
  switched: []
}>()

/** ESC 关闭引导（不想继续可直接退出；若已建库，库保留，稍后在设置中心继续链接） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const step = ref<1 | 2 | 3>(1)
const name = ref('')
const nameError = ref('')
const creating = ref(false)
/** 照片库创建成功（先展示成功提示，再手动进入链接步骤） */
const created = ref(false)
const libraryId = ref<number | null>(null)
/** 该库创建后是否就是激活库（已有其他库时后端不激活新库，R-22） */
const libActive = ref(true)
const authOpen = ref(false)
const authDone = ref(false)
const syncing = ref(false)
const sync = ref<SyncState | null>(null)
const syncError = ref('')

let syncTimer: number | undefined

/** 步骤 ①：创建照片库并激活（成功后展示成功提示，再手动进入链接步骤） */
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
    // 已有其他库时后端只建库不激活（不打断当前照片墙），同步前需要先切过来（见 startFullSync）
    libActive.value = res.library.active
    created.value = true // 停在步骤①，先让用户看到「已创建」成功提示
  } catch (err) {
    nameError.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

/** 步骤 ②：认证完成 */
function onAuthDone(): void {
  authOpen.value = false
  authDone.value = true
  step.value = 3
}

/** 步骤 ③：手动触发全量拉取（用户确认后） */
async function startFullSync(): Promise<void> {
  if (libraryId.value == null) return
  syncing.value = true
  syncError.value = ''
  try {
    // R-22：同步接口只允许对「当前激活库」执行，而已有其他库时新建的库不激活
    // （后端刻意不激活，避免建库就把用户当前照片墙换掉）。
    // 走到这一步说明用户明确要用这个库了，因此先热切换再同步：
    // 停旧库 watcher → 清缩略图队列 → 关旧 DB → 覆写路径 → 重扫新库，
    // 全程不动 location，引导弹窗与已完成的认证都不受影响。
    if (!libActive.value) {
      await switchLibrary(libraryId.value)
      libActive.value = true
      emit('switched') // 通知 App：关闭引导时要整页刷新
    }
    const res = await startSync(libraryId.value, 'full')
    sync.value = res.sync
    startPolling()
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  } finally {
    syncing.value = false
  }
}

async function pollSync(): Promise<void> {
  if (libraryId.value == null) return
  try {
    const { sync: next } = await fetchSync(libraryId.value)
    sync.value = next
    if (next.status === 'done' || next.status === 'error' || next.status === 'cancelled') {
      stopPolling()
    }
  } catch {
    // 抖动忽略
  }
}

function startPolling(): void {
  stopPolling()
  syncTimer = window.setInterval(() => void pollSync(), 2000)
}

function stopPolling(): void {
  if (syncTimer !== undefined) {
    window.clearInterval(syncTimer)
    syncTimer = undefined
  }
}

async function cancelFullSync(): Promise<void> {
  if (libraryId.value == null) return
  try {
    const res = await cancelSync(libraryId.value)
    sync.value = res.sync
    stopPolling()
  } catch (err) {
    syncError.value = err instanceof Error ? err.message : String(err)
  }
}

function finish(): void {
  stopPolling()
  emit('close')
}

onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="onboard-backdrop" role="presentation">
    <section class="onboard-card" aria-label="新建照片库">
      <header class="onboard-header">
        <span class="onboard-brand">iCloud本地照片</span>
        <h1>新建照片库</h1>
        <p>把 iCloud 照片下载到本地，离线浏览、永不丢失。</p>
        <button class="onboard-close" type="button" aria-label="关闭" title="关闭（已创建的库会保留，可稍后在设置中心继续）" @click="emit('close')">×</button>
      </header>

      <!-- 步骤条 -->
      <ol class="onboard-steps" :class="`step-${step}`">
        <li :class="{ current: step === 1, done: step > 1 }"><span>1</span>设置照片库</li>
        <li :class="{ current: step === 2, done: step > 2 }"><span>2</span>链接 iCloud</li>
        <li :class="{ current: step === 3 }"><span>3</span>全量拉取</li>
      </ol>

      <!-- ① 库名（创建中动画；创建成功后展示成功提示，再进入链接） -->
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
          <small>最多 32 个字符；照片将下载到项目内与该名字对应的目录，目录结构固定为 年/月/日。</small>
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
          <small>本地照片库已就绪。下一步链接你的 Apple ID，即可把 iCloud 照片同步到本机。</small>
        </div>
        <footer class="onboard-actions">
          <button class="onboard-btn primary" type="button" @click="step = 2">下一步：链接 iCloud</button>
        </footer>
      </div>

      <!-- ② 链接 -->
      <div v-else-if="step === 2" class="onboard-body">
        <div class="onboard-intro">
          <p>登录你的 Apple ID，应用将调用官方 icloudpd 工具建立本机会话（cookie 保存在本机照片库目录内）。</p>
        </div>
        <footer class="onboard-actions">
          <button class="onboard-btn primary" type="button" @click="authOpen = true">链接 iCloud</button>
        </footer>
      </div>

      <!-- ③ 全量拉取 -->
      <div v-else class="onboard-body">
        <div v-if="!sync || sync.status === 'idle'" class="onboard-intro">
          <p class="onboard-warn">
            首次拉取会下载全部 iCloud 照片到本地，耗时取决于照片数量和网络，可随时取消后再次执行（已下载的部分不会重复下载）。
          </p>
        </div>
        <p v-if="syncError" class="onboard-error" role="alert">{{ syncError }}</p>

        <!-- 任务状态 -->
        <div v-if="sync && sync.status !== 'idle'" class="onboard-sync">
          <div class="onboard-sync-line">
            <span class="spinner" v-if="sync.status === 'running' || sync.status === 'waiting_retry'" />
            <svg v-else-if="sync.status === 'done'" class="sync-check" viewBox="0 0 16 16"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
            <svg v-else-if="sync.status === 'error'" class="sync-err" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1L8 1.5Z" /><path d="M8 5.2v4.2M8 11.7v.1" /></svg>
            <strong>{{ sync.message }}</strong>
          </div>
          <p v-if="sync.downloaded > 0" class="onboard-sync-count">已下载 {{ sync.downloaded }} 项</p>
        </div>

        <footer class="onboard-actions">
          <template v-if="sync?.status === 'running' || sync?.status === 'waiting_retry'">
            <button class="onboard-btn" type="button" @click="cancelFullSync">取消</button>
          </template>
          <template v-else-if="sync?.status === 'done'">
            <button class="onboard-btn primary" type="button" @click="finish">进入照片库</button>
          </template>
          <template v-else-if="sync?.status === 'error' || sync?.status === 'cancelled'">
            <button class="onboard-btn" type="button" @click="startFullSync">重新拉取</button>
            <button class="onboard-btn primary" type="button" @click="finish">先跳过，稍后再说</button>
          </template>
          <template v-else>
            <button class="onboard-btn primary" type="button" :disabled="syncing" @click="startFullSync">
              {{ syncing ? '启动中…' : '开始全量拉取' }}
            </button>
          </template>
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
.onboard-body { display: grid; gap: 15px; padding: 20px 26px 24px; }
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
.onboard-intro p { margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.6; }
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
}
.onboard-btn .spinner { width: 12px; height: 12px; }
.onboard-btn.primary { border-color: #4384ee; background: #4384ee; color: #fff; }
.onboard-btn:disabled { opacity: 0.55; cursor: wait; }
.onboard-sync { display: grid; gap: 6px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-field); }
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
