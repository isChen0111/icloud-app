/**
 * 扫描主流程端到端测试（审查 R-04 / R-19 配套）
 *
 * 做法：在系统临时目录造一个真实照片库（真实图片用 sharp 现生成、真实视频用 vendor
 * 里的 ffmpeg 现生成），把 `config.libraryRoot / cacheDir / dbPath` 指过去，
 * 然后调真正的 `runScan()` —— 走的是线上同一条遍历 → 配对 → 提取 → 入库 → 对账链路，
 * 不 mock 任何内部函数。全程不碰真实照片库与 `server/cache`。
 *
 * 覆盖：
 *   ① 首次扫描入库（目录日期兜底 / 同目录同基名的实况配对）+ 二次扫描幂等
 *   ② 磁盘文件消失 → 删除对账清理对应行
 *   ③ 同路径源文件被覆盖 → 元数据重新提取、缩略图状态重置（R-04）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { config } from '../config.js'
import { closeDb, getDb } from '../db/index.js'
import { runScan, scanProgress } from './index.js'
import { toLocalIso } from '../utils/date.js'

/** 用例期间会临时改写三个路径配置，结束后恢复成进程启动时的值 */
const originalConfig = {
  libraryRoot: config.libraryRoot,
  cacheDir: config.cacheDir,
  dbPath: config.dbPath,
  scanLimit: config.scanLimit,
}

interface Env {
  /** 照片库根目录（库内路径都相对它） */
  root: string
  dir: string
}

function setup(): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-scan-'))
  const root = path.join(dir, 'photos')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true })
  config.libraryRoot = root
  config.cacheDir = path.join(dir, 'cache')
  config.dbPath = path.join(dir, 'library.db')
  config.scanLimit = 0
  return { root, dir }
}

function teardown(env: Env): void {
  // 先关连接：Windows 上 WAL 文件被占用会导致删目录失败
  closeDb()
  config.libraryRoot = originalConfig.libraryRoot
  config.cacheDir = originalConfig.cacheDir
  config.dbPath = originalConfig.dbPath
  config.scanLimit = originalConfig.scanLimit
  fs.rmSync(env.dir, { recursive: true, force: true })
}

/** 生成一张纯色 JPEG（尺寸可不同，用于制造签名变化） */
async function writeJpeg(absPath: string, size: number): Promise<void> {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  await sharp({ create: { width: size, height: size, channels: 3, background: '#808080' } })
    .jpeg()
    .toFile(absPath)
}

/** 在 config.ffmpegDir 下递归找 ffmpeg 可执行文件（找不到则相关用例跳过） */
function findFfmpeg(dir = config.ffmpegDir): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFfmpeg(full)
      if (nested) return nested
    } else if (/^ffmpeg(?:\.exe)?$/i.test(entry.name)) {
      return full
    }
  }
  return null
}

/** 用 ffmpeg 生成指定尺寸/时长的纯色 mp4（内容与文件名无关，只看解码结果） */
function writeVideo(ffmpeg: string, absPath: string, size: number, seconds: number): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  const r = spawnSync(
    ffmpeg,
    ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', absPath],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, `ffmpeg 生成测试视频失败: ${r.stderr}`)
}

interface AssetRow {
  id: number
  file_path: string
  type: string
  date_taken: string | null
  width: number | null
  height: number | null
  duration: number | null
  live_video: string | null
  file_size: number | null
  thumb_status: string
}

function readAssets(): AssetRow[] {
  return getDb()
    .prepare(
      `SELECT id, file_path, type, date_taken, width, height, duration, live_video, file_size, thumb_status
       FROM assets ORDER BY file_path`,
    )
    .all() as AssetRow[]
}

/**
 * 本连接建立以来的累计写入次数（INSERT/UPDATE/DELETE 都算，含 FTS 影子表）。
 *
 * 稳态跳过写库要证明的就是「这一轮什么都没写」，直接读这个计数器比逐列比对可靠：
 * 逐列比对只能证明「值没变」，而值没变也可能来自「用同样的值又写了一遍」。
 */
function totalChanges(): number {
  return (getDb().prepare('SELECT total_changes() AS c').get() as { c: number }).c
}

