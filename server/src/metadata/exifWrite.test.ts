/**
 * EXIF 拍摄时间补写 单元测试
 *
 * 依赖 exiftool 二进制（exiftool-vendored 随包提供）。拿不到时整组 t.skip，不判失败——
 * 补写是「锦上添花」能力，二进制缺失时导入流程会自动降级跳过（见 isExifToolAvailable）。
 *
 * 三条必须锁死的行为：
 *   ① 写进去的值能原样读回来（本地时间不能整体偏移 8 小时）
 *   ② mtime 写前写后必须一致——mtime 是导入判重的键，一变就会重复导入
 *   ③ size 会变（判重因此不能比 size，这是 conflict.ts 方案 1 的前提）
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { readImageMeta } from './index.js'
import {
  closeExifTool,
  isExifToolAvailable,
  isPatchableImage,
  toExifDateTime,
  writeDateTaken,
} from './exifWrite.js'
import { resolveDate } from '../import/resolveDate.js'
import { toLocalIso } from '../utils/date.js'

const available = await isExifToolAvailable()

after(async () => {
  await closeExifTool()
})

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 造一张无 EXIF 的 JPEG，返回路径 */
async function makeJpeg(dir: string, name = 'IMG_1.jpg'): Promise<string> {
  const p = path.join(dir, name)
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
    .jpeg()
    .toFile(p)
  return p
}

test('toExifDateTime：本地 ISO → EXIF 时间格式，不做时区换算', () => {
  assert.equal(toExifDateTime('2015-05-03T11:46:57+08:00'), '2015:05:03 11:46:57')
  assert.equal(toExifDateTime('2024-01-03T00:00:00+08:00'), '2024:01:03 00:00:00')
  // 偏移不参与换算：字符串里的本地时间原样搬过去
  assert.equal(toExifDateTime('2024-01-03T00:00:00Z'), '2024:01:03 00:00:00')
  assert.throws(() => toExifDateTime('2015/05/03'), /无法转换为 EXIF 时间格式/)
})

test('isPatchableImage：只认 JPEG', () => {
  assert.equal(isPatchableImage('a.jpg'), true)
  assert.equal(isPatchableImage('a.JPEG'), true)
  assert.equal(isPatchableImage('a.heic'), false)
  assert.equal(isPatchableImage('a.png'), false)
  assert.equal(isPatchableImage('a.mov'), false)
})

test('writeDateTaken：日期可原样读回、mtime 不变、size 会变', async (t) => {
  if (!available) return t.skip('exiftool 不可用')
  const dir = tempDir('exif-write-')
  try {
    const jpg = await makeJpeg(dir)
    const before = fs.statSync(jpg)
    assert.equal((await readImageMeta(jpg)).dateTimeOriginal, null, '前置：构造的文件必须没有 0x9003')

    const iso = toLocalIso(new Date(2015, 4, 3, 11, 46, 57))!
    await writeDateTaken(jpg, iso)

    const meta = await readImageMeta(jpg)
    assert.equal(meta.dateTimeOriginal, iso, '0x9003 应能原样读回（时区不能偏）')
    assert.equal(meta.createDate, iso, '0x9004 应同时写入')

    const afterStat = fs.statSync(jpg)
    assert.equal(afterStat.mtimeMs, before.mtimeMs, 'mtime 必须原样保留（判重键）')
    assert.notEqual(afterStat.size, before.size, 'size 会变——所以判重不能比 size')

    // 补写后再走导入日期链，来源必须变成 exif-datetime（否则每次导入都会重复补写）
    const resolved = await resolveDate(jpg, 'image')
    assert.equal(resolved?.iso, iso)
    assert.equal(resolved?.source, 'exif-datetime')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writeDateTaken：非 JPEG 会被 exiftool 拒绝（调用方已按扩展名过滤，这里是兜底）', async (t) => {
  if (!available) return t.skip('exiftool 不可用')
  const dir = tempDir('exif-write-')
  try {
    const p = path.join(dir, 'note.txt')
    fs.writeFileSync(p, 'not an image')
    await assert.rejects(() => writeDateTaken(p, '2015-05-03T11:46:57+08:00'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
