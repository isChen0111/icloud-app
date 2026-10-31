<script setup lang="ts">
/**
 * iCloud 认证面板（P0 自绘方案，替代 icloudpd webui）
 *
 * 交互：
 *   ① 新建链接：输入 Apple ID 邮箱 → 开始链接（后端 auth-only 进程启动）
 *   ② 刷新链接（已链接过的库，account 固定）：跳过邮箱步骤，直接进入认证流程
 *   ③ 按后端提示输入密码 → 输入验证码（如需要）→ 完成
 *
 * 已链接库固定邮箱不可改（换邮箱会造成照片库目录/会话错乱）；
 * 凭据只经后端进程 stdin 传递，不落盘、不进日志；本组件不持久化任何输入。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { startAuth, sendAuthInput, fetchAuth, cancelAuth } from '../api/client'
import type { AuthSession } from '../types'

const props = defineProps<{ libraryId: number; libraryName: string; account?: string | null; autoStart?: boolean }>()
const emit = defineEmits<{ done: []; close: [] }>()

const username = ref('')
const password = ref('')
const code = ref('')
const stage = ref<AuthSession['stage'] | null>(null)
const hint = ref('')
const message = ref('')
const busy = ref(false)
const started = ref(false)
const passwordTried = ref(false)
/** 提交密码/验证码后的锁定态：等后端确认（轮询到阶段变化或错误）才解锁，防重复提交 */
const submitting = ref(false)
let lastStage: AuthSession['stage'] | null = null

/** 步骤指示：1 密码 → 2 验证码 → 3 完成（设计稿认证面板；校验中跟随其所属步骤） */
const stepIndex = computed(() => {
  if (stage.value === 'done') return 3
  if (stage.value === 'waiting_code') return 2
  if (submitting.value && lastStage === 'waiting_code') return 2
  return 1
})

let pollTimer: number | undefined

/** 开始链接：已链接库用固定邮箱（props.account），新建库用输入邮箱 */
async function begin(): Promise<void> {
  // 认证已在进行：拒绝再次启动（后端 startAuth 同步返回，busy 锁太短，需此防连点重复 spawn）
  if (started.value || busy.value) return
  const email = props.account ?? username.value.trim()
  if (!props.account && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    message.value = '请输入正确的 Apple ID 邮箱'
    return
  }
  busy.value = true
  message.value = ''
  try {
    const res = await startAuth(props.libraryId, email)
    stage.value = res.auth.stage
    hint.value = res.auth.hint
    started.value = true
    startPolling()
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

/** 提交当前输入（密码 / 验证码）：提交后锁定，等后端确认阶段变化才解锁 */
async function submitInput(): Promise<void> {
  if (submitting.value) return // 防重复提交
  const value = stage.value === 'waiting_password' ? password.value : code.value
  if (!value.trim()) {
    message.value = stage.value === 'waiting_password' ? '请输入密码' : '请输入验证码'
    return
  }
  submitting.value = true
  lastStage = stage.value
  message.value = ''
  try {
    const res = await sendAuthInput(value.trim())
    if (stage.value === 'waiting_password') {
      passwordTried.value = true
      password.value = ''
    } else {
      code.value = ''
    }
    stage.value = res.auth.stage
    hint.value = res.auth.hint
    if (res.auth.message) message.value = res.auth.message
    // 后端已落定本次提交（pending=false）、或到终态：立刻解锁，不等下一轮轮询。
    // pending=false 覆盖「验证码输错」这类阶段不变的场景，否则会一直停在转圈视图。
    if (res.auth.pending === false || res.auth.stage === 'done' || res.auth.stage === 'error') {
      submitting.value = false
      if (res.auth.stage === 'done' || res.auth.stage === 'error') stopPolling()
    }
  } catch (err) {
    submitting.value = false
    message.value = err instanceof Error ? err.message : String(err)
  }
  // 仍在等待确认（pending=true）时保持锁定，等轮询解锁
}

/** 轮询会话状态：完成/错误即停；密码输错后端会再次提示密码 */
async function poll(): Promise<void> {
  try {
    const { auth } = await fetchAuth()
    if (!auth) {
      stopPolling()
      message.value = '认证会话已结束，请重新开始'
      started.value = false
      submitting.value = false
      return
    }
    // 提交后的解锁条件：后端本次提交已落定（pending=false）、阶段变化、或带回错误文案。
    // 早期只判后两者，而「验证码输错」恰好阶段不变且错误文案解析不到 → 永久转圈。
    if (submitting.value && (auth.pending === false || auth.stage !== lastStage || auth.message)) {
      submitting.value = false
    }
    stage.value = auth.stage
    hint.value = auth.hint
    if (auth.message) message.value = auth.message
    if (auth.stage === 'done') {
      // 成功：停轮询、解锁，展示成功视图（用户点「完成」再退出，不自动关）
      stopPolling()
      submitting.value = false
    } else if (auth.stage === 'error') {
      // 失败：停轮询、解锁，展示失败视图（用户点「关闭」退出）
      stopPolling()
      submitting.value = false
    }
  } catch {
    // 网络抖动忽略，下轮再试
  }
}

function startPolling(): void {
  stopPolling()
  pollTimer = window.setInterval(() => void poll(), 1000)
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}

/** 取消认证（幂等）：handleClose 与卸载钩子都可能触发，避免重复打后端 */
let cancelRequested = false
async function requestCancel(): Promise<void> {
  if (cancelRequested || !started.value) return
  cancelRequested = true
  try {
    await cancelAuth()
  } catch {
    // 后端不可达时忽略
  }
}

async function handleClose(): Promise<void> {
  // 只有「启动请求还在飞」时才拦：提交密码/验证码期间允许关闭，否则后端卡住时用户无路可退
  // （关闭会调用 cancelAuth 结束 icloudpd 进程，不会留下孤儿占着 8080）。
  if (busy.value) return
  stopPolling()
  await requestCancel()
  emit('close')
}

/** Esc 关闭弹窗：弹窗是最上层，Esc 归它处理（引导页的 Esc 会被 authOpen 拦下） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') void handleClose()
}

/** 成功后用户点「完成」关闭（成功视图停留，让用户明确看到结果） */
function finish(): void {
  stopPolling()
  emit('done')
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  stopPolling()
  // R-27：组件被父级无条件卸载（例如引导页被整体关闭）时也必须收掉 icloudpd
  // 子进程。它继续占着 8080 会让下次认证直接起不来，而界面上看不出任何原因。
  void requestCancel()
})

/** 设置中心/主界面点「刷新链接」（已有 account）打开即自动开始认证，不再要求二次点击 */
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (props.autoStart && props.account) void begin()
})
</script>

