/**
 * 第四批修复的工具函数单测（R-17 / R-18 / R-23 / R-26）
 *
 * 覆盖的都是「纯函数 / 只依赖文件系统」的小逻辑，不需要起服务：
 *  - parseOffset：Infinity/NaN/负数/小数/上限 归一化（R-23）
 *  - toDateCompact：扫描入库与启动回填共用同一实现（R-26）
 *  - toLocalIso / hasTimezoneOffset：date_taken 统一为「本地时间 + 偏移」（R-08）
 *  - isCacheUsable：0 字节坏缓存不能算命中（R-17）
 *  - 搜索错误分类：库损坏必须 5xx，不能被 `malformed` 白名单吞成「没有结果」（R-18）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isCacheUsable } from '../pipeline/thumbnails.js'
import { isDbCorruptError, isExpectedFtsInputError } from '../routes/search.js'
import { hasTimezoneOffset, toDateCompact, toLocalIso } from './date.js'
import { MAX_OFFSET, parseOffset } from './paging.js'

test('parseOffset：非有限值一律归 0（R-23，Infinity 曾直接绑定到 SQLite OFFSET 报 500）', () => {
  assert.equal(parseOffset(undefined), 0)
  assert.equal(parseOffset(null), 0)
  assert.equal(parseOffset(''), 0)
  assert.equal(parseOffset('abc'), 0)
  assert.equal(parseOffset('NaN'), 0)
  assert.equal(parseOffset('Infinity'), 0)
  assert.equal(parseOffset('-Infinity'), 0)
  assert.equal(parseOffset('1e999'), 0) // Number 溢出成 Infinity
})

test('parseOffset：负数归 0、小数向下取整、超上限钳制、正常值原样返回', () => {
  assert.equal(parseOffset('-5'), 0)
  assert.equal(parseOffset('12.9'), 12)
  assert.equal(parseOffset('200'), 200)
  assert.equal(parseOffset('0'), 0)
  assert.equal(parseOffset(String(MAX_OFFSET + 1)), MAX_OFFSET)
  assert.equal(parseOffset('1e9'), MAX_OFFSET)
})

test('toDateCompact：只保留字母数字并截掉毫秒/时区，同一时刻只有一种表示（R-26 / R-08）', () => {
  // 毫秒与时区后缀都被截掉，只留本地时间的数字 + T
  assert.equal(toDateCompact('2024-09-13T08:40:28.000Z'), '20240913T084028')
  assert.equal(toDateCompact('2024-09-13T08:40:28+08:00'), '20240913T084028')
  assert.equal(toDateCompact('2025-02-17T00:00:00+08:00'), '20250217T000000')
  assert.equal(toDateCompact(null), '')
  assert.equal(toDateCompact(undefined), '')
  // 关键回归点一：旧回填 SQL 会删掉 T（20240913084028），新实现保留 T
  assert.ok(toDateCompact('2024-09-13T08:40:28Z').includes('T'))
  // 关键回归点二（R-08）：偏移不能被压成尾巴数字，否则搜索串里凭空多出 0800
  assert.equal(toDateCompact('2024-09-13T08:40:28+08:00').endsWith('0800'), false)
})

test('isCacheUsable：0 字节/截断缓存不算命中，正常文件才算（R-17）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-cache-'))
  try {
    const missing = path.join(dir, '404.webp')
    assert.equal(isCacheUsable(missing), false, '不存在 → 不可用')

    const empty = path.join(dir, '0.webp')
    fs.writeFileSync(empty, '')
    assert.equal(isCacheUsable(empty), false, '0 字节（断电/磁盘满的典型产物）→ 不可用')

    const ok = path.join(dir, 'ok.webp')
    fs.writeFileSync(ok, Buffer.from('RIFFxxxxWEBP', 'ascii'))
    assert.equal(isCacheUsable(ok), true, '有内容 → 可用')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('搜索错误分类：库损坏走 5xx，不再被 malformed 白名单吞掉（R-18）', () => {
  const corrupt = new Error('database disk image is malformed')
  assert.equal(isDbCorruptError(corrupt), true)
  // 顺序不变量：损坏错误绝不能同时被判为「输入问题」
  assert.equal(isExpectedFtsInputError(corrupt), false)

  const corrupt2 = new Error('file is not a database')
  assert.equal(isDbCorruptError(corrupt2), true)
})

test('搜索错误分类：真正的输入级 FTS 报错仍返回空结果（R-18 不能过度收紧）', () => {
  for (const msg of [
    'fts5: syntax error near "AND"',
    'malformed MATCH expression: [foo AND]',
    'unterminated string',
    'no such column: 09',
  ]) {
    const err = new Error(msg)
    assert.equal(isExpectedFtsInputError(err), true, msg)
    assert.equal(isDbCorruptError(err), false, msg)
  }
})

/** 本机时区偏移后缀，如 +08:00 / -05:00（测试不假定机器在东八区） */
function localSuffix(offsetMin: number): string {
  const abs = Math.abs(offsetMin)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${offsetMin >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

test('toLocalIso：输出「本地时间 + 偏移」，不带毫秒，且时刻与输入完全一致（R-08）', () => {
  const input = new Date('2024-09-13T00:40:28.000Z')
  const iso = toLocalIso(input)
  assert.ok(iso, '有效 Date 必须返回字符串')
  // 形如 2024-09-13T08:40:28+08:00：秒级精度、带偏移、不带毫秒
  assert.match(iso!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  // 关键不变量：解析回来必须还是同一个时刻（迁移不能改变照片的真实时间）
  assert.equal(new Date(iso!).getTime(), input.getTime())
  // 偏移段必须与本机时区一致
  assert.ok(iso!.endsWith(localSuffix(-input.getTimezoneOffset())), `偏移应为本机时区: ${iso}`)
  // 无效 Date 返回 null，调用方可以据此跳过而不是写入 "Invalid Date"
  assert.equal(toLocalIso(new Date('nope')), null)
})

test('hasTimezoneOffset：只有带 ±HH:MM 的才算已迁移（R-08 迁移的跳过依据）', () => {
  assert.equal(hasTimezoneOffset('2024-09-13T08:40:28+08:00'), true)
  assert.equal(hasTimezoneOffset('2024-09-13T08:40:28-05:00'), true)
  // UTC 表示与裸时间都算「未迁移」，否则迁移会漏掉它们
  assert.equal(hasTimezoneOffset('2024-09-13T00:40:28.000Z'), false)
  assert.equal(hasTimezoneOffset('2024-09-13T08:40:28'), false)
})
