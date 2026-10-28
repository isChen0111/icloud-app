/**
 * 照片库路由（P0 单活跃库模型）
 *
 * GET   /api/libraries            ：库列表（account 打码，不泄露完整邮箱）
 * POST  /api/libraries {name}     ：新建库并激活（首次引导「设置库名」步骤）
 * PATCH /api/libraries/:id/active ：切换激活库（热切换：停 watcher → 清队列 → 关 DB
 *                                   → 覆写 config → 重开 DB → 重扫 → 启 watcher）
 *
 * 热切换保证（对应架构文档 §3.2.2）：
 *   1. 同步任务在跑/在等重试时拒绝切换（409），避免 icloudpd 进程写错库目录；
 *   2. 缩略图队列清空 + 进度复位，旧库任务不会串到新库；
 *   3. 现有路由持有 getDb() 代理，切库后自动指向新库连接，零改动。
 */
import type { FastifyInstance } from 'fastify'
import {
  listLibraries,
  getLibraryById,
  createLibrary,
  setActiveLibrary,
  deleteLibrary,
  updateLibraryConfig,
  validateLibraryName,
  type LibraryRow,
} from '../db/libraries.js'
import { applyLibraryPaths, getCurrentLibrary, resetLibraryPaths } from '../context.js'
import { closeDb, getDb } from '../db/index.js'
import { stopWatcher, startWatcher } from '../scanner/watcher.js'
import { runScan, scanProgress } from '../scanner/index.js'
import { clearThumbnailQueue } from '../pipeline/queue.js'
import { isSyncBusy } from '../icloudpd/sync.js'
import { resetSyncState } from '../icloudpd/state.js'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** 只读统计某库 library.db 的照片/视频数（无 DB / 打不开 → 0，不影响列表） */
function countAssets(dbPath: string): { photos: number; videos: number } {
  try {
    if (!fs.existsSync(dbPath)) return { photos: 0, videos: 0 }
    const db = new Database(dbPath, { readonly: true })
    try {
      const rows = db
        .prepare(`SELECT type, COUNT(*) AS c FROM assets GROUP BY type`)
        .all() as { type: string; c: number }[]
      const counts: Record<string, number> = {}
      for (const r of rows) counts[r.type] = r.c
      // 与主页 /api/stats 口径统一：照片数 = 普通照片 + 实况照片（live），视频数不含实况附带视频
      return {
        photos: (counts.photo ?? 0) + (counts.live ?? 0),
        videos: counts.video ?? 0,
      }
    } finally {
      db.close()
    }
  } catch {
    return { photos: 0, videos: 0 }
  }
}

/** 库列表的对外形态（激活标记 + 目录展示；本地单机应用，账号原样返回供完整显示） */
function toPublic(row: LibraryRow) {
  return {
    id: row.id,
    name: row.name,
    account: row.account,
    authStatus: row.auth_status,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
    active: row.active === 1,
    libraryRoot: row.library_root,
    cacheDir: row.cache_dir,
    cookieDir: row.cookie_dir,
    untilFound: row.until_found,
    recentLimit: row.recent_limit,
  }
}

/**
 * 切库 / 删库 / 删照片 守卫：同步任务执行中或照片库扫描进行中 → 返回错误文案（null = 放行）。
 * 抽出为独立函数便于单元测试（审查 P1 在途扫描守卫 + 同步任务守卫）。
 *
 * 'delete-asset' 用于 DELETE /api/assets（R-15/R-16）：扫描在途时删除会与删除对账互相踩
 * （对账基于本轮遍历快照，刚删掉的文件可能被重新插入或被判孤儿），同步在途时 icloudpd
 * 正在写同一目录，所以同样拒绝。
 */
