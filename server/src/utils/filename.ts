/**
 * 文件名净化：把「在别的文件系统上合法、到了 Windows 上会出事」的名字改成安全形式。
 *
 * 为什么需要（审查 C-10 + 2026-11-02 补漏）：
 *   导入有两个入口——上传（filename 由客户端提供）与本机迁移（文件名来自源目录）。
 *   两条路最终都把文件落到 NTFS 上，因此**必须共用同一套规则**，否则漏掉的那条入口
 *   会把 `CON.JPG`、`a:b.jpg` 这类名字写进库。
 *
 * Windows 上的三种故障形态（均已实测）：
 *   ① 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）：Node 走 `\\?\` 前缀能写成功，
 *      文件真实存在且可读，但 Win32 shell（资源管理器、FindFirstFile、备份/同步工具）
 *      认为它不存在 —— `[System.IO.File]::ReadAllBytes` 能读，`Test-Path` 返回 False。
 *      用户视角就是「照片看得见，但删不掉、打不开、备份跳过」。
 *   ② 非法字符 `* ? " < > | :`：`a:b.jpg` 在 NTFS 上被解释成「文件 a 的 b.jpg 数据流」，
 *      `writeFileSync` 返回成功，readdir 里只有一个 `a`，主数据流丢了。
 *   ③ 结尾的点与空格：Win32 会静默丢弃，于是 `x.jpg.` 与 `x.jpg` 指向同一个文件，
 *      两个不同的源文件互相覆盖。
 */

/**
 * Windows 保留设备名。
 * `CON.jpg` / `NUL.mp4` 这类名字在 Win32 上 open 是**成功的**，但字节流向设备而不是磁盘：
 * 文件根本不落盘，接口却返回 200「导入完成」。带扩展名同样中招（设备名判断只看第一个点之前）。
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 单个路径段里的非法字符（Windows 全平台通用的一套；`/` 已由分隔符归一化处理） */
const ILLEGAL_SEGMENT_CHARS = /[*?"<>|:]/g

/**
 * 单段最大长度。NTFS 单段上限 255 个 UTF-16 码元，Win32 整路径还有 260 限制；
 * 这里取 200 留出日期目录与库根的余量，超长时保留扩展名截断主体。
 */
const MAX_SEGMENT_LENGTH = 200

/**
 * 清洗单个路径段（文件名或目录名），非法则**改名而不是整批失败**（审查 C-10）。
 *
 * 处理四种情况：
 *   ① 非法字符 `* ? " < > | :` → `_`（`a:b.jpg` 在 NTFS 上会被当备用数据流，写出来是 0 字节）
 *   ② 结尾的点与空格 → 去掉（Win32 会静默丢弃，于是 `x.jpg.` 与 `x.jpg` 指向同一个文件，
 *      后传的悄悄覆盖前一个；两个不同的源文件互相覆盖是数据丢失）
 *   ③ Windows 保留设备名 → 前缀 `_`
 *   ④ 超长 → 保留扩展名，截断主体
 *
 * 同一套规则同时用于上传落盘的相对路径、本机迁移的目标文件名，以及 mtimes 的 key，
 * 三处必须一致，否则回设 mtime 会静默失效、判重会错。
 */
export function sanitizeFileSegment(seg: string): string {
  let s = seg.replace(ILLEGAL_SEGMENT_CHARS, '_').replace(/[. ]+$/g, '')
  if (s === '') return '_'
  if (WINDOWS_RESERVED.test(s.split('.')[0] ?? '')) s = `_${s}`
  if (s.length > MAX_SEGMENT_LENGTH) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : ''
    s = s.slice(0, MAX_SEGMENT_LENGTH - ext.length) + ext
  }
  return s
}
