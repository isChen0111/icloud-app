/**
 * 上传工具（相对路径清洗 + 临时目录管理）单元测试
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeRelPath, importTempDir, newImportSessionId, cleanImportTempDir, cleanStaleImportTemp, resolveMultipartFileSize, parseUploadMtimes, applyUploadMtimes } from './upload.js'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('sanitizeRelPath：保留相对层级并统一正斜杠', () => {
  assert.equal(sanitizeRelPath('2024/三亚/IMG_1.jpg'), '2024/三亚/IMG_1.jpg')
  assert.equal(sanitizeRelPath('a\\b\\c.jpg'), 'a/b/c.jpg')
  assert.equal(sanitizeRelPath('./a/b.jpg'), 'a/b.jpg')
  assert.equal(sanitizeRelPath('IMG_1.HEIC'), 'IMG_1.HEIC')
})

test('sanitizeRelPath：拒绝目录穿越', () => {
  assert.throws(() => sanitizeRelPath('../etc/passwd'))
  assert.throws(() => sanitizeRelPath('a/../../b.jpg'))
})

test('sanitizeRelPath：拒绝绝对路径', () => {
  assert.throws(() => sanitizeRelPath('/etc/passwd'))
  assert.throws(() => sanitizeRelPath('C:/windows/x.jpg'))
  assert.throws(() => sanitizeRelPath('C:\\windows\\x.jpg'))
})

test('sanitizeRelPath：拒绝空路径', () => {
  assert.throws(() => sanitizeRelPath(''))
  assert.throws(() => sanitizeRelPath('.'))
})

test('importTempDir + cleanImportTempDir：创建与清理', async () => {
  const dir = tempDir('import-upload-')
  try {
    const cacheDir = path.join(dir, 'cache')
    const tmp = importTempDir(cacheDir, newImportSessionId())
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'x')
    assert.ok(fs.existsSync(tmp))
    await cleanImportTempDir(tmp)
    assert.ok(!fs.existsSync(tmp))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanStaleImportTemp：只清理超龄残留，保留新鲜目录', async () => {
  const dir = tempDir('import-upload-')
  try {
    const cacheDir = path.join(dir, 'cache')
    const oldDir = importTempDir(cacheDir, 'old')
    const freshDir = importTempDir(cacheDir, 'fresh')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(freshDir, { recursive: true })
    // 把 old 目录的 mtime 改到 48h 前，模拟上次异常退出残留
    const past = new Date(Date.now() - 48 * 3600 * 1000)
    fs.utimesSync(oldDir, past, past)

    await cleanStaleImportTemp(cacheDir)

    assert.ok(!fs.existsSync(oldDir), '超龄残留应被清理')
    assert.ok(fs.existsSync(freshDir), '新鲜目录应保留')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveMultipartFileSize：0（不限）→ Infinity，>0 → 原值', () => {
  // 回归钉住 2026-10-31 的 bug：fileSize 传 undefined 会被 @fastify/multipart
  // 回落到 Fastify bodyLimit（1 MiB），正常照片也报「request file too large」。
  assert.equal(resolveMultipartFileSize(0), Infinity, '0 必须映射成 Infinity，而不是 undefined')
  assert.equal(resolveMultipartFileSize(5_000_000), 5_000_000)
  assert.equal(resolveMultipartFileSize(-1), Infinity, '负数同样视为不限')
})

test('parseUploadMtimes：解析 JSON 并归一化 key，过滤非法值', () => {
  const map = parseUploadMtimes(JSON.stringify({
    '2024/三亚/IMG_1.jpg': 1720000000000,
    'a\\b\\c.jpg': 1730000000000,
    'bad': -1,
    'zero': 0,
    'notnum': 'abc',
  }))
  assert.equal(map['2024/三亚/IMG_1.jpg'], 1720000000000)
  assert.equal(map['a/b/c.jpg'], 1730000000000, '反斜杠 key 应归一化成正斜杠')
  assert.ok(!('bad' in map), '负值应被忽略')
  assert.ok(!('zero' in map), '0 应被忽略')
  assert.ok(!('notnum' in map), '非数字应被忽略')
  assert.deepEqual(parseUploadMtimes(undefined), {}, '缺失 JSON → 空对象')
  assert.deepEqual(parseUploadMtimes('{bad json'), {}, '坏 JSON → 空对象，不抛错')
  assert.deepEqual(parseUploadMtimes('[1,2]'), {}, '非对象 → 空对象')
})

test('applyUploadMtimes：把 lastModified 回设到落盘文件', async () => {
  const dir = tempDir('import-mtime-')
  try {
    const dest = path.join(dir, 'sub', 'IMG_1.jpg')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'x')

    const target = new Date(2016, 2, 12, 12, 59, 5) // 一个明显不是「现在」的时间
    await applyUploadMtimes([{ dest, rel: 'sub/IMG_1.jpg' }], JSON.stringify({ 'sub/IMG_1.jpg': target.getTime() }))

    const st = fs.statSync(dest)
    assert.equal(Math.trunc(st.mtimeMs), Math.trunc(target.getTime()), 'mtime 应被回设为前端传来的 lastModified')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