test('runScan：首次入库 + 目录日期兜底 + 实况配对，二次扫描幂等', async () => {
  const env = setup()
  try {
    await writeJpeg(path.join(env.root, 'icloud', '2024', '09', '13', 'IMG_1.jpg'), 4)
    await writeJpeg(path.join(env.root, 'icloud', '2024', '09', '13', 'IMG_2.jpg'), 5)
    // 同目录、同基名的 jpg + mov → 配成一张实况照片（mov 不再单独入库）
    await writeJpeg(path.join(env.root, 'icloud', '2024', '09', '14', 'IMG_3.jpg'), 6)
    fs.writeFileSync(path.join(env.root, 'icloud', '2024', '09', '14', 'IMG_3.mov'), 'fake-mov')

    await runScan('manual', { enqueueThumbnails: false })
    const first = readAssets()

    assert.equal(first.length, 3, '两张普通照片 + 一张实况照片')
    const live = first.find((r) => r.file_path.endsWith('IMG_3.jpg'))!
    assert.equal(live.type, 'live')
    assert.ok(live.live_video?.endsWith('IMG_3.mov'), '实况视频应挂在主资产上')
    assert.equal(first.filter((r) => r.file_path.endsWith('.mov')).length, 0, '配对的 mov 不应独立入库')

    // 无 EXIF → 目录日期兜底，且必须是「本地零点 + 偏移」表示（R-08 的统一格式）
    const expected = toLocalIso(new Date(2024, 8, 13))
    const img1 = first.find((r) => r.file_path.endsWith('IMG_1.jpg'))!
    assert.equal(img1.date_taken, expected)
    assert.match(img1.date_taken!, /[+-]\d{2}:\d{2}$/, 'date_taken 必须带时区偏移')

    // 幂等：再扫一次不应新增、不应改 id、不应改内容
    await runScan('manual', { enqueueThumbnails: false })
    assert.deepEqual(readAssets(), first, '二次扫描必须完全幂等')
  } finally {
    teardown(env)
  }
})

/**
 * 稳态跳过写库（2026-11-03）：签名与配对都没变时，本轮不执行 UPSERT、也不重写 FTS。
 *
 * 三条断言分三层，缺一条都可能漏掉错误实现：
 *   · total_changes 差为 0 —— 证明「真的没写」，而不是「写了同样的值」
 *   · filename 哨兵值不被覆盖 —— 证明写库路径确实没走到
 *   · assetsAdded —— 稳态下必须是 0，否则「新增 N 项」会越扫越大
 */
test('runScan：稳态（签名与配对都没变）不产生任何写库', async () => {
  const env = setup()
  try {
    await writeJpeg(path.join(env.root, 'icloud', '2024', '09', '13', 'A.jpg'), 4)
    await writeJpeg(path.join(env.root, 'icloud', '2024', '09', '13', 'B.jpg'), 5)

    await runScan('manual', { enqueueThumbnails: false })
    assert.equal(readAssets().length, 2)
    assert.equal(scanProgress.assetsAdded, 2, '首轮两个都是新增')
    assert.equal(scanProgress.assetsFound, 2)

    // 哨兵：只有真的执行了 UPSERT，filename 才会被覆盖回磁盘上的名字
    getDb().prepare(`UPDATE assets SET filename='SENTINEL' WHERE file_path LIKE '%A.jpg'`).run()

    const before = totalChanges()
    await runScan('manual', { enqueueThumbnails: false })
    const written = totalChanges() - before

    assert.equal(written, 0, `稳态扫描不得产生任何写库（含 FTS），实际写了 ${written} 次`)
    const sentinel = getDb()
      .prepare(`SELECT filename FROM assets WHERE file_path LIKE '%A.jpg'`)
      .get() as { filename: string }
    assert.equal(sentinel.filename, 'SENTINEL', '稳态下不应重写已有行')
    assert.equal(scanProgress.assetsAdded, 0, '稳态没有新增')
    assert.equal(scanProgress.assetsFound, 2, 'assetsFound 语义不变：本轮处理过的资产数（含跳过）')
  } finally {
    teardown(env)
  }
})

/**
 * 跳过写库的边界：13 列里只有 type / live_video 有「修正语义」，它们与磁盘不一致时
 * 必须仍然写库。漏掉这条 = 配对修正永久失效（跨目录同名、MOV 增删都改不回来），
 * 而且是静默的、不会自愈。
 */
