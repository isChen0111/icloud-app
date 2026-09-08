<script setup lang="ts">
/**
 * LivePhoto —— 实况照片展示器
 *
 * 完全对标 iCloud 网页端实测结构：
 *   静止帧 <img> 铺底 + 同源 <video> 绝对定位叠层（z-index 更高、opacity:0）
 *   按住 → video.play() + opacity→1（500ms 过渡）
 *   松开 → video.pause() + opacity→0 + currentTime 归零
 *
 * 要点：
 *   - pointer capture：按住后把指针"锁"在本元素，滑出屏幕松开也能收到事件
 *   - 首次播放前不加载视频（onPointerDown 时才设 src，节省网络/内存）
 */
import { computed, nextTick, ref, watch } from 'vue'
import { thumbUrl, videoStreamUrl } from '../../api/client'

const props = defineProps<{ id: number }>()

/**
 * 静止帧（detail 档大图）。
 * 修复（详情页连按切换验证发现）：旧实现是 setup 里的普通常量，props.id 变化
 * 后 stillSrc 不会重新计算 → 快速翻页时图片停在第一张。必须用 computed 响应 id。
 */
const stillSrc = computed(() => thumbUrl(props.id, 'detail'))
/** 实况视频 URL（首次按下才注入，避免提前拉流量） */
const videoSrc = ref('')
const playing = ref(false)
/** video 元素引用（按下播放/松开暂停复位都要用它） */
const videoEl = ref<HTMLVideoElement | null>(null)

/**
 * id 变化（详情页连按 ←→ 复用本组件）：重置视频状态。
 * 旧实现 videoSrc 只在为空时赋值，切换 id 后按下仍播放上一个实况的视频。
 */
watch(
  () => props.id,
  () => {
    videoSrc.value = ''
    playing.value = false
    const v = videoEl.value
    if (v) {
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
  },
)

async function onPointerDown(e: PointerEvent): Promise<void> {
  // 指针捕获：按住后把指针"锁"在本元素，滑出屏幕松开也能收到 pointerup
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 合成事件没有活动指针时会抛，忽略（真实场景正常捕获） */
  }

  if (!videoSrc.value) videoSrc.value = videoStreamUrl(props.id)
  playing.value = true // 触发 video 淡入（opacity 过渡）

  // 关键：必须显式调用 play()！video 元素由 v-if="videoSrc" 刚创建，
  // 等它在 DOM 挂载后再播放（play() 会自行等待首帧数据就绪）
  await nextTick()
  await videoEl.value?.play().catch(() => {
    /* 播放被拒（极少见，muted+playsinline 下一般放行） */
  })
}

function onPointerUp(): void {
  playing.value = false
  // 松开：暂停并归零，对标 iCloud「松开 pause + currentTime 归零」
  const v = videoEl.value
  if (v) {
    v.pause()
    v.currentTime = 0
  }
}

/** 视频元素：播放完成/松开时暂停并复位 */
function onVideoEnded(video: HTMLVideoElement): void {
  playing.value = false
  video.pause()
  video.currentTime = 0
}
</script>

<template>
  <div
    class="live-photo"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!-- 静止帧 -->
    <img :src="stillSrc" class="stage still" alt="" draggable="false" />

    <!-- 实况视频叠层 -->
    <video
      ref="videoEl"
      v-if="videoSrc"
      :src="videoSrc"
      class="stage motion"
      :class="{ on: playing }"
      playsinline
      muted
      loop
      @ended="(e) => onVideoEnded(e.target as HTMLVideoElement)"
    ></video>

    <!-- 顶部徽标（按住才高亮，对标 iCloud 的实况徽标反馈） -->
    <span class="live-badge" :class="{ active: playing }">LIVE</span>
    <span class="hint">按住播放</span>
  </div>
</template>

<style scoped>
.live-photo {
  /* 不用 height:100%：flex item 的百分比高度在多数浏览器不解析（会塌成 0），
     用 absolute inset:0 撑满定位父（.stage 是 position:relative） */
  position: absolute;
  inset: 0;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}
.stage {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}
.motion {
  z-index: 2;
  opacity: 0;
  transition: opacity 0.5s ease; /* 对标 iCloud 500ms 过渡 */
}
.motion.on { opacity: 1; }
.live-badge {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 3;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  padding: 4px 8px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.5);
  color: #ffd60a;
  pointer-events: none;
}
.live-badge.active { background: #ffd60a; color: #1d1d1f; }
.hint {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  font-size: 11px;
  color: rgba(245, 245, 247, 0.6);
  pointer-events: none;
}
</style>
