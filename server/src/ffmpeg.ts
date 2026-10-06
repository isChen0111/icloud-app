/**
 * FFmpeg / FFprobe 子进程封装。
 *
 * 优先使用显式环境变量；否则从 FFMPEG_DIR（默认 vendor/ffmpeg-full）
 * 查找同目录的 ffmpeg 与 ffprobe。参数以数组传给 spawn，不经过 shell。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  bit_rate?: number | string
}

interface FfprobeFormat {
  duration?: number | string
  bit_rate?: number | string
  tags?: Record<string, string | undefined>
}

interface FfprobeResult {
  streams?: FfprobeStream[]
  format?: FfprobeFormat
}

function findToolPair(directory: string): { ffmpegPath: string; ffprobePath: string } | null {
  if (!fs.existsSync(directory)) return null

  const entries = fs.readdirSync(directory, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = findToolPair(fullPath)
      if (nested) return nested
      continue
    }

    if (entry.isFile() && /^ffmpeg(?:\.exe)?$/i.test(entry.name)) {
      const ffprobeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      const ffprobePath = path.join(directory, ffprobeName)
      if (fs.existsSync(ffprobePath) && fs.statSync(ffprobePath).isFile()) {
        return { ffmpegPath: fullPath, ffprobePath }
      }
    }
  }
  return null
}

function resolveToolPaths(): { ffmpegPath: string; ffprobePath: string } {
  const ffmpegPath = process.env.FFMPEG_PATH
  const ffprobePath = process.env.FFPROBE_PATH

  if (ffmpegPath || ffprobePath) {
    const inferredFfmpeg =
      ffmpegPath ?? (ffprobePath ? path.join(path.dirname(ffprobePath), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : '')
    const inferredFfprobe =
      ffprobePath ?? (ffmpegPath ? path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : '')
    if (
      inferredFfmpeg &&
      inferredFfprobe &&
      fs.existsSync(inferredFfmpeg) &&
      fs.statSync(inferredFfmpeg).isFile() &&
      fs.existsSync(inferredFfprobe) &&
      fs.statSync(inferredFfprobe).isFile()
    ) {
      return { ffmpegPath: inferredFfmpeg, ffprobePath: inferredFfprobe }
    }
    throw new Error('FFMPEG_PATH / FFPROBE_PATH must point to existing executable files (or sibling executables).')
  }

  const pair = findToolPair(config.ffmpegDir)
  if (pair) return pair
  throw new Error(
    `FFmpeg tools not found under "${config.ffmpegDir}". Install vendor binaries or set FFMPEG_PATH and FFPROBE_PATH.`,
  )
}

const tools = resolveToolPaths()

export interface RunProcessOptions {
  /** 是否收集 stdout（ffprobe -of json 需要；ffmpeg 输出不收集） */
  collectStdout?: boolean
  /**
   * 子进程超时（毫秒，修复审查 F-07）：到点 kill 并等待 close 后才 reject，
   * 防止 ffmpeg/ffprobe 卡死（损坏文件/网络盘挂起）时 Promise 永不结束、
   * 任务永久占住队列槽位。错误信息带 "timed out ... and was killed" + stderr 尾部。
   */
  timeoutMs: number
}

/**
 * 通用子进程运行（导出供单元测试直接验证超时/kill 逻辑；生产由 runFfmpeg/ffprobeJson 使用）。
 * 返回 stdout 全文（collectStdout 时），失败/超时 reject 并附 stderr 尾部。
 */
export function runProcess(binaryPath: string, args: string[], options: RunProcessOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    // settled 防双 settle：error/close 只允许一次生效；timedOut 区分「超时被杀」与「正常非零退出」
    let settled = false
    let timedOut = false

    child.stdout.on('data', (chunk: Buffer) => {
      if (options.collectStdout) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const maxStderrBytes = 8 * 1024
      if (chunk.length >= maxStderrBytes) {
        stderrTail = chunk.subarray(-maxStderrBytes)
      } else {
        const combined = Buffer.concat([stderrTail, chunk])
        stderrTail = combined.subarray(Math.max(0, combined.length - maxStderrBytes))
      }
    })

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      console.warn(
        `[ffmpeg] ${path.basename(binaryPath)} 超过 ${options.timeoutMs}ms 未退出，已 kill（防止卡死占槽）`,
      )
      child.kill() // Windows 下即强制终止；close 事件随后触发，由 close 统一 settle
    }, options.timeoutMs)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Failed to start ${path.basename(binaryPath)}: ${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const detail = stderrTail.toString('utf8').trim()
      if (timedOut) {
        reject(
          new Error(
            `${path.basename(binaryPath)} timed out after ${options.timeoutMs}ms and was killed${detail ? `: ${detail}` : ''}`,
          ),
        )
        return
      }
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'))
        return
      }
      reject(new Error(`${path.basename(binaryPath)} exited with code ${code}${detail ? `: ${detail}` : ''}`))
    })
  })
}

/** 执行 FFmpeg 命令；args 不应包含可执行文件本身。超时由 config.ffmpegTimeoutMs 控制（F-07）。 */
export async function runFfmpeg(args: string[]): Promise<void> {
  await runProcess(tools.ffmpegPath, args, { timeoutMs: config.ffmpegTimeoutMs })
}

/** 读取 FFprobe JSON 元数据。超时由 config.ffprobeTimeoutMs 控制（F-07）。 */
export async function ffprobeJson(filePath: string): Promise<FfprobeResult> {
  const output = await runProcess(
    tools.ffprobePath,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
    { collectStdout: true, timeoutMs: config.ffprobeTimeoutMs },
  )
  try {
    return JSON.parse(output) as FfprobeResult
  } catch (error) {
    throw new Error(`FFprobe returned invalid JSON for "${filePath}": ${(error as Error).message}`)
  }
}
