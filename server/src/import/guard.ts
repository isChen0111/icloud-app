/**
 * 导入源目录守卫
 *
 * 为什么需要：路由层原本只校验「路径存在且是目录」，这个条件对三类明显错误的输入
 * 同样成立。而导入是后台长任务——用户点完「开始导入」就离开了界面，等发现问题时
 * 往往已经写入几十 GB。
 *
 *   ① 源目录 = 库根：把 icloud/、import/ 整个再导一遍。目标日期目录不同，
 *      判重不命中，每张照片在 import/ 下多一份，照片墙直接翻倍。
 *   ② 源目录 = 库内子目录（icloud/、import/）：同上；move 模式下同盘走 rename，
 *      会把 icloud/ 的原片搬进 import/，icloudpd 下次 --until-found 找不到，
 *      会重新全量下载。
 *   ③ 源目录 = 盘符根 / 包含库根的上层目录：扫全盘。最典型的是填成项目根
 *      F:\iPhone\icloud-app——server/cache 下的缩略图（jpg）和 node_modules 里的
 *      图片都在 IMAGE_EXTS 白名单内，会被当成照片一起导进照片墙。
 *
 * 只排除这三类「不可能正确」的输入。库外的合法源目录（如正式数据原位
 * F:\iPhone\iCloudPhoto）不包含库根，三条规则都不会命中它。
 */
import fs from 'node:fs'
import path from 'node:path'

export type ImportSourceCheck = { ok: true } | { ok: false; reason: string }

/** Windows 路径大小写不敏感，比较前统一折叠；其他平台保持原样 */
function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * 取真实路径：解掉符号链接与 Windows 目录联接，否则用户可以用一个指向库内的
 * junction 绕开包含关系判断。路径不存在时返回 null（路由已 stat 过，这里只做兜底）。
 */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/** child 是否位于 parent 之内（含两者相等） */
function isWithin(child: string, parent: string): boolean {
  const a = foldCase(child)
  const b = foldCase(parent)
  if (a === b) return true
  const prefix = b.endsWith(path.sep) ? b : b + path.sep
  return a.startsWith(prefix)
}

/**
 * 校验导入源目录是否可用。
 *
 * @param sourceDir 用户填写 / 上传的源目录绝对路径
 * @param opts.libraryRoot 目标库的库根（绝对路径）
 * @param opts.cacheDir 目标库的缓存目录（缩略图所在，可选）
 */
export function checkImportSource(
  sourceDir: string,
  opts: { libraryRoot: string; cacheDir?: string | null },
): ImportSourceCheck {
  const src = realOrNull(sourceDir)
  if (!src) return { ok: false, reason: '目录不存在或不可读' }

  // 盘符根（F:\）与 UNC 根：path.parse().root 与路径自身相等
  if (path.parse(src).root === src) {
    return { ok: false, reason: '不能导入整个磁盘，请选择具体的照片目录' }
  }

  const libRoot = realOrNull(opts.libraryRoot)
  if (libRoot) {
    if (foldCase(src) === foldCase(libRoot)) {
      return { ok: false, reason: '不能导入照片库自己的目录，请选择库外的源目录' }
    }
    if (isWithin(src, libRoot)) {
      return { ok: false, reason: '不能导入照片库内部的目录（icloud/ 与 import/ 由程序管理，重复导入会产生副本）' }
    }
    if (isWithin(libRoot, src)) {
      return {
        ok: false,
        reason: '所选目录包含当前照片库，会把库内照片再导一遍。请选择库外的具体照片目录',
      }
    }
  }

  const cache = opts.cacheDir ? realOrNull(opts.cacheDir) : null
  if (cache) {
    if (isWithin(src, cache)) {
      return { ok: false, reason: '不能导入应用的缓存目录，里面是缩略图不是原片' }
    }
    if (isWithin(cache, src)) {
      return { ok: false, reason: '所选目录包含应用的缓存目录，会把缩略图当成照片一起导入' }
    }
  }

  return { ok: true }
}
