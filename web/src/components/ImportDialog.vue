<script setup lang="ts">
/**
 * 导入本地照片目录弹窗（设置中心 + 首次引导共用）
 *
 * 两种来源，处理逻辑不同：
 *   - 本机迁移：后端运行机器上的本地目录，直接填绝对路径（后端直读文件系统），
 *     默认复制，可选「导入后删除源文件」。
 *   - 上传：其他设备浏览器整文件夹上传（webkitdirectory 保留相对路径），
 *     上传完成后后端走同一条归置流水线。
 *
 * 进度：导入阶段轮询 GET /api/libraries/:id/import（2s），仿同步任务的轮询形态。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { startLocalImport, uploadImport, fetchImport, cancelImport } from '../api/client'
import type { ImportState } from '../types'

const props = defineProps<{ libraryId: number; libraryName: string }>()
const emit = defineEmits<{ close: []; 'need-stats-refresh': [] }>()

type Mode = 'local' | 'upload'
const mode = ref<Mode>('local')

/* ===== 本机迁移 ===== */
const localPath = ref('')
const localMove = ref(false) // false=复制（保留源文件）；true=移动（导入后删除源文件）

/* ===== 上传 ===== */
const files = ref<File[]>([])
const uploadPct = ref(0)
const uploading = ref(false)
let abortCtrl: AbortController | null = null

/* ===== 导入状态 ===== */
const state = ref<ImportState | null>(null)
const error = ref('')
let pollTimer: number | undefined

const running = computed(() => state.value?.status === 'running')
const totalSizeText = computed(() => {
  const bytes = files.value.reduce((s, f) => s + f.size, 0)
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
})

function onPickFiles(e: Event): void {
  const input = e.target as HTMLInputElement
  files.value = Array.from(input.files ?? [])
}

