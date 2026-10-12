<!--
  同步按钮（共享组件：主界面顶栏 + 设置中心每库共用，保证视觉/文案/状态机完全一致）

  状态优先级：busy（执行中·可取消）> starting（启动中占位）> picked（已选待执行）> idle（同步▾菜单）
  - busy：本库任务执行中（含 waiting_retry），点击 emit cancel
  - starting：任务刚启动、stats 轮询尚未确认（仅设置中心需要，主页立即 pollStats 可不用）
  - picked：已选全量/增量待执行，点击 emit run
  - idle：「同步」主按钮 + 全量/增量菜单，选择 emit pick(kind)
  - disabled：仅视觉灰显（其他库任务占用），菜单仍可点开，点执行由后端 409 提示
-->
<template>
  <div class="sync-btn-wrap">
    <!-- 执行中：点击取消 -->
    <button v-if="busy" class="sync-btn run" type="button" @click="$emit('cancel')">
      <span class="spinner" />
      <span>{{ runningLabel }}</span>
    </button>
    <div v-if="busy" class="sync-prog" aria-hidden="true" />

    <!-- 启动中占位 -->
    <button v-else-if="starting" class="sync-btn wait" type="button" disabled>
      <span class="spinner" />
      <span>启动中…</span>
    </button>

    <!-- 已选待执行 -->
    <button v-else-if="picked" class="sync-btn primary" type="button" @click="$emit('run')">
      <span class="ico">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 3.2v9.6L13 8 5 3.2Z" />
        </svg>
      </span>
      <span>执行 · {{ picked === 'inc' ? '增量同步' : '全量拉取' }}</span>
    </button>

    <!-- 空闲：同步 ▾ 菜单 -->
    <button
      v-else
      class="sync-btn"
      :class="{ disabled }"
      type="button"
      :aria-expanded="menuOpen"
      @click="menuOpen = !menuOpen"
    >
      <span class="ico">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6.5 17a4 4 0 0 1-.8-7.9A5.5 5.5 0 0 1 17 8.6a3.5 3.5 0 0 1-.5 8.4" />
          <path d="m9.5 13 2.5 2.5 2.5-2.5M12 15.5v-6" />
        </svg>
      </span>
      <span>同步</span>
      <svg class="chev" :class="{ open: menuOpen }" viewBox="0 0 12 12" aria-hidden="true">
        <path d="m3 4.5 3 3 3-3" />
      </svg>
      <div v-if="menuOpen" class="sync-menu" role="menu">
        <button type="button" role="menuitem" @click="choose('full')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 18a4.5 4.5 0 0 1-.8-8.9A5.5 5.5 0 0 1 17.4 9.5 3.8 3.8 0 0 1 17 17" />
            <path d="M12 12v6" />
            <path d="m9 15.5 3 3 3-3" />
          </svg>
          全量拉取
        </button>
        <button type="button" role="menuitem" @click="choose('inc')">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          增量同步
        </button>
      </div>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  /** 本库任务执行中（含 waiting_retry） */
  busy: boolean
  /** 当前执行任务的类型（busy 文案用） */
  kind?: 'full' | 'inc'
  /** 任务刚启动、stats 尚未确认的本地占位 */
  starting?: boolean
  /** 已选待执行类型 */
  picked?: 'full' | 'inc' | null
  /** 仅视觉灰显（其他库任务占用），不禁用菜单点击 */
  disabled?: boolean
}>(), {
  kind: 'full',
  starting: false,
  picked: null,
  disabled: false,
})

const emit = defineEmits<{
  pick: [kind: 'full' | 'inc']
  run: []
  cancel: []
}>()

const menuOpen = ref(false)

const runningLabel = computed(() =>
  `${props.kind === 'inc' ? '增量同步' : '全量拉取'}执行中 · 点击取消`,
)

function choose(kind: 'full' | 'inc'): void {
  menuOpen.value = false
  emit('pick', kind)
}
</script>

<style scoped>
.sync-btn-wrap { position: relative; display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
.sync-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 26px;
  padding: 0 12px;
  min-width: 138px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-panel);
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 2px rgb(15 23 42 / 4%);
  transition: all 0.18s ease;
}
.sync-btn:hover { border-color: #4384ee; color: #4384ee; box-shadow: 0 2px 6px rgb(10 132 255 / 12%); }
.sync-btn.disabled { opacity: 0.6; cursor: not-allowed; }
.sync-btn.disabled:hover { border-color: var(--border); color: var(--text-1); box-shadow: none; }
.sync-btn .ico { display: inline-flex; align-items: center; flex-shrink: 0; color: inherit; }
.sync-btn .ico svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.sync-btn .chev { width: 11px; height: 11px; flex-shrink: 0; transition: transform 0.18s ease; }
.sync-btn .chev.open { transform: rotate(180deg); }
.sync-btn.primary { border-color: #4384ee; background: #4384ee; color: #fff; }
.sync-btn.primary:hover { background: #3577dc; color: #fff; }
.sync-btn.run { background: rgb(67 132 238 / 10%); border-color: #4384ee; color: #4384ee; }
.sync-btn.wait { border-color: var(--border); color: var(--text-2); opacity: 0.8; cursor: default; }
.sync-btn .spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid rgb(67 132 238 / 25%);
  border-top-color: #4384ee;
  border-radius: 50%;
  animation: sync-spin 0.8s linear infinite;
}
@keyframes sync-spin { to { transform: rotate(360deg); } }
/* 执行中行内进度条（按钮下方 2px 渐变推进） */
.sync-prog {
  position: absolute;
  left: 0;
  top: calc(100% + 3px);
  height: 2px;
  width: 138px;
  border-radius: 2px;
  background: linear-gradient(90deg, #4384ee, #7cc2ff);
  animation: sync-prog-slide 2.6s linear infinite;
  z-index: 32;
  pointer-events: none;
}
@keyframes sync-prog-slide {
  0% { transform: scaleX(0); transform-origin: left; }
  55% { transform: scaleX(0.9); transform-origin: left; }
  100% { transform: scaleX(0.9) translateX(30px); transform-origin: left; }
}
.sync-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 138px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 18px rgb(15 23 42 / 14%);
  z-index: 31;
  padding: 4px;
  font-size: 11px;
  animation: sync-pop 0.12s ease;
}
@keyframes sync-pop { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.sync-menu button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.sync-menu button:hover { background: rgb(67 132 238 / 9%); color: #4384ee; }
.sync-menu button svg { width: 12px; height: 12px; flex-shrink: 0; fill: none; stroke: var(--text-3); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.sync-menu button:hover svg { stroke: #4384ee; }
</style>
