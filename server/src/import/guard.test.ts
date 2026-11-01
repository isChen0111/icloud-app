/**
 * 导入源目录守卫单测
 *
 * 造一棵真实的临时库结构（库根 + icloud/ + import/ + 库外缓存 + 库外源目录），
 * 逐条验证三类必拦输入与合法输入，避免「守卫写反了把正常目录也拦住」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkImportSource } from './guard.js'

interface Env {
  root: string
  lib: string
  cache: string
  outside: string
}

function setup(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-guard-'))
  const lib = path.join(root, 'iCloudPhoto', 'lib7')
  fs.mkdirSync(path.join(lib, 'icloud', '2024', '09', '13'), { recursive: true })
  fs.mkdirSync(path.join(lib, 'import', '2024', '09', '14'), { recursive: true })
  const cache = path.join(root, 'cache', 'lib7')
  fs.mkdirSync(path.join(cache, 'thumbs'), { recursive: true })
  const outside = path.join(root, '我的照片')
  fs.mkdirSync(path.join(outside, '旅行'), { recursive: true })
  return { root, lib, cache, outside }
}

test('checkImportSource：拒绝库根、库内子目录、包含库的上层目录', () => {
  const env = setup()
  try {
    const reject = (src: string, hint: string) => {
      const r = checkImportSource(src, { libraryRoot: env.lib, cacheDir: env.cache })
      assert.equal(r.ok, false, `应当拒绝：${src}`)
      assert.ok(
        !r.ok && r.reason.includes(hint),
        `拒绝理由应包含「${hint}」，实际：${!r.ok ? r.reason : '(放行)'}`,
      )
    }

    reject(env.lib, '照片库自己的目录')
    reject(path.join(env.lib, 'icloud'), '内部的目录')
    reject(path.join(env.lib, 'import'), '内部的目录')
    reject(path.join(env.lib, 'icloud', '2024', '09', '13'), '内部的目录')
    // 库的父目录（= 含库根的上层）
    reject(path.join(env.root, 'iCloudPhoto'), '包含当前照片库')
    reject(env.root, '包含当前照片库')
    // 缓存目录：里面全是缩略图，导进去会被当成照片
    reject(env.cache, '缓存目录')
    reject(path.join(env.cache, 'thumbs'), '缓存目录')
    reject(path.join(env.root, 'cache'), '包含应用的缓存目录')
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true })
  }
})

test('checkImportSource：拒绝盘符根与不存在的路径', () => {
  const env = setup()
  try {
    // 当前系统盘根（Windows 为 C:\，类 Unix 为 /），跨平台取法
    const diskRoot = path.parse(env.root).root
    const r = checkImportSource(diskRoot, { libraryRoot: env.lib, cacheDir: env.cache })
    assert.equal(r.ok, false, '盘符根必须拒绝')
    assert.ok(!r.ok && r.reason.includes('整个磁盘'))

    const missing = path.join(env.root, '不存在的目录')
    const m = checkImportSource(missing, { libraryRoot: env.lib, cacheDir: env.cache })
    assert.equal(m.ok, false, '不存在的路径必须拒绝')
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true })
  }
})

test('checkImportSource：放行库外目录（含库的兄弟目录与完全无关的路径）', () => {
  const env = setup()
  try {
    // 用户真实的源目录形态：库外、结构任意
    const ok1 = checkImportSource(env.outside, { libraryRoot: env.lib, cacheDir: env.cache })
    assert.equal(ok1.ok, true, `应放行库外目录，实际拒绝：${!ok1.ok ? ok1.reason : ''}`)

    const ok2 = checkImportSource(path.join(env.outside, '旅行'), {
      libraryRoot: env.lib,
      cacheDir: env.cache,
    })
    assert.equal(ok2.ok, true, '应放行库外子目录')

    // 库的兄弟目录（与库根同级、不在库内）
    const sibling = path.join(env.root, 'iCloudPhoto', 'backup')
    fs.mkdirSync(sibling, { recursive: true })
    const ok3 = checkImportSource(sibling, { libraryRoot: env.lib, cacheDir: env.cache })
    assert.equal(ok3.ok, true, '应放行与库根同级的兄弟目录')
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true })
  }
})

test('checkImportSource：Windows 下大小写不同仍按同一路径判定', (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows 路径大小写不敏感')
  const env = setup()
  try {
    const upper = env.lib.toUpperCase()
    const r = checkImportSource(upper, { libraryRoot: env.lib, cacheDir: env.cache })
    assert.equal(r.ok, false, '同一路径的大写写法必须被识别为库根')
    assert.ok(!r.ok && r.reason.includes('照片库自己的目录'))
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true })
  }
})

test('checkImportSource：符号链接指向库内时必须拒绝（不能靠 junction 绕过）', (t) => {
  const env = setup()
  try {
    const link = path.join(env.root, '看起来在库外的链接')
    try {
      // Windows 建目录联接不需要管理员权限（符号链接需要）；Node 的 type 参数在
      // Windows 上会被映射成 junction
      fs.symlinkSync(env.lib, link, 'junction')
    } catch {
      return t.skip('当前环境无法创建目录联接/符号链接')
    }
    const r = checkImportSource(link, { libraryRoot: env.lib, cacheDir: env.cache })
    assert.equal(r.ok, false, '链接指向库根，realpath 后应判定为同一目录')
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true })
  }
})