<template>
  <div class="auth-backdrop" role="presentation" @pointerdown.stop @click.self="handleClose">
    <section class="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title">
      <header class="auth-dialog-header">
        <div>
          <h2 id="auth-dialog-title">链接 iCloud 照片库</h2>
          <p>
            {{ started ? '凭据仅本次使用，认证成功后保存为本地 cookie，不会上传到本应用以外的任何地方。' : '使用 Apple ID 登录，应用将读取你的 iCloud 照片。' }}
          </p>
        </div>
        <button class="dialog-close" type="button" aria-label="关闭" :disabled="busy" @click="handleClose">×</button>
      </header>

      <!-- 步骤指示（设计稿认证面板：密码 → 验证码 → 完成；已完成打 ✓，当前步高亮） -->
      <div v-if="started" class="auth-steps" aria-hidden="true">
        <span class="as" :class="{ on: stepIndex === 1, ok: stepIndex > 1 }">
          <span class="pill">{{ stepIndex > 1 ? '✓' : '1' }}</span> 密码
        </span>
        <span class="ln" />
        <span class="as" :class="{ on: stepIndex === 2, ok: stepIndex > 2 }">
          <span class="pill">{{ stepIndex > 2 ? '✓' : '2' }}</span> 验证码
        </span>
        <span class="ln" />
        <span class="as" :class="{ on: stepIndex === 3 }">
          <span class="pill">3</span> 完成
        </span>
      </div>

      <!-- 第一步：邮箱（新建链接）；已链接库固定邮箱、直接开始认证 -->
      <form v-if="!started && !props.account" class="auth-form" @submit.prevent="begin">
        <label class="auth-field">
          <span>Apple ID 邮箱</span>
          <input
            v-model="username"
            type="email"
            inputmode="email"
            autocomplete="username"
            placeholder="例如 ischen0111@foxmail.com"
            :disabled="busy"
          />
        </label>
        <p v-if="message" class="auth-error" role="alert">{{ message }}</p>
        <footer class="auth-actions">
          <button class="action-button" type="button" :disabled="busy" @click="handleClose">取消</button>
          <button class="action-button primary" type="submit" :disabled="busy">
            {{ busy ? '启动中…' : '开始链接' }}
          </button>
        </footer>
      </form>

      <!-- 已链接库：固定邮箱不可改（防换邮箱错乱），挂载即 autoStart 直接认证，无需确认页 -->
      <form v-else-if="!started && props.account" class="auth-form" @submit.prevent="begin">
        <div class="auth-fixed-account">
          <span class="auth-fixed-label">Apple ID 邮箱</span>
          <code>{{ props.account }}</code>
        </div>
        <p v-if="message" class="auth-error" role="alert">{{ message }}</p>
        <footer class="auth-actions">
          <button class="action-button" type="button" :disabled="busy" @click="handleClose">取消</button>
          <button class="action-button primary" type="submit" :disabled="busy || started">
            {{ busy ? '启动中…' : '刷新链接' }}
          </button>
        </footer>
      </form>

      <!-- 第二步：分步状态机——启动 → 输密码 → 校验密码 → 输验证码 → 校验验证码 → 成功/失败。
           每步 UI 独立：校验中只显示转圈文案（不残留输入框/标题），结果用动画图标提示 -->
      <form v-else class="auth-form" @submit.prevent="submitInput">
        <!-- 1. 启动认证服务（无输入框） -->
        <template v-if="stage === 'starting'">
          <div class="auth-stage">
            <span class="auth-stage-icon"><span class="spinner" /></span>
            <div class="auth-stage-copy">
              <strong>正在启动认证服务…</strong>
              <small>正在建立与 iCloud 的安全连接</small>
            </div>
          </div>
          <footer class="auth-actions">
            <button class="action-button" type="button" :disabled="busy || submitting" @click="handleClose">取消</button>
          </footer>
        </template>

        <!-- 2. 校验中（密码/验证码提交后，等待后端确认；不显示输入框和提交按钮） -->
        <template v-else-if="submitting">
          <div class="auth-stage">
            <span class="auth-stage-icon"><span class="spinner" /></span>
            <div class="auth-stage-copy">
              <strong>{{ stage === 'waiting_password' ? '正在校验密码…' : '正在校验验证码…' }}</strong>
              <small>{{ hint }}</small>
            </div>
          </div>
          <!-- 校验中保留取消入口：后端若长时间无响应，用户至少能退出重来（不会留下孤儿进程） -->
          <footer class="auth-actions">
            <button class="action-button" type="button" @click="handleClose">取消</button>
          </footer>
        </template>

        <!-- 3. 链接成功 -->
        <template v-else-if="stage === 'done'">
          <div class="auth-result ok">
            <span class="auth-result-icon">
              <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
            </span>
            <strong>链接成功</strong>
            <small>iCloud 会话 cookie 已保存到本机，可以开始同步照片了</small>
          </div>
          <footer class="auth-actions">
            <button class="action-button primary" type="button" @click="finish">完成</button>
          </footer>
        </template>

        <!-- 4. 链接失败（启动失败/进程异常/超时等终态） -->
        <template v-else-if="stage === 'error'">
          <div class="auth-result err">
            <span class="auth-result-icon">
              <svg viewBox="0 0 24 24"><path d="M12 3 21 20H3L12 3Z" /><path d="M12 9.5v4.5M12 16.8v.2" /></svg>
            </span>
            <strong>链接失败</strong>
            <small>{{ message || '认证服务异常，请重试' }}</small>
          </div>
          <footer class="auth-actions">
            <button class="action-button" type="button" @click="handleClose">关闭</button>
          </footer>
        </template>

        <!-- 5. 输入密码 -->
        <template v-else-if="stage === 'waiting_password'">
          <div class="auth-stage">
            <span class="auth-stage-icon"><span class="spinner" /></span>
            <div class="auth-stage-copy">
              <strong>请输入 Apple ID 密码</strong>
              <small>{{ hint }}</small>
            </div>
          </div>
          <label class="auth-field">
            <span>密码</span>
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              placeholder="Apple ID 密码"
              :disabled="busy || submitting"
              autofocus
            />
          </label>
          <p v-if="message" class="auth-error" role="alert">
            {{ message }}
            <template v-if="passwordTried && !submitting">（若密码正确，请检查 Apple 是否要求双重验证）</template>
          </p>
          <footer class="auth-actions">
            <button class="action-button" type="button" :disabled="busy || submitting" @click="handleClose">取消</button>
            <button class="action-button primary" type="submit" :disabled="busy || submitting">提交密码</button>
          </footer>
        </template>

        <!-- 6. 输入验证码 -->
        <template v-else-if="stage === 'waiting_code'">
          <div class="auth-stage">
            <span class="auth-stage-icon"><span class="spinner" /></span>
            <div class="auth-stage-copy">
              <strong>请输入验证码</strong>
              <small>{{ hint }}</small>
            </div>
          </div>
          <label class="auth-field">
            <span>验证码</span>
            <input
              v-model="code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              placeholder="6 位验证码"
              :disabled="busy || submitting"
              autofocus
            />
          </label>
          <p v-if="message" class="auth-error" role="alert">{{ message }}</p>
          <footer class="auth-actions">
            <button class="action-button" type="button" :disabled="busy || submitting" @click="handleClose">取消</button>
            <button class="action-button primary" type="submit" :disabled="busy || submitting">确认验证码</button>
          </footer>
        </template>
      </form>
    </section>
  </div>
