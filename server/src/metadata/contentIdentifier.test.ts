/**
 * Apple MakerNote 里实况 UUID（tag 0x0011）的提取测试
 *
 * 为什么手工构造字节而不是拿真实照片当 fixture：
 *   ① 真实 HEIC 动辄几 MB，进不了仓库；② 我们要守的是**解析器对各种布局的处理**，
 *   包括真实文件里遇不到的畸形输入（非 Apple 头、非法长度、IFD 链）。真实文件的
 *   端到端验证放在下面的可选用例里，本机有样本才跑，不判失败。
 *
 * 布局参考（用真实 iPhone HEIC 核对过，见 metadata/index.ts 的注释）：
 *   0..10  "Apple iOS\0"，10..12 版本，12..14 字节序，14..16 填充，16..20 首 IFD 偏移
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractContentIdentifier, readImageMeta, readVideoMeta } from './index.js'

const UUID_A = '02DCEE37-674E-45DB-8827-6F9247450230'
const UUID_B = '21B3E117-0541-40BF-9A0C-1BD54F121F96'

interface MakerNoteOptions {
  uuid?: string
  /** 小端（"II"）；默认大端（"MM"） */
  little?: boolean
  /** 把 0x0011 放到第二个 IFD，第一个只放个无关标签（测 IFD 链跟随） */
  secondIfd?: boolean
  /** 改掉文件头，模拟安卓等非 Apple MakerNote */
  header?: string
  /** 覆盖 0x0011 条目的长度字段（测非法长度被跳过） */
  declaredLength?: number
}

/** 构造一块 Apple MakerNote 字节（结构见文件头注释） */
function buildMakerNote(opts: MakerNoteOptions = {}): Buffer {
  const le = opts.little ?? false
  const uuidBuf = Buffer.from(opts.uuid ?? UUID_A, 'latin1')
  const ifdSize = 18 // count(2) + 一个条目(12) + next 指针(4)
  const ifdA = 20
  const ifdB = ifdA + ifdSize
  const uuidAt = ifdB + (opts.secondIfd ? ifdSize : 0)

  const buf = Buffer.alloc(uuidAt + uuidBuf.length)
  buf.write(opts.header ?? 'Apple iOS\0', 0, 'latin1')
  buf.writeUInt16BE(2, 10)
  buf.write(le ? 'II' : 'MM', 12, 'latin1')
  const w16 = (v: number, o: number): void => {
    if (le) buf.writeUInt16LE(v, o)
    else buf.writeUInt16BE(v, o)
  }
  const w32 = (v: number, o: number): void => {
    if (le) buf.writeUInt32LE(v, o)
    else buf.writeUInt32BE(v, o)
  }
  w32(ifdA - 12, 16) // 首 IFD 偏移（相对字节序字段）

  /** 写一个「只有一个条目」的 IFD；nextRel 为 0 表示没有下一个 */
  const writeIfd = (at: number, tag: number, nextRel: number): void => {
    w16(1, at) // 条目数
    w16(tag, at + 2)
    w16(7, at + 4) // type = UNDEFINED
    w32(opts.declaredLength ?? uuidBuf.length, at + 6)
    w32(uuidAt - 12, at + 10) // 值偏移（相对字节序字段）
    w32(nextRel, at + 16) // next IFD
  }

  if (opts.secondIfd) {
    writeIfd(ifdA, 0x0001, ifdB - 12)
    writeIfd(ifdB, 0x0011, 0)
  } else {
    writeIfd(ifdA, 0x0011, 0)
  }
  uuidBuf.copy(buf, uuidAt)
  return buf
}

test('extractContentIdentifier：大端 MakerNote 命中 0x0011', () => {
  assert.equal(extractContentIdentifier(buildMakerNote()), UUID_A)
})

test('extractContentIdentifier：小端 MakerNote 同样命中', () => {
  assert.equal(extractContentIdentifier(buildMakerNote({ little: true })), UUID_A)
  assert.equal(extractContentIdentifier(buildMakerNote({ little: true, uuid: UUID_B })), UUID_B)
})

