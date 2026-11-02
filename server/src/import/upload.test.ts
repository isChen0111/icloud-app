/**
 * 上传工具（相对路径清洗 + 临时目录管理）单元测试
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import Fastify from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import { sanitizeRelPath, importTempDir, newImportSessionId, cleanImportTempDir, cleanStaleImportTemp, resolveMultipartFileSize, parseUploadMtimes, applyUploadMtimes, resolveMultipartOptions } from './upload.js'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('sanitizeRelPath：保留相对层级并统一正斜杠', () => {
  assert.equal(sanitizeRelPath('2024/三亚/IMG_1.jpg'), '2024/三亚/IMG_1.jpg')
  assert.equal(sanitizeRelPath('a\\b\\c.jpg'), 'a/b/c.jpg')
  assert.equal(sanitizeRelPath('./a/b.jpg'), 'a/b.jpg')
  assert.equal(sanitizeRelPath('IMG_1.HEIC'), 'IMG_1.HEIC')
})

test('sanitizeRelPath：拒绝目录穿越', () => {
  assert.throws(() => sanitizeRelPath('../etc/passwd'))
  assert.throws(() => sanitizeRelPath('a/../../b.jpg'))
})

test('sanitizeRelPath：拒绝绝对路径', () => {
  assert.throws(() => sanitizeRelPath('/etc/passwd'))
  assert.throws(() => sanitizeRelPath('C:/windows/x.jpg'))
  assert.throws(() => sanitizeRelPath('C:\\windows\\x.jpg'))
})

test('sanitizeRelPath：拒绝空路径', () => {
  assert.throws(() => sanitizeRelPath(''))
  assert.throws(() => sanitizeRelPath('.'))
})

test('importTempDir + cleanImportTempDir：创建与清理', async () => {
  const dir = tempDir('import-upload-')
  try {
    const cacheDir = path.join(dir, 'cache')
    const tmp = importTempDir(cacheDir, newImportSessionId())
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'a.jpg'), 'x')
    assert.ok(fs.existsSync(tmp))
    await cleanImportTempDir(tmp)
    assert.ok(!fs.existsSync(tmp))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanStaleImportTemp：只清理超龄残留，保留新鲜目录', async () => {
  const dir = tempDir('import-upload-')
  try {
    const cacheDir = path.join(dir, 'cache')
    const oldDir = importTempDir(cacheDir, 'old')
    const freshDir = importTempDir(cacheDir, 'fresh')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(freshDir, { recursive: true })
    // 把 old 目录的 mtime 改到 48h 前，模拟上次异常退出残留
    const past = new Date(Date.now() - 48 * 3600 * 1000)
    fs.utimesSync(oldDir, past, past)

    await cleanStaleImportTemp(cacheDir)

    assert.ok(!fs.existsSync(oldDir), '超龄残留应被清理')
    assert.ok(fs.existsSync(freshDir), '新鲜目录应保留')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveMultipartFileSize：0（不限）→ Infinity，>0 → 原值', () => {
  // 回归钉住 2026-10-31 的 bug：fileSize 传 undefined 会被 @fastify/multipart
  // 回落到 Fastify bodyLimit（1 MiB），正常照片也报「request file too large」。
  assert.equal(resolveMultipartFileSize(0), Infinity, '0 必须映射成 Infinity，而不是 undefined')
  assert.equal(resolveMultipartFileSize(5_000_000), 5_000_000)
  assert.equal(resolveMultipartFileSize(-1), Infinity, '负数同样视为不限')
})

test('parseUploadMtimes：解析 JSON 并归一化 key，过滤非法值', () => {
  const map = parseUploadMtimes(JSON.stringify({
    '2024/三亚/IMG_1.jpg': 1720000000000,
    'a\\b\\c.jpg': 1730000000000,
    'bad': -1,
    'zero': 0,
    'notnum': 'abc',
  }))
  assert.equal(map['2024/三亚/IMG_1.jpg'], 1720000000000)
  assert.equal(map['a/b/c.jpg'], 1730000000000, '反斜杠 key 应归一化成正斜杠')
  assert.ok(!('bad' in map), '负值应被忽略')
  assert.ok(!('zero' in map), '0 应被忽略')
  assert.ok(!('notnum' in map), '非数字应被忽略')
  assert.deepEqual(parseUploadMtimes(undefined), {}, '缺失 JSON → 空对象')
  assert.deepEqual(parseUploadMtimes('{bad json'), {}, '坏 JSON → 空对象，不抛错')
  assert.deepEqual(parseUploadMtimes('[1,2]'), {}, '非对象 → 空对象')
})

test('applyUploadMtimes：把 lastModified 回设到落盘文件', async () => {
  const dir = tempDir('import-mtime-')
  try {
    const dest = path.join(dir, 'sub', 'IMG_1.jpg')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'x')

    const target = new Date(2016, 2, 12, 12, 59, 5) // 一个明显不是「现在」的时间
    await applyUploadMtimes([{ dest, rel: 'sub/IMG_1.jpg' }], JSON.stringify({ 'sub/IMG_1.jpg': target.getTime() }))

    const st = fs.statSync(dest)
    assert.equal(Math.trunc(st.mtimeMs), Math.trunc(target.getTime()), 'mtime 应被回设为前端传来的 lastModified')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 构造与浏览器一致的多段 multipart 请求体（files 在前、mtimes 字段在后，与 client.ts 顺序一致）。
 * filename 带目录是「整文件夹上传」的关键：浏览器把 webkitRelativePath 塞进 filename。
 */
