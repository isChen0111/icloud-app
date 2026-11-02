/**
 * 缩略图任务的库归属（审查 C-02，2026-11-02）
 *
 * 背景：`getDb()` 返回的是「永不失效」的 Proxy，每次 `.prepare()` 都解析到**当前**激活库。
 * 生成一张缩略图要几百毫秒到几十秒（视频抽帧更久），期间用户切库的话，结尾那几条
 * `UPDATE assets SET thumb_status=...` 就会落到**新库的同 id 资产**上：
 *   - 新库那张照片被标成 done，但它的缓存文件根本不存在（永久破图且不再重试）
 *   - 失败路径写 error 后用户一点「忽略」，那张照片就永远没有缩略图了
 *   - ensureSize 会把旧库照片的宽高写进新库 → 网格宽高比错、详情尺寸错
 *
 * 做法：不 mock，真建两个临时库（各有自己的 library.db / cache / photos），
 * 在 A 库发起生成后**同一个 tick 内**把 config 切到 B —— 此时 generate 正卡在
 * sharp 编码的 await 上，切库必然发生在写库之前。断言 B 库那行纹丝不动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { config } from '../config.js'
import { closeDb, getDb } from '../db/index.js'
import { ensureThumbnail } from './thumbnails.js'

/** 用例期间会临时改写三个路径配置，结束后恢复成进程启动时的值 */
const originalConfig = {
  libraryRoot: config.libraryRoot,
  cacheDir: config.cacheDir,
  dbPath: config.dbPath,
}

interface Lib {
  root: string
  cache: string
  dbPath: string
}

function makeLib(dir: string): Lib {
  const lib: Lib = {
    root: path.join(dir, 'photos'),
    cache: path.join(dir, 'cache'),
    dbPath: path.join(dir, 'library.db'),
  }
  fs.mkdirSync(lib.root, { recursive: true })
  fs.mkdirSync(lib.cache, { recursive: true })
  return lib
}

function useLib(lib: Lib): void {
  config.libraryRoot = lib.root
  config.cacheDir = lib.cache
  config.dbPath = lib.dbPath
}

/** 插一行最小可用的资产（thumb_status 默认 pending） */
function insertAsset(relPath: string): void {
  getDb()
    .prepare(
      `INSERT INTO assets (file_path, type, filename, date_taken) VALUES (?, 'photo', ?, ?)`,
    )
    .run(relPath, path.basename(relPath), '2020-01-01T00:00:00+08:00')
}

function thumbStatus(assetId: number): string {
  const row = getDb()
    .prepare(`SELECT thumb_status FROM assets WHERE id = ?`)
    .get(assetId) as { thumb_status: string } | undefined
  assert.ok(row, `资产 ${assetId} 应存在`)
  return row.thumb_status
}

test('C-02：生成期间切库 → 不写新库的同 id 资产，也不在新库缓存落文件', async () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-owner-a-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-owner-b-'))
  try {
    const a = makeLib(dirA)
    const b = makeLib(dirB)

    // A 库：真实图片 + 一行 pending 资产（id=1）
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
      .jpeg()
      .toFile(path.join(a.root, 'a.jpg'))
    useLib(a)
    insertAsset('a.jpg')

    // B 库：只有一行 pending 资产（id 同样是 1，故意不建文件、不生成缩略图）
    useLib(b)
    insertAsset('b.jpg')

    // 回到 A 发起生成；verify 切库发生在其写库之前
    useLib(a)
    const pending = ensureThumbnail(1, 'grid', 'interactive')
    // 同一个 tick 内切到 B：generate 此刻正卡在 sharp 编码的 await 上
    useLib(b)
    const result = await pending

    assert.equal(result, null, '切库后应整段放弃，不得返回旧库的缓存路径')
    assert.equal(thumbStatus(1), 'pending', '新库同 id 资产的 thumb_status 不得被旧库任务改写')
    assert.equal(
      fs.existsSync(path.join(b.cache, 'thumbs', 'grid', '1.webp')),
      false,
      '也不得在新库缓存目录里落一份错位的缩略图',
    )
    // 旧库那行的状态同样不该被写（任务已放弃，不是「成功」）
    useLib(a)
    assert.equal(thumbStatus(1), 'pending', '放弃的任务不应把旧库资产标成 done')
  } finally {
    closeDb()
    config.libraryRoot = originalConfig.libraryRoot
    config.cacheDir = originalConfig.cacheDir
    config.dbPath = originalConfig.dbPath
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  }
})

test('C-02 对照：不切库时同一条链路正常生成并置 done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-owner-ok-'))
  try {
    const lib = makeLib(dir)
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
      .jpeg()
      .toFile(path.join(lib.root, 'a.jpg'))
    useLib(lib)
    insertAsset('a.jpg')

    const out = await ensureThumbnail(1, 'grid', 'interactive')
    assert.ok(out, '未切库时应正常生成')
    assert.ok(fs.existsSync(out), '缩略图文件应落盘')
    assert.equal(thumbStatus(1), 'done')
  } finally {
    closeDb()
    config.libraryRoot = originalConfig.libraryRoot
    config.cacheDir = originalConfig.cacheDir
    config.dbPath = originalConfig.dbPath
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
