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
import { config } from './config.js'
import { getDb } from './db/index.js'
import { registerAssetRoutes } from './routes/assets.js'
import { registerThumbRoutes } from './routes/thumb.js'
import { registerVideoRoutes } from './routes/video.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerSearchRoutes } from './routes/search.js'
import { runScan, scanProgress } from './scanner/index.js'

async function main(): Promise<void> {
  // ① 数据库初始化（建表）
  getDb()

  const app = Fastify({ logger: true })

  // 开发期 CORS：前端 Vite 跑在 5173，后端 8899，允许任意源直连
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Range')
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  })

  // ② 路由
  await registerAssetRoutes(app)
  await registerThumbRoutes(app)
  await registerVideoRoutes(app)
  await registerStatsRoutes(app)
  await registerSearchRoutes(app)

  // ③ 首次启动自动扫描（幂等：已有数据则直接跳过）
  const { c } = getDb().prepare(`SELECT COUNT(*) AS c FROM assets`).get() as { c: number }
  if (c === 0) {
    app.log.info('库为空，启动后台扫描…')
    void runScan().catch((err) => {
      scanProgress.status = 'error'
      scanProgress.message = (err as Error).message
      app.log.error(`扫描失败: ${(err as Error).message}`)
    })
  }

  // ④ 启动
  await app.listen({ port: config.port, host: '127.0.0.1' })
  app.log.info(`📸 本地 iCloud 照片浏览器后端已启动`)
  app.log.info(`   照片库: ${config.libraryRoot}`)
  app.log.info(`   数据库: ${config.dbPath}`)
  app.log.info(`   API:    http://127.0.0.1:${config.port}/api/stats`)
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
