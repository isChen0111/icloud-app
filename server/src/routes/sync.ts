/**
 * 照片库同步路由（全量拉取 / 增量同步）
 *
 * POST   /api/library/:id/sync {kind:'full'|'inc'} ：启动同步任务
 * GET    /api/library/:id/sync                     ：任务状态（前端轮询）
 * DELETE /api/library/:id/sync                     ：取消任务
 *
 * 约束（P0 单活跃库 + 全局单任务）：
 *   - 只允许对当前激活库发起同步（避免进程写非激活库目录）；
 *   - 同一时间只有一个同步任务（其他库发起返回 409，前端显示「排队中」由 UI 层处理）。
 */
import type { FastifyInstance } from 'fastify'
import { getLibraryById } from '../db/libraries.js'
import { getCurrentLibrary } from '../context.js'
import { startSync, cancelSync } from '../icloudpd/sync.js'
import { syncState, type SyncTaskState } from '../icloudpd/state.js'

/** 状态对外形态（不含 pid 等内部字段） */
function publicState(state: SyncTaskState) {
  return {
    status: state.status,
    libraryId: state.libraryId,
    kind: state.kind,
    message: state.message,
    downloaded: state.downloaded,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  }
}

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/library/:id/sync', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const body = request.body as { kind?: string } | null
    const kind = body?.kind === 'inc' ? 'inc' : 'full'
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })

    const lib = getLibraryById(id)
    if (!lib) return reply.code(404).send({ error: '库不存在' })
    const current = getCurrentLibrary()
    if (current?.id !== id) {
      return reply.code(409).send({ error: '只能对当前激活库执行同步，请先切换到该库' })
    }

    const result = startSync(lib, kind)
    if (!result.ok) return reply.code(409).send({ error: result.message })
    return reply.send({ ok: true, sync: publicState(syncState) })
  })

  app.get('/api/library/:id/sync', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    return reply.send({ sync: publicState(syncState) })
  })

  app.delete('/api/library/:id/sync', async (_request, reply) => {
    cancelSync()
    return reply.send({ ok: true, sync: publicState(syncState) })
  })
}
