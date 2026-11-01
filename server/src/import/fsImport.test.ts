/**
 * 导入核心流水线端到端测试（临时目录造真实文件，走真实 importDirectory）
 *
 * 覆盖：
 *   ① copy 模式：按日期归置 + 实况同目录 + 保留源 mtime + 源文件保留 + 补写拍摄时间
 *   ② move 模式：导入后源文件被移走
 *   ③ collectSourceFiles：只收录媒体扩展名
 *   ④ 补写后重复导入 → 全部 skipped，不产生 (n) 副本（方案 1 判重的核心回归）
 *
 * 注意：补写会启动 exiftool 常驻进程，必须在 after 里关掉，否则测试进程不退出。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { importDirectory, collectSourceFiles } from './fsImport.js'
import { importState, resetImportState } from './state.js'
import { toLocalIso } from '../utils/date.js'
import { closeExifTool, isExifToolAvailable, writeDateTaken } from '../metadata/exifWrite.js'

const exifAvailable = await isExifToolAvailable()

after(async () => {
  await closeExifTool()
})

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function writeJpeg(absPath: string, size: number): Promise<void> {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  await sharp({ create: { width: size, height: size, channels: 3, background: '#808080' } })
    .jpeg()
    .toFile(absPath)
}

test('importDirectory：copy 模式按日期归置 + 实况同目录 + 保留源 mtime + 源文件保留', async () => {
  const dir = tempDir('import-fs-')
  try {
    const src = path.join(dir, 'src')
    const target = path.join(dir, 'import')
    await writeJpeg(path.join(src, 'IMG_1.jpg'), 4)
    fs.writeFileSync(path.join(src, 'IMG_1.mov'), 'fake-mov')
    const srcJpgMtime = Math.trunc(fs.statSync(path.join(src, 'IMG_1.jpg')).mtimeMs)

    resetImportState()
    await importDirectory({ libraryId: 1, sourceDir: src, targetRoot: target, mode: 'copy', source: 'local' })

    assert.equal(importState.status, 'done')
    assert.equal(importState.totalFiles, 2)
    assert.equal(importState.processedFiles, 2)
    assert.equal(importState.failedCount, 0)

    // 落盘目录 = 源 jpg 的 mtime 日期（无 EXIF → mtime 兜底）
    const ymd = toLocalIso(fs.statSync(path.join(src, 'IMG_1.jpg')).mtime)!.slice(0, 10).replace(/-/g, '/')
    const dstJpg = path.join(target, ymd, 'IMG_1.jpg')
    const dstMov = path.join(target, ymd, 'IMG_1.mov')
    assert.ok(fs.existsSync(dstJpg), '图片应落到日期目录')
    assert.ok(fs.existsSync(dstMov), '实况视频应与图片同目录（不拆散）')

    // copy 模式：源文件保留
    assert.ok(fs.existsSync(path.join(src, 'IMG_1.jpg')))
    assert.ok(fs.existsSync(path.join(src, 'IMG_1.mov')))

    // 关键：保留源 mtime（无 EXIF 文件后续 runScan 的 mtime 兜底日期才正确）
    // 同时也是「补写 EXIF 不得改动 mtime」的验证——exiftool -P 关掉就会在这里红
    assert.equal(Math.trunc(fs.statSync(dstJpg).mtimeMs), srcJpgMtime)

    // 补写：无 EXIF 的 JPEG 落位后应被写上拍摄时间（视频不补）
    assert.equal(importState.exifPatched, exifAvailable ? 1 : 0)
    assert.equal(importState.exifFailed, 0)
  } finally {
    resetImportState()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('importDirectory：move 模式导入后删除源文件', async () => {
  const dir = tempDir('import-fs-')
  try {
    const src = path.join(dir, 'src')
    const target = path.join(dir, 'import')
    await writeJpeg(path.join(src, 'IMG_2.jpg'), 5)

    resetImportState()
    await importDirectory({ libraryId: 1, sourceDir: src, targetRoot: target, mode: 'move', source: 'local' })

    assert.equal(importState.status, 'done')
    assert.equal(importState.processedFiles, 1)

    // move 模式：源文件被移走
    assert.ok(!fs.existsSync(path.join(src, 'IMG_2.jpg')))

    // 目标存在（文件名不变）
    const found = findFile(target, 'IMG_2.jpg')
    assert.ok(found, '目标目录下应能找到导入的图片')
  } finally {
    resetImportState()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('importDirectory：补写后重复导入同一目录 → 全部 skipped，不产生 (n) 副本', async (t) => {
  if (!exifAvailable) return t.skip('exiftool 不可用（该用例验证的正是补写后的判重）')
  const dir = tempDir('import-fs-')
  try {
    const src = path.join(dir, 'src')
    const target = path.join(dir, 'import')
    // 两个文件：① 无 EXIF（会被补写）② 本来就有 EXIF（不会被补写）
    // 第二个是关键——线上事故（2026-11-01）里出问题的正是「不补写」的那类文件，
    // 它没有 utimesSync 兜底，mtime 直接沿用复制的舍入结果（亚毫秒进位 +1ms）。
    await writeJpeg(path.join(src, '生日.jpg'), 6)
    await writeJpeg(path.join(src, '有日期.jpg'), 7)
    await writeDateTaken(path.join(src, '有日期.jpg'), toLocalIso(new Date(2019, 0, 5, 8, 0, 0))!)

    // 第一次导入：落位 + 补写（size 会变，mtime 不变）
    resetImportState()
    await importDirectory({ libraryId: 1, sourceDir: src, targetRoot: target, mode: 'copy', source: 'local' })
    assert.equal(importState.exifPatched, 1, '第一次导入应补写一次（只补无 EXIF 的那张）')
    const landed = findFile(target, '生日.jpg')
    assert.ok(landed)
    const sizeAfterPatch = fs.statSync(landed).size

    // 显式模拟 Windows 复制保留时间戳时的进位误差（现场：源 .3319983 → 目标 .332）。
    // 同卷的临时目录里 cp 未必复现，所以这里直接把目标往后拨 1ms，让判重必须靠容差通过。
    const landedWithDate = findFile(target, '有日期.jpg')
    assert.ok(landedWithDate)
    const stDate = fs.statSync(landedWithDate)
    fs.utimesSync(landedWithDate, stDate.atime, (Math.trunc(stDate.mtimeMs) + 1) / 1000)

    // 第二次导入同一源目录：必须判为「已导入」
    resetImportState()
    await importDirectory({ libraryId: 1, sourceDir: src, targetRoot: target, mode: 'copy', source: 'local' })
    assert.equal(importState.skipped, 2, '两个文件都应判为已导入（含没有补写的那个）')
    assert.equal(importState.exifPatched, 0, 'skipped 的文件不应再次补写')
    assert.equal(importState.failedCount, 0)
    assert.equal(findFile(target, '生日(1).jpg'), null, '不能凭空多出 (1) 副本')
    assert.equal(findFile(target, '有日期(1).jpg'), null, '没补写的文件也不能多出 (1) 副本')
    assert.equal(fs.statSync(landed).size, sizeAfterPatch, '目标文件不应被二次改写')
  } finally {
    resetImportState()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('collectSourceFiles：只收录媒体扩展名，忽略其它文件', async () => {
  const dir = tempDir('import-fs-')
  try {
    await writeJpeg(path.join(dir, 'a.jpg'), 4)
    fs.writeFileSync(path.join(dir, 'b.txt'), 'not-media')
    fs.writeFileSync(path.join(dir, 'c.mov'), 'fake')
    const files = await collectSourceFiles(dir)
    const names = files.map((f) => f.fileName).sort()
    assert.deepEqual(names, ['a.jpg', 'c.mov'])
    // 签名字段已填充
    for (const f of files) {
      assert.ok(f.size > 0)
      assert.ok(f.mtimeMs > 0)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function findFile(root: string, fileName: string): string | null {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      const r = findFile(full, fileName)
      if (r) return r
    } else if (e.name === fileName) {
      return full
    }
  }
  return null
}
