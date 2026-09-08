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
    <video
      class="player"
      :src="videoStreamUrl(props.id)"
      :poster="videoPosterUrl(props.id)"
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
}
.player {
  max-width: 100%;
  max-height: 100%;
  outline: none;
  border-radius: 4px;
  background: #000;
}
</style>
