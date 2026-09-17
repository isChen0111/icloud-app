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
import { formatDuration } from '../utils/format'
import type { AssetDto } from '../types'
import { useAssetStore } from '../stores/assets'

const props = defineProps<{ asset: AssetDto; width: number; selected: boolean }>()
const router = useRouter()
const store = useAssetStore()

const { isVisible, src, rootRef } = useLazyImage(props.asset.id, 'grid')

/** 占位底色：按 id 生成一个稳定的浅灰渐变（视觉上比纯灰更柔和） */
const placeholderBg = computed(() => {
  const hue = (props.asset.id * 37) % 360
  return `hsl(${hue}, 12%, 22%)`
})


/** 单击 = 单选；Ctrl/⌘+单击 = 追加多选（stop 冒泡防触发空白清空） */
function onSelect(e: MouseEvent): void {
  e.stopPropagation()
  if (e.ctrlKey || e.metaKey) store.toggleSelect(props.asset.id)
  else store.selectOnly(props.asset.id)
}

/** 双击 = 进详情（先清空选中，避免返回后误删） */
function openDetail(): void {
  store.clearSelection()
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
    @click="onSelect"
    @dblclick="openDetail"
  >
    <!-- 占位/懒加载锚点：进入视口后由 composable 注入真实图 -->
    <div ref="rootRef" class="thumb-layer">
      <img v-if="isVisible" :src="blurUrl(asset.id)" class="thumb blur" alt="" decoding="async" />
      <img v-if="isVisible" :src="src" class="thumb real" alt="" decoding="async" loading="lazy" />
    </div>

    <!-- 选中态叠加层：绝对定位在缩略图内部，不参与流布局（虚拟滚动行高零影响） -->
    <div v-if="selected" class="select-overlay" aria-hidden="true">
      <span class="check-badge">✓</span>
    </div>
    <!-- hover 提示可选中（虚线圆圈，iCloud 桌面端风格） -->
    <!-- 类型徽标：实况 LIVE（右上）/ 视频时长胶囊（右下，对齐 iCloud 缩略图视频时长条） -->
    <span v-if="asset.type === 'live'" class="badge live">LIVE</span>
    <span v-else-if="asset.type === 'video'" class="badge duration">
      <svg width="7" height="8" viewBox="0 0 7 8" fill="currentColor" aria-hidden="true"><path d="M0 0l7 4-7 4z" /></svg>
      {{ formatDuration(asset.duration) }}
    </span>
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
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.8px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  color: #fff;
  line-height: 1.4;
}
.badge.live { top: 6px; right: 6px; }
.badge.duration {
  bottom: 6px;
  right: 6px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.3px;
  padding: 2px 6px;
}
.badge.duration svg { flex-shrink: 0; }

/* 选中态：蓝色边框 + 左上角对勾（画在缩略图内，不影响外部布局计算） */
.select-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  border: 3px solid #0a84ff;
  border-radius: 6px;
  box-sizing: border-box;
  background: rgba(10, 132, 255, 0.1);
  pointer-events: none;
}
.check-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #0a84ff;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
