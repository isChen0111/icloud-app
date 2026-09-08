<script setup lang="ts">
/**
 * DetailView —— 详情页（对标 iCloud OneUp）
 *
 * 行为对齐实测结论：
 *   - 大图用 detail 档（1600px WebP），渐进加载（先占位后淡入）
 *   - 方向键/点击切换，切换时预取邻居大图（隐藏 Image 预热），回来秒开
 *   - type=live → 实况照片（按住播放）；type=video → 原生视频播放器
 *   - hash 路由深链：#/photo/:id
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchAsset, thumbUrl } from '../api/client'
import type { AssetDetail } from '../types'
import LivePhoto from '../components/detail/LivePhoto.vue'
import VideoStage from '../components/detail/VideoStage.vue'

const route = useRoute()
const router = useRouter()

const detail = ref<AssetDetail | null>(null)
const loading = ref(false)
const loadError = ref(false)

/** 当前 id（来自路由参数） */
const currentId = computed(() => Number(route.params.id))

/** 大图 URL（detail 档） */
const bigSrc = computed(() => (detail.value ? thumbUrl(detail.value.id, 'detail') : ''))

/** 根据类型选择展示器 */
const isLive = computed(() => detail.value?.type === 'live')
const isVideo = computed(() => detail.value?.type === 'video')

/** 加载指定 id 的详情 */
async function load(id: number): Promise<void> {
  loading.value = true
  loadError.value = false
  try {
    detail.value = await fetchAsset(id)
    // 预取下一个邻居的大图（隐藏 Image 预热，切换时直接命中浏览器缓存）
    if (detail.value?.nextId) {
      const img = new Image()
      img.src = thumbUrl(detail.value.nextId, 'detail')
    }
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

/** 切到邻居 */
function go(direction: 1 | -1): void {
  const target = direction === 1 ? detail.value?.nextId : detail.value?.prevId
  if (target == null) return
  void router.push({ name: 'detail', params: { id: String(target) } })
}

/** 键盘导航 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1) }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
  else if (e.key === 'Escape') { void router.push({ name: 'grid' }) }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void load(currentId.value)
})

watch(currentId, (id) => void load(id))

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="detail-view">
    <!-- 顶栏：返回 + 文件名 + 序号 -->
    <div class="detail-topbar">
      <button class="back" @click="router.push({ name: 'grid' })">← 返回</button>
      <span class="name">{{ detail?.filename ?? '…' }}</span>
      <span class="meta">
        <template v-if="detail?.type === 'live'">实况照片</template>
        <template v-else-if="detail?.type === 'video'">视频{{ detail?.duration ? ` · ${Math.round(detail.duration)}s` : '' }}</template>
        <template v-else>照片</template>
      </span>
    </div>

    <!-- 舞台 -->
    <div class="stage" :class="{ dim: loading }" @click.self="router.push({ name: 'grid' })">
      <div v-if="loadError" class="center-hint">加载失败</div>
      <div v-else-if="detail">
        <!-- 实况照片：按住播放 -->
        <LivePhoto v-if="isLive" :id="detail.id" />
        <!-- 普通视频：原生播放器 -->
        <VideoStage v-else-if="isVideo" :id="detail.id" />
        <!-- 普通照片：大图（detail 档淡入） -->
        <div v-else class="photo-stage">
          <img :src="bigSrc" class="big-photo" alt="" draggable="false" />
        </div>
      </div>
    </div>

    <!-- 左右切换（隐藏式，hover 出现） -->
    <button v-if="detail?.prevId != null" class="nav prev" @click="go(-1)">‹</button>
    <button v-if="detail?.nextId != null" class="nav next" @click="go(1)">›</button>
  </div>
</template>

<style scoped>
.detail-view {
  position: absolute;
  inset: 0;
  background: #111113;
  display: flex;
  flex-direction: column;
}
.detail-topbar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 44px;
  padding: 0 16px;
  flex-shrink: 0;
}
.back {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #f5f5f7;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.back:hover { background: rgba(255, 255, 255, 0.1); }
.name {
  font-size: 13px;
  color: rgba(245, 245, 247, 0.85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  font-size: 12px;
  color: rgba(245, 245, 247, 0.45);
  margin-left: auto;
}
.stage {
  flex: 1;
  min-height: 0;
  position: relative;
  transition: opacity 0.2s ease;
}
.stage.dim { opacity: 0.6; }
.photo-stage {
  /* 同 LivePhoto/VideoStage：flex item 内 height:100% 不解析，absolute 撑满 */
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.big-photo {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  opacity: 0;
  animation: fadeIn 0.3s ease forwards; /* 对标 iCloud 0.3s 淡入 */
}
@keyframes fadeIn { to { opacity: 1; } }
.center-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(245, 245, 247, 0.5);
  font-size: 13px;
}
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 22px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s ease;
  z-index: 5;
}
.detail-view:hover .nav { opacity: 1; }
.nav:hover { background: rgba(0, 0, 0, 0.7); }
.nav.prev { left: 14px; }
.nav.next { right: 14px; }
</style>
