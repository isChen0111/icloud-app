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
 * 进度：不再自己轮询 —— 导入状态统一来自 tasks store（打开期间 subscribe 提升到 1.5s），
 * 启动/取消的返回值也直接写回同一份快照，和主界面、设置中心看到的是同一份数据。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { uploadImport } from '../api/client'
import { useTaskStore } from '../stores/tasks'

const props = defineProps<{
  libraryId: number
  libraryName: string
  /**
   * 启动前钩子：返回 false 表示取消。
   *
   * 导入接口只接受「当前激活库」，而新建的库在有其他库时并不会被激活。调用方（引导页）
   * 需要在实际点「开始导入/开始上传」的这一刻才切库，并且先给出确认——所以把切库时机
   * 交给这个钩子，而不是打开弹窗就切。
   */
  beforeStart?: (mode: 'local' | 'upload') => Promise<boolean>
}>()
const emit = defineEmits<{
  close: []
  /** 导入真正完成（可用于在调用方展示「已导入 N 项」） */
  done: [payload: { processed: number; skipped: number; failed: number; exifPatched: number }]
}>()

const tasks = useTaskStore()

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

/* ===== 导入状态（来自 tasks store） ===== */
const importState = computed(() => tasks.importState)
const error = ref('')
/** 本次会话发起过导入：用于「请求已发出、快照还没到」的过渡 */
const justStarted = ref(false)
/** 打开弹窗时任务已经在跑（用户关掉又打开） */
const openedDuringRun = ref(false)
/** 终态已处理过，防重复 emit done */
const resultSeen = ref(false)
let releaseTasks: (() => void) | null = null

/** 属于本库且仍在进行；「已取消但还没写 finishedAt」也算（后端流水线还在收尾） */
const active = computed(() => {
  const s = importState.value
  if (!s || s.libraryId !== props.libraryId) return false
  return s.status === 'running' || (s.status === 'cancelled' && s.finishedAt == null)
})

/** 属于本库且已到终态 */
const terminal = computed(() => {
  const s = importState.value
  if (!s || s.libraryId !== props.libraryId) return false
  return (
    s.status === 'done' ||
    s.status === 'error' ||
    (s.status === 'cancelled' && s.finishedAt != null)
  )
})

/** 已请求取消、流水线还在收尾（后端 status 仍是 running，只是 cancelRequested 置真） */
const cancelling = computed(() => active.value && importState.value?.cancelRequested === true)

/** 结果视图：已终态，且本次确实发起过（避免打开弹窗就看到上一次的旧结果） */
const showResult = computed(() => terminal.value && (justStarted.value || openedDuringRun.value))

/** 已发出请求但快照还没更新 → 显示「正在准备…」而不是停留在表单 */
const preparing = computed(() => justStarted.value && !active.value && !terminal.value)

const totalSizeText = computed(() => {
  const bytes = files.value.reduce((s, f) => s + f.size, 0)
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
})

/** 已选文件夹名（取自 webkitRelativePath 第一段，用于确认选对了目录） */
const pickedFolder = ref('')

function onPickFiles(e: Event): void {
  const input = e.target as HTMLInputElement
  const list = Array.from(input.files ?? [])
  // 用户点「取消」时多数浏览器不触发 change；真触发时空列表不清掉已选，避免误清空
  if (list.length === 0) return
  files.value = list
  pickedFolder.value = list[0]?.webkitRelativePath.split('/')[0] ?? ''
}

/** 标记本次导入已发起（清掉上一次的结果视图状态） */
function markStarted(): void {
  justStarted.value = true
  resultSeen.value = false
}

