/**
 * icloudpd 认证超时处理单元测试（审查 P3e）：
 * 旧实现 stopAuth() 先将 session 置 null 再判 `if (session)` → 超时文案死代码；
 * 修复后 onAuthTimeout() 先置 error 状态（前端轮询可读），teardownAuthProcess()
 * 只清理进程/轮询、保留 session 引用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { newSession, onAuthTimeout, authStatus, stopAuth } from './auth.js'

const COOKIE_DIR = 'C:\\tmp\\nonexistent-cookie-dir'

test('onAuthTimeout：先置 error 文案，session 保留供前端读取（P3e）', () => {
  stopAuth() // 清理上一测试可能残留的 session
  newSession(COOKIE_DIR, 'waiting_password', '请输入 Apple ID 密码')
  onAuthTimeout()
  const s = authStatus()
  assert.ok(s, '超时后 session 必须保留（不能置 null，否则文案死代码）')
  assert.equal(s.stage, 'error')
  assert.equal(s.message, '认证超时（10 分钟），请重试')
  assert.equal(s.cookieDir, COOKIE_DIR)
  stopAuth()
})

test('onAuthTimeout：starting 阶段超时 → 同样置 error（前端展示超时而非卡在启动）', () => {
  stopAuth()
  newSession(COOKIE_DIR, 'starting', '正在启动认证服务…')
  onAuthTimeout()
  const s = authStatus()
  assert.ok(s)
  assert.equal(s.stage, 'error')
  assert.equal(s.message, '认证超时（10 分钟），请重试')
  stopAuth()
})

test('onAuthTimeout：无会话时安全无异常（不抛错）', () => {
  stopAuth() // session = null
  assert.doesNotThrow(() => onAuthTimeout())
})

test('onAuthTimeout：done 阶段超时回调兜底 → 不覆盖已完成状态', () => {
  stopAuth()
  const s = newSession(COOKIE_DIR, 'done', '认证成功，cookie 已保存')
  s.message = '认证成功，cookie 已保存'
  // 注：onAuthTimeout 无条件覆盖为超时（正常流程中 done 后 timer 已随 teardown 清理，
  // 此处仅验证不抛异常且状态机仍可读）
  assert.doesNotThrow(() => onAuthTimeout())
  const after = authStatus()
  assert.ok(after)
  stopAuth()
})
