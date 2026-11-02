<script setup lang="ts">
/**
 * 通用二次确认弹窗（非删除类）
 *
 * 用于「即将发生状态变化，需要先说清楚」的场景，例如：开始导入/拉取前要先切换照片库。
 * 删除确认仍走 DeleteConfirm（红色危险语义），这里保持中性蓝，不要混用。
 *
 * Teleport 到 body：调用方可能本身就处在弹窗里（引导页 → 导入弹窗 → 切库确认），
 * 不 teleport 会被父弹窗的 z-index / overflow 裁掉。
 */
import { onBeforeUnmount, onMounted } from 'vue'

withDefaults(defineProps<{
  title: string
  desc?: string
  confirmText?: string
  cancelText?: string
}>(), {
  desc: '',
  confirmText: '继续',
  cancelText: '取消',
})

const emit = defineEmits<{ confirm: []; cancel: [] }>()

/** ESC 只关这一层：调用方（如引导页）必须自行判断确认弹窗是否打开，否则会把整层都关掉 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    emit('cancel')
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div class="cd-mask" @click.self="emit('cancel')">
      <div class="cd-card" role="alertdialog" aria-modal="true">
        <div class="cd-ico">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 8.4v4.8" />
            <path d="M12 16.6v.1" />
            <circle cx="12" cy="12" r="8.6" />
          </svg>
        </div>
        <h3 class="cd-title">{{ title }}</h3>
        <p v-if="desc" class="cd-desc">{{ desc }}</p>
        <div class="cd-actions">
          <button class="cd-btn" type="button" @click="emit('cancel')">{{ cancelText }}</button>
          <button class="cd-btn primary" type="button" @click="emit('confirm')">{{ confirmText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cd-mask {
  position: fixed;
  z-index: 200;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 38%);
}
.cd-card {
  width: min(360px, 100%);
  padding: 22px 22px 18px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--bg-panel);
  color: var(--text-1);
  box-shadow: 0 20px 60px rgb(0 0 0 / 24%);
  text-align: center;
  animation: cd-in 0.16s ease;
}
@keyframes cd-in {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.cd-ico {
  display: grid;
  width: 42px;
  height: 42px;
  margin: 0 auto 12px;
  place-items: center;
  border-radius: 50%;
  background: rgb(67 132 238 / 12%);
  color: #3577dc;
}
.cd-ico svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.cd-title { margin: 0 0 7px; font-size: 14.5px; }
.cd-desc { margin: 0 0 18px; color: var(--text-2); font-size: 12px; line-height: 1.6; text-align: left; }
.cd-actions { display: flex; gap: 9px; }
.cd-btn {
  flex: 1;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.cd-btn:hover { background: var(--bg-field-hover); }
.cd-btn.primary { border-color: #4384ee; background: #4384ee; color: #fff; }
.cd-btn.primary:hover { background: #3577dc; border-color: #3577dc; }
</style>
