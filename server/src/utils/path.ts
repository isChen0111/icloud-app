import path from 'node:path'

/**
 * 安全解析「库内相对路径」为绝对路径（审查 P2-6）。
 *
 * file_path 由扫描/导入写入，约定是相对 library_root、不含 ..；但读路径此前直接
 * `path.join(config.libraryRoot, file_path)`，一旦 DB 被篡改或写入方出 bug
 * （含 `..` 或绝对路径），就会越界读库外文件。
 * 拼接后必须仍落在 root 内，越界返回 null，调用方按「文件缺失 / 资产异常」处理。
 */
export function resolveInsideRoot(root: string, rel: string): string | null {
  if (path.isAbsolute(rel)) return null
  const abs = path.resolve(root, rel)
  const relCheck = path.relative(root, abs)
  // relCheck 为空串（= root 本身，目录不是文件）或越出 root（.. 开头 / 绝对路径）都拒绝
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null
  return abs
}
