<script setup lang="ts">
/**
 * InfoPanel —— 详情页「信息」抽屉（对标 iCloud 信息面板）
 *
 * 结构：全屏半透明遮罩（点空白关闭）+ 右侧滑出面板。
 * 字段按 iCloud 布局：拍摄时间 / 文件名 / 设备 / 格式 / 镜头 / 像素 / 大小，
 * 参数行（ISO / 焦距 / 曝光补偿 / 光圈 / 快门）横向排列；视频额外显示编码/码率/时长。
 *
 * 主题：全部走全局 CSS 变量（--bg-panel / --text-1/2/3 / --border / --bg-meta），
 * 浅色深色自动适配，无需额外判断。
 */
import type { AssetInfo } from '../../types'
import {
  formatAperture,
  formatBitRate,
  formatBytes,
  formatDuration,
  formatExposureBias,
  formatPixels,
  formatShutter,
  formatTakenFull,
} from '../../utils/format'

defineProps<{
  /** 信息数据（由父组件拉取后传入；null = 加载中） */
  info: AssetInfo | null
  /** 是否正在加载 */
  loading: boolean
}>()

const emit = defineEmits<{ close: [] }>()

/** 面板标题（照片/实况/视频） */
const typeLabel: Record<string, string> = { photo: '照片', live: '实况照片', video: '视频' }
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩：点击关闭；键盘 Esc 由 DetailView 全局监听处理 -->
    <div class="panel-mask" @click.self="emit('close')">
      <div class="panel">
        <!-- 头部：标题 + 关闭 -->
        <div class="head">
          <span class="title">信息</span>
          <button class="close" aria-label="关闭" @click="emit('close')">×</button>
        </div>

        <div v-if="loading" class="loading">加载中…</div>

        <template v-else-if="info">
          <div class="type-tag">{{ typeLabel[info.type] ?? info.type }}</div>

          <!-- 常规字段（label 左 / value 右，对齐 iCloud） -->
          <dl class="rows">
            <template v-if="info.takenAt">
              <div class="row">
                <dt>拍摄时间</dt>
                <dd>{{ formatTakenFull(info.takenAt) }}</dd>
              </div>
            </template>
            <div class="row">
              <dt>文件名</dt>
              <dd class="mono">{{ info.filename }}</dd>
            </div>
            <template v-if="info.device">
              <div class="row">
                <dt>拍摄设备</dt>
                <dd>{{ info.device }}</dd>
              </div>
            </template>
            <template v-if="info.format">
              <div class="row">
                <dt>格式</dt>
                <dd>{{ info.format }}</dd>
              </div>
            </template>
            <template v-if="info.lens">
              <div class="row">
                <dt>镜头</dt>
                <dd>{{ info.lens }}</dd>
              </div>
            </template>
            <template v-if="info.megaPixels != null">
              <div class="row">
                <dt>像素</dt>
                <dd>{{ info.megaPixels.toFixed(1) }} MP • {{ formatPixels(info.width, info.height) }}</dd>
              </div>
            </template>
            <template v-if="info.type === 'video' && info.duration != null">
              <div class="row">
                <dt>时长</dt>
                <dd>{{ formatDuration(info.duration) }}</dd>
              </div>
            </template>
            <template v-if="info.width != null && info.type === 'video'">
              <div class="row">
                <dt>分辨率</dt>
                <dd>{{ formatPixels(info.width, info.height) }}</dd>
              </div>
            </template>
            <div class="row">
              <dt>文件大小</dt>
              <dd>{{ formatBytes(info.sizeBytes) }}</dd>
            </div>
            <template v-if="info.codec">
              <div class="row">
                <dt>编码</dt>
                <dd class="mono">{{ info.codec.toUpperCase() }}</dd>
              </div>
            </template>
            <template v-if="info.bitRate">
              <div class="row">
                <dt>码率</dt>
                <dd>{{ formatBitRate(info.bitRate) }}</dd>
              </div>
            </template>
          </dl>

          <!-- 照片拍摄参数行（对齐 iCloud：ISO / 焦距 / 曝光补偿 / 光圈 / 快门 一行） -->
          <div v-if="info.type !== 'video'" class="params">
            <div v-if="info.iso != null" class="param">
              <span class="k">ISO</span><span class="v">{{ info.iso }}</span>
            </div>
            <div v-if="info.focalLength != null" class="param">
              <span class="k">焦距</span><span class="v">{{ info.focalLength }} 毫米</span>
            </div>
            <div v-if="info.exposureBias != null" class="param">
              <span class="k">曝光补偿</span><span class="v">{{ formatExposureBias(info.exposureBias) }}</span>
            </div>
            <div v-if="info.fNumber != null" class="param">
              <span class="k">光圈</span><span class="v">{{ formatAperture(info.fNumber) }}</span>
            </div>
            <div v-if="info.exposureTime != null" class="param">
              <span class="k">快门</span><span class="v">{{ formatShutter(info.exposureTime) }}</span>
            </div>
          </div>
        </template>

        <div v-else class="loading">信息不可用</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.panel-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  justify-content: flex-end; /* 抽屉贴右 */
}
.panel {
  width: min(380px, 92vw);
  height: 100%;
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  animation: slideIn 0.25s ease;
}
@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 12px;
  flex-shrink: 0;
}
.title { font-size: 16px; font-weight: 600; }
.close {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--bg-hover);
  color: var(--text-1);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.close:hover { background: var(--bg-hover-strong); }
.loading {
  padding: 40px 18px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}
.type-tag {
  display: inline-block;
  align-self: flex-start;
  margin: 0 18px 12px;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 11px;
  background: var(--bg-active);
  color: var(--accent);
}
.rows {
  margin: 0;
  padding: 0 18px;
}
.row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 0;
  border-top: 1px solid var(--border);
}
.row:first-child { border-top: none; }
.row dt {
  flex-shrink: 0;
  width: 64px;
  font-size: 12px;
  color: var(--text-3);
}
.row dd {
  margin: 0;
  flex: 1;
  font-size: 13px;
  color: var(--text-1);
  word-break: break-all;
  text-align: right;
}
.mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
/* 拍摄参数行：横向排列（对齐 iCloud） */
.params {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 18px 20px;
}
.param {
  flex: 1 1 30%;
  min-width: 96px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-meta);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.param .k { font-size: 11px; color: var(--text-3); }
.param .v { font-size: 13px; color: var(--text-1); font-weight: 500; }
</style>
