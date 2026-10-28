# 项目上下文快照（供会话压缩/新会话恢复用）

> 生成日期：2026-09-08；最后同步：2026-10-28（四次合并：① 10-27 整体审查报告第一批 7 项修复——扫描对账保护 / 删除接口严格语义与守卫 / 删除后分页空洞 / 引导切库与非激活库同步 / 删库安全默认 / 错误提示浮层；② 多库体验优化——库卡片切换入口、配置摘要、建库预建目录、引导可跳过；③ 审查第二批 6 项——删库竞态 / 缩略图队列竞态三连 / 认证定时器与进程归属；④ 审查第三批 3 项前端——网格 rev 响应式 / 宽度变化重测量 / 切数据源保位；此前 10-12 同步 P0 照片库同步与多库实现 + 文档三件套）。若本会话上下文被压缩或丢失，先读本文件 + 架构设计文档 + README，即可恢复全部关键信息。

## 项目目标与现状
- 用户已用 iCloudPD 把 iCloud 照片全部拉到本地（照片库根 `F:\iPhone\icloud-app\iCloudPhoto\`）。**源文件数量与容量从略（属个人隐私）：全库照片、实况照片与视频合计为万级资产，磁盘媒体文件为数万级。**
- 目标：本地网页应用，复刻 iCloud 网页端浏览体验。前端 Vue 3 系列，后端 Node.js。
- **当前状态：P0/P1/P2 全部完成并通过验收；代码审查 12 项稳定化修复全部完成；扫描配对修复（跨目录同名，修复后与磁盘精确一致）已合并；照片墙全量骨架（C 方案）已上线：滚动条=全库双向滚动 + 吸顶日期跨度 + 月份头区间标签 + 4~12 列 + 行高抽象；详情信息面板（/api/assets/:id/info）已上线；UI 徽标刷新与详情页三级渐进已上线；P2+-1 部分落地（目录热监听 + 删除对账 + 启动同步，一键拉取 exe 待开发）；客户端删除已上线（照片墙单选/Ctrl多选 + 详情页删除 + DELETE /api/assets + 确认弹框）；2026-09-17 全项目审查完成并修复 B1~B5（删除后页缓存错位 / 实况宽高兜底 / 首屏默认浅色 / CORS 补 DELETE / 排版整理）+ 文档三件套同步；2026-09-18 采纳 Claude 审查两处高信号修复（assets store 删除与分页请求竞态：dataVersion + requestSequence/activeRequests 双校验；GridView 搜索宽度 ResizeObserver 启动）已合并；**2026-09-19 搜索照片墙化 + FTS trigram 精确性修复已合并**（匹配集虚拟滚动/月份分组/列数共享；trigram 片段 AND 误命中 → FTS 粗筛 + instr 连续子串精筛）；**2026-10-06 审查报告 F-01~F-07 全部修复合并推送 main**（单调度器 ≤8 并发 / F-02 断开检测 / F-03 签名失效 + rev 联动 / F-04 Origin 校验 / F-05 搜索错误态 / F-06 FTS 版本化 / F-07 ffmpeg 超时 + 失败清单系列）；Git 私有仓库 + GitHub 远程（isChen0111/icloud-app，SSH 推送）版本管理。**

## 已完成的工作
1. **实测 iCloud 网页端机制**（浏览器操作 + 网络抓包 + JS bundle 源码分析）：
   - 网格 = 自研虚拟滚动（DOM 常驻 ~168 节点，absolute+transform，列数 3~9 滑块缩放只改 CSS）；缩略图 DerivativeImage ~415px 档 XHR→blob→objectURL；详情 OneUp 轮播 3 格 + 邻居预加载 ±2；实况照片 = 静止帧 + 隐藏 video 叠层按住播放；视频 = 原生 video + HTTP 206 Range。
2. **行业调研**：Immich 三档缩略图、@tanstack/vue-virtual、sharp（libvips+libheif 是 Node HEIC 唯一成熟方案）、iCloudPD 输出结构（YYYY/MM/DD + `IMG_xxxx.HEIC ⇄ IMG_xxxx_HEVC.MOV`）。
3. **P0 已落地并端到端验证**：后端 server/（Fastify + better-sqlite3 + sharp + ffmpeg）+ 前端 web/（Vue3.5+Vite+TS+Pinia 虚拟滚动/懒加载/详情轮播/实况/视频）。全量扫描完成（资产数从略）；HEIC 解码用 BtbN ffmpeg full 版（libheif）已固化 postinstall。**第三方二进制自动安装**：postinstall 串联 `install-ffmpeg-full.ps1` + `install-icloudpd.ps1`（icloudpd exe 2026-10-12 加入），均从仓库 Release `vendor-binaries` 下载（已存在跳过，URL 可覆盖）。
4. **P1 已验收**：日期分组定位（月份头行 + 吸顶月份指示器 + **方案 C 日期导航面板**——工具栏「日期」按钮 → 下拉面板，左年份 + 右月份缩略图 3×4 网格，/api/dates 返回全部月份分组 offset+thumbId）、缩放滑块（**默认 8 列**）、详情邻居预加载、照片墙底色占位后渐进显示 grid 缩略图、hash 深链、键盘切换、实况按住播放。内存 LRU 已决定不做（2026-10-07：本地场景收益低，浏览器缓存已足够）。
5. **P2 已验收（范围收缩）**：FTS5 trigram 搜索（文件名/日期子串，至少 3 字符，/api/search）。用户已决定不做：HEVC 按需转码缓存 / 逆地理编码 / 收藏 / 最近删除 / 下载原片；客户端批量选择已在 P2+-1 随删除功能落地。
6. **稳定化（代码审查 5×P1 + 7×P2 = 12 项全部修复）**：
   - stats 异步体积统计 + 落盘缓存（首屏 229ms）
   - 原图宽高全量修正（`npm run fix-size`，fix-asset-size.ts）
   - EXIF 方向缩略图重建（`npm run fix-thumbs`，rebuild-orientation-thumbs.ts，数量从略）
   - 浏览器缩略图缓存失效链路：thumbUrl 带 `rev` 版本号（web/src/api/client.ts 的 THUMB_REV，当前 3；视频封面共用该版本）+ 响应头去 immutable（thumb.ts）——2026-10-06 F-03 后 rev 已动态化（= file_mtime），见「工程约定」
   - 实况按住播放带原声（LivePhoto.vue：`:muted="!playing"` + 显式 unmuted + 静音兜底）
   - 详情/搜索竞态守卫、扫描断点续跑容错
7. **文档已同步**：README.md（目录树/命令/API/验证表/踩坑）+ 架构设计文档.html（§5 结构、§6 路线图含稳定化 + P2+ 规划）。
8. **审查后功能（2026-09-08 当日）**：① 主题切换——浅色/深色 CSS 变量双主题，默认浅色，localStorage 持久化 + index.html 内联脚本防闪烁；详情/实况/视频查看区恒深。② 日期面板方案 C（toggle 开关）。③ 默认 8 列。④ 详情返回保留滚动位置——KeepAlive 仅缓存 GridView，onScroll 持续记录 + onActivated 恢复（修复了 deactivated 读不到滚动值、ResizeObserver 污染宽高导致的行高错位两个坑）。
9. **照片墙全量骨架（C 方案，2026-09-08 三版）**：行序列（月份头 + 资产行）由「月份分组 + 列数」一次精确生成全库（8 列 1,676 行 / 219,106px）→ 滚动条 = 全库、双向滚动；store 改页区间懒加载（pages Map，120 条/页，幂等 + 并发去重）；吸顶月份指示器升级为**日期跨度**（视口首末资产行，倒序直出，过滤 overscan 预热行与真实可视范围一致）；月份头标签改区间（如「2021年4月-3月」）；列数范围 4~12（12 列需扣 .grid-row 水平 padding ROW_PAD=24 防溢出）+ 行高抽象 getRowHeight（原比例扩展点）；currentYm/currentMonthLabel 同口径过滤 overscan。
10. **扫描配对修复（2026-09-08 二次）**：配对 key 从「文件名基名」改为「**目录 + 基名**」——iCloudPD 会把同名文件（不同设备/编辑版本）按各自拍摄日期归档进不同目录，只看基名会跨目录错误配对：同组多余视频被静默丢弃（曾丢失大量视频）、实况视频可能配到另一张同名照片上。增量逻辑同时改为「复用现有元数据、仍 UPSERT 修正 type/live_video」。重扫后与磁盘文件精确一致；与 iCloud 统计基本对齐。验证：实况配对跨目录 0、live 配对视频磁盘缺失 0、video 文件磁盘缺失 0、缩略图缓存孤儿 0。
11. **UI 徽标刷新（2026-09-08）**：标题「iCloud本地照片」+ favicon.svg（web/public/，蓝渐变圆角方块+白色照片图形）；LIVE 徽标简约化（网格 + 详情白字胶囊圆角，去掉原黄色字）；详情实况按住播放时徽标内旋转加载动画（@loadstart/@waiting→loading，@canplay/@playing→结束，松开复位）；视频缩略图右下 ▶ 改黑底时长胶囊（复用 asset.duration，0:03 式）；formatDuration 支持 ≥1h（1:02:03）。HDR 徽标用户砍掉：实测全库 HEIC 中仅 1 张含 GainMap，判定方法可靠（HEIF iinf item_type GMap/gmap，ISO 21496-1），收益低。
12. **详情页渐进显示（2026-09-08）**：详情页冷生成 detail 大图期间此前仅 loading 遮罩（0.5~3s 黑屏）；现复用照片墙已缓存的 grid 档做 CSS 模糊占位（blur 16px）→ detail 加载完成后淡入覆盖（DetailView / LivePhoto / VideoStage 三组件，不产生独立占位缩略图请求）。detail 缓存命中时两图并行、直出清晰大图。P2+-4 detail 缓存治理（保留最近 N 月 / 一键清空）仍按计划，仅针对 cache/thumbs/detail/ 目录（约 250KB/张）；详情 CSS 模糊不依赖独立 blur 缩略图档。
13. **P2+-1 落地（2026-09-17；2026-10-01 稳健性补齐）**：① 目录热监听（server/src/scanner/watcher.ts）——chokidar 监听照片库，事件防抖 1.5s 合并、扫描互斥。② 删除对账——只有完整遍历照片库后才清理磁盘缺失资产；根目录或子目录读取失败时保留数据库记录并跳过本次删除对账。③ 启动同步——index.ts 启动即后台 runScan('startup')。④ 前端每 5 秒轮询扫描状态，扫描期间发现已入库资产且照片墙仍为空时自动填充；扫描结束后最终刷新并尽量保留滚动位置。⑤ 后端启动时清理超过 24 小时、符合流水线命名的遗留 PNG 临时帧。
14. **客户端删除（2026-09-17；2026-10-01 反馈补齐）**：照片墙单选/多选删除 + 详情页删除 + 确认弹框；源文件不存在按已删除处理，其他 unlink 失败会记录并返回计数，前端提示源文件可能仍留在磁盘；数据库记录与缓存仍会移除。
15. **2026-09-17 全项目审查 + 修复**：B1 删除后页缓存错位（removeAssets 清空删除点之后的页，防滚动错位）；B2 实况宽高兜底（thumb.ts ensureSize 条件 photo→非 video）；B3 首屏主题异常分支默认深色→浅色（index.html，应用默认白色）；B4 CORS 补 DELETE；B5 五处补丁残留排版整理（App/GridScroller/DetailView/GridItem/GridView，纯格式）；文档三件套同步（README + 架构设计文档 + 本快照）。
16. **2026-09-18 采纳 Claude 审查修复**：assets store 删除与分页请求竞态（dataVersion 版本号 + requestSequence/activeRequests 每页唯一 id 双校验，删除后旧分页响应不回写缓存、加载中页重拉）；GridView 搜索宽度 ResizeObserver 正确启动（监听 searchActive 进入搜索后绑定、卸载 disconnect）。已合并 main（91c8b71）。
17. **2026-09-19～2026-09-21 搜索照片墙化、审查修复与运行验证**：① 搜索照片墙化——后端 /api/search 加 offset 跳页分页 + total 真实计数 + months 匹配集月份分组；GridScroller 抽象 GridDataSource 接口（照片墙 assets store / 搜索 search store 共用，组件实例不销毁只切数据源）；列数提升到 theme store（thumbnailCols 持久化 4~12，照片墙/搜索共享）；GridView 搜索态改用 GridScroller（删除旧固定 5 列网格 + 100 条截断）。② FTS trigram 精确性——FTS 粗筛 + 每个 token `instr` 连续子串精筛，多 token AND，误匹配归零。③ 搜索 store 增加统一结果失效/重置，旧请求不会污染新查询。④ 完成后端扫描、视频 Range、统计缓存、图片信息回退、同名额外视频保留等修复，并用隔离测试库验证；`server/package.json` 的 `npm run scan` 已修正为 `src/cli-scan.ts`。
18. **2026-09-29 依赖清理**：去掉未使用的 `heic-convert`、已停维护的 `fluent-ffmpeg` 与精简版 `ffmpeg-static`；ffmpeg 改为 `server/vendor/ffmpeg-full/` 直出 + `src/ffmpeg.ts` spawn，sharp 升至 0.35。better-sqlite3 13.0.3 的平台预编译文件随 npm 包分发；npm 11.9.0 在 `npm ci` 时若 lockfile 未保留 `gypfile:false`，会按 `binding.gyp` 自动触发 node-gyp，因此 lockfile 显式保留此字段。
19. **2026-10-01 稳健性修复**：资产/搜索 `limit` 限制为 1–500 整数；开发 CORS 只允许本机 Vite 来源；视频封面 URL 与普通缩略图共用 `THUMB_REV=3`；修正入口扫描与实况配对注释。
20. **2026-10-06 全项目代码审查 + F-01/F-02/F-05/F-06 修复（主线）**：
   - 审查报告 `docs/整体审查报告-2026-10-06.md`（基线 c2a64bb）：7 项问题 F-01~F-07 全部核验属实（P1×2 + P2×5），含"六、后续执行方案"（已提交 7efbd43 / 合并 fdb946c）。
   - **F-01 并发超限（P1，199fbc0/合并 2a8abb0）**：旧双队列（后台 8 + 交互 1 = 9 并发）合并为单一 `ThumbnailScheduler`（server/src/pipeline/thumbnailScheduler.ts）——单 p-queue、concurrency=8、交互 priority=10 / 后台 priority=0（**2026-10-07 事件让位改造后：后台始终入队、交互不足时后台填满剩余槽位，原「浏览租约 30s 挂起 + 60s 强制放行」机制已移除**）；queue.ts 重构后对外接口不变；新增 node:test 单元测试 `thumbnailScheduler.test.ts`（10 用例，npm test）。
   - **F-02 轻量版 + 队列指标（7b0180c/合并 e58e947）**：`/api/thumb` 与 `/api/video/poster` 任务开始执行时检查 `req.raw.destroyed/aborted`，断开则跳过生成 + 计入"已跳过"（静默结束、不进失败清单）；调度器加 3 计数器（interactiveRunning/interactiveWaiting/cancelled）→ `/api/stats.thumbQueueMetrics`；前端资源状态浮层展示队列指标（含口径悬浮提示）。测试扩至 9 用例。
   - **并发来源统一 + rAF（608c925/合并 792cd7e）**：前端调度器并发上限（原硬编码 8）改为经 `/api/stats.thumbConcurrency` 校准（后端 config 唯一来源，防漂移）；滚动触发 pump 改 rAF 合并（每帧最多一次布局读取）；架构文档新增 §4.12「照片墙滚动 → 缩略图请求的前后端协同机制（三道闸 + F-01/F-02）」。**关键结论（已入文档）**：前端限流 ≤8 并发 → 后端交互队列几乎不排队 → F-02 轻量版日常"已跳过=0"是预期（纵深防御 + 极端积压兜底）。
   - **F-05 搜索错误态（P2，5a17e8e/合并 e24600b）**：search.ts catch 分类——预期输入级错误（FTS 语法类，消息含 syntax/malformed/no such column 等）返回空结果；真异常返回 500 + 错误信息（不再伪装成"没有结果"）；前端 search store 加 `searchError`（首屏失败置错）+ GridView「搜索失败，请重试」错误态与重试按钮；滚动后续页失败仍走静默 + 滚回重试。
   - **F-06 FTS 版本化（P2，同合并）**：schema.ts 建表 DROP → `CREATE VIRTUAL TABLE IF NOT EXISTS`；db/index.ts 用 `PRAGMA user_version` 记录 `FTS_SCHEMA_VERSION=2`——版本不符才 DROP+CREATE 全量重建，正常启动只按行数差回填（**正常启动零重建**，迁移已执行：user_version 0→2，assets_fts 与 assets 表行数一致）。
   - **Git 清理**：远程 9 分支系本地过期缓存快照（实际仅 main）；一次性清理 17 个已合并旧分支 + prune 远程 gone 分支。
   - **F-07 FFmpeg/FFprobe 超时 + 失败清单系列（P2，2026-10-06，分支 fix/ffmpeg-timeout → 合并 505cb28 已推送）**：`ffmpeg.ts` 按操作类型超时（FFprobe 30s / 抽帧、HEIC 解码 60s），超时 kill 子进程并等 close 统一收尾，错误带 stderr 尾部；新增 `ffmpeg.test.ts`（超时 kill / 不误杀 2 用例）。**附带失败清单系列修复（同分支）**：①失败项忽略/重试不再被 preparing 锁住（只锁扫描中，消除 409 死锁）；②后台挂起上限 `backgroundMaxDeferMs=60s` 强制放行（防持续浏览饿死后台；**注：该挂起机制 2026-10-07 事件让位改造中已整体移除**）；③失败保留 `thumb_ignored` + 忽略项跳过自动重试 + 自愈日志；④浮层三态入口（失败 N / 已忽略 N / 失败 0，入口常驻）；⑤扫描缓存对账（grid 缓存存在但 DB pending → 补记 done，根治「待处理 N 卡 99% 转圈」死锁，实测待处理 2→0）；⑥命名修正：浮层「待处理」→「失败」、顶部徽标「预览图待处理」→「预览图失败」。测试 12/12 全绿 + 前端 build 通过。
   - **F-03 源文件签名 + F-04 Origin 校验（P2，2026-10-06，分支 fix/f03-f04 → 合并 6fd9dae 已推送）**：assets 表新增 `file_size`/`file_mtime`（列检查 ALTER 迁移）；scanner 遍历收集签名（size + mtimeMs，约 1~2s 总成本），签名不一致 → 重新提取元数据 + 状态置 pending + 删旧 grid/detail 缓存 → 重建。**前端 rev 联动**：资产 DTO / `/api/dates` 返回 `rev = file_mtime`，thumbUrl/videoPosterUrl 调用点携带（GridItem/DetailView/LivePhoto/DateNavPanel/useLazyImage）——覆盖文件后 mtime 变 → URL 变 → 浏览器绕过 1 年强缓存自动换新图（F-03 完整闭环）。F-04：index.ts onRequest hook 对带非允许 Origin 的非 GET/HEAD 请求返回 403（恶意网页跨站防护；curl/本地脚本无 Origin 零影响）。⚠️ **2026-10-18 修订**：原白名单漏生产同源（build 后浏览器同源请求带 `Origin: http://127.0.0.1:8899` 被 403，见 §24）；改为 **dev 白名单 ∪ 同源判定**（Origin host == 请求 Host）。验证：tsc/vue-tsc 0 错、测试 12/12、F-03 端到端（覆盖→失效→重建→前端换图）、F-04 行为 4 项全对。审查报告 7 项全部完成。