function buildMultipart(boundary: string, relPath: string, mtimesJson: string): string {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="files"; filename="${relPath}"`,
    'Content-Type: image/jpeg',
    '',
    'dummy-bytes',
    `--${boundary}`,
    'Content-Disposition: form-data; name="mtimes"',
    '',
    mtimesJson,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

test('上传链路端到端：filename 保留相对目录，mtime 按 relPath 正确回设', async () => {
  // 回归钉住 2026-11-01 的 bug：busboy 默认 preservePath=false 会把 filename 剥成裸文件名，
  // 导致 mtimes 的 key（完整相对路径）永远匹配不上落盘 rel，回设静默失效，
  // 无 EXIF 日期的文件被归到「上传当天」。单测 parseUploadMtimes/applyUploadMtimes 全绿也发现不了，
  // 必须用真实 multipart 请求验证「收到的 filename 是什么」。
  const app = Fastify()
  await app.register(fastifyMultipart, resolveMultipartOptions(0))
  const dir = tempDir('import-wire-')
  try {
    const written: { dest: string; rel: string }[] = []
    app.post('/upload', async (request) => {
      let mtimesJson: string | undefined
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'mtimes') mtimesJson = String(part.value ?? '')
          continue
        }
        if (part.type !== 'file') continue
        const rel = sanitizeRelPath(part.filename)
        const dest = path.join(dir, rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        await new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(dest)
          part.file.pipe(ws)
          ws.on('finish', () => resolve())
          ws.on('error', reject)
        })
        written.push({ dest, rel })
      }
      await applyUploadMtimes(written, mtimesJson)
      return { rels: written.map((w) => w.rel), mtimes: written.map((w) => Math.trunc(fs.statSync(w.dest).mtimeMs)) }
    })

    const boundary = '----wbTestBoundary'
    const relPath = 'export/2015/05/03/31f76eb0.JPG'
    const expected = new Date(2015, 4, 3, 11, 46, 57).getTime()
    const res = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: buildMultipart(boundary, relPath, JSON.stringify({ [relPath]: expected })),
    })

    assert.equal(res.statusCode, 200)
    const body = res.json() as { rels: string[]; mtimes: number[] }
    assert.deepEqual(body.rels, [relPath], 'filename 必须保留相对目录（preservePath: true）')
    assert.equal(body.mtimes[0], expected, 'mtime 必须按完整相对路径匹配并回设为 lastModified')
    assert.ok(fs.existsSync(path.join(dir, relPath)), '文件应落在保留层级的临时目录里')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ============ 审查 C-10：文件名净化（Windows 保留名 / 非法字符 / 结尾点空格 / 超长） ============ */

test('C-10：Windows 保留设备名加前缀，避免字节流向设备、文件不落盘', () => {
  // CON.jpg 在 Win32 上 open 成功但内容进了设备，接口却返回 200「导入完成」
  assert.equal(sanitizeRelPath('CON.jpg'), '_CON.jpg')
  assert.equal(sanitizeRelPath('nul.mp4'), '_nul.mp4')
  assert.equal(sanitizeRelPath('COM1.mov'), '_COM1.mov')
  assert.equal(sanitizeRelPath('LPT9'), '_LPT9')
  // 只是以保留名开头的正常文件名不受影响（判断只看第一个点之前）
  assert.equal(sanitizeRelPath('CONSOLE.jpg'), 'CONSOLE.jpg')
  assert.equal(sanitizeRelPath('NUL_2.jpg'), 'NUL_2.jpg')
})

test('C-10：非法字符替换为下划线，目录段同样处理', () => {
  // a:b.jpg 在 NTFS 上会变成备用数据流，写出来是 0 字节
  assert.equal(sanitizeRelPath('a:b.jpg'), 'a_b.jpg')
  assert.equal(sanitizeRelPath('a*b?c.jpg'), 'a_b_c.jpg')
  assert.equal(sanitizeRelPath('x<y>z|w.jpg'), 'x_y_z_w.jpg')
  assert.equal(sanitizeRelPath('2024/三亚:海边/IMG_1.jpg'), '2024/三亚_海边/IMG_1.jpg')
})

test('C-10：结尾的点与空格去掉，避免两个不同文件归一化成同一个', () => {
  // Win32 会静默丢弃结尾点，`x.jpg.` 与 `x.jpg` 指向同一文件 → 后传的覆盖前一个
  assert.equal(sanitizeRelPath('x.jpg.'), 'x.jpg')
  assert.equal(sanitizeRelPath('x.jpg   '), 'x.jpg')
  assert.equal(sanitizeRelPath('dir./a.jpg'), 'dir/a.jpg')
  // 整段只有点 → 兜底成 _
  assert.equal(sanitizeRelPath('...'), '_')
})

test('C-10：超长段截断但保留扩展名', () => {
  const long = `${'a'.repeat(300)}.jpg`
  const out = sanitizeRelPath(long)
  assert.ok(out.length <= 200, `截断后不应超过 200，实际 ${out.length}`)
  assert.ok(out.endsWith('.jpg'), '必须保留扩展名，否则 scanner 不认')
})

test('C-10：mtimes 的 key 与落盘路径用同一套净化，回设才不会静默失效', () => {
  const map = parseUploadMtimes(JSON.stringify({ 'a:b.jpg': 1700000000000, 'CON.jpg': 1700000000001 }))
  assert.deepEqual(Object.keys(map).sort(), ['_CON.jpg', 'a_b.jpg'])
})
