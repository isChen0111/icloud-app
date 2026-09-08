/**
 * 路由（hash 模式）
 *
 * 对齐 iCloud 的 hash 深链设计（#/i,pz,GUID,index/）：
 * - hash 模式在本地/静态部署下无需服务器配置，天然支持刷新保留位置
 * - /photo/:id 详情路由：可直接分享/收藏一条"第 N 张照片"的链接
 */
import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'grid', component: () => import('../views/GridView.vue') },
    { path: '/photo/:id', name: 'detail', component: () => import('../views/DetailView.vue') },
  ],
})

export default router
