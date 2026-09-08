# 项目上下文快照（供会话压缩/新会话恢复用）

> 生成日期：2026-09-08（当日多次更新，已同步至稳定化 + 审查后功能完成：主题/日期面板方案C/默认8列/KeepAlive）。若本会话上下文被压缩或丢失，先读本文件 + 架构设计文档 + README，即可恢复全部关键信息。

## 项目目标与现状
- 用户已用 iCloudPD 把 iCloud 照片全部拉到本地（`F:\iPhone\icloud-app\iCloudPhoto\`，源文件：11,009 资产 = 照片 3,781 + 实况 5,635 + 视频 1,593，162.8GB，约 2 万媒体文件）。
- 目标：本地网页应用，复刻 iCloud 网页端浏览体验。前端 Vue 3 系列，后端 Node.js。
- **当前状态：P0/P1/P2 全部完成并通过验收；代码审查 12 项稳定化修复全部完成；审查后新增：主题切换（默认浅色）/ 日期面板方案 C / 默认 8 列 / 详情返回保留滚动位置（KeepAlive）；Git 私有仓库 + GitHub 远程（isChen0111/icloud-app，SSH 推送）版本管理。**

## 已完成的工作
1. **实测 iCloud 网页端机制**（浏览器操作 + 网络抓包 + JS bundle 源码分析）：
   - 网格 = 自研虚拟滚动（DOM 常驻 ~168 节点，absolute+transform，列数 3~9 滑块缩放只改 CSS）；缩略图 DerivativeImage ~415px 档 XHR→blob→objectURL；详情 OneUp 轮播 3 格 + 邻居预加载 ±2；实况照片 = 静止帧 + 隐藏 video 叠层按住播放；视频 = 原生 video + HTTP 206 Range。
2. **行业调研**：Immich 三档缩略图、@tanstack/vue-virtual、sharp（libvips+libheif 是 Node HEIC 唯一成熟方案）、iCloudPD 输出结构（YYYY/MM/DD + `IMG_xxxx.HEIC ⇄ IMG_xxxx_HEVC.MOV`）。
3. **P0 已落地并端到端验证**：后端 server/（Fastify + better-sqlite3 + sharp + ffmpeg）+ 前端 web/（Vue3.5+Vite+TS+Pinia 虚拟滚动/懒加载/详情轮播/实况/视频）。全量扫描 11,009 资产；HEIC 解码用 BtbN ffmpeg full 版（libheif）已固化 postinstall。
4. **P1 已验收**：日期分组定位（月份头行 + 吸顶月份指示器 + **方案 C 日期导航面板**——工具栏「日期」按钮 → 下拉面板，左年份 + 右月份缩略图 3×4 网格，/api/dates 返回 108 个月 offset+thumbId）、缩放滑块（**默认 8 列**）、详情邻居预加载、blur 占位、hash 深链、键盘切换、实况按住播放。遗留：内存 LRU（本地场景收益低，后置）。
5. **P2 已验收（范围收缩）**：FTS5 trigram 搜索（文件名/日期子串，至少 3 字符，/api/search）。用户已决定不做：目录热监听 / HEVC 按需转码缓存 / 逆地理编码 / 收藏 / 最近删除 / 下载原片 / 批量选择。
6. **稳定化（代码审查 5×P1 + 7×P2 = 12 项全部修复）**：
   - stats 异步体积统计 + 落盘缓存（首屏 229ms）
   - 原图宽高 11,009 条全量修正（`npm run fix-size`，fix-asset-size.ts）
   - EXIF 方向缩略图重建（`npm run fix-thumbs`，rebuild-orientation-thumbs.ts，103 张）
   - 浏览器缩略图缓存失效链路：thumbUrl 带 `rev` 版本号（web/src/api/client.ts 的 THUMB_REV，当前 2）+ 响应头去 immutable（thumb.ts）
   - 实况按住播放带原声（LivePhoto.vue：`:muted="!playing"` + 显式 unmuted + 静音兜底）
   - 详情/搜索竞态守卫、扫描断点续跑容错
7. **文档已同步**：README.md（目录树/命令/API/验证表/踩坑）+ 架构设计文档.html（§5 结构、§6 路线图含稳定化 + P2+ 规划）。
8. **审查后功能（2026-09-08 当日）**：① 主题切换——浅色/深色 CSS 变量双主题，默认浅色，localStorage 持久化 + index.html 内联脚本防闪烁；详情/实况/视频查看区恒深。② 日期面板方案 C（toggle 开关）。③ 默认 8 列。④ 详情返回保留滚动位置——KeepAlive 仅缓存 GridView，onScroll 持续记录 + onActivated 恢复（修复了 deactivated 读不到滚动值、ResizeObserver 污染宽高导致的行高错位两个坑）。

## 照片库实测数据（2026-09-08）
- 结构：`YYYY/MM/DD/文件名`（iCloudPD 默认），实况配对基名归一（`_HEVC` 后缀），**无时间差校验**。
- 11,009 资产：heic 8,131 / mov 1,159(+12 异常小写 "*.mov") / jpg 1,067 / mp4 403 / png 217 / m4v 19 / gif 1。
- 关键统计：orientation=6 共 6,853 张（photo+live），orientation=1 共 1,905；非 HEIC + orientation 2~8 = 103 张（方向重建范围）。

## 技术选型（已定）
- 后端：Node 24（用户 D:\nodejs）+ TypeScript + Fastify 5 + better-sqlite3 + exifr + sharp + fluent-ffmpeg/ffmpeg-static + p-queue（并发 8）
- 前端：Vue 3.5 + Vite + TS + Pinia + vue-router(hash) + @tanstack/vue-virtual + 自研 useLazyImage（IntersectionObserver）
- 缩略图三档：grid 320px / detail 1600px / blur 32px WebP；视频封面 ffmpeg 抽帧
- 端口：后端 127.0.0.1:8899，前端 http://localhost:5173（Vite 绑 IPv6，勿用 127.0.0.1:5173）

## 实施路线（最新）
- ✅ P0：扫描 + 虚拟滚动 + 缩放 + 缩略图懒生成 + 详情 + 实况 + 视频
- ✅ P1：日期定位 + 邻居预取 + blur + 深链 + 键盘 + 实况（剩内存 LRU 后置）
- ✅ P2：FTS5 搜索（HEVC 转码/收藏/最近删除/下载/批量选择用户决定不做）
- ✅ 稳定化：12 项修复 + GitHub 版本管理
- 🔜 **P2+-1 同步与热更新（已纳入计划）**：一键拉取同步（前端按钮 → 后端 spawn icloudpd 官方 exe `icloudpd-1.32.3-windows-amd64.exe` 14.4MB **免 Python**，已核验 GitHub Release；**已定 exe 方案**——首次启动脚本自动下载到 `iCloudTool\bin\`，gitignore 排除不入仓库）+ 目录热监听（chokidar 增删）+ **删除同步**（scanner 当前只增不删，需加「目录文件集合 vs DB 集合」对比）+ 冷启动增量（启动时对比文件数不一致自动增量扫描，手动拷文件开机即发现）
- 🔜 **P2+-2 冷启动体验（已纳入计划）**：顶部轮询 /api/stats 显示扫描进度「已扫描 x/20026 · 已找到 y」+ 缩略图预热进度 + 分批写库边扫边现
- ⏸ P2+-3 语义搜索（暂缓）：人物/地点/场景组合（如「邓州 2023 年 陈咏新」）——不连大模型，face-api.js + tfjs-node 本地人脸聚类 + people/faces/asset_tags 表 + 组合查询解析器；视频抽帧入人脸库；标签不写文件元数据。

## 工程约定（踩坑沉淀）
- **PowerShell 引号坑**：命令实际由 PowerShell 执行；`\"` 不是转义（用反引号）、双引号内 `$` 会展开。多层级引号一律落临时文件：复杂 JS/SQL 写 `.cjs` 文件再 `node 文件`；多行 commit 用 `Out-File` + `git commit --file=`。
- **原生模块**：better-sqlite3/ffmpeg-static 按用户系统 Node 24 编译；我的环境 Node 22 加载会 ERR_DLOPEN_FAILED。**所有加载 better-sqlite3 的命令必须 `& "D:\nodejs\node.exe"`** 或先 PATH 前置。
- **服务进程**：用户自启后端 8899/前端 5173，勿占用；临时验证进程用完 TaskStop。
- **git SSH**：固定 `core.sshCommand = "C:/Windows/System32/OpenSSH/ssh.exe" -o StrictHostKeyChecking=accept-new`；日常 `git push origin main` 畅通。
- **临时脚本**：`server/scripts/.*`（dot 开头）用完即删，已在 .gitignore 排除防误提交。
- **缩略图缓存**：内容变更后 bump `THUMB_REV`（web/src/api/client.ts）；`npm run fix-thumbs` 重建方向缓存。
- **sharp 0.33.5**：构造选项 `rotate:true` 不生效，必须链式 `.rotate()`。

