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
import { importDirectory, collectSourceFiles, copyAtomically, importDoneMessage } from './fsImport.js'
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
    importState.status = 'running' // 编排层启动时设置
    const result = await importDirectory({ libraryId: 1, sourceDir: src, targetRoot: target, mode: 'copy', source: 'local' })

    // C-06：归置结束**不写终态**——落库扫描还没跑，此刻报「完成」是假完成
    assert.equal(result.cancelled, false)
    assert.match(result.message, /^导入完成/, '终态文案由归置阶段给出（可能带补写计数），由编排层统一写入')
    assert.equal(importState.status, 'running', '终态必须由编排层在 runScan 之后写')
    assert.equal(importState.finishedAt, null)
    assert.equal(importState.phase, 'copying')
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
    importState.status = 'running'
    const result = await importDirectory({ libraryId: 1, sourceDir: src, targetRoot: target, mode: 'move', source: 'local' })

    assert.equal(result.cancelled, false)
    assert.equal(importState.status, 'running', '终态归编排层（C-06）')
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

test('C-01/C-06：取消只置信号；归置结束时既不写终态也不写 finishedAt', async () => {
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

    const result = await running

    // C-06：归置阶段只回报「被取消了」，终态与 finishedAt 由编排层在落库扫描后写。
    // 此时 status 仍是 running —— isImportBusy 继续为真，切库/删库仍被拦住（正确）。
    assert.equal(result.cancelled, true)
    assert.equal(result.message, '已取消')
    assert.equal(importState.status, 'running', '归置阶段不得自行写 cancelled')
    assert.equal(importState.finishedAt, null)
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

    const oldResult = await oldRun

    // 旧流水线必须先收手：令牌不符时连终态都不许写，否则会把新任务冲成 done/cancelled
    assert.equal(oldResult.cancelled, true, '被接管的一律按「未完成」上报，让编排层不要写终态')
    assert.equal(oldResult.message, '', '被接管时不产生终态文案')
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

    const oldResult = await oldRun

    assert.equal(oldResult.cancelled, true, '被接管后按「未完成」上报')
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

/* ============ 审查 C-07 / C-08 / C-09：归置阶段的健壮性 ============ */

test('C-07/C-09：原子复制保留源 mtime，且正式路径上不留 .part', async () => {
  const dir = tempDir('import-atomic-')
  try {
    const src = path.join(dir, 'a.jpg')
    const dst = path.join(dir, 'out', 'a.jpg')
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
    await writeJpeg(src, 5)
    // 固定一个足够旧的 mtime：不保留时间戳的拷贝会变成「现在」
    const old = new Date(2019, 4, 6, 7, 8, 9)
    fs.utimesSync(src, old, old)

    await copyAtomically(src, dst)

    assert.ok(fs.existsSync(dst), '目标文件应存在')
    assert.equal(
      Math.trunc(fs.statSync(dst).mtimeMs),
      Math.trunc(fs.statSync(src).mtimeMs),
      'C-07：必须保留源 mtime（否则无 EXIF 文件日期退化成今天）',
    )
    const leftovers = fs.readdirSync(path.join(dir, 'out')).filter((n) => n.endsWith('.part'))
    assert.deepEqual(leftovers, [], 'C-09：成功后不应留下 .part')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * ⚠️ 平台差异：Windows 的 `fs.copyFile` 走 CopyFileW，**本身就复制时间戳**，
 * 所以在 Windows 上「保留 mtime」这条断言区分不出 `copyFile` 与 `fs.cp`——
 * 把实现改成 copyFile 这个用例仍然会绿。C-07 的真实风险平台是 Linux/macOS
 * （POSIX rename/copy 不搬运 mtime），这条断言在那里才有区分力。
 * 这里保留它是因为它同时守住「rename 搬 .part 不会破坏 mtime」这一层。
 */

test('C-09：复制失败 → 正式文件名上不留截断文件，也不留 .part', async () => {
  const dir = tempDir('import-atomic-fail-')
  try {
    const dst = path.join(dir, 'out', 'missing.jpg')
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true })

    await assert.rejects(
      copyAtomically(path.join(dir, 'does-not-exist.jpg'), dst),
      '源文件不存在时应抛错（由调用方记入失败清单）',
    )
    assert.equal(fs.existsSync(dst), false, '正式路径上不得留下半成品（否则会被扫描当成正常资产）')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'out')), [], '临时文件也要清掉')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C-08：目标日期目录不可建时，只影响当天那批文件，后续资产照常导入', async () => {
  const dir = tempDir('import-mkdir-')
  try {
    const src = path.join(dir, 'src')
    const target = path.join(dir, 'import')
    const badDir = path.join(target, '2020', '01', '05')
    // 关键构造：在「日期目录」的位置放一个**普通文件**，mkdir 必然失败
    fs.mkdirSync(path.dirname(badDir), { recursive: true })
    fs.writeFileSync(badDir, 'this is a file, not a dir')

    await writeJpeg(path.join(src, 'bad1.jpg'), 4)
    await writeJpeg(path.join(src, 'bad2.jpg'), 4)
    await writeJpeg(path.join(src, 'ok.jpg'), 4)
    const badDate = new Date(2020, 0, 5, 10, 0, 0)
    fs.utimesSync(path.join(src, 'bad1.jpg'), badDate, badDate)
    fs.utimesSync(path.join(src, 'bad2.jpg'), badDate, badDate)
    const goodDate = new Date(2021, 5, 5, 10, 0, 0)
    fs.utimesSync(path.join(src, 'ok.jpg'), goodDate, goodDate)

    resetImportState()
    importState.status = 'running'
    // 旧实现里 mkdirSync 在 per-file try 之外 → 这里会直接把异常抛到编排层，
    // 整批 status='error'，ok.jpg 也不会被处理。新实现应只记 2 条失败。
    const result = await importDirectory({
      libraryId: 1,
      sourceDir: src,
      targetRoot: target,
      mode: 'copy',
      source: 'local',
    })

    assert.equal(result.cancelled, false)
    assert.equal(importState.failedCount, 2, '两个落不进坏目录的文件各记一条失败')
    assert.ok(
      importState.failures.every((f) => f.relPath.startsWith('bad')),
      `失败项应只有 bad*.jpg，实际：${importState.failures.map((f) => f.relPath).join(',')}`,
    )
    assert.ok(findFile(target, 'ok.jpg'), '同批其它日期的文件必须照常导入（C-08 的核心）')
  } finally {
    resetImportState()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C-09：复制途中正式文件名不存在（先写 .part，最后才 rename）', async () => {
  const dir = tempDir('import-atomic-progress-')
  try {
    const src = path.join(dir, 'big.jpg')
    const outDir = path.join(dir, 'out')
    const dst = path.join(outDir, 'big.jpg')
    fs.mkdirSync(outDir, { recursive: true })
    // 足够大的文件，才能在这一毫秒级的窗口里观察到「正在写」
    fs.writeFileSync(src, Buffer.alloc(24 * 1024 * 1024))

    const running = copyAtomically(src, dst)
    // 轮询到「.part 正在写」这一刻再断言（fs.cp 是异步的，调用返回时文件可能还没建）
    let sawPart = false
    for (let i = 0; i < 600; i++) {
      const names = fs.readdirSync(outDir)
      if (names.includes('big.jpg')) break // 已经落位（或旧实现直接写正式名）
      if (names.some((n) => n.endsWith('.part'))) {
        sawPart = true
        // 这一条才是 C-09 的实质：旧实现直接写正式名，断电/中断就留下截断文件，
        // 紧接着的 runScan 会把它当正常资产入库（永远打不开的图）。
        assert.equal(fs.existsSync(dst), false, '复制途中正式名上不得出现文件')
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.ok(sawPart, '应能观察到 .part 写入阶段（否则说明没走原子写）')

    await running
    assert.ok(fs.existsSync(dst), '完成后才出现正式名')
    assert.equal(
      fs.readdirSync(outDir).filter((n) => n.endsWith('.part')).length,
      0,
      '完成后 .part 应被 rename 走',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C-13：完成文案把「降级跳过」和「mtime 还原失败」说出来，不再一律「导入完成」', () => {
  resetImportState()
  assert.equal(importDoneMessage(), '导入完成')

  // exiftool 不可用：一张都没补，旧实现两个计数都是 0 → 界面看不出任何异常
  importState.exifSkipped = 920
  assert.match(importDoneMessage(), /未补写 920 个（缺少 exiftool）/)

  // mtime 还原失败：后果是判重键损坏，必须和「补写失败」分开说
  resetImportState()
  importState.exifMtimeFailed = 3
  importState.exifFailed = 1
  const msg = importDoneMessage()
  assert.match(msg, /补写失败 1 个/)
  assert.match(msg, /mtime 还原失败 3 个（重复导入可能多出副本）/)
})
