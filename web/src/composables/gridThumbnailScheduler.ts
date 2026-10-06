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

export function createGridThumbnailScheduler(
  getScrollElement: () => HTMLElement | null,
  getPrefetchDistance: () => number,
  maxConcurrentRequests = 8, // 默认与后端 config.thumbConcurrency 一致；GridScroller 启动后会从 /api/stats 校准
): GridThumbnailScheduler {
  const pending = new Map<number, PendingThumbnail>()
  const active = new Map<number, PendingThumbnail>()
  const settleDelayMs = 180
  const dragLoadIntervalMs = 250
  let concurrencyLimit = maxConcurrentRequests
  let scrollbarDragging = false
  let deferUntil = 0
  let settleTimer: number | undefined
  let dragLoadTimer: number | undefined
  let lastDragLoadAt = 0
  let lastDragLoadScrollTop = 0

  /**
   * rAF 合并的 pump 入口：scroll/request/complete 等高频触发源在同一帧内
   * 只真正跑一次 pump，避免每个 scroll 事件都做 getBoundingClientRect
   * （强制布局重算 → 快速滚动掉帧）。visibleOnly 只在拖动慢速场景使用；
   * 同一帧内以「最宽」模式执行（出现过 false 就按 false 跑）。
   */
  let pumpRaf = 0
  let pumpVisibleOnly = false
  function requestPump(visibleOnly = false): void {
    if (!visibleOnly) pumpVisibleOnly = false
    if (pumpRaf !== 0) return
    pumpRaf = requestAnimationFrame(() => {
      pumpRaf = 0
      pump(pumpVisibleOnly)
    })
  }

  function pump(visibleOnly = false): void {
    const scrollElement = getScrollElement()
    if (!scrollElement || active.size >= concurrencyLimit) return

    const viewport = scrollElement.getBoundingClientRect()
    const margin = visibleOnly ? 0 : getPrefetchDistance()
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

  function scheduleDragLoad(): void {
    if (!scrollbarDragging || dragLoadTimer !== undefined) return
    const delay = Math.max(0, dragLoadIntervalMs - (Date.now() - lastDragLoadAt))
    dragLoadTimer = window.setTimeout(() => {
      dragLoadTimer = undefined
      if (!scrollbarDragging) return
      lastDragLoadAt = Date.now()
      const scrollElement = getScrollElement()
      if (!scrollElement) return

      const scrollDistance = Math.abs(scrollElement.scrollTop - lastDragLoadScrollTop)
      lastDragLoadScrollTop = scrollElement.scrollTop
      const slowDragDistance = Math.max(96, scrollElement.clientHeight * 0.2)
      if (scrollDistance <= slowDragDistance) requestPump(true)
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
    if (scrollbarDragging) scheduleDragLoad()
    else requestPump()
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
      lastDragLoadAt = Date.now()
      lastDragLoadScrollTop = getScrollElement()?.scrollTop ?? 0
      deferUntil = 0
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      settleTimer = undefined
      scheduleDragLoad()
    },
    endScrollbarDrag() {
      scrollbarDragging = false
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
