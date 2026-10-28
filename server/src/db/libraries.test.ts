/**
 * 库名校验单元测试（审查 P3c：INVALID_DIR_CHARS 去 /g 消除 .test() 状态性）。
 *
 * 旧实现正则为 /[\\/:*?"<>|]/g：带 /g 的 .test() 会记住 lastIndex，
 * 第一次命中非法字符后 lastIndex 停在匹配末尾，第二次对合法名调用时从该位置
 * 继续搜索 → 合法名被误判/漏判。修复为不带 /g 后校验无状态。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDirs, validateLibraryName } from './libraries.js'

const ILLEGAL_CHARS = ['\\', '/', ':', '*', '?', '"', '<', '>', '|']

test('validateLibraryName：空/空白 → 报错', () => {
  assert.equal(validateLibraryName(''), '库名不能为空')
  assert.equal(validateLibraryName('   '), '库名不能为空')
  assert.equal(validateLibraryName('\t'), '库名不能为空')
})

test('validateLibraryName：超过 32 字符 → 报错', () => {
  assert.equal(validateLibraryName('a'.repeat(33)), '库名不能超过 32 个字符')
  // 32 字符为合法边界
  assert.equal(validateLibraryName('a'.repeat(32)), null)
})

test('validateLibraryName：路径非法字符 → 报错', () => {
  for (const ch of ILLEGAL_CHARS) {
    assert.equal(
      validateLibraryName(`库${ch}名`),
      '库名不能包含 \\ / : * ? " < > | 字符',
      `非法字符应被拦截: ${ch}`,
    )
  }
})

test('validateLibraryName：合法库名（含中文/空格/数字/连字符）→ null', () => {
  assert.equal(validateLibraryName('我的相册'), null)
  assert.equal(validateLibraryName('  My Photos 2026  '), null)
  assert.equal(validateLibraryName('home-lib_1'), null)
})

test('validateLibraryName：/g 状态性回归（P3c）——非法字符判定后再次校验合法名不得误判', () => {
  // 先命中一次非法字符（旧实现会把 lastIndex 停在匹配末尾）
  assert.equal(validateLibraryName('坏:名'), '库名不能包含 \\ / : * ? " < > | 字符')
  // 紧接着校验合法名：修复前 .test() 从 lastIndex 继续 → 可能误报/漏报
  assert.equal(validateLibraryName('好名'), null)
  // 多轮交替验证，防止 lastIndex 残留
  for (let i = 0; i < 3; i++) {
    assert.equal(validateLibraryName(`good-lib-${i}`), null)
  }
  // 再对所有非法字符重复"非法→合法"相邻调用
  for (const ch of ILLEGAL_CHARS) {
    assert.equal(validateLibraryName(`x${ch}y`), '库名不能包含 \\ / : * ? " < > | 字符')
    assert.equal(validateLibraryName('clean-name'), null, `相邻合法校验不得受 ${ch} 影响`)
  }
})

/**
 * 建库预建目录（2026-10-28）：建库时把照片根 / 缓存 / cookies 三层目录真的建出来，
 * 否则设置中心展示的三个路径全是「不存在的目录」，容易被误认为建库失败。
 */
test('ensureDirs：多层嵌套一次建出（含中间父目录）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-dirs-'))
  try {
    const photos = path.join(root, 'iCloudPhoto', 'lib9')
    const cache = path.join(root, 'cache', 'lib9')
    const cookies = path.join(cache, 'cookies')
    // 三个目录共享未知父级，recursive:true 应一次建出全部
    assert.deepEqual(ensureDirs([photos, cache, cookies]), [], '全部目录应创建成功')
    for (const dir of [photos, cache, cookies]) {
      assert.ok(fs.statSync(dir).isDirectory(), `${dir} 应已创建为目录`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensureDirs：幂等——目录已存在时重复调用不报错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-dirs-'))
  try {
    const target = path.join(root, 'cache', 'lib9', 'cookies')
    assert.deepEqual(ensureDirs([target]), [])
    // 第二次调用（目录已存在）仍应返回成功，不抛 EEXIST
    assert.deepEqual(ensureDirs([target]), [])
    assert.ok(fs.statSync(target).isDirectory())
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensureDirs：父级路径是文件时记入失败列表且不抛错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-dirs-'))
  try {
    // 造一个同名「文件」挡在父级位置，mkdir 其子路径必然失败（ENOTDIR/EEXIST）
    const blocker = path.join(root, 'blocker')
    fs.writeFileSync(blocker, 'x')
    const bad = path.join(blocker, 'sub')
    const ok = path.join(root, 'fine')
    const failed = ensureDirs([bad, ok])
    assert.deepEqual(failed, [bad], '只应返回失败的那个路径')
    assert.ok(fs.statSync(ok).isDirectory(), '同一批次里的正常目录仍应被创建')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