test('extractContentIdentifier：0x0011 不在首个 IFD 时跟随 next 指针', () => {
  assert.equal(extractContentIdentifier(buildMakerNote({ secondIfd: true })), UUID_A)
})

test('extractContentIdentifier：非 Apple 头退化为全文匹配', () => {
  // 安卓 / 相机厂商的 MakerNote 结构完全不同，不该硬按 Apple 布局解析
  const buf = buildMakerNote({ header: 'Android\0\0\0' })
  assert.equal(extractContentIdentifier(buf), UUID_A)
})

test('extractContentIdentifier：非 Apple 头且无 UUID → null', () => {
  const pad = Buffer.from('Android\0\0\0 no identifier here, just padding bytes', 'latin1')
  assert.equal(extractContentIdentifier(pad), null)
})

test('extractContentIdentifier：结构无法解析时用正则兜底', () => {
  // 头部像 Apple 但字节序字段是垃圾 → 走 matchUuidText 兜底
  const buf = buildMakerNote()
  buf.write('XX', 12, 'latin1')
  assert.equal(extractContentIdentifier(buf), UUID_A)
})

test('extractContentIdentifier：条目声明的长度离谱时不越界，退化为正则命中', () => {
  // 长度 1000 远超限制（>128）：结构解析必须跳过它而不是拿它去 subarray 越界读取，
  // 跳过之后靠全文正则仍能拿到值——两者都不允许抛异常
  const buf = buildMakerNote({ declaredLength: 1000 })
  assert.equal(extractContentIdentifier(buf), UUID_A)
})

test('extractContentIdentifier：exifr 返回的「偏移→字节值」对象形态', () => {
  // exifr 7.x 没有 Apple MakerNote 标签表，makerNote 是 {0: 65, 1: 112, …} 的普通对象。
  // 数字键按规范升序枚举，Object.values 的顺序就是原始字节顺序。
  const buf = buildMakerNote()
  const asObject: Record<number, number> = {}
  for (let i = 0; i < buf.length; i++) asObject[i] = buf[i]
  assert.equal(extractContentIdentifier(asObject), UUID_A)
})

test('extractContentIdentifier：空 / 畸形输入返回 null，不抛异常', () => {
  assert.equal(extractContentIdentifier(undefined), null)
  assert.equal(extractContentIdentifier(null), null)
  assert.equal(extractContentIdentifier({}), null)
  assert.equal(extractContentIdentifier(Buffer.alloc(0)), null)
  assert.equal(extractContentIdentifier(Buffer.from([1, 2, 3])), null)
  assert.equal(extractContentIdentifier('not bytes'), null)
  assert.equal(extractContentIdentifier([1, 'x', 3]), null)
})

/** 本机实况样本目录（存在才跑下面的端到端用例，仓库里没有这些文件） */
const SAMPLE_ROOT = 'F:/Agent Program/icloud-app-agent/TestPhotoLib/live-samples'

test('readImageMeta / readVideoMeta：真实 HEIC 与 MOV 的 UUID 对得上', async (t) => {
  const still = `${SAMPLE_ROOT}/2018/02/03/IMG_0006.HEIC`
  const mov = `${SAMPLE_ROOT}/2018/02/03/IMG_0006_HEVC.MOV`
  if (!fs.existsSync(still) || !fs.existsSync(mov)) return t.skip('本机无实况样本')

  const img = await readImageMeta(still)
  const video = await readVideoMeta(mov)
  assert.match(img.contentIdentifier ?? '', /^[0-9a-f-]{36}$/i)
  assert.equal(video.contentIdentifier, img.contentIdentifier)
  // 顺带确认没有为了 UUID 破坏原有字段
  assert.ok(img.dateTaken, '拍摄时间仍应解析成功')
  assert.ok(video.duration && video.duration > 0, '视频时长仍应解析成功')
  assert.ok(video.width && video.height, '视频分辨率仍应解析成功')
  // 图片尺寸不断言：HEIC 的宽高在 ISPE box 里，EXIF 常常没有，原实现就靠 sharp 兜底
})
