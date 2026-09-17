<script setup lang="ts">
/**
 * DeleteConfirm —— 删除确认弹框（客户端删除功能通用）
 * 照片墙多选删除传 count=N；详情页删除传 count=1。
 * 文案明确"永久删除、无法恢复"（本地删除会连磁盘源文件一起删，不可逆）。
 */
defineProps<{ count: number; deleting?: boolean }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <div class="confirm-mask" @click.self="emit('cancel')">
    <div class="confirm-card" role="alertdialog" aria-modal="true">
      <div class="trash-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </div>
      <h3 class="title">确定删除选中的 {{ count }} 个项目？</h3>
      <p class="desc">这些项目将从本地照片库中永久删除，且无法恢复。</p>
      <div class="actions">
        <button class="btn cancel" @click="emit('cancel')">取消</button>
        <button class="btn danger" :disabled="deleting" @click="emit('confirm')">
          {{ deleting ? '删除中…' : '删除' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.confirm-card {
  width: 320px;
  padding: 24px;
  border-radius: 14px;
  background: var(--bg-float);
  color: var(--text-1);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25);
  text-align: center;
}
.trash-icon {
  width: 52px;
  height: 52px;
  margin: 0 auto 14px;
  border-radius: 50%;
  background: rgba(10, 132, 255, 0.12);
  color: #0a84ff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.title { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
.desc { font-size: 13px; color: var(--text-2); margin: 0 0 20px; line-height: 1.5; }
.actions { display: flex; gap: 12px; }
.btn {
  flex: 1;
  height: 36px;
  border: none;
  border-radius: 9px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.btn.cancel { background: var(--bg-field); color: var(--text-1); }
.btn.cancel:hover { background: var(--bg-field-hover); }
.btn.danger { background: #ff3b30; color: #fff; }
.btn.danger:disabled { opacity: 0.6; cursor: default; }
</style>