21. **2026-10-07 调度器事件让位改造（fix/event-based-yield，待验收）**：替换原「浏览租约 30s 挂起 + 60s 强制放行」机制——后台任务始终入队（priority=0），交互任务 priority=10 永远先出队，PQueue 一次启动 concurrency 个任务时交互不足则用后台填满剩余槽位（零时间参数、零槽位浪费）。动机：增量更新场景（如仅新增 1 个文件）下后台任务原需白等 30s，即使槽位全空闲；60s 放行在持续浏览时也只保证「入队排队」而非「真正执行」。**结构性 trade-off**：运行中的任务不可被抢占，首次启动大量后台占满槽位时交互需等运行中的后台完成（单任务 ffmpeg 60s 超时上限，通常几百 ms）。连带删除：`/api/thumbnails/activity` 路由与前端 `notifyThumbnailBrowsing`/App.vue 浏览信号监听（6 个事件）、`markThumbnailBrowsing`、`browseLeaseMs`/`backgroundMaxDeferMs`。影响文件：thumbnailScheduler.ts / queue.ts / thumb.ts / client.ts / App.vue / thumbnailScheduler.test.ts（10 用例：并发不变量 3 + 交互优先 2 + 后台填槽 2 + 积压计数 1 + 队列指标 2）+ 文档同步。验证：server npm test 12/12、双端 tsc 0 错。
22. **2026-10-07 慢速拖动修复（fix/slow-drag-prefetch，待验收）**：拖拽模式**按速度拆开**——慢速拖动（250ms 内位移 ≤ 1/5 屏）从原「250ms 节流轮询 + 只加载严格可见（`visibleOnly` → margin=0 无预载）」改为「onScroll 走 rAF 合并每帧派发 + **始终带预载 margin**」，与普通滚动同体验（新进视口的图下一帧即触发、视口外一行提前预载）；快速拖动保留 `fastDrag` 跳过中间区域（防请求风暴）；250ms 轮询从「加载驱动」改为「速度检测器」。**动机**：慢速拖动时图片「慢慢出现、松手才秒出」——原设计每 250ms 才触发且刻意关掉预载，加载自身延迟被放大。**删除** `visibleOnly` 参数与 `pump(visibleOnly)` 的 margin=0 分支。影响文件：仅 `web/src/composables/gridThumbnailScheduler.ts`（接口不变，GridScroller.vue / useLazyImage.ts 零改动）。验证：vue-tsc 0 错 + 浏览器手动 3 场景（慢速拖动即时出现 / 快速拖动跳过中间松手秒出 / 滚轮不变）。
23. **2026-10-09~12 P0 照片库同步与多库（feat/icloudpd-sync → 已合并 main 6ba85ae，2026-10-13）**：网页端直接管理 icloudpd 拉取，多库单活跃库模式。
   - **后端**：① `db/libraries.ts` 库注册表（应用级 `server/cache/meta.db`，多库共享）——createLibrary（**已有激活库时新建不激活**，仅首次建库激活；目录规则：照片根 `iCloudPhoto/lib<id>`、缓存 `server/cache/lib<id>`、cookie 同库下 `cookies`，库名只是别名不参与路径）/list/getActive/setActive/updateAuth/touchSync/delete。② `context.ts` 激活库上下文——getCurrentLibrary 实时读 meta.db、applyLibraryPaths 覆写 config、resetLibraryPaths（删最后一个库回默认路径）。③ `icloudpd/auth.ts` **webui 桥接认证**——console 管道实测不可行（getpass 直读 Windows 控制台不走管道，管道化挂起），改 spawn `--password-provider webui --mfa-provider webui --auth-only`，轮询 127.0.0.1:8080 `/status` 解析 password/code 阶段，前端 `POST /api/auth/input` 由后端桥接转 webui `/password`|`/code`；完成判据 = 进程退出码 0 + cookie 落盘；状态机 starting→waiting_password→submitting→waiting_code→done/error；`sendAuthInput` 加 **inputLock 防重锁**（防连点/并发造成**手机收到两次双重验证弹窗**，2026-10-12 实测）；10 分钟超时 taskkill /T 杀进程树；checkAuthValid 巡检。④ `icloudpd/sync.ts` 全量/增量——`--until-found 20` 增量、测试限量已废弃（`ICLOUDPD_RECENT` 不再读取，改由设置中心每库 `recentLimit` 配置）、waiting_retry（has not finished indexing 60s×5）、done/error/cancelled 内存态全局单任务（isSyncBusy 409）。⑤ routes：`libraries`（CRUD + PATCH active + DELETE removePhotos 必删注册+缓存、删激活库自动切剩余最小 id 库/删最后 resetLibraryPaths、删前 resetSyncState 防旧库「同步完成」残留）、`auth`（POST /api/auth、/api/auth/input、GET /api/auth、POST /api/auth/cancel）、`sync`（POST/GET/DELETE /api/library/:id/sync，仅当前激活库可发起）、`stats`（sync 状态带 libraryId + auth 状态 + 账号去脱敏完整返回）。
   - **前端**：① App.vue——右上角库切换下拉（当前库名 ▾ + 列表 + 新建）+ 设置齿轮；移除 popover 红框库信息/新建库区块；`pickLibrary` 切库后 location.reload()；`onLibraryDeleted` 非激活库仅移除下拉项；`openAuth` 按 account 传 autoStart（刷新链接打开即自动认证）。② `SettingsView.vue`（新）——左侧分组导航（照片库/应用）、每库卡片（当前标识/照片 N·视频 M/完整账号/目录缓存会话/最近同步独立行/新建链接·刷新链接/删除确认弹窗默认勾选删副本）、照片库配置 ▾ 浅蓝面板锁死只读、每库同步四态按钮 + 多库「等待执行…」（全局单任务 409→waiting 自动恢复）；设置窗口 880px。③ `OnboardingView.vue`——弹窗化（半透明遮罩+×+ESC）：「创建照片库」按钮（动画+成功提示，**创建完不自动切换页面/不自动进下一步**）→ 手动「下一步：链接 iCloud」。④ `AuthDialog.vue`——**分步状态机**（starting 无输入框 → 输密码独立步 → submitting 校验中仅转圈文案 → 输验证码 → done/error 绿✓/红✗弹出动画结果停留）+ 步骤指示器（1密码→2验证码→3完成）+ 输入框三态（默认白底边框/聚焦蓝光晕/禁用浅灰）+ 校验中全链路禁点（×/遮罩/输入框/按钮）；**固定邮箱页已删**（设置中心/主界面「刷新链接」打开即 autoStart 自动认证，免二次点击）；邮箱格式校验。⑤ `types.ts` LibraryInfo 补 libraryRoot/cacheDir/cookieDir/photos/videos；`api/client.ts` deleteLibrary。
   - **cli-scan / watcher**：激活库化（仅当前库启停扫描/监听）。
   - **文档**：`docs/iCloudPD照片库同步-架构功能设计.html` 按实现全面回填（§3.1.1 webui 桥接/状态机/防重、§4.1/4.4 设置中心与首次引导、§5 表结构与真实 API、§6 路线图、§7 问题 8）；架构设计文档新增 §3.8 P0 同步与多库 + §5 结构 + §6 路线图行 + §8 风险；README 补多库启动/环境变量/API/功能概览；删除已过时 `docs/资源状态顶部UI方案.html`（产品设计稿保留）。
