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

function run(binaryPath: string, args: string[], collectStdout: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0)

    child.stdout.on('data', (chunk: Buffer) => {
      if (collectStdout) stdout.push(chunk)
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
    child.on('error', (error) => reject(new Error(`Failed to start ${path.basename(binaryPath)}: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'))
        return
      }
      const detail = stderrTail.toString('utf8').trim()
      reject(new Error(`${path.basename(binaryPath)} exited with code ${code}${detail ? `: ${detail}` : ''}`))
    })
  })
}

/** 执行 FFmpeg 命令；args 不应包含可执行文件本身。 */
export async function runFfmpeg(args: string[]): Promise<void> {
  await run(tools.ffmpegPath, args, false)
}

/** 读取 FFprobe JSON 元数据。 */
export async function ffprobeJson(filePath: string): Promise<FfprobeResult> {
  const output = await run(
    tools.ffprobePath,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
    true,
  )
  try {
    return JSON.parse(output) as FfprobeResult
  } catch (error) {
    throw new Error(`FFprobe returned invalid JSON for "${filePath}": ${(error as Error).message}`)
  }
}
