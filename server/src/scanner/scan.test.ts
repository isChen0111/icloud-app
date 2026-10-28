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
import { runScan } from './index.js'
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

test('runScan：首次入库 + 目录日期兜底 + 实况配对，二次扫描幂等', async () => {
  const env = setup()
  try {
    await writeJpeg(path.join(env.root, '2024', '09', '13', 'IMG_1.jpg'), 4)
    await writeJpeg(path.join(env.root, '2024', '09', '13', 'IMG_2.jpg'), 5)
    // 同目录、同基名的 jpg + mov → 配成一张实况照片（mov 不再单独入库）
    await writeJpeg(path.join(env.root, '2024', '09', '14', 'IMG_3.jpg'), 6)
    fs.writeFileSync(path.join(env.root, '2024', '09', '14', 'IMG_3.mov'), 'fake-mov')

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