24. **2026-10-18 局域网访问修复 + P0 复审（feat/lan-access）**：① 生产 build 模式 403 回归（F-04 Origin 白名单漏生产同源，见 §20 F-04 附注）——index.ts 改 dev 白名单 ∪ 同源判定（Origin host == 请求 Host，端口规范化）；config 新增 `HOST`（默认 `0.0.0.0`，局域网设备可访问；`.env.example` 已注释）。commit 5db8137 已提交。② P0 复审 8 项修复（tsc 0 错 + 测试 12/12 + API 回归全绿：同源 PATCH/POST 放行、跨站 403 保留）：P1 切库/删除时在途扫描 409 守卫、P2 删库 rmSync→fsp.rm 异步化、P3a exit 不覆盖 error 终态、P3b 重试耗尽杀进程且终态不翻转、P3c 库名校验正则去 /g、P3d killProcess 同步等待、P3e 认证超时文案死代码修复、P3f checkAuthValid 超时改 taskkill /T。**上述 4 文件已随 `ead5e7f`（merge: 复审修复单元测试 + 可测性重构）提交合并推送，工作区已干净，本条原「待验收后提交」已结清。**
25. **2026-10-28 整体审查（10-27 报告）第一批修复（fix/review-batch1 → 合并 main 37526a6，已推送）**：审查报告 `docs/整体审查报告-2026-10-27.md` 共记录 3 项 P1 / 19 项 P2 / 7 项 P3，本次按「数据安全优先」修复第一批 7 项：
   - **R-03/R-29 扫描对账保护**（scanner/index.ts）：`statSync` 失败的文件记入 `statFailed` 白名单、不参与孤儿判定（原先静默 continue 却仍在 dbRows 中 → 磁盘还在的资产被删记录+缩略图，重扫以新 id 复活、忽略状态丢失）；`walkDir` 显式处理符号链接（文件链接收录、目录链接记 errors → `traversalComplete=false` 跳过本轮对账）；对账抽成纯函数 `collectOrphanIds()`；修正与实现相反的注释。
   - **R-15/R-16 删除接口**（routes/assets.ts + libraries.ts）：ENOENT 视为已删，EPERM/EBUSY 等真实失败**保留 DB 行**并返回 207 + `failed` 清单（原先无条件删行 → 文件残留后以新 id 复活）；DELETE 前置 `libraryBusyGuard('delete-asset')`，扫描/同步中 409。前端 GridView/DetailView 只移除真正删掉的 id，client.ts 透出后端 message。
   - **R-01 分页空洞**（stores/assets.ts）：受影响页原先只 filter 掉被删 id 却保留页起点，页长变短 k 条 → 页尾 k 个全局位置无人持有、永久空白。改为整页丢弃 + 立即重拉。
   - **R-22/R-22b 引导与同步入口**（OnboardingView + App.vue + SettingsView）：已有库时新建的库 `active=0`，而同步只允许激活库 → 引导第 3 步必 409。改为拉取前先 `switchLibrary()` 热切换（不动 location，弹窗与已完成的认证不受影响）+ 关闭引导时整页 reload；设置中心非激活库不再显示「可点但必 409」的同步按钮，改为「切换到此库并同步」。
   - **R-21 删库安全默认**（SettingsView）：`removePhotos` 默认由 `true` 改为 `false`（§23 描述的「默认勾选删副本」已作废），勾选后显示红色后果说明并需二次点击才真删。
   - **R-30 静默失败**（App.vue）：`syncError` 此前只赋值、模板从未渲染 → 同步中切库被拒等于零提示。改为顶栏下方**固定浮层**（`fixed; top:56px; 居中; z-index:50`）：不参与布局流（避免压矮 `.view-host` 触发 GridScroller 的 ResizeObserver 重算导致照片墙抖动）、180ms 滑入淡出、8 秒自动消失、悬停暂停计时、可点 × 关闭。
   - **测试**：新增 `scanner/reconcile.test.ts`（6 例）、`routes/assets.test.ts`（8 例），后端合计 **50 例全绿**；`tsc --noEmit` / `vue-tsc -b` 0 错、`vite build` 通过。用户手工验收 7 项全部通过（涉真实同步的项用「启动后 1~2 秒内取消」验证，不触发实际下载）。
   - **本批未修、已明确规避方式**：R-02 删除激活库竞态、R-05/R-06/R-07 缩略图队列三连、R-09/R-10 认证定时器与同步预检——**均已在 §27 第二批修复中解决**；仍遗留 R-04 签名变化只重置缩略图复用旧元数据、R-08 时间基准 UTC 与 `+08:00` 混存需迁移。
