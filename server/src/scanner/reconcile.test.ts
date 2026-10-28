/**
 * 删除对账保护单元测试（审查 R-03）
 *
 * 背景：扫描的⑤「删除对账」会把 DB 里存在、但本轮遍历没见到的资产判为孤儿并删除
 * （连带 FTS 索引、缩略图缓存、用户的忽略状态）。历史上这条路径有两个漏洞：
 *   ① 单文件 stat 失败被静默 continue，该文件既没进 assetPaths、也没被排除 → 误删
 *   ② 符号链接 / 目录联接既不递归也不报错 → 其下资产全部被误删
 *
 * 本测试锁定两条不变量：
 *   - 无法确认存在性的路径（stat 失败）永远不判孤儿
 *   - 遍历不完整（readdir 失败 / 链接目录）时整轮不对账
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectOrphanIds, walkDir } from './index.js'

test('collectOrphanIds：确认消失的资产 → 判为孤儿', () => {
  const dbRows = [
    { id: 1, file_path: '2024/09/01/IMG_1.HEIC' },
    { id: 2, file_path: '2024/09/01/IMG_2.HEIC' },
  ]
  const assetPaths = new Set(['2024/09/01/IMG_1.HEIC'])
  assert.deepEqual(collectOrphanIds(dbRows, assetPaths, new Set(), true), [2])
})

test('collectOrphanIds：stat 失败的文件不判孤儿（R-03 核心）', () => {
  const dbRows = [{ id: 7, file_path: '2024/09/02/IMG_7.HEIC' }]
  // 本轮遍历没见到它（stat 失败被跳过），但它在白名单里 → 必须保留
  assert.deepEqual(
    collectOrphanIds(dbRows, new Set(), new Set(['2024/09/02/IMG_7.HEIC']), true),
    [],
  )
})

test('collectOrphanIds：遍历不完整（enabled=false）→ 一个都不删', () => {
  const dbRows = [{ id: 3, file_path: '2024/09/03/IMG_3.HEIC' }]
  assert.deepEqual(collectOrphanIds(dbRows, new Set(), new Set(), false), [])
})

test('collectOrphanIds：白名单只影响自己，不影响其他孤儿判定', () => {
  const dbRows = [
    { id: 1, file_path: 'a.HEIC' }, // stat 失败 → 保留
    { id: 2, file_path: 'b.HEIC' }, // 确认消失 → 删
  ]
  assert.deepEqual(collectOrphanIds(dbRows, new Set(), new Set(['a.HEIC']), true), [2])
})

test('walkDir：普通目录递归收录媒体文件，无 error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-walk-'))
  try {
    fs.mkdirSync(path.join(root, '2024', '09', '01'), { recursive: true })
    fs.writeFileSync(path.join(root, '2024', '09', '01', 'IMG_1.HEIC'), 'x')
    const r = await walkDir(root)
    assert.equal(r.errors.length, 0)
    assert.equal(r.files.length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('walkDir：指向目录的链接计入 errors（不静默跳过）', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-link-'))
  const target = path.join(root, 'real')
  const link = path.join(root, 'linked')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'IMG_2.HEIC'), 'x')
  try {
    // Windows 用 junction（普通用户即可创建）；其他平台用普通目录符号链接
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    try { fs.unlinkSync(link) } catch { /* 链接未创建成功 */ }
    fs.rmSync(root, { recursive: true, force: true })
    t.skip('当前环境无创建符号链接的权限')
    return
  }
  try {
    const r = await walkDir(root)
    // 不跟随链接（避免环路/越界），但必须报「遍历不完整」→ 本轮跳过删除对账
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /symbolic link/)
    // 链接本身不递归，只收录真实目录下的文件
    assert.equal(r.files.length, 1)
  } finally {
    // 先断开链接再删目录：某些平台递归删除会跟随目录链接
    try { fs.unlinkSync(link) } catch { /* 已不存在 */ }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('walkDir：遍历期间让出事件循环（R-19）', async () => {
  // 旧实现全同步（readdirSync），整库遍历期间定时器/HTTP 请求都排不上队：
  // 启动时端口还没 listen，前端表现为「后端没起来」。
  // 造足够多的目录，让「定时器能否在遍历结束前跑到」成为可判定的事实。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-yield-'))
  try {
    for (let i = 0; i < 120; i++) {
      const d = path.join(root, `${2024 + (i % 2)}`, String((i % 12) + 1).padStart(2, '0'), String((i % 28) + 1).padStart(2, '0'), `sub${i}`)
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, `IMG_${i}.HEIC`), 'x')
    }
    let timerFired = false
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        timerFired = true
        resolve()
      }, 0),
    )
    const walk = walkDir(root)
    const r = await walk
    // 关键：必须在 await walk 之后、await timer 之前取样——
    // 先等 timer 再断言的话它必然为 true，测不出任何东西。
    const firedBeforeWalkDone = timerFired
    await timer
    assert.equal(r.files.length, 120)
    assert.equal(firedBeforeWalkDone, true, '遍历必须让出事件循环，不能独占主线程')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
