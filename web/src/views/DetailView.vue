<script setup lang="ts">
/**
 * DetailView —— 详情页（对标 iCloud OneUp）
 *
 * 行为对齐实测结论：
 *   - 大图用 detail 档（1600px WebP），渐进加载（先占位后淡入）
 *   - 方向键/点击切换，切换时预取邻居大图（隐藏 Image 预热），回来秒开
 *   - type=live → 实况照片（按住播放）；type=video → 原生视频播放器
 *   - hash 路由深链：#/photo/:id
 *   - 顶栏：左（返回+文件名）· 中（拍摄时间 + "第 N / total 项"）· 右（信息按钮）
 *   - 「信息」：右侧抽屉 InfoPanel，实时拉取 /api/assets/:id/info
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchAsset, fetchAssetInfo, thumbUrl } from '../api/client'
import type { AssetDetail, AssetInfo } from '../types'
import { formatTakenShort } from '../utils/format'
import LivePhoto from '../components/detail/LivePhoto.vue'
import VideoStage from '../components/detail/VideoStage.vue'
import InfoPanel from '../components/detail/InfoPanel.vue'
import { useAssetStore } from '../stores/assets'
import { deleteAssets } from '../api/client'
import DeleteConfirm from '../components/DeleteConfirm.vue'

const route = useRoute()
const router = useRouter()

const detail = ref<AssetDetail | null>(null)
const loading = ref(false)
const loadError = ref(false)
/** 大图 <img> 加载失败（坏图/生成失败时显示占位，避免破损图标） */
const photoError = ref(false)

/** 请求序号守卫：快速连按 ←→ 时丢弃过期响应（修复审查 P1-④ 竞态） */
let loadSeq = 0

/** 信息面板状态：是否打开 / 拉取中 / 数据 */
const assetStore = useAssetStore()
/** 详情页删除：确认弹框 + 删除请求进行中 */
const confirmDeleteOpen = ref(false)
const deleting = ref(false)
const infoOpen = ref(false)
const infoLoading = ref(false)
const info = ref<AssetInfo | null>(null)
/** 信息请求序号守卫（切换资产时丢弃过期响应） */
let infoSeq = 0

/** 当前 id（来自路由参数） */
const currentId = computed(() => Number(route.params.id))

/** 大图 URL（detail 档） */
const bigSrc = computed(() => (detail.value ? thumbUrl(detail.value.id, 'detail') : ''))

/** 占位图 URL（grid 档，照片墙已生成 + 浏览器已缓存 → 秒出；detail 加载完前模糊铺底） */
const placeholderSrc = computed(() => (detail.value ? thumbUrl(detail.value.id, 'grid') : ''))

/** 根据类型选择展示器 */
const isLive = computed(() => detail.value?.type === 'live')
const isVideo = computed(() => detail.value?.type === 'video')

/** 顶栏：拍摄时间短格式（"2026年8月31日 15:45"，对齐 iCloud 顶栏） */
const timeText = computed(() => (detail.value ? formatTakenShort(detail.value.dateTaken) : ''))

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

/** 打开信息面板：懒拉取（点开才解析原文件 EXIF，低频操作） */
async function openInfo(): Promise<void> {
  if (infoOpen.value) return // 已打开则忽略（按钮 toggle 在关闭处处理）
  infoOpen.value = true
  infoLoading.value = true
  info.value = null
  const seq = ++infoSeq
  try {
    const data = await fetchAssetInfo(currentId.value)
    if (seq !== infoSeq) return // 已切换资产：丢弃过期响应
    info.value = data
  } catch {
    if (seq !== infoSeq) return
    info.value = null
  } finally {
    if (seq === infoSeq) infoLoading.value = false
  }
}

/** 详情页删除：确认 → API → store 同步 → 导航到相邻资产（先下一张，再上一张） */
async function onConfirmDelete(): Promise<void> {
    const id = currentId.value
    const d = detail.value
    if (!d) return
    const next = d.nextId
    const prev = d.prevId
    deleting.value = true
    try {
      await deleteAssets([id])
      assetStore.removeAssets([id])
      confirmDeleteOpen.value = false
      if (next != null) void router.push({ name: 'detail', params: { id: String(next) } })
      else if (prev != null) void router.push({ name: 'detail', params: { id: String(prev) } })
      else void router.push({ name: 'grid' })
    } catch {
      alert('删除失败，请检查后端服务')
    } finally {
      deleting.value = false
    }
  }
