/**
 * 图片懒加载组合式函数
 *
 * 对标 iCloud 的 DerivativeImage 行为：
 * - 网格项进入视口（IntersectionObserver）才真正创建 <img> 发起请求
 * - 先显示 32px 模糊占位（blur 档），大图到位后淡入覆盖（opacity 过渡）
 * - 滚动快速滑过时根本不会请求（离屏即取消）
 *
 * 用法：const { src, placeholder, isVisible } = useLazyImage(id, 'grid')
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { thumbUrl } from '../api/client'

export function useLazyImage(assetId: number, size: 'grid' | 'detail' = 'grid') {
  const isVisible = ref(false)
  const src = ref('')

  /** 锚点元素：模板用 ref="rootRef" 绑定；watch 兜底时序，挂载后自动 observe */
  const rootRef = ref<HTMLElement | null>(null)

  let observer: IntersectionObserver | null = null

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
                // 进入视口 → 触发加载；已加载则不再重复请求
                isVisible.value = true
                src.value = thumbUrl(assetId, size)
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

  onBeforeUnmount(() => observer?.disconnect())

  return { isVisible, src, rootRef }
}

/** 模糊占位图 URL（滚动时即时可见） */
export function blurUrl(assetId: number): string {
  return thumbUrl(assetId, 'blur')
}