26. **2026-10-28 多库体验优化（feat/library-ux-polish → 合并 main ff4b415，已推送）**：按用户实际使用反馈做的 4 项调整 + 4 处 UI 打磨。
   - **切换入口**（SettingsView）：非激活库卡片新增「切换照片库」按钮（蓝描边 + 箭头进竖线图标），`switchTo()` = `switchLibrary()` → `location.reload()`，**只切换不启动同步**（应对「只想切过去看看」）。原 §25 的「切换到此库并同步」及其 `sessionStorage['icloud.pendingError']` 接力机制整体移除（App.vue 读取端同步删除）。
   - **非激活库同步真禁用**（SyncButton）：新增 `locked` prop——原生 `disabled` + 菜单不展开 + 灰底实色 + **虚线框 + 锁形图标**，静态即可辨识；与既有 `disabled`（其他库任务占用、仅视觉灰显、菜单仍可点）语义分离，`:class="{ disabled, locked }"` 互斥。
   - **配置摘要**（SettingsView）：折叠态同行显示 `照片库配置 ▾ 增量：命中 N 个即停 · 下载：全部/最近 N 张`（标签 → 箭头 → 灰摘要，`min-width:0 + ellipsis` 窄屏优先压缩摘要）。**注意：不要用 `flex:1` + 右对齐**——中间留白会把一行拉成互不相干的两块；试过两行式也被否。经核 `icloudpd/sync.ts:114-117`，`--recent` 在 kind 判断之外 → **下载限量对全量与增量都生效**，`--until-found` 仅增量。
   - **建库预建目录**（db/libraries + context + routes/libraries）：`createLibrary` 建库即 `mkdirSync` 照片根/缓存/cookies，抽成 `ensureDirs()`（返回失败列表，失败只 warn 不阻断建库）；`applyLibraryPaths` 也调 `ensureDirs` 兜底 → **本版本之前建的库、或目录被手动删掉时，启动/切库自动补齐**；删库未勾选「删照片副本」时用 `fsp.rmdir`（非递归）清理空照片根，有照片必 ENOTEMPTY 自然跳过。
   - **引导可跳过**（OnboardingView）：第 2 步 `[稍后链接] [链接 iCloud]` + 一句浅色说明（跳过后在设置中心点「新建链接」继续）；第 3 步 idle `[稍后拉取] [开始全量拉取]`；error/cancelled 的「先跳过，稍后再说」统一为「稍后拉取」。
   - **删库二次确认三态**（SettingsView）：根因是 `.onboard-btn.danger` 本来就实心红底白字，`photoConfirmArmed` 前后只有文字变 → 像没点到。改为：实心红「确认删除」→ 描边红（`.armed-wait`「删除照片副本并移除库」）→ 深红 `#b83c30` + 警告三角图标 + `armed-pop` 弹跳一次（「确认永久删除照片」）。提示文案**复用同一个 `.delete-danger` 框**（不再另起一条），确认态转实红线 + 16% 红底。**不要给按钮加 `box-shadow` 外光环**（与 1px 边框叠成双层框）；`.onboard-btn` 统一 `inline-flex + gap`，否则加图标后高度跳动。
   - **测试**：新增 `ensureDirs` 3 例（多层嵌套 / 幂等 / 父级是文件时返回失败不抛错），后端 **53 例全绿**；`tsc --noEmit` / `vue-tsc -b` 0 错、`vite build` 通过。用户手工验收通过。
