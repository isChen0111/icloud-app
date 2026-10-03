# 项目上下文快照（供会话压缩/新会话恢复用）

> 生成日期：2026-09-08；最后同步：2026-10-03（移除独立 blur 缩略图档；按目录日期新到旧处理；扫描期间不自动刷新照片墙，结束后最终刷新）。若本会话上下文被压缩或丢失，先读本文件 + 架构设计文档 + README，即可恢复全部关键信息。

## 项目目标与现状
- 用户已用 iCloudPD 把 iCloud 照片全部拉到本地（`F:\iPhone\icloud-app\iCloudPhoto\`，源文件：12,591 资产 = 照片 1,982 + 实况 7,434 + 视频 3,175，162.8GB，约 2 万媒体文件）。
- 目标：本地网页应用，复刻 iCloud 网页端浏览体验。前端 Vue 3 系列，后端 Node.js。
- **当前状态：P0/P1/P2 全部完成并通过验收；代码审查 12 项稳定化修复全部完成；扫描配对修复（跨目录同名，11,009→12,591）已合并；照片墙全量骨架（C 方案）已上线：滚动条=全库双向滚动 + 吸顶日期跨度 + 月份头区间标签 + 4~12 列 + 行高抽象；详情信息面板（/api/assets/:id/info）已上线；UI 徽标刷新与详情页三级渐进已上线；P2+-1 部分落地（目录热监听 + 删除对账 + 启动同步，一键拉取 exe 待开发）；客户端删除已上线（照片墙单选/Ctrl多选 + 详情页删除 + DELETE /api/assets + 确认弹框）；2026-09-17 全项目审查完成并修复 B1~B5（删除后页缓存错位 / 实况宽高兜底 / 首屏默认浅色 / CORS 补 DELETE / 排版整理）+ 文档三件套同步；2026-09-18 采纳 Claude 审查两处高信号修复（assets store 删除与分页请求竞态：dataVersion + requestSequence/activeRequests 双校验；GridView 搜索宽度 ResizeObserver 启动）已合并；**2026-09-19 搜索照片墙化 + FTS trigram 精确性修复已合并**（匹配集虚拟滚动/月份分组/列数共享；trigram 片段 AND 误命中 → FTS 粗筛 + instr 连续子串精筛）；Git 私有仓库 + GitHub 远程（isChen0111/icloud-app，SSH 推送）版本管理。**

## 已完成的工作
1. **实测 iCloud 网页端机制**（浏览器操作 + 网络抓包 + JS bundle 源码分析）：
   - 网格 = 自研虚拟滚动（DOM 常驻 ~168 节点，absolute+transform，列数 3~9 滑块缩放只改 CSS）；缩略图 DerivativeImage ~415px 档 XHR→blob→objectURL；详情 OneUp 轮播 3 格 + 邻居预加载 ±2；实况照片 = 静止帧 + 隐藏 video 叠层按住播放；视频 = 原生 video + HTTP 206 Range。
2. **行业调研**：Immich 三档缩略图、@tanstack/vue-virtual、sharp（libvips+libheif 是 Node HEIC 唯一成熟方案）、iCloudPD 输出结构（YYYY/MM/DD + `IMG_xxxx.HEIC ⇄ IMG_xxxx_HEVC.MOV`）。
3. **P0 已落地并端到端验证**：后端 server/（Fastify + better-sqlite3 + sharp + ffmpeg）+ 前端 web/（Vue3.5+Vite+TS+Pinia 虚拟滚动/懒加载/详情轮播/实况/视频）。全量扫描 12,591 资产；HEIC 解码用 BtbN ffmpeg full 版（libheif）已固化 postinstall。
4. **P1 已验收**：日期分组定位（月份头行 + 吸顶月份指示器 + **方案 C 日期导航面板**——工具栏「日期」按钮 → 下拉面板，左年份 + 右月份缩略图 3×4 网格，/api/dates 返回 108 个月 offset+thumbId）、缩放滑块（**默认 8 列**）、详情邻居预加载、照片墙底色占位后渐进显示 grid 缩略图、hash 深链、键盘切换、实况按住播放。遗留：内存 LRU（本地场景收益低，后置）。
5. **P2 已验收（范围收缩）**：FTS5 trigram 搜索（文件名/日期子串，至少 3 字符，/api/search）。用户已决定不做：HEVC 按需转码缓存 / 逆地理编码 / 收藏 / 最近删除 / 下载原片；客户端批量选择已在 P2+-1 随删除功能落地。
6. **稳定化（代码审查 5×P1 + 7×P2 = 12 项全部修复）**：
   - stats 异步体积统计 + 落盘缓存（首屏 229ms）
   - 原图宽高 11,009 条全量修正（`npm run fix-size`，fix-asset-size.ts）
   - EXIF 方向缩略图重建（`npm run fix-thumbs`，rebuild-orientation-thumbs.ts，103 张）
   - 浏览器缩略图缓存失效链路：thumbUrl 带 `rev` 版本号（web/src/api/client.ts 的 THUMB_REV，当前 3；视频封面共用该版本）+ 响应头去 immutable（thumb.ts）
   - 实况按住播放带原声（LivePhoto.vue：`:muted="!playing"` + 显式 unmuted + 静音兜底）
   - 详情/搜索竞态守卫、扫描断点续跑容错
7. **文档已同步**：README.md（目录树/命令/API/验证表/踩坑）+ 架构设计文档.html（§5 结构、§6 路线图含稳定化 + P2+ 规划）。
8. **审查后功能（2026-09-08 当日）**：① 主题切换——浅色/深色 CSS 变量双主题，默认浅色，localStorage 持久化 + index.html 内联脚本防闪烁；详情/实况/视频查看区恒深。② 日期面板方案 C（toggle 开关）。③ 默认 8 列。④ 详情返回保留滚动位置——KeepAlive 仅缓存 GridView，onScroll 持续记录 + onActivated 恢复（修复了 deactivated 读不到滚动值、ResizeObserver 污染宽高导致的行高错位两个坑）。
9. **照片墙全量骨架（C 方案，2026-09-08 三版）**：行序列（月份头 + 资产行）由「月份分组 + 列数」一次精确生成全库（8 列 1,676 行 / 219,106px）→ 滚动条 = 全库、双向滚动；store 改页区间懒加载（pages Map，120 条/页，幂等 + 并发去重）；吸顶月份指示器升级为**日期跨度**（视口首末资产行，倒序直出，过滤 overscan 预热行与真实可视范围一致）；月份头标签改区间（如「2021年4月-3月」）；列数范围 4~12（12 列需扣 .grid-row 水平 padding ROW_PAD=24 防溢出）+ 行高抽象 getRowHeight（原比例扩展点）；currentYm/currentMonthLabel 同口径过滤 overscan。
10. **扫描配对修复（2026-09-08 二次）**：配对 key 从「文件名基名」改为「**目录 + 基名**」——iCloudPD 会把同名文件（不同设备/编辑版本）按各自拍摄日期归档进不同目录，只看基名会跨目录错误配对：同组多余视频被静默丢弃（曾丢失 3,382 个视频）、实况视频可能配到另一张同名照片上。增量逻辑同时改为「复用现有元数据、仍 UPSERT 修正 type/live_video」。重扫后 11,009 → 12,591（photo 1,982 / live 7,434 / video 3,175），与磁盘文件精确一致；与 iCloud 统计基本对齐（照片 9,416≈9,419，视频 3,175≈3,033）。验证：实况配对跨目录 0、live 配对视频磁盘缺失 0、video 文件磁盘缺失 0、缩略图缓存孤儿 0。
11. **UI 徽标刷新（2026-09-08）**：标题「iCloud本地照片」+ favicon.svg（web/public/，蓝渐变圆角方块+白色照片图形）；LIVE 徽标简约化（网格 + 详情白字胶囊圆角，去掉原黄色字）；详情实况按住播放时徽标内旋转加载动画（@loadstart/@waiting→loading，@canplay/@playing→结束，松开复位）；视频缩略图右下 ▶ 改黑底时长胶囊（复用 asset.duration，0:03 式）；formatDuration 支持 ≥1h（1:02:03）。HDR 徽标用户砍掉：实测全库 8,131 个 HEIC 仅 1 张含 GainMap（2019/12/12/IMG_3944.HEIC），判定方法可靠（HEIF iinf item_type GMap/gmap，ISO 21496-1），收益低。
12. **详情页渐进显示（2026-09-08）**：详情页冷生成 detail 大图期间此前仅 loading 遮罩（0.5~3s 黑屏）；现复用照片墙已缓存的 grid 档做 CSS 模糊占位（blur 16px）→ detail 加载完成后淡入覆盖（DetailView / LivePhoto / VideoStage 三组件，不产生独立占位缩略图请求）。detail 缓存命中时两图并行、直出清晰大图。P2+-4 detail 缓存治理（保留最近 N 月 / 一键清空）仍按计划，仅针对 cache/thumbs/detail/ 目录（约 250KB/张）；详情 CSS 模糊不依赖独立 blur 缩略图档。
13. **P2+-1 落地（2026-09-17；2026-10-01 稳健性补齐）**：① 目录热监听（server/src/scanner/watcher.ts）——chokidar 监听照片库，事件防抖 1.5s 合并、扫描互斥。② 删除对账——只有完整遍历照片库后才清理磁盘缺失资产；根目录或子目录读取失败时保留数据库记录并跳过本次删除对账。③ 启动同步——index.ts 启动即后台 runScan('startup')。④ 前端每 5 秒轮询扫描状态，扫描期间不自动刷新照片墙；扫描结束后最终刷新并尽量保留滚动位置，用户可手动提前查看已入库内容。⑤ 后端启动时清理超过 24 小时、符合流水线命名的遗留 PNG 临时帧。
14. **客户端删除（2026-09-17；2026-10-01 反馈补齐）**：照片墙单选/多选删除 + 详情页删除 + 确认弹框；源文件不存在按已删除处理，其他 unlink 失败会记录并返回计数，前端提示源文件可能仍留在磁盘；数据库记录与缓存仍会移除。
15. **2026-09-17 全项目审查 + 修复**：B1 删除后页缓存错位（removeAssets 清空删除点之后的页，防滚动错位）；B2 实况宽高兜底（thumb.ts ensureSize 条件 photo→非 video）；B3 首屏主题异常分支默认深色→浅色（index.html，应用默认白色）；B4 CORS 补 DELETE；B5 五处补丁残留排版整理（App/GridScroller/DetailView/GridItem/GridView，纯格式）；文档三件套同步（README + 架构设计文档 + 本快照）。
16. **2026-09-18 采纳 Claude 审查修复**：assets store 删除与分页请求竞态（dataVersion 版本号 + requestSequence/activeRequests 每页唯一 id 双校验，删除后旧分页响应不回写缓存、加载中页重拉）；GridView 搜索宽度 ResizeObserver 正确启动（监听 searchActive 进入搜索后绑定、卸载 disconnect）。已合并 main（91c8b71）。
17. **2026-09-19～2026-09-21 搜索照片墙化、审查修复与运行验证**：① 搜索照片墙化——后端 /api/search 加 offset 跳页分页 + total 真实计数 + months 匹配集月份分组；GridScroller 抽象 GridDataSource 接口（照片墙 assets store / 搜索 search store 共用，组件实例不销毁只切数据源）；列数提升到 theme store（thumbnailCols 持久化 4~12，照片墙/搜索共享）；GridView 搜索态改用 GridScroller（删除旧固定 5 列网格 + 100 条截断）。② FTS trigram 精确性——FTS 粗筛 + 每个 token `instr` 连续子串精筛，多 token AND，误匹配归零。③ 搜索 store 增加统一结果失效/重置，旧请求不会污染新查询。④ 完成后端扫描、视频 Range、统计缓存、图片信息回退、同名额外视频保留等修复，并用隔离测试库验证；`server/package.json` 的 `npm run scan` 已修正为 `src/cli-scan.ts`。
18. **2026-09-29 依赖清理**：去掉未使用的 `heic-convert`、已停维护的 `fluent-ffmpeg` 与精简版 `ffmpeg-static`；ffmpeg 改为 `server/vendor/ffmpeg-full/` 直出 + `src/ffmpeg.ts` spawn，sharp 升至 0.35。better-sqlite3 13.0.3 的平台预编译文件随 npm 包分发；npm 11.9.0 在 `npm ci` 时若 lockfile 未保留 `gypfile:false`，会按 `binding.gyp` 自动触发 node-gyp，因此 lockfile 显式保留此字段。
19. **2026-10-01 稳健性修复**：资产/搜索 `limit` 限制为 1–500 整数；开发 CORS 只允许本机 Vite 来源；视频封面 URL 与普通缩略图共用 `THUMB_REV=3`；修正入口扫描与实况配对注释。

## 照片库实测数据（2026-09-08）
- 结构：`YYYY/MM/DD/文件名`（iCloudPD 默认），实况配对基名归一（`_HEVC` 后缀），**无时间差校验**。⚠️ **配对必须限定同一目录**——跨目录同名文件（不同设备/编辑版本的同名，如 `2018/02/04/IMG_0040*` 与 `2021/07/27/IMG_0040*`，全库 2,363 个基名分布多目录）若只按基名配对会错配丢视频（见「已完成」第 9 条）。
- 磁盘文件口径（20,025 文件）：HEIC 8,131 / MOV 1,159+12（异常小写 "*.mov"）/ JPG 1,067 / MP4 403 / PNG 217 / M4V 19 / GIF 1；其中视频文件共 10,609（含 7,434 个实况配对视频）。
- 修复后资产：12,591 = photo 1,982 + live 7,434 + video 3,175。
- 关键统计：orientation=6 共 6,853 张（photo+live），orientation=1 共 1,905；非 HEIC + orientation 2~8 = 103 张（方向重建范围）。

## 技术选型（已定）
- 后端：Node 24（用户 D:\nodejs）+ TypeScript + Fastify 5 + better-sqlite3 13.0.3（包内平台预编译，lockfile 需保留 `gypfile:false`）+ exifr + sharp 0.35 + vendor ffmpeg spawn（BtbN full / libheif）+ p-queue（并发 8）
- 前端：Vue 3.5 + Vite + TS + Pinia + vue-router(hash) + @tanstack/vue-virtual + 自研 useLazyImage（IntersectionObserver）
- 缩略图档：grid 320px / detail 1600px WebP；视频封面 ffmpeg 抽帧。扫描后只后台预热 grid；照片墙格子先显示底色，grid 图片加载成功后淡入；已废弃的 blur 缓存由扫描清理
- 端口：后端 127.0.0.1:8899，前端 http://localhost:5173（Vite 绑 IPv6，勿用 127.0.0.1:5173）

## 实施路线（最新）
- ✅ P0：扫描 + 虚拟滚动 + 缩放 + 缩略图懒生成 + 详情 + 实况 + 视频
- ✅ P1：日期定位 + 邻居预取 + 渐进图片加载 + 深链 + 键盘 + 实况（剩内存 LRU 后置）
- ✅ P2：FTS5 搜索（HEVC 转码/收藏/最近删除/下载不做；批量选择已随客户端删除落地）
- ✅ 稳定化：12 项修复 + GitHub 版本管理
- ✅ **照片墙占位优化（2026-10-03）**：移除独立 blur 缩略图档及对应请求/后台生成；格子先显示底色，grid 图片加载成功后淡入。旧 `cache/thumbs/blur/` 在扫描时清理；详情页复用 grid 并用 CSS 模糊的占位效果保留。
- ✅ **P2+-1 部分落地（2026-09-17；2026-10-01 刷新与完整性保护已补齐）**：目录热监听 + 完整扫描后删除对账 + 启动同步 + 扫描完成后刷新照片墙；一键拉取仍待开发。
- 🔜 **P2+-2 冷启动体验（部分完成）**：扫描按 `YYYY/MM/DD` 目录日期从新到旧处理（仅优先级，展示仍按实际拍摄时间）；每 5 秒轮询扫描状态，扫描期间不自动刷新照片墙，结束后最终刷新一次。顶部详细进度仍待开发。
- ⏸ P2+-3 语义搜索（暂缓）：人物/地点/场景组合（如「邓州 2023 年 陈咏新」）——不连大模型，face-api.js + tfjs-node 本地人脸聚类 + people/faces/asset_tags 表 + 组合查询解析器；视频抽帧入人脸库；标签不写文件元数据。

## 工程约定（踩坑沉淀）
- **PowerShell 引号坑**：命令实际由 PowerShell 执行；`\"` 不是转义（用反引号）、双引号内 `$` 会展开。多层级引号一律落临时文件：复杂 JS/SQL 写 `.cjs` 文件再 `node 文件`；多行 commit 用 `Out-File` + `git commit --file=`。
- **原生模块**：better-sqlite3 13.0.3 随 npm 包提供平台预编译文件；当前运行环境 Node 24，项目要求 Node 22+。本地若切换 Node 主版本后遇到原生模块加载错误，先在 `server/` 重跑 `npm ci`。ffmpeg 不再走 npm 原生包，在 `server/vendor/ffmpeg-full/`。
- **服务进程**：用户自启后端 8899/前端 5173，勿占用；临时验证进程用完 TaskStop。
- **git SSH**：固定 `core.sshCommand = "C:/Windows/System32/OpenSSH/ssh.exe" -o StrictHostKeyChecking=accept-new`；日常 `git push origin main` 畅通。
- **临时脚本**：`server/scripts/.*`（dot 开头）用完即删，已在 .gitignore 排除防误提交。
- **缩略图缓存**：内容变更后 bump `THUMB_REV`（web/src/api/client.ts，当前 3；视频封面也使用此版本号）；`npm run fix-thumbs` 重建方向缓存。
- **sharp 0.33.5**：构造选项 `rotate:true` 不生效，必须链式 `.rotate()`。