test('runScan：库里配对结果与磁盘不一致时必须修正（稳态跳过的边界）', async () => {
  const env = setup()
  try {
    await writeJpeg(path.join(env.root, 'icloud', '2024', '09', '13', 'LIVE.jpg'), 6)
    fs.writeFileSync(path.join(env.root, 'icloud', '2024', '09', '13', 'LIVE.mov'), 'fake-mov')
    await writeJpeg(path.join(env.root, 'icloud', '2024', '09', '13', 'PLAIN.jpg'), 4)

    await runScan('manual', { enqueueThumbnails: false })

    // 投毒：实况照片被写成普通视频且挂了一个不存在的配对视频；普通照片被写成视频
    getDb()
      .prepare(`UPDATE assets SET type='video', live_video='bogus.mov' WHERE file_path LIKE '%LIVE.jpg'`)
      .run()
    getDb().prepare(`UPDATE assets SET type='video' WHERE file_path LIKE '%PLAIN.jpg'`).run()

    await runScan('manual', { enqueueThumbnails: false })

    const rows = readAssets()
    const live = rows.find((r) => r.file_path.endsWith('LIVE.jpg'))!
    const plain = rows.find((r) => r.file_path.endsWith('PLAIN.jpg'))!
    assert.equal(live.type, 'live', '配对结果与库里不一致时必须写库修正')
    assert.ok(live.live_video?.endsWith('LIVE.mov'), `live_video 应指回真实配对视频，实际 ${live.live_video}`)
    assert.equal(plain.type, 'photo', '只有视频少了配对时要能改回 photo')
    assert.equal(scanProgress.assetsAdded, 0, '修正已有行不算新增')
  } finally {
    teardown(env)
  }
})

/**
 * 回归保护（跳过写库最容易踩的坑）：旧库的 file_size/file_mtime 是 NULL，这类行
 * `changed` 恒为 false（签名比较要求非空），**只能靠复用分支的 UPSERT 补写签名**。
 * 若把它们也跳过，签名永远补不上 → 之后文件内容变化永远检测不到。
 */
test('runScan：file_size 为 NULL 的历史行仍要补写签名，补完后进入稳态', async () => {
  const env = setup()
  try {
    const file = path.join(env.root, 'icloud', '2024', '09', '13', 'OLD.jpg')
    await writeJpeg(file, 4)
    const mtime = new Date(2024, 8, 13, 13, 0, 0)
    fs.utimesSync(file, mtime, mtime)
    await runScan('manual', { enqueueThumbnails: false })

    // 模拟历史库：签名列为空（这批行 changed 恒为 false，只能靠复用分支写库补签名）
    getDb().prepare(`UPDATE assets SET file_size=NULL, file_mtime=NULL`).run()
    await runScan('manual', { enqueueThumbnails: false })

    const row = getDb().prepare(`SELECT file_size, file_mtime, date_taken FROM assets`).get() as {
      file_size: number | null
      file_mtime: number | null
      date_taken: string
    }
    assert.ok((row.file_size ?? 0) > 0, '必须补写 file_size，否则永久失去变化检测')
    assert.ok((row.file_mtime ?? 0) > 0, '必须补写 file_mtime')
    assert.equal(row.date_taken, toLocalIso(mtime))

    // 补完之后必须真的进入稳态：若签名没写进去，下一轮仍会判定「无签名」而继续写库
    const before = totalChanges()
    await runScan('manual', { enqueueThumbnails: false })
    assert.equal(totalChanges() - before, 0, '签名补写后应进入稳态（证明签名真的可用了）')
  } finally {
    teardown(env)
  }
})