27. **2026-10-28 整体审查第二批修复：崩溃与资源竞态（fix/review-batch2 → 合并 main e12ee19，已推送）**：
   - **R-02 删库竞态**（routes/libraries.ts）：根因是 `closeDb()` 之后 `await fsp.rm()` 期间，前端 5 秒轮询的状态接口访问 `getDb()` 触发 `ensureOpen()`，在**待删目录里把 library.db 重建出来**（Windows 上文件句柄占用 → 后续 rm 报 EPERM → 接口 500）。修法：在**第一个 `await` 之前**先 `setActiveLibrary(下一个库)` + `applyLibraryPaths()`（无剩余库则 `resetLibraryPaths()`），让后续轮询直接落到新库；文件删除包 try/catch，即使删除失败也先把新库启动好再返回 500，不留半切状态。
   - **R-05 未处理拒绝**（pipeline/queue.ts / thumbnailScheduler.ts）：任务 `catch` 里再 `throw` 会变成没有接收者的进程级 `unhandledRejection`（Node 24 默认直接退出进程）→ 改为只记日志不抛；`submit()` 调用点补 `.catch` 作双保险。
   - **R-06 排队任务永不 settle**（pipeline/queue.ts）：弃用 `p-queue.clear()`（它只是从队列里摘掉任务，**不 resolve/reject 原 Promise**，调用方永远挂着）。改为**世代令牌**：切库/清队时 `queueGeneration++`，每个任务入队时捕获当时的世代，真正排到时若世代不符立即返回 `null`，Promise 正常 settle。
   - **R-07 inFlight 跨库串扰**（pipeline/thumbnails.ts）：`inFlight` 的 key 原为 `assetId:size`，切库后同 id 会命中上一库的进行中 Promise（拿到错误库的图）。改为 `${config.dbPath}|${assetId}:${size}`，抽 `inFlightKey()` 统一生成。
   - **R-09 认证定时器与进程归属**（icloudpd/auth.ts）：① 成功分支漏 `clearTimeout(authTimer)` → 10 分钟后超时逻辑误杀已完成会话；② `exit`/`error` 回调开头加 `if (proc !== child) return`，防旧进程事件覆盖新一轮状态；③ `error` 分支补 `teardownAuthProcess()`。
   - **R-10 同步前预检冗余**（icloudpd/sync.ts）：删除 `checkAuthValid` 调用及 import——该预检与账号接口的判定重复，且会额外起一次 icloudpd 进程；函数本身保留并注明「当前无调用方」。
   - **测试**：新增 `pipeline/queue.test.ts` 2 例——「换代后排队任务立即 settle 不悬挂」（先占满 8 并发让第 9 个真正处于排队态再换代，避免假绿）、「inFlight 键带库标识」；后端合计 **55 例全绿**；`tsc --noEmit` 0 错。本批不涉及前端改动。
   - **验证方式**：用户判定 R-02 与 R-06/R-09 的手工复现成本过高（删库要造大缓存、缩略图已全量缓存后切库不到 1 秒就请求完），采用「代码顺序 + 逻辑推导 + 单元测试」验收，不做手工场景复现。
