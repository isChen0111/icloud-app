/**
 * 导入日期链（去目录兜底）单元测试
 *
 * 覆盖：
 *   ① 无 EXIF 图片 → mtime 兜底（与 scanner 的 mtime 兜底同源），source='mtime'
 *   ② 不可读文件 → 返回 null
 * 带 EXIF 的两个分支（exif-datetime / exif-create）在 metadata/exifWrite.test.ts 里
 * 造出真实文件后验证，避免这里为了造 EXIF 而引入第二套夹具。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { resolveDate } from './resolveDate.js'
import { toLocalIso } from '../utils/date.js'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('resolveDate：无 EXIF 图片 → 文件 mtime 兜底（本地时间+偏移表示）', async () => {
  const dir = tempDir('import-date-')
  try {
    const jpg = path.join(dir, 'IMG_1.jpg')
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#808080' } })
      .jpeg()
      .toFile(jpg)
    const resolved = await resolveDate(jpg, 'image')
    const expected = toLocalIso(fs.statSync(jpg).mtime)
    assert.equal(resolved?.iso, expected)
    assert.equal(resolved?.source, 'mtime')
    assert.match(resolved!.iso, /[+-]\d{2}:\d{2}$/, '必须带时区偏移')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveDate：不存在的文件 → 返回 null（stat 失败不抛错）', async () => {
  const dir = tempDir('import-date-')
  try {
    const missing = path.join(dir, 'not-exist.jpg')
    const resolved = await resolveDate(missing, 'image')
    assert.equal(resolved, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