test('runScan：无 EXIF 时目录与 mtime 印证（同日取 mtime、异日取目录零点）', async () => {
  const env = setup()
  try {
    // 两张无 EXIF 的图放在同一天目录下，但 mtime 分别「同一天」与「不同天」
    const same = path.join(env.root, 'icloud', '2024', '09', '13', 'SAME.jpg')
    await writeJpeg(same, 4)
    fs.utimesSync(same, new Date(2024, 8, 13, 13, 0, 0), new Date(2024, 8, 13, 13, 0, 0))

    const diff = path.join(env.root, 'icloud', '2024', '09', '13', 'DIFF.jpg')
    await writeJpeg(diff, 5)
    fs.utimesSync(diff, new Date(2024, 8, 20, 13, 0, 0), new Date(2024, 8, 20, 13, 0, 0))

    await runScan('manual', { enqueueThumbnails: false })
    const rows = readAssets()
    const sameRow = rows.find((r) => r.file_path.endsWith('SAME.jpg'))!
    const diffRow = rows.find((r) => r.file_path.endsWith('DIFF.jpg'))!

    // 同一天：用 mtime 恢复秒级精度
    assert.equal(sameRow.date_taken, toLocalIso(new Date(2024, 8, 13, 13, 0, 0)), 'mtime 与目录同日 → 取 mtime（秒级）')
    // 不同天：mtime 被污染，退回目录零点
    assert.equal(diffRow.date_taken, toLocalIso(new Date(2024, 8, 13)), 'mtime 与目录异日 → 保守取目录零点')
  } finally {
    teardown(env)
  }
})

test('runScan：白名单子树外的目录日期不采信（用户手动复制进来的任意目录树）', async () => {
  const env = setup()
  try {
    // 模拟用户把备份目录整个复制进库根：目录名恰好形如 YYYY/MM/DD，但那是备份日期
    const manual = path.join(env.root, '我的备份', '2021', '07', '08', 'OLD.jpg')
    await writeJpeg(manual, 4)
    fs.utimesSync(manual, new Date(2016, 0, 2, 9, 30, 0), new Date(2016, 0, 2, 9, 30, 0))

    await runScan('manual', { enqueueThumbnails: false })
    const row = readAssets()[0]
    assert.equal(
      row.date_taken,
      toLocalIso(new Date(2016, 0, 2, 9, 30, 0)),
      '库根下的手动目录不参与日期兜底：应取 mtime 的真实拍摄时间，而不是目录名里的备份日期',
    )
  } finally {
    teardown(env)
  }
})

test('runScan：磁盘文件消失 → 删除对账清理该行，其余保留', async () => {
  const env = setup()
  try {
    await writeJpeg(path.join(env.root, '2024', '09', '13', 'KEEP.jpg'), 4)
    await writeJpeg(path.join(env.root, '2024', '09', '13', 'GONE.jpg'), 5)
    await runScan('manual', { enqueueThumbnails: false })
    assert.equal(readAssets().length, 2)

    fs.rmSync(path.join(env.root, '2024', '09', '13', 'GONE.jpg'))
    await runScan('manual', { enqueueThumbnails: false })

    const rows = readAssets()
    assert.equal(rows.length, 1)
    assert.ok(rows[0].file_path.endsWith('KEEP.jpg'))
  } finally {
    teardown(env)
  }
})

test('runScan：同路径文件被覆盖 → 元数据重新提取、缩略图重置（R-04）', async (t) => {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) {
    t.skip('vendor 目录里没有 ffmpeg，跳过（本用例需要真实可探测的媒体元数据）')
    return
  }
  const env = setup()
  try {
    const clip = path.join(env.root, '2024', '09', '13', 'CLIP.mp4')
    writeVideo(ffmpeg, clip, 64, 1)
    await runScan('manual', { enqueueThumbnails: false })
    const before = readAssets()[0]
    assert.equal(before.width, 64)
    assert.ok(before.duration != null && before.duration > 0.5, `首次应读到时长: ${before.duration}`)

    // 同一路径换成尺寸与时长都不同的视频：签名变化 → 元数据必须重取，不能沿用旧值
    writeVideo(ffmpeg, clip, 128, 2)
    await runScan('manual', { enqueueThumbnails: false })
    const after = readAssets()[0]

    assert.equal(after.id, before.id, '同一路径应复用同一行（不新增资产）')
    assert.equal(after.width, 128, 'R-04：分辨率必须跟着新文件更新')
    assert.ok((after.duration ?? 0) > 1.5, `R-04：时长必须跟着新文件更新，实际 ${after.duration}`)
    assert.notEqual(after.file_size, before.file_size, '签名列同步更新')
    assert.equal(after.thumb_status, 'pending', 'F-03：签名变化后缩略图应重新生成')
  } finally {
    teardown(env)
  }
})
