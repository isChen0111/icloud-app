/**
 * 导入本地照片目录路由
 *
 * POST   /api/libraries/:id/import/scan   ：本机迁移（后端运行机器的本地目录）
 * POST   /api/libraries/:id/import/upload ：上传（其他设备整文件夹上传，multipart）
 * GET    /api/libraries/:id/import        ：查询导入进度（前端经 tasks store 的 /api/stats 轮询）
 * DELETE /api/libraries/:id/import        ：请求取消导入（只置信号，终态由流水线写回）
 *
 * 约束（与 sync 一致，P0 单活跃库 + 全局单任务）：
 *   - 只允许对当前激活库导入（runScan 只能扫激活库）；
 *   - 同步/扫描在途时拒绝启动导入；已有导入在跑时拒绝再次启动。
 */
import type { FastifyInstance } from 'fastify'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { getLibraryById } from '../db/libraries.js'
import { getCurrentLibrary } from '../context.js'
import { startLocalImport, startUploadImport, cancelImport } from '../import/index.js'
import { isImportBusy, publicImportState } from '../import/state.js'
import { isSyncBusy } from '../icloudpd/sync.js'
import { scanProgress } from '../scanner/index.js'
import { importTempDir, newImportSessionId, sanitizeRelPath, cleanImportTempDir, applyUploadMtimes } from '../import/upload.js'
import { checkImportSource } from '../import/guard.js'

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  /** 校验目标库存在且为当前激活库；返回 null=放行，否则返回错误响应文案 */
  function resolveActiveLib(id: number): { error?: string; lib?: ReturnType<typeof getLibraryById> } {
    const lib = getLibraryById(id)
    if (!lib) return { error: '库不存在' }
    const current = getCurrentLibrary()
    if (current?.id !== id) return { error: '只能对当前激活库导入，请先切换到该库' }
    return { lib }
  }

  /** 同步/扫描在途守卫（导入本身是否在跑由 startLocalImport/startUploadImport 判断） */
  function inFlightGuard(): string | null {
    if (isSyncBusy()) return '同步任务执行中，请先等待完成或取消后再导入'
    if (scanProgress.status === 'scanning') return '照片库扫描进行中，请稍候再导入'
    return null
  }

  app.post('/api/libraries/:id/import/scan', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    const resolved = resolveActiveLib(id)
    if (resolved.error) return reply.code(resolved.error === '库不存在' ? 404 : 409).send({ error: resolved.error })

    const body = request.body as { path?: string; mode?: string } | null
    const sourceDir = body?.path?.trim()
    if (!sourceDir) return reply.code(400).send({ error: '请提供要导入的目录路径' })
    const mode = body?.mode === 'move' ? 'move' : 'copy'

    // 校验目录存在且确实是目录（本机迁移是后端直读文件系统）
    let st: fs.Stats
    try {
      st = fs.statSync(sourceDir)
    } catch {
      return reply.code(400).send({ error: '目录不存在或不可读' })
    }
    if (!st.isDirectory()) return reply.code(400).send({ error: '路径不是目录' })

    // 目录守卫：拒绝库根、库内子目录、包含库根的上层目录、盘符根、缓存目录。
    // 放在 stat 之后（此时路径已确定存在，realpath 不会抛）、启动之前（不在写入后才失败）。
    const guard = checkImportSource(sourceDir, {
      libraryRoot: resolved.lib!.library_root,
      cacheDir: resolved.lib!.cache_dir,
    })
    if (!guard.ok) return reply.code(400).send({ error: guard.reason })

    const busy = inFlightGuard()
    if (busy) return reply.code(409).send({ error: busy })

    const result = startLocalImport(resolved.lib!, sourceDir, mode)
    if (!result.ok) return reply.code(409).send({ error: result.message })
    return reply.send({ ok: true, import: publicImportState() })
  })

  app.post('/api/libraries/:id/import/upload', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    const resolved = resolveActiveLib(id)
    if (resolved.error) return reply.code(resolved.error === '库不存在' ? 404 : 409).send({ error: resolved.error })
    if (!request.isMultipart()) return reply.code(400).send({ error: '需要 multipart 上传' })

    const busy = inFlightGuard()
    if (busy) return reply.code(409).send({ error: busy })
    if (isImportBusy()) return reply.code(409).send({ error: '已有导入任务执行中，请等待完成或取消' })

    const lib = resolved.lib!
    const tmpDir = importTempDir(lib.cache_dir, newImportSessionId())
    await fsp.mkdir(tmpDir, { recursive: true })

    // 流式写盘：逐 part 写进临时目录，保留 webkitRelativePath 相对路径；pipeline 背压不爆内存。
    // 同时收集前端附带的时间戳字段（mtimes JSON）与落盘清单，写完后统一回设 mtime。
    let received = 0
    let mtimesJson: string | undefined
    const written: { dest: string; rel: string }[] = []
    /**
     * 单 part 失败不再中断整批（审查 C-11）：5000 张里 1 个文件写失败，不能让已经传完的
     * 几个 GB 白费（旧实现在 catch 里连临时目录一起删掉，用户只能从头再传）。
     * 注：协议层错误（超出总大小限制、连接中断）仍会终止整个请求，那一层不在这里兜。
     */
    const failures: { relPath: string; reason: string }[] = []
    try {
      const parts = request.parts()
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'mtimes') mtimesJson = String(part.value ?? '')
          continue
        }
        if (part.type !== 'file') continue
        try {
          const rel = sanitizeRelPath(part.filename)
          const dest = path.join(tmpDir, rel)
          await fsp.mkdir(path.dirname(dest), { recursive: true })
          await pipeline(part.file, createWriteStream(dest))
          written.push({ dest, rel })
          received++
        } catch (err) {
          failures.push({ relPath: part.filename, reason: (err as Error).message })
        }
      }
    } catch (err) {
      await cleanImportTempDir(tmpDir)
      return reply.code(400).send({ error: `上传失败：${(err as Error).message}` })
    }
    if (received === 0) {
      await cleanImportTempDir(tmpDir)
      const first = failures[0]?.reason
      return reply.code(400).send({ error: first ? `上传失败：${first}` : '未收到任何文件' })
    }
    if (failures.length > 0) {
      console.warn(`[import] 上传阶段 ${failures.length} 个文件失败，其余 ${received} 个继续导入`)
    }

    // 回设 mtime：无 EXIF 日期的文件若只靠「上传时刻」兜底，会被归到上传当天（日期错）。
    // 解析失败/缺失不影响主流程，仅退化为上传时刻兜底。
    try {
      await applyUploadMtimes(written, mtimesJson)
    } catch (err) {
      console.warn('[import] 上传时间戳回设失败:', (err as Error).message)
    }

    const result = startUploadImport(lib, tmpDir, failures)
    if (!result.ok) {
      await cleanImportTempDir(tmpDir)
      return reply.code(409).send({ error: result.message })
    }
    return reply.send({ ok: true, import: publicImportState(), failures })
  })

  app.get('/api/libraries/:id/import', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' })
    return reply.send({ import: publicImportState() })
  })

  app.delete('/api/libraries/:id/import', async (_request, reply) => {
    // 落库阶段不受理取消（C-06）：文件已归置完，中途退只会留下一半入库的照片。
    // 返回 409 让前端把按钮收起来，而不是「点了没反应」。
    if (!cancelImport()) {
      const state = publicImportState()
      const error =
        state.status === 'running' && state.phase === 'scanning'
          ? '文件已导入完成，正在入库，无需取消'
          : '没有正在执行的导入任务'
      return reply.code(409).send({ error, import: state })
    }
    return reply.send({ ok: true, import: publicImportState() })
  })
}
