/**
 * Pinia Store：主题（深色/浅色）+ 缩略图列数（照片墙/搜索共享）
 *
 * 设计：
 *  - 状态持久化到 localStorage（key: 'icloud-app-theme' / 'icloud-app-thumb-cols'），刷新保持
 *  - index.html 内联脚本在首屏（CSS 生效前）读取主题 key 设置 [data-theme]，
 *    避免"先深后浅/先浅后深"闪烁；本 store 只负责后续运行时切换与持久化
 *  - 主题切换 = 根元素 [data-theme] 变化 → CSS 变量（--bg 系列、--text 系列）整体响应，
 *    所有组件样式引用 var()，无需任何组件重渲染逻辑
 *  - thumbnailCols：GridScroller 的缩略图列数档位提升到这里——照片墙与搜索结果
 *    共用同一列数（搜索态工具栏也有滑块，改一处两处同时变），持久化到 localStorage
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ThemeMode = 'dark' | 'light'

const STORAGE_KEY = 'icloud-app-theme'
const THUMB_KEY = 'icloud-app-thumb-cols'

/** 读取上次主题；异常（隐私模式等）时回退浅色（应用默认浅色） */
function readStoredTheme(): ThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 读取上次列数；非法值回退默认 8（对标 iCloud 默认 8 列） */
function readStoredCols(): number {
  try {
    const v = Number(localStorage.getItem(THUMB_KEY))
    return Number.isInteger(v) && v >= 4 && v <= 12 ? v : 8
  } catch {
    return 8
  }
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>(readStoredTheme())
  /** 缩略图列数（照片墙 + 搜索共用，持久化；GridScroller 滑块读写） */
  const thumbnailCols = ref<number>(readStoredCols())

  /** 切换深浅 */
  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  /** 持久化：主题变化 → 写 localStorage（与 index.html 内联脚本同 key） */
  watch(theme, (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, v)
    } catch {
      /* 存储不可用则忽略：本次会话内仍生效 */
    }
  })

  /** 列数持久化（同策略） */
  watch(thumbnailCols, (v) => {
    try {
      localStorage.setItem(THUMB_KEY, String(v))
    } catch {
      /* 存储不可用则忽略 */
    }
  })

  return { theme, toggleTheme, thumbnailCols }
})
