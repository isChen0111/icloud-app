<script setup lang="ts">
/**
 * 根组件
 *
 * 结构对标 iCloud 网页端：
 * - 顶部细标题栏（当前显示照片统计 + 主题切换按钮）
 * - 主体 = 路由出口（网格 / 详情）
 * - 启动时拉一次统计并自动开始首页加载
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchStats } from './api/client'
import { useThemeStore } from './stores/theme'
import type { Stats } from './types'
import { useRoute } from 'vue-router'

const stats = ref<Stats | null>(null)
const route = useRoute()

const backendReady = ref(false)

/** 主题：切换深浅（localStorage 持久化，见 stores/theme.ts） */
const themeStore = useThemeStore()
// store 值 ↔ 根元素 [data-theme] 双向同步：
// index.html 内联脚本已在首屏设置初值，这里保证 store 与 DOM 一致并响应切换
watch(
  () => themeStore.theme,
  (t) => {
    document.documentElement.dataset.theme = t
  },
  { immediate: true },
)

/** 重连轮询定时器句柄 */
let retryTimer: number | undefined

/**
 * 拉取统计；失败则每 5 秒重试直到连上（修复审查 P1-F4）。
 * 旧实现只重试一次：先开前端、后开后端的常见顺序下会永久停在
 * "等待后端启动"，必须手动刷新。现在持续轮询，后端就绪自动恢复。
 */
async function pollStats(): Promise<void> {
  try {
    stats.value = await fetchStats()
    backendReady.value = true
  } catch {
    retryTimer = window.setTimeout(() => void pollStats(), 5000)
  }
}

/** 回到照片墙时刷新统计（详情页删除后返回，顶栏计数保持准确） */
watch(
  () => route.name,
  (n) => {
    if (n === 'grid') void pollStats()
  },
)
onMounted(() => void pollStats())
onBeforeUnmount(() => window.clearTimeout(retryTimer))
</script>

<template>
  <div class="app-shell">
    <!-- 顶栏：轻量信息条 + 主题切换 -->
    <header class="topbar">
      <span class="brand">iCloud本地照片</span>
      <span v-if="stats" class="stat">
        {{ stats.photos + stats.livePhotos }} 张照片 · {{ stats.videos }} 个视频
        <span v-if="stats.thumbQueue > 0" class="queue-hint">（缩略图生成中 {{ stats.thumbQueue }}）</span>
      </span>
      <span v-else class="stat warn">
        {{ backendReady ? '' : '等待后端启动…（npm run dev → server 目录）' }}
      </span>

      <span class="spacer" />

      <!-- 主题切换：深色显示太阳（点→浅色），浅色显示月亮（点→深色） -->
      <button
        class="theme-btn"
        :title="themeStore.theme === 'dark' ? '切换到浅色' : '切换到深色'"
        @click="themeStore.toggleTheme()"
      >
        <svg v-if="themeStore.theme === 'dark'" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.8" />
          <path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
        </svg>
      </button>
    </header>

    <!-- 路由出口：KeepAlive 仅缓存照片墙（返回详情页时保留滚动位置/已加载数据/搜索态），
         详情页不缓存（大图 DOM 无需常驻） -->
    <main class="view-host">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="['GridView']">
          <component :is="Component" @deleted="pollStats" />
        </KeepAlive>
      </RouterView>
    </main>

  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 44px;
  padding: 0 16px;
  flex-shrink: 0;
  background: var(--bg-topbar);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  z-index: 10;
}
.brand {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.spacer { flex: 1; }
.stat {
  font-size: 12px;
  color: var(--text-2);
}
.queue-hint { color: #ffd60a; }
.warn { color: #ff9f0a; }

/* 主题切换按钮（顶栏最右） */
.theme-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: var(--bg-field);
  color: var(--text-1);
  cursor: pointer;
  transition: background 0.15s, transform 0.15s;
}
.theme-btn:hover {
  background: var(--bg-field-hover);
  transform: scale(1.05);
}

.view-host {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