28. **2026-10-28 整体审查第三批修复：前端体验（fix/review-batch3-front → 合并 main 33eddb7，已推送）**：纯前端 4 文件，无后端改动。
   - **R-12 `rev` 响应式**（useLazyImage + GridItem）：`<GridItem :key="asset.id">` **不含 rev** → 组件实例复用、不重建，而 `useLazyImage` 的 `rev` 是 setup 期快照、且 `src` 已赋值后 observer 已 unobserve → 覆盖源文件后缩略图永不更新。改为 `rev: MaybeRefOrGetter<number>`，请求时 `toValue(rev)` 现读；新增 `watch(rev)`——已加载过（`src` 非空）时直接换 `src`（URL 带新 `file_mtime`，浏览器不命中旧缓存），未加载过则不动（下次进视口自然用新值）。GridItem 传 `() => props.asset.rev`。
   - **R-13 宽度变化重测量**（GridScroller）：`itemWidth`/`rowHeight` 是 computed，但虚拟器的 `estimateSize` **不在测量 memo 的响应式依赖里**，只改 `viewportWidth` 不会让已测量行高失效 → 行重叠/留白、总高度错、滚动条乱跳。`ResizeObserver` 回调改为「宽度真变了才处理 → rAF 合并（`cancelAnimationFrame` 后重排，拖动时每帧一次且总用最新宽度）→ `remeasureKeepingAnchor()`」。**附加滚动锚定**（报告里没提但必须做）：行高 = f(容器宽)，只 measure 不动 scrollTop 会让视口内容跳几十行（8 列 1200→900px，行高 148→110，scrollTop=10000 处约跳 23 行）——measure 前记首可视行 index，measure 后 `scrollToIndex(anchor, { align: 'start' })` 拉回行顶。`onActivated` 的恢复也复用该函数。
   - **R-14 切数据源保位**（GridScroller）：原 `watch(props.dataSource)` 无条件 `savedScrollTop = 0` + `scrollTop = 0` → 「滚到某月 → 搜一张图 → 返回」直接回顶部。改为 `WeakMap<GridDataSource, number>` 按数据源记忆位置：切走时存旧源位置、切回时取新源位置写回；`init().then()` 里 measure **之后再写一次** `scrollTop`（骨架重建后总高度变化，切换瞬间的写入会被浏览器截断）。
   - **顺带（搜索换关键词回顶）**：换关键词时 `props.dataSource` 引用不变（同一个 search store），上面的 watch 不触发 → 滚动位置停在旧值，新结果更少时落到末尾空白。GridScroller 新增 `defineExpose({ scrollToTop })`，GridView 在 debounce 回调里 **`nextTick` 之后**调用（早一步会把归零打到照片墙上，连带把它刚缓存的滚动位置写成 0）。
   - **验证**：`vue-tsc -b` 0 错、`vite build` 通过、`dist` 已重建；用户手工验收三项——拖窗口宽度行不错位、滚到某月搜索后返回仍在原处、换关键词回顶部。R-12（覆盖文件后换图）用户决定不单独验，按代码逻辑推导。

