/**
 * 图片懒加载组合式函数
 *
 * 网格项进入视口附近（IntersectionObserver）后才设置缩略图 URL，
 * 滚动快速跳过的离屏图片不会发起请求。
 *
 * 用法：const { src, isVisible, rootRef } = useLazyImage(id, 'grid', () => props.asset.rev)
 *
 * rev 必须是 getter/ref 而非快照值（R-12）：
 *   源文件被覆盖后后端 file_mtime 变化 → DTO 的 rev 变化 → 缩略图 URL 必须跟着变。
 *   但 GridItem 的 :key 是 asset.id（不含 rev），组件实例会被复用、不会重建，
 *   若 rev 在 setup 期被求值成普通数字，这里就永远是旧值 → 覆盖过的图继续显示旧缩略图。
 *   因此：① 真正发起请求时用 toValue(rev) 现读；
 *        ② 已经加载过（src 非空）时 watch rev，变化即换新 URL（浏览器不会命中旧缓存）。
 */
import { inject, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { thumbUrl } from '../api/client'
import { gridThumbnailSchedulerKey } from './gridThumbnailScheduler'

export function useLazyImage(
  assetId: number,
  size: 'grid' | 'detail' = 'grid',
  rev: MaybeRefOrGetter<number> = 0,
) {
  const src = ref('')
  const scheduler = size === 'grid' ? inject(gridThumbnailSchedulerKey, null) : null

  /** 锚点元素：模板用 ref="rootRef" 绑定；watch 兜底时序，挂载后自动 observe */
  const rootRef = ref<HTMLElement | null>(null)

  let observer: IntersectionObserver | null = null
  let cancelScheduledLoad = () => {}

  // 用 watch + immediate 而非 onMounted：
  // 函数 ref 与 onMounted 的执行先后在 v-for 场景下不可靠，ref 值一旦非空就建立观察器最稳
  watch(
    rootRef,
    (el) => {
      if (el && !observer) {
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                // 进入视口 → 触发加载；快速滚动时由网格调度器暂缓中间位置请求
                const load = () => {
                  // 现读 rev：排队等待期间资产可能已被刷新（扫描完成重拉 DTO）
                  src.value = thumbUrl(assetId, size, Number(toValue(rev)) || 0)
                }
                cancelScheduledLoad = scheduler
                  ? scheduler.request(assetId, entry.target as HTMLElement, load)
                  : (load(), () => {})
                observer?.unobserve(entry.target)
                // 修复（审查 P2-F7）：置空引用——该实例已不会再 observe 任何元素，
                // 防止组件复用时误判"已有 observer 而跳过重建"
                observer = null
              }
            }
          },
          { rootMargin: '300px 0px', threshold: 0.01 }, // 提前 300px 预热，滚动更顺
        )
        observer.observe(el)
      }
    },
    { immediate: true },
  )

  // R-12：rev 变化（源文件被覆盖后重扫）→ 已加载过的图直接换 URL，无需等组件重建
  watch(
    () => Number(toValue(rev)) || 0,
    (next) => {
      if (!src.value) return // 尚未进视口：下次 load 会用新值，无需提前请求
      const nextSrc = thumbUrl(assetId, size, next)
      if (nextSrc !== src.value) src.value = nextSrc
    },
  )

  onBeforeUnmount(() => {
    observer?.disconnect()
    cancelScheduledLoad()
  })

  function onLoadFinished(): void {
    const element = rootRef.value
    if (element) scheduler?.complete(assetId, element)
  }

  return { src, rootRef, onLoadFinished }
}
