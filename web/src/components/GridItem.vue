<script setup lang="ts">
/**
 * GridItem —— 网格单项
 *
 * 渲染层级（对标 iCloud DerivativeImage 的渐进式呈现）：
 *   1. 灰色底色容器（方形，固定宽高）→ 保证滚动时布局零抖动
 *   2. blur 模糊占位图（32px，秒出）
 *   3. 真实缩略图（320px WebP）→ 加载完成后淡入覆盖占位
 *
 * 类型徽标：
 *   ▶ 视频（右下角）
 *   LIVE 实况照片（右上角，对标 iCloud 的实况徽标）
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { blurUrl, useLazyImage } from '../composables/useLazyImage'
import type { AssetDto } from '../types'

const props = defineProps<{ asset: AssetDto; width: number }>()
const router = useRouter()

const { isVisible, src, rootRef } = useLazyImage(props.asset.id, 'grid')

/** 是否视频类（视频与实况都有可播放内容，实况单独标 LIVE） */
const isVideoLike = computed(() => props.asset.type === 'video' || props.asset.type === 'live')

/** 占位底色：按 id 生成一个稳定的浅灰渐变（视觉上比纯灰更柔和） */
const placeholderBg = computed(() => {
  const hue = (props.asset.id * 37) % 360
  return `hsl(${hue}, 12%, 22%)`
})

function openDetail(): void {
  router.push({ name: 'detail', params: { id: String(props.asset.id) } })
}
</script>

<template>
  <div
    class="grid-item"
    :style="{
      width: `${width}px`,
      height: `${width}px`,
      background: placeholderBg,
    }"
    @click="openDetail"
  >
    <!-- 占位/懒加载锚点：进入视口后由 composable 注入真实图 -->
    <div ref="rootRef" class="thumb-layer">
      <img v-if="isVisible" :src="blurUrl(asset.id)" class="thumb blur" alt="" decoding="async" />
      <img v-if="isVisible" :src="src" class="thumb real" alt="" decoding="async" loading="lazy" />
    </div>

    <!-- 类型徽标 -->
    <span v-if="asset.type === 'live'" class="badge live">LIVE</span>
    <span v-else-if="isVideoLike" class="badge play">▶</span>
  </div>
</template>

<style scoped>
.grid-item {
  position: relative;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  transition: transform 0.12s ease;
}
.grid-item:hover { transform: scale(1.02); z-index: 2; }
.thumb-layer {
  position: absolute;
  inset: 0;
}
.thumb {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* 真实图淡入覆盖占位（对标 iCloud 的 ProgressiveImageElement opacity 过渡） */
.thumb.real { opacity: 0; transition: opacity 0.3s ease; }
.thumb.real[src] { opacity: 1; }
.badge {
  position: absolute;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  color: #fff;
}
.badge.live { top: 6px; right: 6px; color: #ffd60a; }
.badge.play {
  bottom: 6px;
  right: 6px;
  font-size: 11px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
</style>
