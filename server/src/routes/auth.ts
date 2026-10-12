/**
 * iCloud 认证路由（网页端自绘面板 + 后端桥接 icloudpd 内嵌 webui 服务）
 *
 * POST /api/auth {libraryId, username} ：启动认证进程（auth-only）
 * POST /api/auth/input {value}          ：提交密码 / 验证码（经本机回环 HTTP 转交 icloudpd）
 * GET  /api/auth                        ：查询当前认证状态（前端轮询）
 * POST /api/auth/cancel                 ：取消认证
 *
 * 安全：密码/验证码只经 127.0.0.1 回环进入 icloudpd 内存；不写日志、不落盘、不做任何持久化。
 */
import type { FastifyInstance } from 'fastify'
import { getLibraryById, updateLibraryAuth } from '../db/libraries.js'
import { startAuth, sendAuthInput, authStatus, stopAuth } from '../icloudpd/auth.js'

/** 当前认证会话对应的库（认证完成时把库状态落为已认证） */
let authLibraryId: number | null = null

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth', async (request, reply) => {
    const body = request.body as { libraryId?: number; username?: string } | null
    const libraryId = Number(body?.libraryId ?? 0)
    const username = (body?.username ?? '').trim()
    if (!Number.isInteger(libraryId) || libraryId <= 0) return reply.code(400).send({ error: 'libraryId 无效' })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) return reply.code(400).send({ error: '邮箱格式不正确' })

    const lib = getLibraryById(libraryId)
    if (!lib) return reply.code(404).send({ error: '库不存在' })

    const session = startAuth(username, lib.cookie_dir)
    if (session.stage === 'error') {
      return reply.code(500).send({ error: session.message })
    }
    authLibraryId = lib.id
    // 记录账号（认证中/成功均保留，供下载与巡检使用）。
    // 注意：开始认证不重置 auth_status——「刷新链接」的库应保持原「已链接/过期」显示，
    //       只有认证完成 → authed、同步遇 cookie 失效 → expired 才写入，避免取消/失败把状态打回未链接。
    updateLibraryAuth(lib.id, { account: username })
    return reply.send({ ok: true, auth: session })
  })

  app.post('/api/auth/input', async (request, reply) => {
    const body = request.body as { value?: string } | null
    const value = body?.value ?? ''
    if (!value) return reply.code(400).send({ error: '输入不能为空' })
    const session = await sendAuthInput(value)
    if (!session) return reply.code(409).send({ error: '没有进行中的认证会话' })
    return reply.send({ ok: true, auth: session })
  })

  app.get('/api/auth', async () => {
    const session = authStatus()
    // 认证完成（cookie 落盘、进程退出）→ 把库状态落为已认证
    if (session?.stage === 'done' && authLibraryId !== null) {
      updateLibraryAuth(authLibraryId, { auth_status: 'authed' })
      authLibraryId = null
    }
    return { auth: session }
  })

  app.post('/api/auth/cancel', async () => {
    authLibraryId = null
    stopAuth()
    return { ok: true }
  })
}
