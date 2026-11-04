/**
 * 实况照片配对：UUID 优先，文件名兜底。
 *
 * 判据只有一条优先级，不因成本而调换：
 *   两侧 UUID 都非空且相等 → 实况（高置信）
 *   至少一侧 UUID 为空     → 「目录 + 配对基名」兜底（低置信）
 *   两侧都有但不相等       → **不配对**，哪怕文件名一模一样
 *
 * 最后一条是重点：UUID 冲突说明其中一半被外部工具重写过（重编码会剥掉 MakerNote /
 * content.identifier），此时两半已经不是同一张实况，硬配只会放出错误的片段。
 * Apple 自己也认不出这对，我们不比它更聪明。
 *
 * UUID 这一轮是**全局索引，不限定目录**：iCloud 偶尔把同一张实况的静止帧和视频归到
 * 不同日期目录，文件被改名后更是彻底失配，只有 UUID 能救回来。文件名那一轮则必须
 * 限定目录——iCloudPD 会把同名文件（不同设备 / 编辑版本）归档进不同日期目录，
 * 只看基名会把不同照片错配成一组，并让同组多余视频被丢弃（曾丢失 3382 个视频）。
 *
 * 为什么不写在 scanner/index.ts 里：三态判据要覆盖「一致 / 冲突 / 缺一侧」，
 * 端到端测法得先造出带真实 UUID 的 HEIC + MOV 才有意义，那需要拿真实照片当 fixture。
 * 抽成纯函数后可以直接注入 UUID，扫描与导入两条链路也共用同一份规则，不会慢慢走偏。
 */

/** 参与配对的文件的最小信息 */
export interface PairFile {
  /** 相对库根（或导入源目录）的路径 */
  relPath: string
  /** 含扩展名的文件名 */
  fileName: string
  kind: 'image' | 'video'
}

/** 配对结果：主资产 + 可选的实况视频 */
export interface PairGroup<T> {
  /** 主资产：图片，或没配上图片的独立视频 */
  image: T
  /** 配对到的实况视频 */
  liveVideo: T | null
}

/** 文件名去扩展名（配对基名） */
function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

/** 把 relPath 的目录部分统一成正斜杠（Windows 下是反斜杠） */
function posixDir(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(0, slash) : '.'
}

/** 配对基名：视频去掉 `_HEVC` 后缀后与静止帧同名 */
function pairBaseName(f: PairFile): string {
  const base = baseName(f.fileName)
  return f.kind === 'video' && base.endsWith('_HEVC') ? base.slice(0, -'_HEVC'.length) : base
}

/**
 * 把扁平文件列表组装成资产列表。
 *
 * @param files  本轮扫描/导入看到的全部媒体文件
 * @param cidOf  该文件的实况内容标识（UUID）；没有就返回 null。
 *               扫描链路从元数据来，导入链路暂时恒返回 null（见 import/pair.ts 的说明）。
 */
export function pairLiveAssets<T extends PairFile>(
  files: T[],
  cidOf: (f: T) => string | null,
): { assets: PairGroup<T>[]; livePairs: number } {
  const assets: PairGroup<T>[] = []
  let livePairs = 0
  const pairedImage = new Set<string>()
  const consumedVideo = new Set<string>()

  // —— 第一轮：UUID ——
  const videosByCid = new Map<string, T[]>()
  for (const f of files) {
    if (f.kind !== 'video') continue
    const id = cidOf(f)
    if (!id) continue
    const arr = videosByCid.get(id)
    if (arr) arr.push(f)
    else videosByCid.set(id, [f])
  }
  for (const f of files) {
    if (f.kind !== 'image') continue
    const id = cidOf(f)
    if (!id) continue
    const candidates = videosByCid.get(id)
    if (!candidates || candidates.length === 0) continue
    // 同一 UUID 命中多个视频（同一张实况被复制过多份）：优先同目录的那个，少抢错
    const live =
      candidates.find((v) => !consumedVideo.has(v.relPath) && posixDir(v.relPath) === posixDir(f.relPath)) ??
      candidates.find((v) => !consumedVideo.has(v.relPath))
    if (!live) continue
    consumedVideo.add(live.relPath)
    pairedImage.add(f.relPath)
    livePairs++
    assets.push({ image: f, liveVideo: live })
  }

  // —— 第二轮：文件名兜底（只处理第一轮没配上的） ——
  const byNameKey = new Map<string, T[]>()
  for (const f of files) {
    if (f.kind === 'image' && pairedImage.has(f.relPath)) continue
    if (f.kind === 'video' && consumedVideo.has(f.relPath)) continue
    const key = `${posixDir(f.relPath)}/${pairBaseName(f)}`
    const arr = byNameKey.get(key)
    if (arr) arr.push(f)
    else byNameKey.set(key, [f])
  }

  for (const group of byNameKey.values()) {
    const images = group.filter((f) => f.kind === 'image')
    const videos = group.filter((f) => f.kind === 'video')
    if (images.length === 0) {
      // 只有视频 → 每个都是独立视频资产
      for (const v of videos) assets.push({ image: v, liveVideo: null })
      continue
    }
    const img = images[0]
    const imgCid = cidOf(img)
    // 两边都有 UUID 却不相等的视频不能配（它是别的实况的片段），跳过它继续找
    const live = videos.find((v) => {
      const vCid = cidOf(v)
      return !imgCid || !vCid || vCid === imgCid
    })
    if (!live) {
      // 组内所有视频都与主图的 UUID 冲突 → 整组拆开：一张照片 + 若干独立视频
      for (const f of group) assets.push({ image: f, liveVideo: null })
      continue
    }
    livePairs++
    assets.push({ image: img, liveVideo: live })
    // 同基名多余图片（如编辑变体）也独立入库为照片
    for (const extra of images.slice(1)) assets.push({ image: extra, liveVideo: null })
    // 额外视频不能静默丢弃（曾丢失 3382 个视频），作为普通视频资产保留
    for (const v of videos) if (v !== live) assets.push({ image: v, liveVideo: null })
  }

  return { assets, livePairs }
}
