/**
 * Pinia Store：主题（深色/浅色）
 *
 * 设计：
 *  - 状态持久化到 localStorage（key: 'icloud-app-theme'），刷新保持选择
 *  - index.html 内联脚本在首屏（CSS 生效前）读取同一 key 设置 [data-theme]，
 *    避免"先深后浅/先浅后深"闪烁；本 store 只负责后续运行时切换与持久化
 *  - 主题切换 = 根元素 [data-theme] 变化 → CSS 变量（--bg 系列、--text 系列）整体响应，
 *    所有组件样式引用 var()，无需任何组件重渲染逻辑
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ThemeMode = 'dark' | 'light'

const STORAGE_KEY = 'icloud-app-theme'

/** 读取上次选择；异常（隐私模式等）时回退深色 */
function readStoredTheme(): ThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>(readStoredTheme())

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

  return { theme, toggleTheme }
})