## 照片库实测数据（2026-09-08）
- 结构：`YYYY/MM/DD/文件名`（iCloudPD 默认），实况配对基名归一（`_HEVC` 后缀），**无时间差校验**。⚠️ **配对必须限定同一目录**——跨目录同名文件（不同设备/编辑版本的同名，如 `2018/02/04/IMG_0040*` 与 `2021/07/27/IMG_0040*`，全库大量基名分布多目录）若只按基名配对会错配丢视频（见「已完成」第 9 条）。
- 磁盘文件口径（从略，属个人隐私）：HEIC 为主，另有 MOV/JPG/MP4/PNG/M4V/GIF 等；视频文件为数千级（含实况配对视频）。
- 修复后资产（2026-10-06 实测，数量从略）：照片/实况/视频合计万级；修复后与磁盘文件精确一致，与 iCloud 统计基本对齐。
- 关键统计（从略）：orientation 分布以无需旋转为主，少量非 HEIC 属方向重建范围。

## 技术选型（已定）
- 后端：Node 24（用户 D:\nodejs）+ TypeScript + Fastify 5 + better-sqlite3 13.0.3（包内平台预编译，lockfile 需保留 `gypfile:false`）+ exifr + sharp 0.35 + vendor ffmpeg spawn（BtbN full / libheif）+ p-queue（**F-01 后为单一 ThumbnailScheduler：交互 priority=10 / 后台 priority=0、后台始终入队、交互不足时后台填满剩余槽位（事件让位，2026-10-07 移除原租约挂起）、总并发 config.thumbConcurrency=8 严格不超**）+ **icloudpd-1.32.3-windows-amd64.exe 黑盒 spawn（P0：vendor 目录，ICLOUDPD_EXE 可覆盖；webui 桥接认证 + 全量/增量同步，详见 §23）**
- 前端：Vue 3.5 + Vite + TS + Pinia + vue-router(hash) + @tanstack/vue-virtual + 自研 useLazyImage（IntersectionObserver；网格最多 8 个图片请求并发；拖动滚动条**按速度拆开**：慢速拖动走 rAF 每帧派发 + 带预载（与普通滚动同体验），快速拖动 250ms 判速跳过中间区域，松开后优先派发最终视口，2026-10-07 fix/slow-drag-prefetch）
- 缩略图档：grid 320px / detail 1600px WebP；视频封面 ffmpeg 抽帧。扫描后只后台预热 grid；照片墙格子先显示底色，grid 图片加载成功后淡入；已废弃的 blur 缓存由扫描清理
- 端口：后端 0.0.0.0:8899（默认监听全网卡，同一局域网设备可访问；`HOST` 可配置收回），前端 http://localhost:5173（Vite 绑 IPv6，勿用 127.0.0.1:5173）

## 实施路线（最新）
- ✅ P0：扫描 + 虚拟滚动 + 缩放 + 缩略图懒生成 + 详情 + 实况 + 视频
- ✅ P1：日期定位 + 邻居预取 + 渐进图片加载 + 深链 + 键盘 + 实况（内存 LRU 已决定不做，2026-10-07）
- ✅ P2：FTS5 搜索（HEVC 转码/收藏/最近删除/下载不做；批量选择已随客户端删除落地）
- ✅ 稳定化：12 项修复 + GitHub 版本管理
- ✅ **照片墙占位优化（2026-10-03）**：移除独立 blur 缩略图档及对应请求/后台生成；格子先显示底色，grid 图片加载成功后淡入。旧 `cache/thumbs/blur/` 在扫描时清理；详情页复用 grid 并用 CSS 模糊的占位效果保留。
- ✅ **P2+-1 部分落地（2026-09-17；2026-10-01 刷新与完整性保护已补齐）**：目录热监听 + 完整扫描后删除对账 + 启动同步 + 首批资产入库后填充照片墙、扫描结束后最终刷新；**一键拉取已由 2026-10-12 P0 落地（icloudpd 同步模块 + 网页端触发，见 §23）**。
- ✅ **P2+-2 冷启动体验（状态展示落地）**：扫描按 `YYYY/MM/DD` 目录日期从新到旧处理（仅优先级，展示仍按实际拍摄时间）；每 5 秒轮询状态，扫描期间发现已入库资产且照片墙仍为空时立即初始化，扫描结束后再最终刷新。顶栏单行资源摘要 + 浮层详情；扫描显示已检查文件数及当前入库照片/视频数、不显示预览图百分比；扫描结束后按数据库持久化状态显示全库预览图总量、已处理/已生成/待处理/失败，服务重启后已生成计数和百分比可从数据库状态恢复。失败数可点击查看文件清单及原因，支持逐项/批量重试、忽略和恢复提醒；忽略不会删除原文件，历史记录缺少原因时明确提示。照片/视频数量口径通过计数旁悬浮提示说明；照片数包含普通照片和实况照片，视频数不包含实况配对 MOV；扫描对账按配对后的主资产路径执行，支持既有独立 MOV 后来与照片配对时清除旧视频资产记录。
- ⏸ P2+-3 语义搜索（暂缓）：人物/地点/场景组合（如「邓州 2023 年 陈咏新」）——不连大模型，face-api.js + tfjs-node 本地人脸聚类 + people/faces/asset_tags 表 + 组合查询解析器；视频抽帧入人脸库；标签不写文件元数据。