async function startLocal(): Promise<void> {
  const p = localPath.value.trim()
  if (!p) {
    error.value = '请填写目录路径'
    return
  }
  error.value = ''
  // 切库确认放这里：用户点了「开始导入」才算真的要用这个库，此时打扰他才说得通
  if (props.beforeStart && !(await props.beforeStart('local'))) return
  markStarted()
  try {
    await tasks.startLocalImport(props.libraryId, p, localMove.value ? 'move' : 'copy')
  } catch (err) {
    justStarted.value = false
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function startUpload(): Promise<void> {
  if (files.value.length === 0) {
    error.value = '请先选择要上传的文件夹'
    return
  }
  error.value = ''
  // 与「开始导入」同理：上传真正提交前才切库并确认
  if (props.beforeStart && !(await props.beforeStart('upload'))) return
  uploading.value = true
  uploadPct.value = 0
  abortCtrl = new AbortController()
  try {
    // 上传是组件级 IO（带进度回调与中断信号），不适合搬进 store；
    // 但结束后把状态交回 store，后续进度仍走同一份快照
    const res = await uploadImport(
      props.libraryId,
      files.value,
      (pct) => (uploadPct.value = pct),
      abortCtrl.signal,
    )
    markStarted()
    tasks.applyImport(res.import)
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

async function cancelRun(): Promise<void> {
  try {
    // 返回的是「cancelled + 未写 finishedAt」的中间态，随后靠轮询收尾
    await tasks.cancelImport(props.libraryId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function close(): void {
  abortCtrl?.abort()
  emit('close')
}

/**
 * 终态 → 通知调用方。用 resultSeen 去重：任务状态可能在多次快照里停在同一终态，
 * 旧实现靠「停轮询」天然只触发一次，这里必须自己守。
 * 注意不要在这里清 justStarted —— 结果视图正是靠它（或 openedDuringRun）才显示。
 */
watch(
  terminal,
  (isTerminal) => {
    if (!isTerminal || resultSeen.value) return
    resultSeen.value = true
    const s = importState.value
    if (s?.status === 'done') {
      emit('done', {
        processed: s.processedFiles,
        skipped: s.skipped,
        failed: s.failedCount,
        exifPatched: s.exifPatched,
      })
    }
  },
  { immediate: true },
)

onMounted(() => {
  releaseTasks = tasks.subscribe()
  // 打开时任务已在跑（关掉又打开、或从别处发起）→ 直接进进度视图
  openedDuringRun.value = active.value
  void tasks.refresh()
})

onBeforeUnmount(() => {
  releaseTasks?.()
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

      <!-- 导入进行中（preparing = 请求已发出、快照还没更新到第一个进度） -->
      <div v-if="active || preparing" class="import-body">
        <div class="import-status-line">
          <span class="spinner" />
          <strong>{{ importState?.message || (preparing ? '正在准备导入…' : '正在导入…') }}</strong>
        </div>
        <div class="import-progress">
          <div class="import-progress-bar" :style="{ width: `${importState?.totalFiles ? Math.round(((importState?.processedFiles ?? 0) / importState.totalFiles) * 100) : 0}%` }" />
        </div>
        <p class="import-count">
          已处理 {{ importState?.processedFiles ?? 0 }} / {{ importState?.totalFiles ?? 0 }}
          <template v-if="(importState?.skipped ?? 0) > 0"> · 跳过 {{ importState?.skipped }}</template>
          <template v-if="(importState?.failedCount ?? 0) > 0"> · 失败 {{ importState?.failedCount }}</template>
        </p>

        <div v-if="(importState?.failures?.length ?? 0) > 0" class="import-failures">
          <div class="import-failures-title">失败清单（{{ importState?.failedCount }} 项）</div>
          <ul class="import-failures-list">
            <li v-for="(f, i) in importState?.failures ?? []" :key="i">
              <code>{{ f.relPath }}</code>
              <span>{{ f.reason }}</span>
            </li>
          </ul>
        </div>

        <p v-if="error" class="import-error" role="alert">{{ error }}</p>
        <footer class="import-actions">
          <!-- 取消只是置信号：大文件可能正卡在拷贝中，收尾要等它回到循环顶部。
               这期间禁用按钮，避免用户以为没点上而反复点 -->
          <button class="onboard-btn" type="button" :disabled="cancelling" @click="cancelRun">
            {{ cancelling ? '正在取消…' : '取消导入' }}
          </button>
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

      <!-- 完成 / 失败 / 取消 结果（仅当本次确实发起过，避免看到上一次的旧结果） -->
      <div v-else-if="showResult" class="import-body">
        <div class="import-status-line">
          <svg v-if="importState?.status === 'done'" class="import-check" viewBox="0 0 16 16"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
          <svg v-else class="import-err" viewBox="0 0 16 16"><path d="M8 1.5 15 14H1L8 1.5Z" /><path d="M8 5.2v4.2M8 11.7v.1" /></svg>
          <strong>{{ importState?.message }}</strong>
        </div>
        <p class="import-count">
          已处理 {{ importState?.processedFiles ?? 0 }} / {{ importState?.totalFiles ?? 0 }}
          <template v-if="(importState?.skipped ?? 0) > 0"> · 跳过 {{ importState?.skipped }}</template>
          <template v-if="(importState?.exifPatched ?? 0) > 0"> · 补写时间 {{ importState?.exifPatched }}</template>
          <template v-if="(importState?.failedCount ?? 0) > 0"> · 失败 {{ importState?.failedCount }}</template>
        </p>
        <div v-if="(importState?.failures?.length ?? 0) > 0" class="import-failures">
          <div class="import-failures-title">失败清单（{{ importState?.failedCount }} 项）</div>
          <ul class="import-failures-list">
            <li v-for="(f, i) in importState?.failures ?? []" :key="i"><code>{{ f.relPath }}</code><span>{{ f.reason }}</span></li>
          </ul>
        </div>
        <footer class="import-actions">
          <button class="onboard-btn primary" type="button" @click="close">完成</button>
        </footer>
      </div>

      <!-- 空闲：模式选择 + 输入 -->
      <div v-else class="import-body">
        <div class="import-tabs" role="tablist">
          <button class="import-tab" :class="{ active: mode === 'local' }" type="button" role="tab" @click="mode = 'local'">本机迁移</button>
          <button class="import-tab" :class="{ active: mode === 'upload' }" type="button" role="tab" @click="mode = 'upload'">上传</button>
        </div>

        <!-- 本机迁移 -->
        <div v-if="mode === 'local'" class="import-pane">
          <label class="import-field">
            <span>目录路径（本机绝对路径）</span>
            <input v-model="localPath" type="text" placeholder="例如：D:\照片\2024 或 F:\Photos\旅行" />
            <small>这是运行本应用的那台电脑上的目录路径，程序会递归遍历其中的照片/视频，按拍摄日期归置到照片库。</small>
          </label>
          <label class="import-option">
            <input v-model="localMove" type="checkbox" />
            <span class="import-option-text">
              <span>导入后删除源文件</span>
              <small>默认保留源文件，只做复制</small>
            </span>
          </label>
        </div>

        <!-- 上传 -->
        <div v-else class="import-pane">
          <div class="import-field">
            <span>选择要上传的文件夹（整文件夹）</span>
            <label class="file-pick" :class="{ picked: files.length > 0 }">
              <input type="file" webkitdirectory multiple @change="onPickFiles" />
              <svg class="file-ico" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.5 7.6A2 2 0 0 1 5.5 5.6h3.1l1.8 2.2h8.1a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
                <path d="M12 11.2v4.4M9.9 13.4 12 11.2l2.1 2.2" />
              </svg>
              <span>{{ files.length ? '重新选择文件夹' : '选择文件夹' }}</span>
            </label>
            <small>浏览器会保留目录结构，保证实况照片（同目录同名的 HEIC+MOV）能正确配对。</small>
          </div>
          <div v-if="files.length" class="import-picked">
            <svg class="picked-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.1 8.1 3.1 3.1 6.7-6.7" /></svg>
            <span class="picked-name">{{ pickedFolder }}</span>
            <span class="picked-sum">{{ files.length }} 个文件 · {{ totalSizeText }}</span>
          </div>
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
  width: min(468px, 100%);
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
  padding: 14px 18px;
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
.import-body { display: grid; gap: 16px; padding: 18px 20px; }

/* 模式切换：胶囊分段控件。比下划线 tab 更像「二选一」，也让下面两块内容有明确归属 */
.import-tabs {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: 9px;
  background: var(--bg-field);
}
.import-tab {
  flex: 1;
  padding: 7px 14px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.import-tab:hover { color: var(--text-1); }
.import-tab.active {
  background: var(--bg-panel);
  color: #3577dc;
  font-weight: 600;
  box-shadow: 0 1px 3px rgb(15 23 42 / 10%);
}

.import-pane { display: grid; gap: 11px; }
.import-field { display: grid; gap: 6px; }
.import-field > span { color: var(--text-1); font-size: 12px; font-weight: 600; }
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
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.import-field input[type='text']::placeholder { color: var(--text-3); }
.import-field input[type='text']:focus { border-color: #4384ee; box-shadow: 0 0 0 3px rgb(67 132 238 / 14%); }
.import-field small { color: var(--text-2); font-size: 11px; line-height: 1.55; }

/* 文件夹选择：原生 input[type=file] 在各浏览器长得都不一样且无法改样式，
   所以把它变成一层透明覆盖层，外面用 label 画出统一按钮 */
.file-pick {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 14px;
  border: 1px dashed rgb(67 132 238 / 48%);
  border-radius: 9px;
  background: rgb(67 132 238 / 5%);
  color: #3577dc;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.file-pick:hover { border-color: #4384ee; background: rgb(67 132 238 / 11%); }
.file-pick.picked {
  border-style: solid;
  border-color: rgb(44 154 97 / 45%);
  background: rgb(44 154 97 / 7%);
  color: #2c9a61;
}
.file-pick.picked:hover { border-color: #2c9a61; background: rgb(44 154 97 / 12%); }
.file-pick input[type='file'] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
}
.file-ico {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 已选结果：文件夹名单独一行，数量与体积靠右，避免和说明文字混在一起 */
.import-picked {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-field);
  font-size: 11.5px;
}
.picked-ico {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  fill: none;
  stroke: #2c9a61;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.picked-name { color: var(--text-1); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picked-sum { margin-left: auto; flex: 0 0 auto; color: var(--text-3); }

/* 「导入后删除源文件」：主文案 + 小字说明分两行，checkbox 用主题蓝 */
.import-option {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.import-option:hover { border-color: rgb(67 132 238 / 40%); background: rgb(67 132 238 / 4%); }
.import-option input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin: 1px 0 0;
  flex: 0 0 auto;
  accent-color: #4384ee;
  cursor: pointer;
}
.import-option-text { display: grid; gap: 2px; }
.import-option-text > span { color: var(--text-1); font-size: 12px; }
.import-option-text > small { color: var(--text-3); font-size: 10.5px; line-height: 1.45; }

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
/* 完成态对勾图标。注意：这个类名曾与「导入后删除源文件」的 label 同名，
   后者的 width/height 被这条规则覆盖成 16px，导致文字挤压错位；label 已改名 .import-option */
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
/* 底部操作区：加一条分隔线，让「取消/开始」从表单里独立出来 */
.import-actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.onboard-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
}
.onboard-btn.primary { border-color: #4384ee; background: #4384ee; color: #fff; }
.onboard-btn:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
