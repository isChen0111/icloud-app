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
/** 静止帧占位（grid 档秒出，detail 加载完前模糊铺底） */
const stillPlaceholder = computed(() => thumbUrl(props.id, 'grid'))
/** detail 静止帧是否加载完成（淡入覆盖占位） */
const stillLoaded = ref(false)
/** 实况视频 URL（首次按下才注入，避免提前拉流量） */
const videoSrc = ref('')
const playing = ref(false)
/** 视频加载中（按下后等待首帧数据就绪）：徽标显示旋转加载动画 */
const videoLoading = ref(false)
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
    stillLoaded.value = false // 新资产：占位重新显示，等 detail 淡入
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
  playing.value = true // 触发 video 淡入（opacity 过渡）+ :muted="!playing" 取消静音
  videoLoading.value = true // 视频数据就绪前徽标显示加载动画

  // 关键：必须显式调用 play()！video 元素由 v-if="videoSrc" 刚创建，
  // 等它在 DOM 挂载后再播放（play() 会自行等待首帧数据就绪）
  await nextTick()
  const v = videoEl.value
  if (!v) return
  // 带声播放（修复：实况原声。pointerdown 是用户手势，满足自动播放策略的激活条件）
  v.muted = false
  try {
    await v.play()
    videoLoading.value = false // 已开始播放，撤掉加载动画
  } catch {
    videoLoading.value = false
    // 兜底：个别环境仍拒绝带声播放 → 回退静音，保证"至少出画面"不丢
    v.muted = true
    await v.play().catch(() => {
      /* 静音播放也被拒（极少见），保持静帧即可 */
    })
  }
}

function onPointerUp(): void {
  playing.value = false
  videoLoading.value = false
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
    <!-- 静止帧占位（grid 档秒出，模糊铺底） -->
    <img :src="stillPlaceholder" class="stage still-placeholder" alt="" draggable="false" />
    <!-- 静止帧（detail 档，加载完成淡入覆盖占位） -->
    <img :src="stillSrc" class="stage still" :class="{ loaded: stillLoaded }" alt="" draggable="false" @load="stillLoaded = true" />

    <!-- 实况视频叠层：:muted="!playing" —— 按住播放带原声（iCloud 原版行为），松开复位静音属性 -->
    <video
      ref="videoEl"
      v-if="videoSrc"
      :src="videoSrc"
      class="stage motion"
      :class="{ on: playing }"
      :muted="!playing"
      playsinline
      loop
      @ended="(e) => onVideoEnded(e.target as HTMLVideoElement)"
      @loadstart="videoLoading = true"
      @waiting="videoLoading = true"
      @canplay="videoLoading = false"
      @playing="videoLoading = false"
    ></video>

    <!-- 顶部徽标（按住才高亮，对标 iCloud 的实况徽标反馈） -->
    <span class="live-badge" :class="{ active: playing, loading: videoLoading }">LIVE<span v-if="videoLoading" class="spinner" /></span>
    <span class="hint">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/>
        <path d="M11 11V4.5a1.5 1.5 0 0 1 3 0V11"/>
        <path d="M14 11.5V7a1.5 1.5 0 0 1 3 0v5.5a5.5 5.5 0 0 1-5.5 5.5H11a5.5 5.5 0 0 1-4.3-2.1L4 12.6a1.4 1.4 0 0 1 2.2-1.7L8 13"/>
      </svg>
      按住播放
    </span>
  </div>
</template>

<style scoped>
.live-photo {
  /* 不用 height:100%：flex item 的百分比高度在多数浏览器不解析（会塌成 0），
     用 absolute inset:0 撑满定位父（.stage 是 position:relative） */
  position: absolute;
  inset: 0;
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
/* 静止帧 detail 档：加载完成前隐藏，@load 后 0.3s 淡入覆盖占位 */
.still {
  z-index: 1;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.still.loaded { opacity: 1; }
/* 静止帧占位（grid 档）：模糊 + 轻微放大防边缘透底 */
.still-placeholder {
  z-index: 0;
  filter: blur(16px);
  opacity: 0.9;
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
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.5px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  pointer-events: none;
  backdrop-filter: blur(4px);
}
/* 视频加载中：徽标内旋转环（按住后等待首帧数据就绪的反馈） */
.live-badge .spinner {
  width: 9px;
  height: 9px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: live-spin 0.7s linear infinite;
}
@keyframes live-spin { to { transform: rotate(360deg); } }
.live-badge.active { background: #ffd60a; color: #1d1d1f; }
.hint {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.4px;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.92);
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
  pointer-events: none;
  opacity: 0.85;
  transition: opacity 0.25s ease;
}
/* 按住播放中：提示淡出（正在播放不再需要提示），松开后淡回 */
.live-photo:active .hint { opacity: 0; }
</style>