## 待办 / 遗留（均不影响使用）
- 29 个 4K 视频缩略图 thumb_status='error'（历史遗留，用户未决定是否排查；与历次修复无关）。
- ✅ 缩略图生成失败留 0 字节 WebP 兜底：已在 generate() catch 分支补 `fs.rmSync(outPath, {force:true})`（2026-09-08 审查后修复）。
- `server\vendor\ffmpeg-full.zip`（163MB 安装包）保留或删除：无用户决定（.gitignore 已排除不入库）。
- ✅ toolbar 调试信息（items/rows/virt）：已定保留（用户确认）。
- ✅ **KeepAlive 缓存失效已补齐（2026-10-01）**：前端轮询扫描状态，扫描结束后刷新月份和已缓存页；保留滚动位置。
- ✅ 2026-09-17 审查 B1~B5 修复完成（删除页缓存错位 / 实况宽高兜底 / 首屏默认浅色 / CORS DELETE / 排版整理）。
- 🔜 P2+-1 一键拉取（exe 方案已定）与 P2+-2 冷启动进度交互待开发；P2+-3 语义搜索暂缓实现；**P2+-4 详情缓存治理已列入**（保留最近 N 月浏览的 detail 图 / 一键清空 detail 缓存，可选）。
- 🔜 **search store 换词 finally 竞态**（2026-09-19 审查发现，待用户确认）：旧词请求 finally 无条件 `pageLoading.delete(p)` 可能误删新词请求的加载标记 → 偶发重复请求（数据幂等无错）。修复 = finally 加 `if (seq !== searchSeq) return`（一行）。

## 用户偏好（与本项目相关）
- 技术/财经类内容偏好"深度解析 + 大白话 + 结构化清单"。
- 代码要目录规范、结构清晰、详细注释（用于学习）。
- **改动工作流程（硬性）**：① 任何需求改动先给评估（怎么改、对现有代码的影响）→ ② 用户明确确认 → ③ 新建 git 分支再改 → ④ 完成后经用户确认 → ⑤ 合并回 main 并清理旧分支。