## 工程约定（踩坑沉淀）
- **PowerShell 引号坑**：命令实际由 PowerShell 执行；`\"` 不是转义（用反引号）、双引号内 `$` 会展开。多层级引号一律落临时文件：复杂 JS/SQL 写 `.cjs` 文件再 `node 文件`；多行 commit 用 `Out-File` + `git commit --file=`。
- **原生模块**：better-sqlite3 13.0.3 随 npm 包提供平台预编译文件；当前运行环境 Node 24，项目要求 Node 22+。本地若切换 Node 主版本后遇到原生模块加载错误，先在 `server/` 重跑 `npm ci`。ffmpeg 不再走 npm 原生包，在 `server/vendor/ffmpeg-full/`；icloudpd exe 在 `server/vendor/icloudpd-1.32.3-windows-amd64.exe`——两者均由 postinstall 自动下载（仓库 Release `vendor-binaries`，2026-10-12 起 icloudpd 也自动安装）。
- **服务进程**：用户自启后端 8899/前端 5173，勿占用；临时验证进程用完 TaskStop。
- **git SSH**：固定 `core.sshCommand = "C:/Windows/System32/OpenSSH/ssh.exe" -o StrictHostKeyChecking=accept-new`；日常 `git push origin main` 畅通。
- **临时脚本**：`server/scripts/.*`（dot 开头）用完即删，已在 .gitignore 排除防误提交。
- **缩略图缓存**：rev 已动态化——前端缩略图 URL 带 `rev = 资产 file_mtime`（后端 AssetDto.rev / dates.thumbRev 下发），源文件变化后 URL 自动变、浏览器强制重拉（F-03 闭环）；`THUMB_REV=3` 常量仅作无 rev 场景的默认兜底，不再需要手动 bump；`npm run fix-thumbs` 已随 2026-10-06 脚本清理移除（重建走 F-03 签名失效）。
- **sharp 0.33.5**：构造选项 `rotate:true` 不生效，必须链式 `.rotate()`。
- **虚拟滚动三坑（2026-10-28，见 §28）**：① 虚拟器的 `estimateSize` 不在测量 memo 的响应式依赖里——`itemWidth`/行高是 computed 也不会自动失效，尺寸变了必须显式 `measure()`，且要**锚定首可视行**（否则 scrollTop 不变而行高变 → 视口跳几十行）；② `GridItem :key="asset.id"` 不含 `rev` → 组件会复用不重建，任何随 rev 变化的东西（缩略图 URL）都必须用 getter 现读，不能在 setup 期快照；③ 切数据源时 `props` 更新晚于同步调用 → 想在新数据源上做滚动归零，必须 `nextTick` 之后再调，否则会把归零打到旧数据源上。

## 待办 / 遗留（均不影响使用）
- 预览图失败记录现在可在顶栏清单中查看、重试或忽略；较早的失败项没有存储原因，会显示“失败时未记录详细原因”。
- **10-27 审查报告前三批已修完（共 16 项），第四批及以后未动**（详见 `docs/整体审查报告-2026-10-27.md` 第六章实施顺序）：R-04 签名变化重取元数据、R-08 时间基准统一（需一次数据迁移）、R-17~R-20（缓存原子写 / 搜索错误白名单 / 启动时序 / cli-scan 多库上下文）。
- ✅ 缩略图生成失败留 0 字节 WebP 兜底：已在 generate() catch 分支补 `fs.rmSync(outPath, {force:true})`（2026-09-08 审查后修复）。
- ✅ `server\vendor\ffmpeg-full.zip`（163MB 安装包）：已决定保留不删（2026-10-07，.gitignore 已排除不入库，用户自行处理）。
- ✅ toolbar 调试信息（items/rows/virt）：已定保留（用户确认）。
- ✅ **KeepAlive 缓存失效已补齐（2026-10-01）**：前端轮询扫描状态，扫描结束后刷新月份和已缓存页；保留滚动位置。
- ✅ 2026-09-17 审查 B1~B5 修复完成（删除页缓存错位 / 实况宽高兜底 / 首屏默认浅色 / CORS DELETE / 排版整理）。
- ✅ **P0（2026-10-09~12，feat/icloudpd-sync）已提交合并 main（6ba85ae，2026-10-13）**：认证流 + 全量/增量 + 多库切换/删除 + 设置中心。**P0 期间的测试照片库与缓存已清理；正式照片库目录为 `iCloudPhoto`（多库下 `iCloudPhoto/lib<id>`）。**P2+-3 语义搜索暂缓实现；**P2+-4 详情缓存治理已列入**（保留最近 N 月浏览的 detail 图 / 一键清空 detail 缓存，可选）。
- ✅ **search store finally 竞态已修**（2026-09-19 审查发现，代码 finally 已有 `if (seq !== searchSeq) return` 守卫，F-05 改动时一并确认）。
- ✅ **F-07 + 失败清单系列已完成**（2026-10-06，分支 fix/ffmpeg-timeout → 合并 505cb28 推送）：ffmpeg/ffprobe 超时 kill；失败项操作解锁（只锁扫描中）；后台挂起 60s 上限（**2026-10-07 事件让位改造中已移除**）；失败保留 ignored + 忽略跳过重试 + 自愈日志；浮层三态入口；扫描缓存对账（待处理卡死根治，实测收敛）；命名修正（浮层/徽标「待处理」→「失败」）。测试 12/12。
- ✅ **审查报告 7 项全部完成**（2026-10-06，F-03/F-04 分支 fix/f03-f04 → 合并 6fd9dae 推送）：F-03 源文件签名（size+mtimeMs）驱动缓存失效 + 前端 rev 联动（rev=file_mtime，URL 随内容变化强制换图）；F-04 副作用请求非允许 Origin 403。文档快照资产口径已同步。

## 用户偏好（与本项目相关）
- 技术/财经类内容偏好"深度解析 + 大白话 + 结构化清单"。
- 代码要目录规范、结构清晰、详细注释（用于学习）。
- **改动工作流程（硬性）**：① 任何需求改动先给评估（怎么改、对现有代码的影响）→ ② 用户明确确认 → ③ 新建 git 分支再改 → ④ 完成后经用户确认 → ⑤ 合并回 main 并清理旧分支。
