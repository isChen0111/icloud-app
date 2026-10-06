import type { InjectionKey } from 'vue'

export interface GridThumbnailScheduler {
  request(assetId: number, element: HTMLElement, load: () => void): () => void
  onScroll(): void
  complete(assetId: number, element: HTMLElement): void
  beginScrollbarDrag(): void
  endScrollbarDrag(): void
  prioritizeNextScroll(): void
}

interface PendingThumbnail {
  element: HTMLElement
  load: () => void
}

export const gridThumbnailSchedulerKey: InjectionKey<GridThumbnailScheduler> = Symbol('gridThumbnailScheduler')

export function createGridThumbnailScheduler(
  getScrollElement: () => HTMLElement | null,
  getPrefetchDistance: () => number,
): GridThumbnailScheduler {
  const pending = new Map<number, PendingThumbnail>()
  const active = new Map<number, PendingThumbnail>()
  const settleDelayMs = 180
  const dragLoadIntervalMs = 250
  const maxConcurrentRequests = 8
  let scrollbarDragging = false
  let deferUntil = 0
  let settleTimer: number | undefined
  let dragLoadTimer: number | undefined
  let lastDragLoadAt = 0
  let lastDragLoadScrollTop = 0

  function pump(visibleOnly = false): void {
    const scrollElement = getScrollElement()
    if (!scrollElement || active.size >= maxConcurrentRequests) return

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
      if (active.size >= maxConcurrentRequests) break
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
      if (scrollDistance <= slowDragDistance) pump(true)
      scheduleDragLoad()
    }, delay)
  }

  function request(assetId: number, element: HTMLElement, load: () => void): () => void {
    const item: PendingThumbnail = { element, load }
    pending.set(assetId, item)
    if (scrollbarDragging) scheduleDragLoad()
    else if (deferUntil <= Date.now()) pump()
    return () => {
      if (pending.get(assetId) === item) pending.delete(assetId)
      if (active.get(assetId) === item) {
        active.delete(assetId)
        if (scrollbarDragging) scheduleDragLoad()
        else pump()
      }
    }
  }

  function onScroll(): void {
    if (scrollbarDragging) scheduleDragLoad()
    else pump()
  }

  return {
    request,
    onScroll,
    complete(assetId, element) {
      if (active.get(assetId)?.element !== element) return
      active.delete(assetId)
      if (scrollbarDragging) scheduleDragLoad()
      else pump()
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
        pump()
      }, settleDelayMs)
    },
    prioritizeNextScroll() {
      scrollbarDragging = false
      deferUntil = 0
      if (settleTimer !== undefined) window.clearTimeout(settleTimer)
      settleTimer = undefined
    },
  }
}