function closeInfo(): void {
  infoSeq++
  infoOpen.value = false
  info.value = null
  infoLoading.value = false
}

/** 切到邻居 */
function go(direction: 1 | -1): void {
  const target = direction === 1 ? detail.value?.nextId : detail.value?.prevId
  if (target == null) return
  void router.push({ name: 'detail', params: { id: String(target) } })
}

/** 键盘导航 */
function onKeydown(e: KeyboardEvent): void {
  // 信息面板打开时：Esc 优先关面板，不返回网格
  if (infoOpen.value && e.key === 'Escape') {
    closeInfo()
    return
  }
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1) }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
  else if (e.key === 'Escape') { void router.push({ name: 'grid' }) }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void load(currentId.value)
})

watch(currentId, (id) => {
  void load(id)
  // 切换资产时关闭信息面板（面板数据属于上一个资产）
  if (infoOpen.value) closeInfo()
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="detail-view">
    <!-- 顶栏：左（返回+文件名）｜中（时间+序号/总数，绝对居中）｜右（信息按钮） -->
    <div class="detail-topbar">
      <div class="tb-left">
        <button class="back" @click="router.push({ name: 'grid' })">← 返回</button>
        <span class="name" :title="detail?.filename">{{ detail?.filename ?? '…' }}</span>
      </div>

      <div class="tb-center">
        <div class="time">{{ timeText }}</div>
        <div v-if="detail" class="count">{{ detail.position.toLocaleString() }} / {{ detail.total.toLocaleString() }} 项</div>
      </div>

      <div class="tb-right">
        <button class="del-btn" :disabled="deleting" title="删除此项目" @click="confirmDeleteOpen = true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="info-btn" aria-label="信息" :class="{ active: infoOpen }" @click="infoOpen ? closeInfo() : openInfo()">
          i
        </button>
      </div>
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
          <img :src="placeholderSrc" class="photo-placeholder" alt="" draggable="false" />
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

    <!-- 删除确认弹框（详情页单张删除） -->
    <DeleteConfirm
      v-if="confirmDeleteOpen"
      :count="1"
      :deleting="deleting"
      @confirm="onConfirmDelete"
      @cancel="confirmDeleteOpen = false"
    />
    <!-- 信息抽屉 -->
    <InfoPanel v-if="infoOpen" :info="info" :loading="infoLoading" @close="closeInfo" />
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
  position: relative; /* 作为中栏绝对居中的定位参考 */
  display: flex;
  align-items: center;
  gap: 16px;
  height: 52px;
  padding: 0 16px;
  flex-shrink: 0;
}
.tb-left {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.tb-center {
  /* 真正居中（不随左右内容宽度偏移） */
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  pointer-events: none;
}
.tb-right {
  flex: 1;
  display: flex;
  justify-content: flex-end;
}
.time {
  font-size: 13px;
  font-weight: 600;
  color: var(--detail-text-1);
  white-space: nowrap;
}
.count {
  font-size: 11px;
  color: var(--detail-text-2);
  margin-top: 2px;
  white-space: nowrap;
}
.back {
  background: none;
  border: 1px solid var(--detail-border);
  color: var(--detail-text-1);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
}
.back:hover { background: var(--bg-hover); }
.name {
  font-size: 13px;
  color: var(--detail-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.info-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--detail-border);
  background: none;
  color: #0a84ff; /* 统一蓝色（与删除按钮一致） */
  font-size: 17px;
  font-style: italic;
  font-family: Georgia, serif;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.info-btn:hover { background: var(--bg-hover); color: #0a84ff; }
.info-btn.active { background: #0a84ff; color: #fff; border-color: #0a84ff; }
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
/* 占位（grid 档）：铺满舞台 + 模糊 + 轻微放大（防模糊边缘透出背景黑边） */
.photo-placeholder {
  position: absolute;
  inset: 0;
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  filter: blur(16px);
  transform: scale(1.02);
  opacity: 0.9;
}
.big-photo {
  position: absolute;
  inset: 0;
  margin: auto;
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

/* 删除按钮（信息按钮旁）：同款圆形描边，垃圾桶图标蓝色（与信息按钮统一） */
.del-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--detail-border);
  background: none;
  color: #0a84ff;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.del-btn:hover:not(:disabled) { background: var(--bg-hover); }
.del-btn:disabled { opacity: 0.4; cursor: default; }
</style>