</template>

<style scoped>
.auth-backdrop {
  position: fixed;
  z-index: 120;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(0 0 0 / 42%);
}
.auth-dialog {
  width: min(430px, 100%);
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 18px 54px rgb(0 0 0 / 28%);
}
.auth-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 19px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.auth-dialog-header h2 { margin: 0 0 4px; font-size: 16px; }
.auth-dialog-header p { margin: 0; color: var(--text-2); font-size: 11px; line-height: 1.5; }
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
.dialog-close:disabled { opacity: 0.5; cursor: wait; }
.auth-form { display: grid; gap: 13px; padding: 17px 20px 15px; }
.auth-field { display: grid; gap: 5px; }
.auth-field span { color: var(--text-2); font-size: 11px; font-weight: 600; }
/* 输入框三态（设计稿 .field input）：默认白底+边框；聚焦蓝边框+光晕；禁用浅灰底（可读但不可输入） */
.auth-field input {
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
.auth-field input::placeholder { color: var(--text-3); }
.auth-field input:focus { border-color: #4384ee; box-shadow: 0 0 0 3px rgb(67 132 238 / 14%); }
.auth-field input:disabled { background: #f5f6f8; color: var(--text-3); cursor: wait; }

/* 步骤指示（设计稿 auth-steps） */
.auth-steps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px 20px 0;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
}
.auth-steps .as { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.auth-steps .as.on { color: #4384ee; }
.auth-steps .as.ok { color: #2c9a61; }
.auth-steps .pill {
  display: inline-grid;
  width: 17px;
  height: 17px;
  place-items: center;
  border-radius: 50%;
  background: var(--bg-field);
  font-size: 10px;
}
.auth-steps .as.on .pill { background: #4384ee; color: #fff; }
.auth-steps .as.ok .pill { background: #2c9a61; color: #fff; }
.auth-steps .ln { width: 26px; height: 1px; background: var(--border); }
.auth-fixed-account {
  display: grid;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-field);
}
.auth-fixed-label { color: var(--text-2); font-size: 11px; font-weight: 600; }
.auth-fixed-account code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 13px;
  word-break: break-all;
}
.auth-fixed-note { margin: 0; color: var(--text-3); font-size: 10.5px; line-height: 1.5; }
.auth-stage {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-field);
}
.auth-stage-icon { display: inline-grid; width: 22px; height: 22px; flex: 0 0 auto; place-items: center; }
.auth-stage-icon svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.auth-stage-icon .icon-cutout { stroke: #fff !important; }
.auth-stage-icon.ok { color: #2c9a61; }
.auth-stage-icon.err { color: #d05245; }
.auth-stage-copy { display: grid; gap: 2px; min-width: 0; }
.auth-stage-copy strong { font-size: 12px; font-weight: 650; }
.auth-stage-copy small { color: var(--text-2); font-size: 10px; line-height: 1.45; }

/* 认证结果视图（成功/失败终态，动画图标提醒） */
.auth-result {
  display: grid;
  gap: 6px;
  justify-items: center;
  padding: 18px 8px 10px;
  text-align: center;
}
.auth-result-icon {
  display: grid;
  width: 46px;
  height: 46px;
  place-items: center;
  border-radius: 50%;
  animation: auth-result-pop 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.4);
}
.auth-result.ok .auth-result-icon { background: rgb(44 154 97 / 12%); color: #2c9a61; }
.auth-result.err .auth-result-icon { background: rgb(208 82 69 / 12%); color: #d05245; }
.auth-result-icon svg {
  width: 26px;
  height: 26px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.auth-result strong { font-size: 15px; }
.auth-result small { color: var(--text-2); font-size: 11px; line-height: 1.55; max-width: 320px; }
@keyframes auth-result-pop {
  0% { transform: scale(0.4); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}
.auth-error { margin: 0; color: #d05245; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.auth-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px; }
.action-button {
  padding: 6px 11px;
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
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: auth-spin 0.8s linear infinite;
}
@keyframes auth-spin { to { transform: rotate(360deg); } }
@media (max-width: 480px) {
  .auth-backdrop { padding: 10px; }
}
</style>