async function startLocal(): Promise<void> {
  const p = localPath.value.trim()
  if (!p) {
    error.value = '请填写目录路径'
    return
  }
  error.value = ''
  try {
    await startLocalImport(props.libraryId, p, localMove.value ? 'move' : 'copy')
    startPolling()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function startUpload(): Promise<void> {
  if (files.value.length === 0) {
    error.value = '请先选择要上传的文件夹'
    return
  }
  error.value = ''
  uploading.value = true
  uploadPct.value = 0
  abortCtrl = new AbortController()
  try {
    await uploadImport(props.libraryId, files.value, (pct) => (uploadPct.value = pct), abortCtrl.signal)
    startPolling()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    uploading.value = false
    abortCtrl = null
  }
}

function cancelUploading(): void {
  abortCtrl?.abort()
}

async function pollImport(): Promise<void> {
  try {
    const { import: next } = await fetchImport(props.libraryId)
    state.value = next
    if (next.status === 'done' || next.status === 'error' || next.status === 'cancelled') {
      stopPolling()
      if (next.status === 'done') emit('need-stats-refresh')
    }
  } catch {
    // 抖动忽略
  }
}

function startPolling(): void {
  stopPolling()
  state.value = null
  pollTimer = window.setInterval(() => void pollImport(), 2000)
  void pollImport()
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}

async function cancelRun(): Promise<void> {
  try {
    await cancelImport(props.libraryId)
    const { import: next } = await fetchImport(props.libraryId)
    state.value = next
    stopPolling()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function close(): void {
  stopPolling()
  abortCtrl?.abort()
  emit('close')
}

onBeforeUnmount(() => {
  stopPolling()
  abortCtrl?.abort()
})
</script>

<template>
  <div class="import-backdrop" role="presentation" @click.self="close">
    <section class="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <header class="import-header">
        <strong id="import-title">导入本地照片到「{{ libraryName }}」</strong>
        <button class="import-close" type="button" aria-label="关闭" @click="close">×</button>
      </header>

      <!-- 导入进行中 -->
      <div v-if="running" class="import-body">
        <div class="import-status-line">
          <span class="spinner" />
          <strong>{{ state!.message || '正在导入…' }}</strong>
        </div>
        <div class="import-progress">
          <div class="import-progress-bar" :style="{ width: `${state!.totalFiles ? Math.round((state!.processedFiles / state!.totalFiles) * 100) : 0}%` }" />
        </div>
        <p class="import-count">
          已处理 {{ state!.processedFiles }} / {{ state!.totalFiles }}
          <template v-if="state!.skipped > 0"> · 跳过 {{ state!.skipped }}</template>
          <template v-if="state!.failedCount > 0"> · 失败 {{ state!.failedCount }}</template>
        </p>

        <div v-if="state!.failures.length" class="import-failures">
          <div class="import-failures-title">失败清单（{{ state!.failedCount }} 项）</div>
          <ul class="import-failures-list">
            <li v-for="(f, i) in state!.failures" :key="i">
              <code>{{ f.relPath }}</code>
              <span>{{ f.reason }}</span>
            </li>
          </ul>
        </div>

        <p v-if="error" class="import-error" role="alert">{{ error }}</p>
        <footer class="import-actions">
          <button class="onboard-btn" type="button" @click="cancelRun">取消导入</button>
        </footer>
      </div>

      <!-- 上传中（字节进度） -->
      <div v-else-if="uploading" class="import-body">
        <div class="import-status-line"><span class="spinner" /><strong>正在上传…</strong></div>
        <div class="import-progress"><div class="import-progress-bar" :style="{ width: `${uploadPct}%` }" /></div>
        <p class="import-count">{{ uploadPct }}%</p>
        <footer class="import-actions">
          <button class="onboard-btn" type="button" @click="cancelUploading">取消上传</button>
        </footer>
      </div>

      <!-- 完成 / 失败 / 取消 结果 -->
      <div v-else-if="state && state.status !== 'idle'" class="import-body">
        <div class="import-status-line">
          <svg v-if="state.status === 'done'" class="import-check" viewBox="0 0 16 16"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
          <svg v-else class="import-err" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1L8 1.5Z" /><path d="M8 5.2v4.2M8 11.7v.1" /></svg>
          <strong>{{ state.message }}</strong>
        </div>
        <p class="import-count">
          已处理 {{ state.processedFiles }} / {{ state.totalFiles }}
          <template v-if="state.skipped > 0"> · 跳过 {{ state.skipped }}</template>
          <template v-if="state.failedCount > 0"> · 失败 {{ state.failedCount }}</template>
        </p>
        <div v-if="state.failures.length" class="import-failures">
          <div class="import-failures-title">失败清单（{{ state.failedCount }} 项）</div>
          <ul class="import-failures-list">
            <li v-for="(f, i) in state.failures" :key="i"><code>{{ f.relPath }}</code><span>{{ f.reason }}</span></li>
          </ul>
        </div>
        <footer class="import-actions">
          <button class="onboard-btn primary" type="button" @click="close">完成</button>
        </footer>
      </div>

      <!-- 空闲：模式选择 + 输入 -->
      <div v-else class="import-body">
        <div class="import-tabs" role="tablist">
          <button class="import-tab" :class="{ active: mode === 'local' }" type="button" @click="mode = 'local'">本机迁移</button>
          <button class="import-tab" :class="{ active: mode === 'upload' }" type="button" @click="mode = 'upload'">上传</button>
        </div>

        <!-- 本机迁移 -->
        <div v-if="mode === 'local'" class="import-pane">
          <label class="import-field">
            <span>目录路径（本机绝对路径）</span>
            <input v-model="localPath" type="text" placeholder="例如：D:\照片\2024 或 F:\Photos\旅行" />
            <small>这是运行本应用的那台电脑上的目录路径，程序会递归遍历其中的照片/视频，按拍摄日期归置到照片库。</small>
          </label>
          <label class="import-check">
            <input v-model="localMove" type="checkbox" />
            <span>导入后删除源文件（默认保留源文件，只复制）</span>
          </label>
        </div>

        <!-- 上传 -->
        <div v-else class="import-pane">
          <label class="import-field">
            <span>选择要上传的文件夹（整文件夹）</span>
            <input type="file" webkitdirectory multiple @change="onPickFiles" />
            <small>浏览器会保留目录结构，保证实况照片（同目录同名的 HEIC+MOV）能正确配对。</small>
          </label>
          <p v-if="files.length" class="import-count">已选 {{ files.length }} 个文件 · 共 {{ totalSizeText }}</p>
        </div>

        <p v-if="error" class="import-error" role="alert">{{ error }}</p>

        <footer class="import-actions">
          <button class="onboard-btn" type="button" @click="close">取消</button>
          <button v-if="mode === 'local'" class="onboard-btn primary" type="button" @click="startLocal">开始导入</button>
          <button v-else class="onboard-btn primary" type="button" :disabled="files.length === 0" @click="startUpload">开始上传</button>
        </footer>
      </div>
    </section>
  </div>
</template>

<style scoped>
.import-backdrop {
  position: fixed;
  z-index: 130;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 34%);
  padding: 24px;
}
.import-dialog {
  width: min(460px, 100%);
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 20px 60px rgb(0 0 0 / 22%);
  overflow: hidden;
}
.import-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.import-header strong { font-size: 14px; }
.import-close {
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
.import-close:hover { background: var(--bg-field-hover); color: var(--text-1); }
.import-body { display: grid; gap: 14px; padding: 18px 20px 20px; }

.import-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--border); }
.import-tab {
  padding: 7px 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.import-tab.active { color: #4384ee; border-bottom-color: #4384ee; font-weight: 600; }

.import-pane { display: grid; gap: 10px; }
.import-field { display: grid; gap: 6px; }
.import-field span { color: var(--text-1); font-size: 12px; font-weight: 600; }
.import-field input[type='text'] {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.import-field input[type='text']:focus { border-color: #4384ee; box-shadow: 0 0 0 3px rgb(67 132 238 / 14%); }
.import-field small { color: var(--text-2); font-size: 10.5px; line-height: 1.5; }
.import-field input[type='file'] { font-size: 12px; color: var(--text-2); }

.import-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--text-1); cursor: pointer; }
.import-check input { margin-top: 2px; }

.import-status-line { display: flex; align-items: center; gap: 8px; }
.import-status-line strong { font-size: 12.5px; font-weight: 650; }
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: #4384ee;
  border-radius: 50%;
  animation: import-spin 0.8s linear infinite;
  flex: 0 0 auto;
}
@keyframes import-spin { to { transform: rotate(360deg); } }
.import-check { width: 16px; height: 16px; fill: none; stroke: #2c9a61; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.import-err { width: 16px; height: 16px; fill: none; stroke: #d05245; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

.import-progress { height: 6px; border-radius: 3px; background: var(--bg-field); overflow: hidden; }
.import-progress-bar { height: 100%; background: #4384ee; border-radius: 3px; transition: width 0.3s; }
.import-count { margin: 0; color: var(--text-2); font-size: 11.5px; }

.import-failures { border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.import-failures-title { padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--bg-field); color: #d05245; font-size: 11px; font-weight: 600; }
.import-failures-list { margin: 0; padding: 6px 0; max-height: 160px; overflow: auto; list-style: none; }
.import-failures-list li { display: flex; flex-direction: column; gap: 2px; padding: 5px 10px; }
.import-failures-list code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--text-1); word-break: break-all; }
.import-failures-list span { font-size: 10.5px; color: var(--text-3); }

.import-error { margin: 0; color: #d05245; font-size: 11px; line-height: 1.5; }
.import-actions { display: flex; justify-content: flex-end; gap: 9px; }
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
.onboard-btn.primary { border-color: #4384ee; background: #4384ee; color: #fff; }
.onboard-btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
