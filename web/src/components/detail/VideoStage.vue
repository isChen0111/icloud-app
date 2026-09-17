<script setup lang="ts">
/**
 * VideoStage —— 视频播放器
 *
 * 原生 <video> + HTTP Range 流式（后端 /api/video/:id/stream 支持 206）：
 *   - preload="metadata"：首屏只拉 moov 头（几 KB），进度条可拖
 *   - controls：浏览器自带播放条/全屏/音量
 *   - poster：视频封面帧（ffmpeg 抽的第 1 秒）
 */
import { videoPosterUrl, videoStreamUrl } from '../../api/client'

const props = defineProps<{ id: number }>()
</script>

<template>
  <div class="video-stage">
    <!-- 封面占位（grid 档秒出；poster 未就绪前模糊铺底） -->
    <img :src="videoPosterUrl(props.id, 'grid')" class="poster-placeholder" alt="" draggable="false" />
    <video
      class="player"
      :src="videoStreamUrl(props.id)"
      :poster="videoPosterUrl(props.id, 'detail')"
      controls
      playsinline
      preload="metadata"
    ></video>
  </div>
</template>

<style scoped>
.video-stage {
  /* 同 LivePhoto：height:100% 在 flex item 内不解析，改用 absolute 撑满 */
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* video 透明后留边黑底由舞台承担（poster 未加载时占位图可见） */
  background: var(--detail-bg); /* 主题化：与照片详情页同底（原硬编码黑底） */
}
.poster-placeholder {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: blur(16px);
  transform: scale(1.02);
  opacity: 0.9;
  pointer-events: none;
}
.player {
  /* 铺满舞台：poster 未加载视频流时也按舞台尺寸 contain 显示（修复播放前小图）；
     播放后视频同样 contain，不裁切 */
  width: 100%;
  height: 100%;
  object-fit: contain;
  outline: none;
  border-radius: 4px;
  background: transparent; /* poster 未加载时透出占位图；留边黑底由 .video-stage 承担 */
  position: relative;
  z-index: 1;
}
</style>
