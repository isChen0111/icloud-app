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
}
.player {
  /* 铺满舞台：poster 未加载视频流时也按舞台尺寸 contain 显示（修复播放前小图）；
     播放后视频同样 contain，不裁切 */
  width: 100%;
  height: 100%;
  object-fit: contain;
  outline: none;
  border-radius: 4px;
  background: #000;
}
</style>
