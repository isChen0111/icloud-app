/**
 * 服务入口
 *
 * 启动流程：
 *   ① 初始化数据库（建表）
 *   ② 注册全部 API 路由
 *   ③ 每次启动都触发后台全量增量同步（缩略图懒生成，不阻塞启动）
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
import { ensureDefaultLibrary, getMetaDb } from './db/libraries.js'
import { applyLibraryPaths } from './context.js'
import { registerAssetRoutes } from './routes/assets.js'
import { registerThumbRoutes } from './routes/thumb.js'
import { registerVideoRoutes } from './routes/video.js'
import { registerStatsRoutes } from './routes/stats.js'
import { registerSearchRoutes } from './routes/search.js'
import { registerInfoRoutes } from './routes/info.js'
import { registerThumbnailErrorRoutes } from './routes/thumbnail-errors.js'
import { registerLibraryRoutes } from './routes/libraries.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerSyncRoutes } from './routes/sync.js'
import { runScan, scanProgress } from './scanner/index.js'
import { startWatcher } from './scanner/watcher.js'
import { cleanStaleTempFiles } from './pipeline/thumbnails.js'

/** 项目根目录（server/src/../..） */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function main(): Promise<void> {
  // ① 库注册表初始化（meta.db）；有激活库则覆写全局 config 为该库路径
  //    （现有模块零改动复用）；无库 → 前端进入首次引导，不隐式建库。
  getMetaDb()
  const lib = ensureDefaultLibrary()
  if (lib) {
    applyLibraryPaths(lib)
    console.log(`[libraries] 激活库: ${lib.name} (${lib.library_root})`)

    // ② 数据库初始化（激活库的 library.db，建表）
    getDb()
    cleanStaleTempFiles()
  } else {
    console.log('[libraries] 无照片库，等待首次引导创建（主页将显示引导流程）')
  }

  const app = Fastify({ logger: true })

  // 仅允许本机 Vite 开发服务器跨源访问（dev 模式经 Vite 代理转发：浏览器 Origin 是 5173，
  // 而 changeOrigin 已把 Host 改写为后端 8899，两者不同源，必须靠白名单）。
  // 生产模式（后端静态托管）走同源判定：Origin 的 host 与请求 Host 一致即放行
  // （127.0.0.1 / localhost / 局域网 IP / 域名均可，无需维护白名单）。
  const devOrigins = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://[::1]:5173',
  ])
  /** 同源判定：Origin 与请求 Host 的 hostname + 端口一致（经 URL 规范化，默认端口 80/443 自动等价） */
  function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
    if (!origin || !host) return false
    try {
      const o = new URL(origin)
      const h = new URL(`http://${host}`)
      return o.hostname.toLowerCase() === h.hostname.toLowerCase() && o.port === h.port
    } catch {
      return false
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    const allowed = origin !== undefined && (devOrigins.has(origin) || isSameOrigin(origin, request.headers.host))
    if (allowed) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Range')
      reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    }
    if (request.method === 'OPTIONS') {
      return reply.code(allowed ? 204 : 403).send()
    }
    // 副作用请求（非 GET/HEAD）带非允许 Origin → 403。
    // 威胁模型 = 恶意网页跨站调用本机 API（删照片/触发扫描/操作失败项）；
    // 跨站必有 Origin，且其 host 与本机 Host 不一致 → 拒绝。
    // curl / 本地脚本 / 无 Origin 的直连 → 放行（浏览器外无跨站 Origin 语义）。
    if (origin !== undefined && !allowed && !['GET', 'HEAD'].includes(request.method)) {
      return reply.code(403).send({ error: 'forbidden origin' })
    }
  })

  // ② 路由
  await registerAssetRoutes(app)
  await registerThumbRoutes(app)
  await registerVideoRoutes(app)
  await registerStatsRoutes(app)
  await registerSearchRoutes(app)
  await registerInfoRoutes(app)
  await registerThumbnailErrorRoutes(app)
  await registerLibraryRoutes(app)
  await registerAuthRoutes(app)
  await registerSyncRoutes(app)

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
  //    不 await、不阻塞启动；前端轮询 /api/stats 获取状态并在结束时刷新照片墙。
  //    无库时不启动（引导流程建库后再扫描）。
  if (lib) {
    void runScan('startup').catch((err) => {
      scanProgress.status = 'error'
      scanProgress.message = (err as Error).message
      app.log.error(`启动同步失败: ${(err as Error).message}`)
    })
  }
  // ④ 启动（监听地址可配置：默认 0.0.0.0 局域网可访问；设 HOST=127.0.0.1 仅本机）
  await app.listen({ port: config.port, host: config.host })
  app.log.info(`📸 本地 iCloud 照片浏览器后端已启动`)
  app.log.info(`   照片库: ${config.libraryRoot}`)
  app.log.info(`   数据库: ${config.dbPath}`)
  app.log.info(`   API:    http://127.0.0.1:${config.port}/api/stats`)

  // ⑤ 目录热监听（P2+-1）：手动拷入/删除/重命名文件 → 自动触发同步
  if (lib) startWatcher()
}

main().catch((err) => {
  console.error('启动失败:', err)
  process.exit(1)
})
