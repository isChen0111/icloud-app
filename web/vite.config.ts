import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Vite 配置
 *
 * 关键点：开发服务器把 /api 开头的请求代理到后端 8899 端口，
 * 这样前端代码里写相对路径（/api/...）即可，无跨域问题。
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8899',
        changeOrigin: true,
      },
    },
  },
})