export function libraryBusyGuard(action: 'switch' | 'delete' | 'delete-asset'): string | null {
  if (isSyncBusy()) {
    if (action === 'switch') return '同步任务执行中，请先等待完成或取消后再切换照片库'
    if (action === 'delete-asset') return '同步任务执行中，请先等待完成或取消后再删除照片'
    return '同步任务执行中，请先等待完成或取消后再删除照片库'
  }
  // 在途扫描未完成时拒绝切换/删除（审查 P1）：旧扫描会在切库后继续经 getDb() 代理写入新库，
  // 其删除对账会把新库资产判为孤儿批量删除 → 数据记录被清空/污染
  if (scanProgress.status === 'scanning') {
    if (action === 'switch') return '照片库扫描进行中，请稍候再切换'
    if (action === 'delete-asset') return '照片库扫描进行中，请稍候再删除照片'
    return '照片库扫描进行中，请稍候再删除'
  }
  return null
}

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/libraries', async () => {
    const current = getCurrentLibrary()
    return {
      libraries: listLibraries().map((l) => ({
        ...toPublic(l),
        ...countAssets(path.join(l.cache_dir, 'library.db')),
      })),
      activeId: current?.id ?? null,
    }
  })

  app.post('/api/libraries', async (request, reply) => {
    const body = request.body as { name?: string } | null
    const name = body?.name ?? ''
    const error = validateLibraryName(name)
    if (error) return reply.code(400).send({ error })
    const existing = listLibraries().find((l) => l.name === name.trim())
    if (existing) return reply.code(409).send({ error: '库名已存在' })

    const lib = createLibrary(name)
    // 仅首次建库（无任何库、createLibrary 内部会激活）需要切换上下文启动扫描；
    // 已有激活库时新建库不激活、不切换——主页面/下拉/设置中心的当前库保持不变
    if (lib.active === 1) {
      switchToLibrary(lib.id)
    }
    return reply.code(201).send({
      ok: true,
      library: toPublic(getLibraryById(lib.id)!),
      note: lib.active === 1 ? '已创建并激活；照片墙已切换，浏览器将刷新' : '已创建；当前照片库保持不变',
    })
  })

  app.patch('/api/libraries/:id/active', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    const target = getLibraryById(id)
    if (!target) return reply.code(404).send({ error: '库不存在' })
    if (target.active === 1) return reply.send({ ok: true, activeId: id, unchanged: true })

    const busy = libraryBusyGuard('switch')
    if (busy) return reply.code(409).send({ error: busy })
    switchToLibrary(id)
    return reply.send({ ok: true, activeId: id })
  })

  /**
   * 更新单库同步参数：untilFound（增量：连续 N 个已存在则停，默认 20）
   *                       recentLimit（下载限量，0=全量不限，默认 0）
   * 环境变量 ICLOUDPD_RECENT 已废弃，仅保留在 .env.example 作兼容说明。
   */
  app.patch('/api/libraries/:id/config', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    const target = getLibraryById(id)
    if (!target) return reply.code(404).send({ error: '库不存在' })
    const body = (request.body ?? {}) as { untilFound?: number; recentLimit?: number }
    updateLibraryConfig(id, {
      untilFound: body.untilFound,
      recentLimit: body.recentLimit,
    })
    const updated = getLibraryById(id)!
    return reply.send({ ok: true, config: { untilFound: updated.until_found, recentLimit: updated.recent_limit } })
  })

  /**
   * 删除照片库（仅本地：注册 + 缓存；勾选时连同本地已下载照片副本一起删。云端 iCloud 不受影响）
   *
   * 删除范围说明（安全边界，用户确认弹窗同文案）：
   *   - 永远删除：meta.db 库注册 + server/cache/lib<id>（缩略图/library.db/stats/cookies 会话）
   *   - 可选删除（removePhotos=true）：iCloudPhoto/lib<id> 本地照片副本；云端原片不动
   *   - 绝不调用 icloudpd 删除类命令
   *
   * 约束：
   *   - 同步任务执行中 → 409（防止删到正在写入的目录）
   *   - 删除当前激活库 → 自动切到剩余库（id 最小）；删最后一个 → 回到无库状态（前端整页刷新走首次引导）
   */
  app.delete('/api/libraries/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    const lib = getLibraryById(id)
    if (!lib) return reply.code(404).send({ error: '库不存在' })

    const busy = libraryBusyGuard('delete')
    if (busy) return reply.code(409).send({ error: busy })
    // 走到这里必然无运行中任务；删除后清全局同步状态残留
    resetSyncState()

    const body = request.body as { removePhotos?: boolean } | null
    const removePhotos = body?.removePhotos === true
    const isActive = lib.active === 1

    // 删除激活库：先停 watcher / 清缩略图队列 / 关库 DB，避免删到打开的文件
    if (isActive) {
      stopWatcher()
      clearThumbnailQueue()
      closeDb()
    }

    // 缓存目录（注册表记录 + 缩略图/DB/cookies）永远删。
    // 用异步 rm（libuv 线程池）而非 rmSync：大目录（缩略图可数十 GB）同步删除会阻塞事件循环，
    // 期间整个服务无响应（审查 P2）
    await fsp.rm(lib.cache_dir, { recursive: true, force: true })
    // 本地照片副本：仅勾选时删（云端原片不动）
    if (removePhotos) {
      await fsp.rm(lib.library_root, { recursive: true, force: true })
    } else {
      // 未勾选时：照片根若是建库预建的空目录（2026-10-28 起建库会预建），顺手清掉避免留空壳。
      // 用 rmdir（非递归）而不是 rm：目录里还有照片时必然抛 ENOTEMPTY，
      // 正好保证这条清理逻辑永远不会误删任何照片。
      try {
        await fsp.rmdir(lib.library_root)
      } catch {
        // 非空（有照片）或本就不存在 → 保持原样
      }
    }
    // 移除注册
    deleteLibrary(id)

    if (isActive) {
      const remaining = listLibraries()
      if (remaining.length > 0) {
        const next = remaining[0]
        setActiveLibrary(next.id)
        applyLibraryPaths(next)
        getDb()
        void runScan('switch').catch((err) => {
          scanProgress.status = 'error'
          scanProgress.message = (err as Error).message
          console.error(`[libraries] 删除后切换扫描失败: ${(err as Error).message}`)
        })
        startWatcher()
        console.log(`[libraries] 已删除照片库 ${lib.name}，切换激活库: ${next.name}`)
        return reply.send({ ok: true, activeId: next.id, remaining: remaining.length })
      }
      // 最后一个库：回到无库状态（config 路径重置为默认，前端整页刷新 → 首次引导）
      resetLibraryPaths()
      console.log(`[libraries] 已删除最后一个照片库 ${lib.name}，回到无库状态`)
      return reply.send({ ok: true, activeId: null, remaining: 0 })
    }

    console.log(`[libraries] 已删除照片库 ${lib.name}`)
    return reply.send({ ok: true, activeId: getCurrentLibrary()?.id ?? null, remaining: listLibraries().length })
  })

  /**
   * 热切换激活库（共用逻辑）：
   * 停 watcher → 清缩略图队列 → 关旧 DB → 覆写 config → 重开新 DB → 增量扫描 → 启 watcher
   */
  function switchToLibrary(id: number): void {
    stopWatcher()
    clearThumbnailQueue()
    closeDb()
    // 切库后同步状态复位（全局单例；否则新库 stats 会残留旧库的「同步完成/已下载 N 项」文案）
    resetSyncState()

    const lib = setActiveLibrary(id)
    applyLibraryPaths(lib)

    // 重开新库连接（建表/迁移），启动新库增量扫描
    getDb()
    void runScan('switch').catch((err) => {
      scanProgress.status = 'error'
      scanProgress.message = (err as Error).message
      console.error(`[libraries] 切换后扫描失败: ${(err as Error).message}`)
    })
    startWatcher()
    console.log(`[libraries] 已切换激活库: ${lib.name} (${lib.library_root})`)
  }
}
