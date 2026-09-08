# 项目上下文快照（供会话压缩/新会话恢复用）

> 生成日期：2026-09-08。若本会话上下文被压缩或丢失，先读本文件 + 架构文档，即可恢复全部关键信息。

## 项目目标
用户已用 iCloudPD 把 iCloud 照片全部拉到本地（iPhone 源文件：9,423 图 + 3,034 视频 ≈ 150GB）。
目标：搭建本地网页应用，复刻 iCloud 网页端浏览体验。前端 Vue 系列，后端 Node.js。

## 已完成的工作
1. **实测 iCloud 网页端机制**（浏览器操作 + 网络抓包 + JS bundle 源码分析，photos3 2632Build19）：
   - 网格 = 自研虚拟滚动：`grid-scroll` 高 24万~157万px，DOM 常驻 ~168 节点，absolute+transform 定位，列数 3~9（滑块），缩放只改 CSS 不重载图。
   - 缩略图 = DerivativeImage ~415px 档，XHR→blob→objectURL 注入，`cvws.icloud-content.com.cn/B/<id>/public.jpeg?o=...&x=3&a=...` 签名 URL；offscreeniness 优先级、失败降级。
   - 详情 = OneUp 轮播 3 格 + 预加载邻居 ±2（2048px 大图 + 实况视频），hash 路由 `#/i,pz,GUID,index/`，opacity 渐进淡入。
   - 实况照片 = 静止帧 img + 隐藏 video 叠层（z-index:1 opacity:0），按住播放、松开 pause+归零（已验证）。
   - 视频 = 原生 video + HTTP 206 Range 流式（非 HLS），Video.js 封装。
   - 元数据 = CloudKit records/query 分页；URL 带短期签名。
2. **行业调研**：Immich（后台任务三档缩略图 blur/small/large + NestJS+Postgres+Redis）、vue-virtual-scroller / @tanstack/vue-virtual、sharp（libvips+libheif 是 Node HEIC 唯一成熟方案）、iCloudPD 输出结构（YYYY/MM/DD + 实况配对命名：HEIC⇄IMG_xxxx_HEVC.MOV、JPG⇄IMG_xxxx.MOV）。
3. **P0 已落地并端到端验证通过**（2026-09-08）：
   - 后端 `server/`（TS）：config / db(schema+index) / metadata(exifr+ffprobe) / scanner(扫描+实况配对+入库) / pipeline(缩略图懒生成+队列) / routes(assets/thumb/video/stats)。
   - 前端 `web/`（Vue3.5+Vite+TS+Pinia）：GridScroller(虚拟滚动+缩放滑块+翻页) / GridItem(blur→real 渐进) / useLazyImage(IO 懒加载) / DetailView(hash 深链+键盘切换+邻居预取) / LivePhoto(按住播放) / VideoStage(Range 流)。
   - 全量扫描 11,009 资产（照片 3,781 + 实况 5,635 + 视频 1,593）；缩略图冷生成 0.68s / 热缓存 25ms；视频 206 流式播放验证通过；实况 HEVC 流播放验证通过。
   - 关键攻坚：HEIC 解码（sharp 无 HEVC 插件 → BtbN ffmpeg full 版 libheif 解码，已固化到 scripts/install-ffmpeg-full.ps1 + postinstall）；virtual 库 count getter 坑；flex 百分比高度坑；exifr Orientation 数字化；GPS DMS 数组炸参数。
4. **交付物**（已迁移至新项目 `F:\iPhone\icloud-app`）：
   - 架构设计文档（主交付）：`F:\iPhone\icloud-app\docs\架构设计文档.html`
   - 上下文快照：`F:\iPhone\icloud-app\docs\CONTEXT-项目上下文快照.md`
   - 源码分析材料：`F:\iPhone\icloud-app\docs\icloud-analyze\`（upf.js/oneup.js/videoplayer.js/ui_main.js 等）

## 照片库实测数据（2026-09-08 确认，F:\iPhone\icloud-app\iCloudPhoto\）
- 结构：`YYYY/MM/DD/文件名`（iCloudPD 默认），实况配对 `IMG_xxxx.HEIC ⇄ IMG_xxxx_HEVC.MOV`（默认 suffix 命名，与设计假设一致）。
- 总文件 20,026 个 / 162.8GB。
- 图片 9,416 个：HEIC 8,131 + JPG 1,067 + PNG 217 + GIF 1。
- 视频文件 10,610 个：MOV 10,157（其中 **实况 `_HEVC.MOV` 7,432**）+ mp4 404 + M4V 49。
- 展示资产估算：照片 ≈ 9,416，普通视频 ≈ 3,034，实况照片 ≈ 7,432（占照片 79%）。
- 派生：媒体资产总数 ≈ 12,450，与 iCloud 网页端（9,423 图 + 3,034 视频）吻合。
- 含 `iCloudTool\`（iCloudPD 工具与 cookie，与库无关，不处理）。

## 技术选型（已定）
- 后端：Node 20+ LTS + TypeScript + Fastify 5 + better-sqlite3 + exifr + sharp + ffmpeg-static + p-queue
- 前端：Vue 3.5 + Vite + TS + Pinia + vue-router(hash) + @tanstack/vue-virtual + 自研 useImageLoader
- 缩略图三档：grid 320px WebP q80（~25KB×12457≈0.3GB）/ detail 1600px WebP q82（按需）/ blur 占位；视频封面 ffmpeg 抽第 1 秒帧
- 视频策略：A 原片直出（P0）→ B 按需转码 H.264 缓存（P1 兜底 HEVC 兼容）
- 实况配对：基名匹配 + 拍摄时间差 <3s 二次校验

## 实施路线
- ✅ P0（已验收）：扫描入库 + 网格虚拟滚动 + 缩放滑块 + 翻页 + grid/detail/blur 缩略图懒生成 + 详情(键盘切换+邻居预取) + 实况照片(按住播放) + 视频(206 Range+poster) + hash 深链
- ⏳ P1（下一步候选）：日期分组定位(滚动到某月) + LRU 缓存淘汰 + 后台预热策略优化 + HEVC 按需转码兜底 + FTS5 搜索
- P2：收藏/最近删除 + 下载 + 目录热监听

## 待办 / 阻塞项
- ✅ 照片库路径已确认：`F:\iPhone\icloud-app\iCloudPhoto\`（结构/命名与设计假设一致，见上节数据）。
- ✅ P0 骨架代码已完成并通过浏览器 E2E 验证（详见 README「已实测验证」表）。
- 待用户决定：`server\vendor\ffmpeg-full.zip`（163MB 安装包，可删可留）；toolbar 上的 items/rows/virt 调试信息是否保留。

## 用户偏好（与本项目相关）
- 技术/财经类内容偏好"深度解析 + 大白话 + 结构化清单"。
- 工具人角色：数据处理要精确条件筛选与量化结果。
