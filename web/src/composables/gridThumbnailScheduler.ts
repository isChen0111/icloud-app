import type { InjectionKey } from 'vue'

export interface GridThumbnailScheduler {
  request(assetId: number, element: HTMLElement, load: () => void): () => void
  onScroll(): void
  complete(assetId: number, element: HTMLElement): void
  beginScrollbarDrag(): void
  endScrollbarDrag(): void
  prioritizeNextScroll(): void
  /** 并发上限更新：以后端 /api/stats 的 thumbConcurrency 为准（防前后端漂移） */
  setMaxConcurrentRequests(n: number): void
}

interface PendingThumbnail {
  element: HTMLElement
  load: () => void
}

export const gridThumbnailSchedulerKey: InjectionKey<GridThumbnailScheduler> = Symbol('gridThumbnailScheduler')

/**
 * 网格缩略图前端调度器（三层防线之一：几何距离排队；外层有 IO 懒加载，后端有 F-02 断开跳过）。
 *
 * 滚动条拖拽模式（2026-10-07 优化，fix/slow-drag-prefetch）：
 * - 慢速拖动（250ms 内位移 ≤ 20% 屏高）与普通滚动同体验：onScroll 走 rAF 合并的
 *   requestPump（始终带预载 margin），新进视口的图下一帧即触发，视口外一行也提前预载，
 *   不再「每 250ms 才触发 + 只加载严格可见」（旧实现导致图片慢慢追着手、松手才秒出）。
 * - 快速拖动（250ms 内位移 > 20% 屏高）：fastDrag 置位后停止 pump，跳过快速滑过的
 *   中间区域（防请求风暴）；250ms 轮询持续检测速度，降速即恢复。
 * - 松手：180ms settle 缓冲后恢复正常 pump，按最终视口 + 预载区全量加载。
 */
