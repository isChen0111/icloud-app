/**
 * 目标目录计算 + 同名冲突处理 单元测试
 *
 * 判重键在 2026-11-01 从「同名 + size + mtime」改成「同名 + mtime」（方案 1），
 * 原因见 conflict.ts 顶部注释：补写 EXIF 会改 size 但不改 mtime。这里保留一组
 * 「size 变了也要判为已导入」的用例锁住该行为。
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

/** 造一个 mtime 固定的文件（秒级），返回 stat */
function makeFile(p: string, content: string, mtimeSec: number): fs.Stats {
  fs.writeFileSync(p, content)
  fs.utimesSync(p, mtimeSec, mtimeSec)
  return fs.statSync(p)
}

test('dateToDir：ISO8601 → YYYY/MM/DD 目录段', () => {
  assert.equal(dateToDir('2026-10-25T16:47:15+08:00'), '2026/10/25')
  assert.equal(dateToDir('2024-01-03T00:00:00Z'), '2024/01/03')
})

test('pickTargetName：目标不存在 → 直接用原名', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import')
    const r = pickTargetName(root, '2026/10/25', 'IMG_1.HEIC', 1000)
    assert.equal(r.skipped, false)
    assert.equal(path.basename(r.targetPath), 'IMG_1.HEIC')
    assert.ok(r.targetPath.endsWith(path.join('import', '2026', '10', '25', 'IMG_1.HEIC')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：目标已存在且 mtime 相同 → 跳过（视为已导入）', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2026', '10', '25')
    fs.mkdirSync(root, { recursive: true })
    const existing = path.join(root, 'IMG_1.HEIC')
    const st = makeFile(existing, 'x'.repeat(100), 1_600_000_000)

    const r = pickTargetName(path.join(dir, 'import'), '2026/10/25', 'IMG_1.HEIC', st.mtimeMs)
    assert.equal(r.skipped, true)
    assert.equal(r.targetPath, existing)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：size 变了但 mtime 相同 → 仍判为已导入（补写 EXIF 后的真实形态）', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2026', '10', '25')
    fs.mkdirSync(root, { recursive: true })
    const existing = path.join(root, '生日.JPG')
    // 落位时 274 字节，补写 EXIF 后变成 3445 字节；mtime 被 -P 保住
    const st = makeFile(existing, 'x'.repeat(3445), 1_431_888_417)

    // 源文件仍是未补写的 274 字节、同一个 mtime
    const r = pickTargetName(path.join(dir, 'import'), '2026/10/25', '生日.JPG', st.mtimeMs)
    assert.equal(r.skipped, true, 'size 不同不应影响判重')
    assert.equal(r.targetPath, existing)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：目标已存在但 mtime 不同 → 加后缀 (1)（绝不覆盖）', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2026', '10', '25')
    fs.mkdirSync(root, { recursive: true })
    // 即便 size 完全相同，mtime 不同就视为另一个文件
    makeFile(path.join(root, 'IMG_1.HEIC'), 'x'.repeat(100), 1_600_000_000)

    const r = pickTargetName(path.join(dir, 'import'), '2026/10/25', 'IMG_1.HEIC', 1_700_000_000_000)
    assert.equal(r.skipped, false)
    assert.equal(path.basename(r.targetPath), 'IMG_1(1).HEIC')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：mtime 相差 1ms（Windows 复制进位误差）→ 仍判为已导入', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2020', '01', '02')
    fs.mkdirSync(root, { recursive: true })
    const existing = path.join(root, '有日期照片.jpg')
    fs.writeFileSync(existing, 'x'.repeat(5239))
    // 现场数据：源 mtime = …594331.9983，复制落地后被进位成 …594332
    fs.utimesSync(existing, 1793504594.332, 1793504594.332)

    const r = pickTargetName(path.join(dir, 'import'), '2020/01/02', '有日期照片.jpg', 1793504594331)
    assert.equal(r.skipped, true, '1ms 的表示误差不能把同一个文件判成两个')
    assert.equal(r.targetPath, existing)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：mtime 相差 2ms 以上 → 视为不同文件，另存 (1)（容差不能放大）', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2020', '01', '02')
    fs.mkdirSync(root, { recursive: true })
    const existing = path.join(root, '有日期照片.jpg')
    fs.writeFileSync(existing, 'x'.repeat(5239))
    fs.utimesSync(existing, 1793504594.332, 1793504594.332)

    const r = pickTargetName(path.join(dir, 'import'), '2020/01/02', '有日期照片.jpg', 1793504594334)
    assert.equal(r.skipped, false)
    assert.equal(path.basename(r.targetPath), '有日期照片(1).jpg')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pickTargetName：后缀连续递增直到找到空位', () => {
  const dir = tempDir('import-conflict-')
  try {
    const root = path.join(dir, 'import', '2026', '10', '25')
    fs.mkdirSync(root, { recursive: true })
    // 已存在 IMG_1.HEIC 与 IMG_1(1).HEIC —— mtime 都与源不同
    makeFile(path.join(root, 'IMG_1.HEIC'), 'x'.repeat(100), 1_600_000_000)
    makeFile(path.join(root, 'IMG_1(1).HEIC'), 'x'.repeat(200), 1_600_000_100)

    const r = pickTargetName(path.join(dir, 'import'), '2026/10/25', 'IMG_1.HEIC', 1_700_000_000_000)
    assert.equal(r.skipped, false)
    assert.equal(path.basename(r.targetPath), 'IMG_1(2).HEIC')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
