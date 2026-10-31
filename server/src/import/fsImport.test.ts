/**
 * 导入核心流水线端到端测试（临时目录造真实文件，走真实 importDirectory）
 *
 * 覆盖：
 *   ① copy 模式：按日期归置 + 实况同目录 + 保留源 mtime + 源文件保留
 *   ② move 模式：导入后源文件被移走
 *   ③ collectSourceFiles：只收录媒体扩展名
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { importDirectory, collectSourceFiles } from './fsImport.js'
import { importState, resetImportState } from './state.js'
import { toLocalIso } from '../utils/date.js'

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
    assert.equal(Math.trunc(fs.statSync(dstJpg).mtimeMs), srcJpgMtime)
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