export function createGridThumbnailScheduler(
  getScrollElement: () => HTMLElement | null,
  getPrefetchDistance: () => number,
  maxConcurrentRequests = 8, // 默认与后端 config.thumbConcurrency 一致；GridScroller 启动后会从 /api/stats 校准
): GridThumbnailScheduler {
  const pending = new Map<number, PendingThumbnail>()
  const active = new Map<number, PendingThumbnail>()
  const settleDelayMs = 180
  const dragSpeedCheckMs = 250
  let concurrencyLimit = maxConcurrentRequests
  let scrollbarDragging = false
  /** 快速拖动标志：250ms 轮询检测位移超阈值后置位，停止派发（跳过中间区域） */
  let fastDrag = false
  let deferUntil = 0
  let settleTimer: number | undefined
  let dragLoadTimer: number | undefined
  let lastDragLoadAt = 0
  let lastDragLoadScrollTop = 0

  /**
   * rAF 合并的 pump 入口：scroll/request/complete 等高频触发源在同一帧内
   * 只真正跑一次 pump，避免每个 scroll 事件都做 getBoundingClientRect
   * （强制布局重算 → 快速滚动掉帧）。
   */
  let pumpRaf = 0
  function requestPump(): void {
    if (pumpRaf !== 0) return
    pumpRaf = requestAnimationFrame(() => {
      pumpRaf = 0
      pump()
    })
  }

  /** 遍历 pending，几何过滤：仅视口 + 预载行内的元素会真正触发 load；可见优先、距离近优先 */
  function pump(): void {
    const scrollElement = getScrollElement()
    if (!scrollElement || active.size >= concurrencyLimit) return

    const viewport = scrollElement.getBoundingClientRect()
    const margin = getPrefetchDistance()
    const ready: { assetId: number; distance: number; visible: boolean }[] = []

    for (const [assetId, item] of pending) {
      if (!item.element.isConnected) {
        pending.delete(assetId)
        continue
      }

      const rect = item.element.getBoundingClientRect()
      if (rect.bottom < viewport.top - margin || rect.top > viewport.bottom + margin) continue

      const visible = rect.bottom > viewport.top && rect.top < viewport.bottom
      const distance = visible
        ? 0
        : Math.min(Math.abs(rect.bottom - viewport.top), Math.abs(rect.top - viewport.bottom))
      ready.push({ assetId, distance, visible })
    }

    ready.sort((a, b) => Number(b.visible) - Number(a.visible) || a.distance - b.distance)
    for (const item of ready) {
      if (active.size >= concurrencyLimit) break
      const thumbnail = pending.get(item.assetId)
      if (!thumbnail) continue
      pending.delete(item.assetId)
      active.set(item.assetId, thumbnail)
      thumbnail.load()
    }
  }

  /**
   * 拖拽速度检测轮询（250ms）：拖动期间持续判定快/慢并更新 fastDrag。
   * 慢速拖动时带预载兜底触发 pump（覆盖 request() 新注册但未被 onScroll 触发的元素）；
   * 快速拖动时不派发（跳过中间区域）。
   */
  function scheduleDragLoad(): void {
    if (!scrollbarDragging || dragLoadTimer !== undefined) return
    const delay = Math.max(0, dragSpeedCheckMs - (Date.now() - lastDragLoadAt))
    dragLoadTimer = window.setTimeout(() => {
      dragLoadTimer = undefined
      if (!scrollbarDragging) return
      lastDragLoadAt = Date.now()
      const scrollElement = getScrollElement()
      if (!scrollElement) return

      const scrollDistance = Math.abs(scrollElement.scrollTop - lastDragLoadScrollTop)
      lastDragLoadScrollTop = scrollElement.scrollTop
      const slowDragDistance = Math.max(96, scrollElement.clientHeight * 0.2)
      fastDrag = scrollDistance > slowDragDistance
      if (!fastDrag) requestPump()
      scheduleDragLoad()
    }, delay)
  }

  function request(assetId: number, element: HTMLElement, load: () => void): () => void {
    const item: PendingThumbnail = { element, load }
    pending.set(assetId, item)
    if (scrollbarDragging) scheduleDragLoad()
    else if (deferUntil <= Date.now()) requestPump()
    return () => {
      if (pending.get(assetId) === item) pending.delete(assetId)
      if (active.get(assetId) === item) {
        active.delete(assetId)
        if (scrollbarDragging) scheduleDragLoad()
        else requestPump()
      }
    }
  }

  function onScroll(): void {
    if (scrollbarDragging) {
      // 慢速拖动 = 普通滚动体验：每帧 rAF 派发（带预载）；快速拖动等轮询判速后停止
      if (!fastDrag) requestPump()
      scheduleDragLoad()
    } else {
      requestPump()
    }
  }

  return {
    request,
    onScroll,
    complete(assetId, element) {
      if (active.get(assetId)?.element !== element) return
      active.delete(assetId)
      if (scrollbarDragging) scheduleDragLoad()
      else requestPump()
    },
    beginScrollbarDrag() {
      scrollbarDragging = true
      fastDrag = false // 初始按慢速处理：拖起即加载当前位置；轮询检测到快速后才停止
      lastDragLoadAt = Date.now()
      lastDragLoadScrollTop = getScrollElement()?.scrollTop ?? 0
      deferUntil = 0
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      settleTimer = undefined
      scheduleDragLoad()
    },
    endScrollbarDrag() {
      scrollbarDragging = false
      fastDrag = false
      if (dragLoadTimer !== undefined) window.clearTimeout(dragLoadTimer)
      dragLoadTimer = undefined
      deferUntil = Date.now() + settleDelayMs
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        settleTimer = undefined
        deferUntil = 0
        requestPump()
      }, settleDelayMs)
    },
    prioritizeNextScroll() {
      scrollbarDragging = false
      fastDrag = false
      deferUntil = 0
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      settleTimer = undefined
      requestPump()
    },
    setMaxConcurrentRequests(n) {
      const next = Math.max(1, Math.floor(n))
      if (next === concurrencyLimit) return
      concurrencyLimit = next
      // 上限调大后可能有余量：立即补发一轮
      if (!scrollbarDragging) requestPump()
    },
  }
}
