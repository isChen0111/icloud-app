/**
 * FFmpeg/FFprobe 子进程超时逻辑单元测试（修复审查 F-07）。
 *
 * 用 process.execPath（node）模拟任意"可执行文件"：
 * - 正常用例：子进程立即输出并退出 → 应 resolve 且不误杀；
 * - 超时用例：子进程挂起（setInterval 不退出）→ 到点应被 kill、reject 且消息带 "timed out"。
 * 生产路径（runFfmpeg/ffprobeJson）同用 runProcess，因此此处直接验证 runProcess。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runProcess } from './ffmpeg.js'

test('runProcess：子进程正常完成 → resolve stdout，不误杀', async () => {
  const out = await runProcess(process.execPath, ['-e', "console.log('hello')"], {
    collectStdout: true,
    timeoutMs: 5_000,
  })
  assert.equal(out.trim(), 'hello')
})

test('runProcess：子进程挂起 → 超时 kill + reject，消息带 timed out', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      collectStdout: false,
      timeoutMs: 300,
    }),
    /timed out after 300ms and was killed/,
  )
})
