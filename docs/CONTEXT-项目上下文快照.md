# 项目上下文快照（供会话压缩/新会话恢复用）

> 生成日期：2026-09-08；最后同步：2026-09-19（Claude 审查竞态修复合并、搜索照片墙化、FTS trigram 精确性修复、文档三件套同步）。若本会话上下文被压缩或丢失，先读本文件 + 架构设计文档 + README，即可恢复全部关键信息。

## 项目目标与现状
- 用户已用 iCloudPD 把 iCloud 照片全部拉到本地（`F:\iPhone\icloud-app\iCloudPhoto\`，源文件：12,591 资产 = 照片 1,982 + 实况 7,434 + 视频 3,175，162.8GB，约 2 万媒体文件）。
- 目标：本地网页应用，复刻 iCloud 网页端浏览体验。前端 Vue 3 系列，后端 Node.js。
- **当前状态：P0/P1/P2 全部完成并通过验收；代码审查 12 项稳定化修复全部完成；扫描配对修复（跨目录同名，11,009→12,591）已合并；照片墙全量骨架（C 方案）已上线：滚动条=全库双向滚动 + 吸顶日期跨度 + 月份头区间标签 + 4~12 列 + 行高抽象；详情信息面板（/api/assets/:id/info）已上线；UI 徽标刷新与详情页三级渐进已上线；P2+-1 部分落地（目录热监听 + 删除对账 + 启动同步，一键拉取 exe 待开发）；客户端删除已上线（照片墙单选/Ctrl多选 + 详情页删除 + DELETE /api/assets + 确认弹框）；2026-09-17 全项目审查完成并修复 B1~B5（删除后页缓存错位 / 实况宽高兜底 / 首屏默认浅色 / CORS 补 DELETE / 排版整理）+ 文档三件套同步；2026-09-18 采纳 Claude 审查两处高信号修复（assets store 删除与分页请求竞态：dataVersion + requestSequence/activeRequests 双校验；GridView 搜索宽度 ResizeObserver 启动）已合并；**2026-09-19 搜索照片墙化 + FTS trigram 精确性修复已合并**（匹配集虚拟滚动/月份分组/列数共享；trigram 片段 AND 误命中 → FTS 粗筛 + instr 连续子串精筛）；Git 私有仓库 + GitHub 远程（isChen0111/icloud-app，SSH 推送）版本管理。**

## 已完成的工作
1. **实测 iCloud 网页端机制**（浏览器操作 + 网络抓包 + JS bundle 源码分析）：
   - 网格 = 自研虚拟滚动（DOM 常驻 ~168 节点，absolute+transform，列数 3~9 滑块缩放只改 CSS）；缩略图 DerivativeImage ~415px 档 XHR→blob→objectURL；详情 OneUp 轮播 3 格 + 邻居预加载 ±2；实况照片 = 静止帧 + 隐藏 video 叠层按住播放；视频 = 原生 video + HTTP 206 Range。
2. **行业调研**：Immich 三档缩略图、@tanstack/vue-virtual、sharp（libvips+libheif 是 Node HEIC 唯一成熟方案）、iCloudPD 输出结构（YYYY/MM/DD + `IMG_xxxx.HEIC ⇄ IMG_xxxx_HEVC.MOV`）。
3. **P0 已落地并端到端验证**：后端 server/（Fastify + better-sqlite3 + sharp + ffmpeg）+ 前端 web/（Vue3.5+Vite+TS+Pinia 虚拟滚动/懒加载/详情轮播/实况/视频）。全量扫描 12,591 资产；HEIC 解码用 BtbN ffmpeg full 版（libheif）已固化 postinstall。
4. **P1 已验收**：日期分组定位（月份头行 + 吸顶月份指示器 + **方案 C 日期导航面板**——工具栏「日期」按钮 → 下拉面板，左年份 + 右月份缩略图 3×4 网格，/api/dates 返回 108 个月 offset+thumbId）、缩放滑块（**默认 8 列**）、详情邻居预加载、blur 占位、hash 深链、键盘切换、实况按住播放。遗留：内存 LRU（本地场景收益低，后置）。
5. **P2 已验收（范围收缩）**：FTS5 trigram 搜索（文件名/日期子串，至少 3 字符，/api/search）。用户已决定不做：HEVC 按需转码缓存 / 逆地理编码 / 收藏 / 最近删除 / 下载原片 / 批量选择（目录热监听后经 P2+-1 落地）。
6. **稳定化（代码审查 5×P1 + 7×P2 = 12 项全部修复）**：
   - stats 异步体积统计 + 落盘缓存（首屏 229ms）
   - 原图宽高 11,009 条全量修正（`npm run fix-size`，fix-asset-size.ts）
   - EXIF 方向缩略图重建（`npm run fix-thumbs`，rebuild-orientation-thumbs.ts，103 张）
   - 浏览器缩略图缓存失效链路：thumbUrl 带 `rev` 版本号（web/src/api/client.ts 的 THUMB_REV，当前 2）+ 响应头去 immutable（thumb.ts）
   - 实况按住播放带原声（LivePhoto.vue：`:muted="!playing"` + 显式 unmuted + 静音兜底）
   - 详情/搜索竞态守卫、扫描断点续跑容错
7. **文档已同步**：README.md（目录树/命令/API/验证表/踩坑）+ 架构设计文档.html（§5 结构、§6 路线图含稳定化 + P2+ 规划）。
8. **审查后功能（2026-09-08 当日）**：① 主题切换——浅色/深色 CSS 变量双主题，默认浅色，localStorage 持久化 + index.html 内联脚本防闪烁；详情/实况/视频查看区恒深。② 日期面板方案 C（toggle 开关）。③ 默认 8 列。④ 详情返回保留滚动位置——KeepAlive 仅缓存 GridView，onScroll 持续记录 + onActivated 恢复（修复了 deactivated 读不到滚动值、ResizeObserver 污染宽高导致的行高错位两个坑）。
9. **照片墙全量骨架（C 方案，2026-09-08 三版）**：行序列（月份头 + 资产行）由「月份分组 + 列数」一次精确生成全库（8 列 1,676 行 / 219,106px）→ 滚动条 = 全库、双向滚动；store 改页区间懒加载（pages Map，120 条/页，幂等 + 并发去重）；吸顶月份指示器升级为**日期跨度**（视口首末资产行，倒序直出，过滤 overscan 预热行与真实可视范围一致）；月份头标签改区间（如「2021年4月-3月」）；列数范围 4~12（12 列需扣 .grid-row 水平 padding ROW_PAD=24 防溢出）+ 行高抽象 getRowHeight（原比例扩展点）；currentYm/currentMonthLabel 同口径过滤 overscan。
10. **扫描配对修复（2026-09-08 二次）**：配对 key 从「文件名基名」改为「**目录 + 基名**」——iCloudPD 会把同名文件（不同设备/编辑版本）按各自拍摄日期归档进不同目录，只看基名会跨目录错误配对：同组多余视频被静默丢弃（曾丢失 3,382 个视频）、实况视频可能配到另一张同名照片上。增量逻辑同时改为「复用现有元数据、仍 UPSERT 修正 type/live_video」。重扫后 11,009 → 12,591（photo 1,982 / live 7,434 / video 3,175），与磁盘文件精确一致；与 iCloud 统计基本对齐（照片 9,416≈9,419，视频 3,175≈3,033）。验证：实况配对跨目录 0、live 配对视频磁盘缺失 0、video 文件磁盘缺失 0、缩略图缓存孤儿 0。
11. **UI 徽标刷新（2026-09-08）**：标题「iCloud本地照片」+ favicon.svg（web/public/，蓝渐变圆角方块+白色照片图形）；LIVE 徽标简约化（网格 + 详情白字胶囊圆角，去掉原黄色字）；详情实况按住播放时徽标内旋转加载动画（@loadstart/@waiting→loading，@canplay/@playing→结束，松开复位）；视频缩略图右下 ▶ 改黑底时长胶囊（复用 asset.duration，0:03 式）；formatDuration 支持 ≥1h（1:02:03）。HDR 徽标用户砍掉：实测全库 8,131 个 HEIC 仅 1 张含 GainMap（2019/12/12/IMG_3944.HEIC），判定方法可靠（HEIF iinf item_type GMap/gmap，ISO 21496-1），收益低。
12. **详情页三级渐进（2026-09-08）**：详情页冷生成 detail 大图期间此前仅 loading 遮罩（0.5~3s 黑屏）；现复用照片墙已缓存 grid 档做模糊占位（blur 16px）秒出 → detail 加载完成 0.3s 淡入覆盖（DetailView / LivePhoto / VideoStage 三组件，后端零改动、不产生额外请求）。detail 缓存命中时两图并行、直出清晰大图。P2+-4 detail 缓存治理（保留最近 N 月 / 一键清空）仍按计划，仅针对 cache/thumbs/detail/ 目录（约 250KB/张），不影响照片墙（blur/grid 是照片墙专属，detail 是详情页专属）。
13. **P2+-1 落地（2026-09-17）**：① 目录热监听（server/src/scanner/watcher.ts）——chokidar 监听 iCloudPhoto/，add/change/unlink/unlinkDir → 防抖 1.5s 合并 → runScan('watcher')，ignoreInitial + awaitWriteFinish 500ms + 忽略隐藏文件；扫描互斥（dirty 标志延后补扫）。② 删除对账——runScan 末尾「磁盘文件集合 vs DB 集合」对比，磁盘消失文件清理资产 + FTS + 三档缩略图缓存 + 孤儿缩略图清理；只删遍历明确缺失的文件，IO 抖动不误删。③ 启动同步——index.ts 启动即后台 runScan('startup')，手动拷入文件开机即发现。⚠ 已知缺口：KeepAlive 照片墙不感知 watcher 同步，手动拷/删文件后需刷新页面（机制已列待办）。
14. **客户端删除（2026-09-17）**：照片墙单击单选 / Ctrl+单击多选（选中态画缩略图内，selectedIds 存 Pinia store，虚拟滚动销毁重建不丢）；删除按钮在搜索栏行（未选中灰禁、选中亮蓝 + 「已选 N 项」）；确认弹框（DeleteConfirm，文案「永久删除、无法恢复」）；详情页删除按钮与信息按钮统一 34px 蓝色圆形；后端 DELETE /api/assets（去重限 1000，unlink 源文件只计数，事务删 DB+FTS+缓存，触发热监听对账幂等空转）。
15. **2026-09-17 全项目审查 + 修复**：B1 删除后页缓存错位（removeAssets 清空删除点之后的页，防滚动错位）；B2 实况宽高兜底（thumb.ts ensureSize 条件 photo→非 video）；B3 首屏主题异常分支默认深色→浅色（index.html，应用默认白色）；B4 CORS 补 DELETE；B5 五处补丁残留排版整理（App/GridScroller/DetailView/GridItem/GridView，纯格式）；文档三件套同步（README + 架构设计文档 + 本快照）。
16. **2026-09-18 采纳 Claude 审查修复**：assets store 删除与分页请求竞态（dataVersion 版本号 + requestSequence/activeRequests 每页唯一 id 双校验，删除后旧分页响应不回写缓存、加载中页重拉）；GridView 搜索宽度 ResizeObserver 正确启动（监听 searchActive 进入搜索后绑定、卸载 disconnect）。已合并 main（91c8b71）。
17. **2026-09-19 搜索照片墙化 + trigram 精确性**：① 搜索照片墙化——后端 /api/search 加 offset 跳页分页 + total 真实计数 + months 匹配集月份分组；GridScroller 抽象 GridDataSource 接口（照片墙 assets store / 搜索 search store 共用，组件实例不销毁只切数据源）；列数提升到 theme store（thumbnailCols 持久化 4~12，照片墙/搜索共享）；GridView 搜索态改用 GridScroller（删除旧固定 5 列网格 + 100 条截断）。② FTS trigram 精确性——根因：trigram 对多字符查询按「片段 AND」匹配（"2023"="202"+"023"，带引号短语也无相邻约束），日期时间串碰巧含两片段即误命中（搜 2023 混入 2018/2021/2025 照片）；修复：FTS 粗筛 + 每个 token `instr(文件名小写/ISO/紧凑时间去 -)` 连续子串精筛（多 token AND）。实测 2131→2126=库中 2023 年资产数，误匹配归零 1ms。已合并 main（1b6fdee）。遗留：search store 换词 finally 竞态（旧请求可能误删新请求 pageLoading → 偶发重复请求，数据幂等无错，待修）。

## 照片库实测数据（2026-09-08）
- 结构：`YYYY/MM/DD/文件名`（iCloudPD 默认），实况配对基名归一（`_HEVC` 后缀），**无时间差校验**。⚠️ **配对必须限定同一目录**——跨目录同名文件（不同设备/编辑版本的同名，如 `2018/02/04/IMG_0040*` 与 `2021/07/27/IMG_0040*`，全库 2,363 个基名分布多目录）若只按基名配对会错配丢视频（见「已完成」第 9 条）。
- 磁盘文件口径（20,025 文件）：HEIC 8,131 / MOV 1,159+12（异常小写 "*.mov"）/ JPG 1,067 / MP4 403 / PNG 217 / M4V 19 / GIF 1；其中视频文件共 10,609（含 7,434 个实况配对视频）。
- 修复后资产：12,591 = photo 1,982 + live 7,434 + video 3,175。
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
- ✅ **P2+-1 部分落地（2026-09-17）**：目录热监听（chokidar）+ 删除对账（磁盘 vs DB）+ 启动同步（runScan startup）已合并。🔜 一键拉取（前端按钮 → 后端 spawn icloudpd 官方 exe `icloudpd-1.32.3-windows-amd64.exe` 14.4MB **免 Python**，已核验 GitHub Release；**已定 exe 方案**——首次启动脚本自动下载到 `iCloudTool\bin\`，gitignore 排除不入仓库）待开发；缺口：同步完成后前端 KeepAlive 缓存失效（需刷新页面）
- 🔜 **P2+-2 冷启动体验（已纳入计划）**：顶部轮询 /api/stats 显示扫描进度「已扫描 x/20025 · 已找到 y」+ 缩略图预热进度 + 分批写库边扫边现
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
- 29 个 4K 视频缩略图 thumb_status='error'（历史遗留，用户未决定是否排查；与历次修复无关）。
- ✅ 缩略图生成失败留 0 字节 WebP 兜底：已在 generate() catch 分支补 `fs.rmSync(outPath, {force:true})`（2026-09-08 审查后修复）。
- `server\vendor\ffmpeg-full.zip`（163MB 安装包）保留或删除：无用户决定（.gitignore 已排除不入库）。
- ✅ toolbar 调试信息（items/rows/virt）：已定保留（用户确认）。
- ⚠ **KeepAlive 缓存失效（P2+-1 已知缺口，2026-09-17 更新）**：热监听/删除对账已落地，但照片墙被 KeepAlive 缓存后不感知后端数据变化——手动拷入/删除文件后需刷新页面才可见。规划机制：同步完成 → 前端失效照片墙缓存并刷新（store reload 标志 / GridView onActivated 检查 / 整页刷新路由；架构文档 §4.9 已注明）。
- ✅ 2026-09-17 审查 B1~B5 修复完成（删除页缓存错位 / 实况宽高兜底 / 首屏默认浅色 / CORS DELETE / 排版整理）。
- 🔜 P2+-1 一键拉取（exe 方案已定）与 P2+-2 冷启动进度交互待开发；P2+-3 语义搜索暂缓实现；**P2+-4 详情缓存治理已列入**（保留最近 N 月浏览的 detail 图 / 一键清空 detail 缓存，可选）。
- 🔜 **search store 换词 finally 竞态**（2026-09-19 审查发现，待用户确认）：旧词请求 finally 无条件 `pageLoading.delete(p)` 可能误删新词请求的加载标记 → 偶发重复请求（数据幂等无错）。修复 = finally 加 `if (seq !== searchSeq) return`（一行）。

## 用户偏好（与本项目相关）
- 技术/财经类内容偏好"深度解析 + 大白话 + 结构化清单"。
- 代码要目录规范、结构清晰、详细注释（用于学习）。
- **改动工作流程（硬性）**：① 任何需求改动先给评估（怎么改、对现有代码的影响）→ ② 用户明确确认 → ③ 新建 git 分支再改 → ④ 完成后经用户确认 → ⑤ 合并回 main 并清理旧分支。
