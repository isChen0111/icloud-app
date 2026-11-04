/**
 * 实况 UUID 配对的端到端验证（真文件 → 真扫描 → 真 DB）
 *
 * 与本机实况样本一起跑：样本从真实 iPhone 照片复制而来，静止帧的 UUID 在 Apple
 * MakerNote 0x0011，视频的 UUID 在 `com.apple.quicktime.content.identifier`。
 *
 * 覆盖五种情形：
 *   ① 同目录同基名、两侧 UUID 一致        → live
 *   ② **跨目录 + 视频改名、两侧 UUID 一致** → live（文件名方案在这里必然失配）
 *   ③ 只有静止帧、没有配对视频            → photo
 *   ④ 二次扫描幂等（顺带守住 skipWrite 分支：漏比较 UUID 列会让配对结果被写坏）
 *   ⑤ content_identifier / live_video_cid 真的落库
 *
 * 样本目录不在仓库里（几十 MB 的二进制）。取不到就整组 skip，不判失败——
 * 判据本身的正确性由 pair.test.ts 用注入的方式覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { closeDb, getDb } from '../db/index.js'
import { runScan } from './index.js'

/** 本机实况样本根目录（由开发机准备，见 CONTEXT 的测试数据说明） */
const SAMPLE_ROOT = 'F:/Agent Program/icloud-app-agent/TestPhotoLib/live-samples'

const originalConfig = {
  libraryRoot: config.libraryRoot,
  cacheDir: config.cacheDir,
  dbPath: config.dbPath,
  scanLimit: config.scanLimit,
}

interface AssetRow {
  file_path: string
  type: string
  live_video: string | null
  content_identifier: string | null
  live_video_cid: string | null
}

function setup(): { root: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-live-'))
  const root = path.join(dir, 'photos')
  // 按 iCloudPD 的结构放：库根/icloud/YYYY/MM/DD/…（日期子树可信，与真实库一致）
  for (const sub of ['2018/02/03', '2018/02/04', '2018/02/05', '2024/01/01']) {
    fs.mkdirSync(path.join(root, 'icloud', sub), { recursive: true })
  }
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true })
  closeDb()
  config.libraryRoot = root
  config.cacheDir = path.join(dir, 'cache')
  config.dbPath = path.join(dir, 'library.db')
  config.scanLimit = 0
  return { root, dir }
}

function teardown(env: { dir: string }): void {
  closeDb()
  config.libraryRoot = originalConfig.libraryRoot
  config.cacheDir = originalConfig.cacheDir
  config.dbPath = originalConfig.dbPath
  config.scanLimit = originalConfig.scanLimit
  fs.rmSync(env.dir, { recursive: true, force: true })
}

/** 把样本按相对路径复制进库根 */
function copySamples(root: string): void {
  for (const rel of [
    '2018/02/03/IMG_0006.HEIC',
    '2018/02/03/IMG_0006_HEVC.MOV',
    '2018/02/04/IMG_0040.HEIC',
    '2018/02/04/IMG_0040_HEVC.MOV',
    '2018/02/04/IMG_0032.HEIC',
    '2018/02/05/renamed-clip-a1.mov',
    '2024/01/01/IMG_1801.HEIC',
    '2024/01/01/IMG_1801_HEVC.MOV',
    '2024/01/01/IMG_1802.HEIC',
  ]) {
    fs.copyFileSync(path.join(SAMPLE_ROOT, rel), path.join(root, 'icloud', rel))
  }
}

test('端到端：UUID 优先配对（含跨目录改名）+ 落库 + 二次扫描幂等', async (t) => {
  if (!fs.existsSync(path.join(SAMPLE_ROOT, '2018/02/03/IMG_0006.HEIC'))) {
    return t.skip('本机没有实况样本，跳过')
  }
  const env = setup()
  try {
    copySamples(env.root)
    await runScan('startup', { enqueueThumbnails: false })

    const db = getDb()
    const readAll = (): AssetRow[] =>
      db
        .prepare(`SELECT file_path, type, live_video, content_identifier, live_video_cid FROM assets ORDER BY file_path`)
        .all() as AssetRow[]

    const rows = readAll()
    // 9 个文件 → 4 张实况 + 1 张普通照片（IMG_1802 只有静止帧）
    assert.equal(rows.length, 5, `资产数应为 5，实际 ${rows.length}`)
    const byName = (suffix: string): AssetRow => {
      const row = rows.find((r) => r.file_path.endsWith(suffix))
      assert.ok(row, `缺少资产 ${suffix}`)
      return row
    }

    // ① 同目录同基名
    for (const [still, movSuffix, cidFile] of [
      ['IMG_0006.HEIC', 'IMG_0006_HEVC.MOV', 'IMG_0006'],
      ['IMG_0040.HEIC', 'IMG_0040_HEVC.MOV', 'IMG_0040'],
      ['IMG_1801.HEIC', 'IMG_1801_HEVC.MOV', 'IMG_1801'],
    ]) {
      const row = byName(still)
      assert.equal(row.type, 'live', `${still} 应为 live`)
      assert.ok(row.live_video?.endsWith(movSuffix), `${still} 的配对视频不对：${row.live_video}`)
      assert.match(row.content_identifier ?? '', /^[0-9a-f-]{36}$/i, `${cidFile} 的 UUID 未入库`)
      assert.equal(row.live_video_cid, row.content_identifier, '两侧 UUID 应一致且都入库')
    }

    // ② 跨目录 + 改名的视频：只能靠 UUID 配上
    const crossDir = byName('IMG_0032.HEIC')
    assert.equal(crossDir.type, 'live', '跨目录的实况应靠 UUID 配上')
    assert.ok(
      crossDir.live_video?.endsWith('renamed-clip-a1.mov'),
      `配对视频应为改名后的那个，实际 ${crossDir.live_video}`,
    )
    assert.equal(crossDir.live_video_cid, crossDir.content_identifier)

    // ③ 只有静止帧 → 普通照片，但自身 UUID 仍要入库（下次配对/回填还要用）
    const solo = byName('IMG_1802.HEIC')
    assert.equal(solo.type, 'photo')
    assert.equal(solo.live_video, null)
    assert.match(solo.content_identifier ?? '', /^[0-9a-f-]{36}$/i)

    // ④ 二次扫描：签名未变 → 走 skipWrite 分支，结果必须完全不变
    await runScan('startup', { enqueueThumbnails: false })
    assert.deepEqual(readAll(), rows, '二次扫描不应改变任何配对结果')
  } finally {
    teardown(env)
  }
})
