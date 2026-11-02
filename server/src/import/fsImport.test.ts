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
import {
  importState,
  resetImportState,
  beginImportRun,
  requestImportCancel,
  isImportBusy,
} from './state.js'
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

test('C-01：取消只置信号，终态与 finishedAt 由持有令牌的流水线写回', async () => {
  const dir = tempDir('import-fs-')
  try {
    const src = path.join(dir, 'src')
    const target = path.join(dir, 'import')
    for (let i = 1; i <= 5; i++) await writeJpeg(path.join(src, `C_${i}.jpg`), 4)

    resetImportState()
    const token = beginImportRun()
    importState.status = 'running'
    const running = importDirectory(
      { libraryId: 1, sourceDir: src, targetRoot: target, mode: 'copy', source: 'local' },
      token,
    )
    // 同一个 tick 内取消：此时流水线正卡在 collectSourceFiles 的 await 上
    assert.equal(requestImportCancel(), true)
    assert.equal(importState.status, 'running', '取消不得直接改 status，否则新任务一 reset 信号就失效')
    assert.equal(isImportBusy(), true, '取消后到收尾前仍须占住忙碌位')

    await running

    assert.equal(importState.status, 'cancelled')
    assert.ok(importState.finishedAt, '流水线必须写 finishedAt，否则忙碌位永久占住（只能重启服务）')
    assert.equal(isImportBusy(), false, '收尾后应放行')
    assert.ok(importState.processedFiles <= 1, '取消后不应继续处理文件')
  } finally {
    resetImportState()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C-01：旧流水线被新任务接管 → 不处理文件、不写任何状态（含终态）', async () => {
  const dir = tempDir('import-fs-')
  try {
    const src = path.join(dir, 'src')
    const target = path.join(dir, 'import')
    for (let i = 1; i <= 5; i++) await writeJpeg(path.join(src, `D_${i}.jpg`), 4)

    // 第一次运行：令牌 A
    resetImportState()
    const tokenA = beginImportRun()
    importState.status = 'running'
    const oldRun = importDirectory(
      { libraryId: 1, sourceDir: src, targetRoot: target, mode: 'copy', source: 'local' },
      tokenA,
    )

    // 同一 tick 内被新任务接管（模拟「取消后立刻再点导入」，旧流水线还卡在 cp 上）
    resetImportState()
    const tokenB = beginImportRun()
    importState.status = 'running'
    importState.totalFiles = 99
    importState.message = '正在导入…（新任务）'

    await oldRun

    // 旧流水线必须先收手：令牌不符时连终态都不许写，否则会把新任务冲成 done/cancelled
    assert.equal(importState.status, 'running', '旧流水线不得覆盖新任务状态')
    assert.equal(importState.message, '正在导入…（新任务）')
    assert.equal(importState.totalFiles, 99, '旧流水线不得重置新任务的进度基数')
    assert.equal(importState.processedFiles, 0, '旧流水线不得再处理任何文件')
    assert.equal(
      fs.existsSync(target),
      false,
      '旧流水线不该往库里拷任何东西（否则会与新任务同名/生成 (n) 副本）',
    )
    assert.notEqual(tokenA, tokenB)
  } finally {
    resetImportState()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C-01：跑到一半被接管 → 停在循环里，且不写终态（终态守卫的关键场景）', async () => {
  const dir = tempDir('import-fs-')
  try {
    const src = path.join(dir, 'src')
    const target = path.join(dir, 'import')
    for (let i = 1; i <= 40; i++) await writeJpeg(path.join(src, `E_${i}.jpg`), 4)

    resetImportState()
    const tokenA = beginImportRun()
    importState.status = 'running'
    const oldRun = importDirectory(
      { libraryId: 1, sourceDir: src, targetRoot: target, mode: 'copy', source: 'local' },
      tokenA,
    )

    // 等流水线真正进入主循环（totalFiles 是在收集完源文件、进循环之前写的），再接管。
    // 此时它已经过半，靠的是循环内的 stopped() 检查 + 终态守卫，而不是入口处那一次判断。
    for (let i = 0; i < 500 && importState.totalFiles === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.ok(importState.totalFiles > 0, '流水线应已进入主循环')

    resetImportState()
    beginImportRun()
    importState.status = 'running'
    importState.totalFiles = 99
    importState.message = '新任务'

    await oldRun

    assert.equal(importState.status, 'running', '旧流水线跑到一半被接管后不得写终态')
    assert.equal(importState.totalFiles, 99)
    assert.equal(importState.message, '新任务')
    assert.equal(importState.finishedAt, null, '旧流水线不得替新任务写 finishedAt')
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
