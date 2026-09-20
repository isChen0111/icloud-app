/**
 * 服务入口
 *
 * 启动流程：
 *   ① 初始化数据库（建表）
 *   ② 注册全部 API 路由
 *   ③ 若库为空 → 自动触发后台全量扫描（缩略图懒生成，不阻塞启动）
 *   ④ 打印访问地址
 *
 * 学习提示：Fastify 5 的插件式组织 —— 每个路由文件是一个 register 函数，
 * 在这里统一挂载，互不依赖。
 */
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { getDb } from './db/index.js'
import { registerAssetRoutes } from './routes/assets.js'
import { registerThumbRoutes } from './routes/thumb.js'
import { registerVideoRoutes } from './routes/video.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerInfoRoutes } from './routes/info.js'
import { runScan, scanProgress } from './scanner/index.js'
import { startWatcher } from './scanner/watcher.js'

/** 项目根目录（server/src/../..） */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function main(): Promise<void> {
  // ① 数据库初始化（建表）
  getDb()

  const app = Fastify({ logger: true })

  // 开发期 CORS：前端 Vite 跑在 5173，后端 8899，允许任意源直连
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Range')
    reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  })

  // ② 路由
  await registerAssetRoutes(app)
  await registerThumbRoutes(app)
  await registerVideoRoutes(app)
  await registerStatsRoutes(app)
  await registerSearchRoutes(app)
  await registerInfoRoutes(app)

  // ②.5 生产模式静态托管：若 web/dist 存在（已 build），把前端挂到根路径。
  //     开发模式下没有 dist，走 Vite 5173 + proxy，不影响。
  const distDir = path.join(projectRoot, 'web', 'dist')
  if (fs.existsSync(distDir)) {
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
    })
    app.log.info(`   前端:    http://127.0.0.1:${config.port}/`)
  }

  // ③ 启动后台全量同步（P2+-1）：幂等增量，新增入库 + 删除对账 + 配对修正。
  //    不 await、不阻塞启动；前端轮询 /api/stats 可见进度。
  void runScan('startup').catch((err) => {
    scanProgress.status = 'error'
    scanProgress.message = (err as Error).message
    app.log.error(`启动同步失败: ${(err as Error).message}`)
  })
  // ④ 启动
  await app.listen({ port: config.port, host: '127.0.0.1' })
  app.log.info(`📸 本地 iCloud 照片浏览器后端已启动`)
  app.log.info(`   照片库: ${config.libraryRoot}`)
  app.log.info(`   数据库: ${config.dbPath}`)
  app.log.info(`   API:    http://127.0.0.1:${config.port}/api/stats`)

  // ⑤ 目录热监听（P2+-1）：手动拷入/删除/重命名文件 → 自动触发同步
  startWatcher()
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