## 待办 / 遗留（均不影响使用）
- ✅ 缩略图生成失败留 0 字节 WebP 兜底：已在 generate() catch 分支补 `fs.rmSync(outPath, {force:true})`（2026-09-08 审查后修复）。
- `server\vendor\ffmpeg-full.zip`（163MB 安装包）保留或删除：无用户决定（.gitignore 已排除不入库）。
- ✅ toolbar 调试信息（items/rows/virt）：已定保留（用户确认）。
- **KeepAlive 缓存失效（P2+-1 前置）**：照片墙被 KeepAlive 缓存后，同步/热监听/删除同步落地时需「同步完成 → 前端失效缓存刷新」（架构文档 §4.7 已注明）。
- P2+-1 / P2+-2 已纳入计划待开发；P2+-3 语义搜索暂缓实现；**P2+-4 详情缓存治理已列入**（保留最近 N 月浏览的 detail 图 / 一键清空 detail 缓存，可选）。

## 用户偏好（与本项目相关）
- 技术/财经类内容偏好"深度解析 + 大白话 + 结构化清单"。
- 代码要目录规范、结构清晰、详细注释（用于学习）。
- **改动工作流程（硬性）**：① 任何需求改动先给评估（怎么改、对现有代码的影响）→ ② 用户明确确认 → ③ 新建 git 分支再改 → ④ 完成后经用户确认 → ⑤ 合并回 main 并清理旧分支。
