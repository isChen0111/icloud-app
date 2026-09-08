<script setup lang="ts">
/**
 * 根组件
 *
 * 结构对标 iCloud 网页端：
 * - 顶部细标题栏（当前显示照片统计）
 * - 主体 = 路由出口（网格 / 详情）
 * - 启动时拉一次统计并自动开始首页加载
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchStats } from './api/client'
import type { Stats } from './types'

const stats = ref<Stats | null>(null)
const backendReady = ref(false)

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

onMounted(() => void pollStats())
onBeforeUnmount(() => window.clearTimeout(retryTimer))
</script>

<template>
  <div class="app-shell">
    <!-- 顶栏：轻量信息条 -->
    <header class="topbar">
      <span class="brand">本地照片</span>
      <span v-if="stats" class="stat">
        {{ stats.photos + stats.livePhotos }} 张照片 · {{ stats.videos }} 个视频
        <span v-if="stats.thumbQueue > 0" class="queue-hint">（缩略图生成中 {{ stats.thumbQueue }}）</span>
      </span>
      <span v-else class="stat warn">
        {{ backendReady ? '' : '等待后端启动…（npm run dev → server 目录）' }}
      </span>
    </header>

    <!-- 路由出口 -->
    <main class="view-host">
      <RouterView />
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
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  z-index: 10;
}
.brand {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.stat {
  font-size: 12px;
  color: rgba(245, 245, 247, 0.7);
}
.queue-hint { color: #ffd60a; }
.warn { color: #ff9f0a; }
.view-host {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
