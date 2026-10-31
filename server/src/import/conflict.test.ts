/**
 * 目标目录计算 + 同名冲突处理 单元测试
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dateToDir, pickTargetName } from './conflict.js'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('dateToDir：ISO8601 → YYYY/MM/DD 目录段', () => {
  assert.equal(dateToDir('2026-10-25T16:47:15+08:00'), '2026/10/25')
  assert.equal(dateToDir('2024-01-03T00:00:00Z'), '2024/01/03')
})

test('pickTargetName：目标不存在 → 直接用原名', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import')
    const r = pickTargetName(root, '2026/10/25', 'IMG_1.HEIC', 100, 1000)
    assert.equal(r.skipped, false)
    assert.equal(path.basename(r.targetPath), 'IMG_1.HEIC')
    assert.ok(r.targetPath.endsWith(path.join('import', '2026', '10', '25', 'IMG_1.HEIC')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：目标已存在同 size+mtime → 跳过（视为已导入）', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2026', '10', '25')
    fs.mkdirSync(root, { recursive: true })
    const existing = path.join(root, 'IMG_1.HEIC')
    fs.writeFileSync(existing, 'x'.repeat(100))
    const st = fs.statSync(existing)

    const r = pickTargetName(path.join(dir, 'import'), '2026/10/25', 'IMG_1.HEIC', st.size, st.mtimeMs)
    assert.equal(r.skipped, true)
    assert.equal(r.targetPath, existing)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：目标已存在但内容不同 → 加后缀 (1)', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2026', '10', '25')
    fs.mkdirSync(root, { recursive: true })
    // 已存在同名但 size 不同（内容不同）
    fs.writeFileSync(path.join(root, 'IMG_1.HEIC'), 'x'.repeat(50))

    const r = pickTargetName(path.join(dir, 'import'), '2026/10/25', 'IMG_1.HEIC', 100, 9999)
    assert.equal(r.skipped, false)
    assert.equal(path.basename(r.targetPath), 'IMG_1(1).HEIC')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：后缀连续递增直到找到空位', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2026', '10', '25')
    fs.mkdirSync(root, { recursive: true })
    // 已存在 IMG_1.HEIC（size 100）、IMG_1(1).HEIC（size 200）——都与源不同
    fs.writeFileSync(path.join(root, 'IMG_1.HEIC'), 'x'.repeat(100))
    fs.writeFileSync(path.join(root, 'IMG_1(1).HEIC'), 'x'.repeat(200))

    const r = pickTargetName(path.join(dir, 'import'), '2026/10/25', 'IMG_1.HEIC', 300, 1234)
    assert.equal(r.skipped, false)
    assert.equal(path.basename(r.targetPath), 'IMG_1(2).HEIC')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
