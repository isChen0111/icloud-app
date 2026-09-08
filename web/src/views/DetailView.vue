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
/** 大图 <img> 加载失败（坏图/生成失败时显示占位，避免破损图标） */
const photoError = ref(false)

/** 请求序号守卫：快速连按 ←→ 时丢弃过期响应（修复审查 P1-④ 竞态） */
let loadSeq = 0

/** 当前 id（来自路由参数） */
const currentId = computed(() => Number(route.params.id))

/** 大图 URL（detail 档） */
const bigSrc = computed(() => (detail.value ? thumbUrl(detail.value.id, 'detail') : ''))

/** 根据类型选择展示器 */
const isLive = computed(() => detail.value?.type === 'live')
const isVideo = computed(() => detail.value?.type === 'video')

/**
 * 加载指定 id 的详情。
 * 竞态说明：切换 id 后若旧请求晚返回，会覆盖当前显示（文件名/序号错位）。
 * 每次 load 递增 loadSeq，只有 seq 与最新一致的响应才允许写入 state。
 */
async function load(id: number): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = false
  photoError.value = false
  try {
    const data = await fetchAsset(id)
    if (seq !== loadSeq) return // 过期响应：丢弃，不覆盖新数据
    detail.value = data
    // 预取下一个邻居的大图（隐藏 Image 预热，切换时直接命中浏览器缓存）
    if (data.nextId) {
      const img = new Image()
      img.src = thumbUrl(data.nextId, 'detail')
    }
  } catch {
    if (seq !== loadSeq) return
    loadError.value = true
  } finally {
    if (seq === loadSeq) loading.value = false
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
        <!-- 普通照片：大图（detail 档淡入；失败时显示占位而非破损图标） -->
        <div v-else class="photo-stage">
          <img
            v-if="!photoError"
            :src="bigSrc"
            class="big-photo"
            alt=""
            draggable="false"
            @error="photoError = true"
          />
          <div v-else class="center-hint">图片加载失败</div>
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
  /* 主题化：浅色主题浅底深字，深色主题深底白字（变量在 index.html 定义） */
  background: var(--detail-bg);
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
  border: 1px solid var(--detail-border);
  color: var(--detail-text-1);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.back:hover { background: var(--bg-hover); }
.name {
  font-size: 13px;
  color: var(--detail-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  font-size: 12px;
  color: var(--detail-text-2);
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
  color: var(--detail-text-2);
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
