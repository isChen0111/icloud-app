/**
 * 实况配对三态测试（UUID 优先 / 文件名兜底 / UUID 冲突不配）
 *
 * 判据的正确性只能靠注入 UUID 来验：真实带 UUID 的 HEIC+MOV 是几 MB 的二进制，
 * 不适合当 fixture。端到端那条路（真文件 → 真解析）由 metadata/contentIdentifier.test.ts
 * 用本机样本覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pairLiveAssets, type PairFile } from './pair.js'

const U1 = '02DCEE37-674E-45DB-8827-6F9247450230'
const U2 = '21B3E117-0541-40BF-9A0C-1BD54F121F96'

function file(relPath: string): PairFile {
  const fileName = relPath.slice(relPath.lastIndexOf('/') + 1)
  return { relPath, fileName, kind: /\.(mov|mp4|m4v)$/i.test(fileName) ? 'video' : 'image' }
}

/** 用「路径 → UUID」建查询函数；没列出的路径视为没有 UUID */
function cidMap(entries: Record<string, string | null>) {
  return (f: PairFile): string | null => entries[f.relPath] ?? null
}

/** 结果里每张图片的配对视频路径（没有就是 null），便于整体断言 */
function liveOf(assets: { image: PairFile; liveVideo: PairFile | null }[]) {
  return Object.fromEntries(assets.map((a) => [a.image.relPath, a.liveVideo?.relPath ?? null]))
}

test('UUID 一致 → 配成实况（同目录、文件名也匹配）', () => {
  const files = [file('2018/02/03/IMG_0006.HEIC'), file('2018/02/03/IMG_0006_HEVC.MOV')]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({
    '2018/02/03/IMG_0006.HEIC': U1,
    '2018/02/03/IMG_0006_HEVC.MOV': U1,
  }))
  assert.equal(livePairs, 1)
  assert.deepEqual(liveOf(assets), { '2018/02/03/IMG_0006.HEIC': '2018/02/03/IMG_0006_HEVC.MOV' })
})

test('跨目录 + 视频改名 → 仍靠 UUID 配上（文件名方案做不到的事）', () => {
  // iCloud 把静止帧和视频归进不同日期目录、视频又被改过名：
  // 文件名那一轮完全对不上（目录不同、基名也不同），只有 UUID 能救
  const files = [file('2018/02/04/IMG_0032.HEIC'), file('2018/02/05/renamed-clip-a1.mov')]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({
    '2018/02/04/IMG_0032.HEIC': U1,
    '2018/02/05/renamed-clip-a1.mov': U1,
  }))
  assert.equal(livePairs, 1)
  assert.deepEqual(liveOf(assets), { '2018/02/04/IMG_0032.HEIC': '2018/02/05/renamed-clip-a1.mov' })
})

test('同目录同名但 UUID 冲突 → 不配对，拆成照片 + 独立视频', () => {
  // 其中一半被外部工具重写过（重编码会剥掉 MakerNote / content.identifier）。
  // 硬配只会放出错误的片段，Apple 自己也认不出这对。
  const files = [file('d/IMG_0009.HEIC'), file('d/IMG_0009_HEVC.MOV')]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({
    'd/IMG_0009.HEIC': U1,
    'd/IMG_0009_HEVC.MOV': U2,
  }))
  assert.equal(livePairs, 0)
  assert.deepEqual(liveOf(assets), {
    'd/IMG_0009.HEIC': null,
    'd/IMG_0009_HEVC.MOV': null,
  })
})

test('只有一侧有 UUID → 文件名兜底照常配上', () => {
  const files = [file('d/IMG_0010.HEIC'), file('d/IMG_0010_HEVC.MOV')]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({ 'd/IMG_0010.HEIC': U1 }))
  assert.equal(livePairs, 1)
  assert.deepEqual(liveOf(assets), { 'd/IMG_0010.HEIC': 'd/IMG_0010_HEVC.MOV' })
})

test('两侧都没有 UUID（非 Apple 来源）→ 文件名兜底', () => {
  const files = [file('d/IMG_0011.JPG'), file('d/IMG_0011.MOV')]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({}))
  assert.equal(livePairs, 1)
  assert.deepEqual(liveOf(assets), { 'd/IMG_0011.JPG': 'd/IMG_0011.MOV' })
})

test('文件名兜底必须限定目录：不同目录的同名文件不能配', () => {
  const files = [file('a/IMG_0012.HEIC'), file('b/IMG_0012_HEVC.MOV')]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({}))
  assert.equal(livePairs, 0)
  assert.deepEqual(liveOf(assets), { 'a/IMG_0012.HEIC': null, 'b/IMG_0012_HEVC.MOV': null })
})

test('没有同名图片的视频是独立视频资产', () => {
  const files = [file('d/IMG_0020.MOV'), file('d/IMG_0021.MP4')]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({}))
  assert.equal(livePairs, 0)
  assert.deepEqual(liveOf(assets), { 'd/IMG_0020.MOV': null, 'd/IMG_0021.MP4': null })
})

test('同基名的多余图片与多余视频都不能丢（曾丢失 3382 个视频）', () => {
  const files = [
    file('d/IMG_0030.HEIC'),
    file('d/IMG_0030.JPG'), // 编辑变体
    file('d/IMG_0030_HEVC.MOV'),
    file('d/IMG_0030_1.MOV'), // 同基名（去 _HEVC 后）的第二个视频
  ]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({}))
  assert.equal(livePairs, 1)
  assert.equal(assets.length, 3, '4 个文件应变成 3 个资产：实况 1 + 独立照片 1 + 独立视频 1')
  assert.deepEqual(liveOf(assets), {
    'd/IMG_0030.HEIC': 'd/IMG_0030_HEVC.MOV',
    'd/IMG_0030.JPG': null,
    'd/IMG_0030_1.MOV': null,
  })
})

test('同一 UUID 命中多个视频时优先同目录的那个', () => {
  const files = [
    file('a/IMG_0040.HEIC'),
    file('b/IMG_0040_HEVC.MOV'), // 复制到别处的同一张实况
    file('a/IMG_0040_HEVC.MOV'),
  ]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({
    'a/IMG_0040.HEIC': U1,
    'b/IMG_0040_HEVC.MOV': U1,
    'a/IMG_0040_HEVC.MOV': U1,
  }))
  assert.equal(livePairs, 1)
  const live = liveOf(assets)
  assert.equal(live['a/IMG_0040.HEIC'], 'a/IMG_0040_HEVC.MOV')
  // 没被选中的那个视频不能消失，作为独立视频入库
  assert.equal(assets.length, 2)
  assert.ok(assets.some((a) => a.image.relPath === 'b/IMG_0040_HEVC.MOV' && a.liveVideo === null))
})

test('图片的 UUID 没找到同 UUID 视频时，不会误配 UUID 冲突的同名视频', () => {
  const files = [file('d/IMG_0050.HEIC'), file('d/IMG_0050_HEVC.MOV')]
  const { assets, livePairs } = pairLiveAssets(files, cidMap({
    'd/IMG_0050.HEIC': U1, // 它真正的视频不在本批文件里
    'd/IMG_0050_HEVC.MOV': U2, // 同名的另一个视频，属于别的实况
  }))
  assert.equal(livePairs, 0)
  assert.deepEqual(liveOf(assets), { 'd/IMG_0050.HEIC': null, 'd/IMG_0050_HEVC.MOV': null })
})
