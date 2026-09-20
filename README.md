# 本地 iCloud 照片浏览器

在本地完整复刻 iCloud 网页端的照片浏览体验（虚拟滚动照片墙 / 缩放 / 日期定位 / 详情轮播 / 实况照片 / 视频流式播放）。

## 目录结构

```
icloud-app/
├── iCloudPhoto/          # 照片库（iCloudPD 拉取，只读，162.8GB）
├── iCloudTool/           # iCloudPD 工具（cookie 配置；一键拉取为 Q5 计划，exe 方案已定）
├── docs/
│   ├── 架构设计文档.html        # 完整架构设计（逆向 iCloud 的结论都在这里）
│   ├── CONTEXT-项目上下文快照.md # 项目上下文速查
│   └── icloud-analyze/          # iCloud 前端源码 bundle（分析材料）
├── server/               # 后端：Node.js + Fastify + SQLite + sharp
│   ├── src/
│   │   ├── index.ts            # 服务入口（启动时库空则自动全量扫描）
│   │   ├── config.ts           # 端口/缩略图尺寸/并发等全局配置
│   │   ├── cli-scan.ts         # 命令行扫描工具（npm run scan）
│   │   ├── db/                 # 数据库（schema + 连接，WAL 模式）
│   │   ├── metadata/           # EXIF / ffprobe 元数据提取
│   │   ├── scanner/            # 目录扫描 + 实况配对 + 幂等入库
│   │   ├── pipeline/           # 缩略图懒生成流水线 + 任务队列
│   │   └── routes/			# API 路由（assets/thumb/video/stats/search/info）
│   ├── scripts/                # 运维脚本（fix-size / fix-thumbs / install-ffmpeg）
│   ├── vendor/                 # BtbN ffmpeg full 版（含 libheif，HEIC 解码必需）
│   └── cache/                  # 缩略图 thumbs/ + library.db + stats.json（可删，会重建）
└── web/                  # 前端：Vue 3 + Vite + TS + Pinia
    └── src/
        ├── views/              # 照片墙 GridView / 详情 DetailView
        ├── components/         # GridScroller / GridItem / DateNavPanel + detail/（LivePhoto/VideoStage）
        ├── stores/			# Pinia：assets（照片墙页区间懒加载）/ search（搜索结果照片墙）/ theme（深浅主题+列数，localStorage 持久化）
        ├── composables/        # 懒加载等组合式函数
        ├── api/                # API 客户端（含缩略图 rev 版本号）
        ├── router/             # hash 路由（#/photo/:id）
        └── types.ts            # 前后端共享类型
```

## 快速启动

**前置要求**：Node.js 22/24（原生模块 better-sqlite3 按 Node ABI 预编译，版本需与编译目标一致）；Windows（脚本为 PowerShell）。

```bash
# 0. （可选）自定义路径：复制模板改名 .env，按需修改
cd server
Copy-Item .env.example .env   # 用记事本打开 .env 改照片库/缓存路径；不改则用默认值
```

```bash
# 1. 后端（端口 8899，首次启动自动扫描入库）
cd server
npm install          # postinstall 自动下载带 libheif 的 ffmpeg full 版（HEIC 解码必需，约 162MB）
npm run dev

# 2. 前端（新终端，端口 5173）
cd web
npm install
npm run dev
```

打开 http://localhost:5173 即见照片墙。

### 生产模式（单端口部署）

开发模式跑两个端口（5173 + 8899）。生产模式只需一个端口：

```bash
cd web && npm run build   # 产出 web/dist/
cd ../server && npm run start   # 后端自动检测 web/dist 并托管，访问 http://127.0.0.1:8899 即页面
```

> 说明：后端首次启动会全量扫描照片库（~2 万媒体文件 / 12,591 资产，约几分钟），扫描完成后缩略图由
> 后台队列按需预热；浏览时未生成的缩略图会现场生成（冷 0.7s / 热 25ms）。

### ⚠ 装依赖注意事项（新机器/新目录必看）

- **不要用 `npm install --ignore-scripts`**：这会跳过 better-sqlite3 的原生编译/预编译下载，启动直接报 `Could not locate the bindings file`。JS 包装了、C++ 原生 `.node` 没有，起不来。
- **国内镜像**：`server/.npmrc` 已配置 npmmirror 镜像（better-sqlite3/sharp/ffmpeg-static 预编译二进制走国内源），新 clone 后 `npm install` 自动生效，无需手动配置。
- **postinstall 要下 162MB ffmpeg**：从项目自己的 GitHub Release 下载（`isChen0111/icloud-app/releases/tag/vendor-binaries`），含 libheif，HEIC 解码必需。网络慢/下不动时：
  - **方案 A（推荐）**：把 `server/vendor/ffmpeg-full.zip` 从已有机器直接拷到新机器同位置，脚本检测到自动跳过下载；
  - **方案 B**：浏览器手动打开 [Release 页面](https://github.com/isChen0111/icloud-app/releases/tag/vendor-binaries) 下载 `ffmpeg-full.zip`，放到 `server/vendor/ffmpeg-full.zip`；
  - **方案 C**：设环境变量 `FFMPEG_FULL_URL` 指向你自己的镜像（如 OSS），再跑 `npm install`。
- **两个目录各装一次**：`server/` 和 `web/` 的 `node_modules` 互相独立，git 都不存——新 clone 后两边都要 `npm install`。
- **照片库 `iCloudPhoto/` 和 `server/cache/` 不入库**：新机器没有这俩。照片库需自己准备（放默认位置或用 `.env` 指向）；`cache/` 首次启动自动重建（会重新全量扫描+生成缩略图，耗时较长）。

### 环境变量（.env）

所有路径/端口都支持环境变量覆盖。在 `server/` 目录建 `.env`（照 `.env.example` 复制），启动脚本已自动加载（Node 原生 `--env-file-if-exists=.env`，文件不存在也不影响）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PHOTO_LIBRARY` | `<项目根>\\iCloudPhoto` | 照片库根目录（iCloudPD 输出，只读） |
| `CACHE_DIR` | `<项目根>\\server\\cache` | 缩略图/封面/转码缓存目录 |
| `DB_PATH` | `<项目根>\\server\\cache\\library.db` | SQLite 数据库文件 |
| `PORT` | `8899` | 后端端口 |
| `SCAN_LIMIT` | `0`（全量） | 调试用，>0 只扫前 N 个文件 |

优先级：命令行临时设置 > `.env` 文件 > 代码默认值。同一时间不要两个后端实例连同一个 `library.db`（SQLite 写锁冲突）。

## 常用命令

| 命令 | 位置 | 作用 |
|---|---|---|
| `npm run dev` | server | 启动后端（文件变更自动重启） |
| `npm run scan` | server | 只执行一次扫描入库 |
| `npm run fix-size` | server | 存量数据修正：用原文件重读像素尺寸（修复旧缩略图尺寸污染宽高字段） |
| `npm run fix-thumbs` | server | 重建 EXIF 方向错误的缩略图缓存（删除旧缓存→用当前 pipeline 重新生成） |
| `powershell -File scripts\install-ffmpeg-full.ps1` | server | 重装依赖后补 HEIC 解码能力 |
| `npm run dev` | web | 启动前端开发服务器 |
| `npm run build` | web | 前端生产构建 |

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/assets?cursor=&limit= | 照片墙分页（时间倒序，游标分页） |
| GET | /api/assets?offset=&limit= | 按全局序号取任意区间（照片墙全量骨架的懒加载取数） |
| GET | /api/assets/:id | 单个资产 + 前后邻居 id + 序号/总数 |
| GET | /api/assets/:id/info | 详情信息面板：实时解析 EXIF / ffprobe（设备/镜头/ISO/光圈/GPS 等） |
| GET | /api/thumb/:id?size=grid\|detail\|blur | 缩略图（懒生成） |
| GET | /api/video/:id/stream | 视频流（HTTP Range） |
| GET | /api/video/:id/poster | 视频封面帧 |
| GET | /api/stats | 库统计 + 扫描进度 |
| POST | /api/scan | 触发扫描 |
| GET | /api/dates | 年月分组：{ ym, label, count, offset, thumbId }（offset=该月首资产全局位置） |
| GET | /api/search?q=&limit=&offset= | FTS5 全文搜索（文件名/日期子串，至少 3 字符；返回 total 真实计数 + months 匹配集月份分组 + offset 匹配流分页，搜索结果照片墙化） |
| DELETE | /api/assets | 批量删除（body: `{ ids }`；删磁盘源文件 + DB 行 + FTS 索引 + 缩略图缓存，不可逆） |

## 设计要点速记

- **虚拟滚动（全量骨架）**：行序列（月份头 + 资产行）由「月份分组 + 列数」一次精确生成全库（8 列 1,676 行 / 219,106px）→ 滚动条 = 全库、任意位置双向滚动；@tanstack/vue-virtual 只挂载视口附近的 ~100 个 DOM 节点。资产数据按 120 条/页**区间懒加载**（pages Map 缓存，未加载行渲染灰块占位），滚动到哪行取哪行、幂等并发去重。行高走 getRowHeight(row) 函数（原比例显示的预留扩展点，当前固定方形）。
- **缩略图懒生成**：首次浏览某张图才生成 320px WebP（~25KB），生成后永久缓存；同资产并发去重（in-flight Map）。
- **缩略图缓存失效**：接口 `Cache-Control: max-age=1年`（无 immutable）+ ETag 协商；前端 URL 带 `rev` 版本号——内容变更（如生成参数修复）后 bump `THUMB_REV` 即可强制浏览器重新拉取。
- **HEIC 解码**：sharp 官方预编译无 HEVC 插件，用 BtbN ffmpeg full 版（libheif）解码后再交 sharp 缩放。
- **实况照片**：静止帧（HEIC）+ 配对视频（_HEVC.MOV），按住播放（**带原声**）、松开暂停复位。
- **视频流**：原生 `<video>` + HTTP Range 206，拖动进度条零延迟。
- **详情页三级渐进**：grid 档模糊占位秒出 → detail 档淡入覆盖（复用照片墙已缓存 grid，冷生成不白屏）；detail 缓存命中时两图并行、直出清晰大图。实况静止帧 / 视频 poster 同款（DetailView / LivePhoto / VideoStage，后端零改动）。
- **徽标体系**：LIVE（网格 + 详情简约白字胶囊；详情按住播放时徽标内旋转加载动画）、视频时长（右下黑底胶囊「0:03」，≥1h 显示 1:02:03）、HDR 未做（实测库内仅 1 张含 GainMap）；标题「iCloud本地照片」+ favicon.svg（web/public/）。
- **主题切换**：浅色/深色双主题（CSS 变量 `--bg-*/--text-*`），**默认浅色**；切换持久化 localStorage，index.html 内联脚本首屏防闪烁；详情页/实况/视频查看区按 iCloud 惯例恒深。
- **详情返回位置保留**：照片墙组件 KeepAlive 缓存（仅 GridView），返回时滚动位置/搜索态原样保留；恢复时 rAF 重测虚拟行，避免行高错位（重叠/间距异常）。
- **日期分组与吸顶跨度**：月份头行（跨月组显示区间标签如「2021年4月-3月」）+ 吸顶日期跨度（视口首末资产行直出，如「2021年5月30日 - 5月11日」，过滤 overscan 预热行与真实可视范围一致）；工具栏「日期」按钮 → 方案 C 面板（左年份 + 右月份缩略图 3 行×4 列），点月份滚动定位该月首行（不重置数据）。
- **FTS5 搜索**：trigram 分词器支持任意子串（搜 "9188" 或 "202409" 都秒出）；索引存小写文件名 + 原始/紧凑日期，入库时同步、启动时校验回填。**搜索结果照片墙化（2026-09-19）**：匹配集 = 倒序资产流，与照片墙共用 GridScroller 虚拟滚动（offset 分页 + total 真实计数 + 匹配集月份分组头 + 吸顶日期 + 列数滑块共享；search store 与 assets store 实现同一 GridDataSource 接口，组件实例不销毁只切数据源）。**⚠ trigram 精确性兜底**：FTS5 trigram 对多字符查询按「片段 AND」匹配（"2023"="202"+"023"，不要求相邻）会误命中时间串碰巧含两片段的照片——FTS 只做粗筛，每个查询 token 再按连续子串 `instr` 精筛（文件名小写 / ISO / 紧凑时间去 -，多 token AND）。
- **目录热监听 + 删除对账（P2+-1）**：chokidar 监听照片库目录树（防抖 1.5s 合并事件 + `awaitWriteFinish: 2s` 等文件写完 + 扫描互斥 + 忽略初始事件），手动拷入/删除/重命名文件自动触发全量同步；同步末尾做「磁盘文件 vs DB 资产」对账——磁盘上已消失的文件清理资产记录 + FTS 索引 + 缩略图缓存，手动删文件后照片墙不再残留"已不存在的图"。启动时（/api/scan）同样全量同步（幂等增量）。
- **客户端删除（照片墙 + 详情页）**：单击单选 / Ctrl+单击多选（选中态画在缩略图内，虚拟滚动不参与布局、选中记忆放 Pinia store 滚动不丢）；删除按钮在搜索栏行（未选中灰禁、选中亮蓝）+ 确认弹框；详情页删除按钮与信息按钮统一蓝色圆形；删除后前端同步页缓存/月份计数（清空删除点之后的页缓存防错位），后端联动触发热监听对账。
- **配对规则**：基名相同**且在同一目录内**即配对（`IMG_1234.HEIC ⇄ IMG_1234_HEVC.MOV`，`_HEVC` 后缀归一），无时间差校验。⚠️ **必须限定同一目录**：iCloudPD 会把同名文件（不同设备 / 编辑版本）归档进不同日期目录（如 `2018/02/04/IMG_0040*` 与 `2021/07/27/IMG_0040*`），只看基名会跨目录错误配对——同组多余视频被静默丢弃、实况视频可能配错照片，曾因此丢失 3,382 个视频（2026-09-08 修复，见下）。

## 已实测验证（2026-09-08 E2E）

| 功能 | 结果 |
|---|---|
| 全量扫描入库 | 12,591 资产（照片 1,982 + 实况 7,434 + 视频 3,175） |
| 照片墙虚拟滚动 | 全量骨架（8 列 1,676 行 / 219,106px），滚动条=全库双向滚动；4~12 列滑块切换正常（默认 8 列），DOM 稳定 ~16 行 |
| 区间懒加载 | 滚动到哪行取哪行（120 条/页 pages Map 缓存 + 并发去重），跳转后向上/向下双向滚动自然衔接 |
| 缩略图懒加载 | blur 占位秒出 → 320px 缩略图淡入，滚过即请求、离开即回收 |
| 详情页 | hash 深链 `#/photo/:id`，键盘 ←→ 切换邻居；三级渐进（grid 占位秒出 → detail 淡入，照片/实况/视频三类型实测通过） |
| 实况照片 | 静止帧 + 按住播放（HEVC 流 206 播放验证通过） |
| 视频 | poster 封面 + Range 流 + 时长/控件正常 |
| **日期分组定位（P1）** | 月份头行（跨月区间标签）+ 吸顶日期跨度（视口首末资产日）+ 工具栏「日期」按钮 → 下拉面板（左侧年份 + 右侧月份缩略图，方案 C 复刻 iCloud；点击月份 → 滚动定位该月首行，不重置数据） |
| **FTS5 搜索（P2）** | 搜索框防抖 300ms → trigram 子串匹配（文件名不区分大小写 / 日期宽匹配 / 紧凑日期），Esc 退出回照片墙，点结果进详情 |
| **热监听 + 删除对账（P2+-1）** | chokidar 监听目录树：手动拷入文件自动入库；手动删除文件自动清资产+缓存；启动全量同步幂等增量（2026-09-17 审查后回归） |
| **客户端删除（2026-09-17）** | 照片墙单选/多选删除 + 详情页删除 + 确认弹框 + 删除后页缓存防错位（审查 B1 修复后验证）；CORS 补 DELETE |
| **搜索照片墙化 + trigram 精确性（2026-09-19）** | 搜索结果匹配集虚拟滚动（月份分组头/吸顶日期/列数联动）、total 真实计数不再截断 100；搜「2023」由 2131 误匹配修正为 2126=库中 2023 年资产数，跨年（2018/2021/2025）误匹配归零；多词 AND 过滤、紧凑日期 202409 正常、1ms 无感（正式库 12,590 资产实测） |
| **稳定性修复（2026-09-08）** | 代码审查 12 项问题全部修复：stats 异步缓存（首屏 229ms）、原图宽高 11,009 条修正、EXIF 方向缩略图重建（fix-thumbs 103 张）、浏览器缩略图缓存失效链路（rev=2 + 去 immutable）、实况按住带原声、详情/搜索竞态守卫、扫描容错等 |
| **扫描配对修复（2026-09-08 二次）** | 跨目录同名文件导致实况配对错乱、3,382 个视频被静默丢弃（详见上「配对规则」）。修复：配对 key 改为「目录 + 基名」+ 增量扫描复用元数据仅修正 type/live_video。重扫后 11,009 → 12,591 资产（photo 1,982 / live 7,434 / video 3,175），与磁盘文件精确一致，与 iCloud 统计基本对齐（照片 9,416≈9,419，视频 3,175≈3,033） |
| **主题 + 返回保留（2026-09-08 审查后）** | 浅色默认双主题切换 + 日期面板 toggle + 默认 8 列；详情返回滚动位置精确保留（KeepAlive，600/1800px 两档深度实测），并修复缓存期间 ResizeObserver 污染导致的行高错位重叠 |
| **UI 徽标 + 详情渐进（2026-09-08）** | 标题「iCloud本地照片」+ favicon；LIVE 白字胶囊（详情按住播放加载动画实测）；视频时长胶囊（0:03）；详情页 grid 占位秒出 → detail 淡入（三类型实测） |
| 冷/热缓存 | 冷生成 grid 0.68s / blur 0.41s，热缓存 25ms |

## 踩坑记录（学习价值）

- **@tanstack/vue-virtual**：`useVirtualizer` 返回的是 ref（`.value` 访问）；`count` 必须用对象 getter（`get count()`）——传 ref 或函数会被 core 直接当数值比较，虚拟项恒为空（virt=0）。
- **flex item 的百分比高度不解析**：`.stage { flex:1 }` 的子元素 `height:100%` 会塌成 0，详情页舞台统一用 `position:absolute; inset:0`。
- **better-sqlite3 不接受数组参数**：EXIF 的 GPS 度分秒数组会爆参数，需先转十进制度数。
- **exifr 的 Orientation 默认返回英文字符串**（"Rotate 90 CW"），要加 `translateValues: false` 拿数字 1~8。
- **实况照片按住不播**：只设了 `playing=true`（切透明度）却没调 `video.play()`；需在 `nextTick` 挂载 `<video>` 后 `play()`，松开时 `pause()` + `currentTime=0`；pointer capture 需 try/catch（合成 PointerEvent 无 active pointer）。
- **实况照片无声**：`<video muted>` 硬编码会永远静音；按住播放时应显式 `v.muted=false` 再 `play()`，失败（自动播放策略）则回退静音继续播。
- **sharp 的 `rotate: true` 构造选项不生效**（0.33.5）：必须用链式 `.rotate()` 才会应用 EXIF 方向——构造选项静默忽略导致竖拍 JPG 缩略图全横。
- **`Cache-Control: immutable` 会把旧图锁死一年**：缩略图内容可能因修复而变化，不能用 immutable；应保留 ETag 协商 + 前端 URL 版本号（rev）实现缓存失效。
- **Windows npm 安装**：`server/.npmrc` 已配 npmmirror 镜像（better-sqlite3/sharp/ffmpeg-static 预编译走国内源）；162MB ffmpeg-full 仍走 GitHub Release，下不动就手动拷 `server/vendor/ffmpeg-full.zip`。
- **KeepAlive 下读不到滚动位置**：deactivated 钩子触发时组件 DOM 已移出文档，scrollTop 已归零；路由切换瞬间的 watch 也读不到真值。正确做法：滚动过程（onScroll）持续记录位置，缓存激活（onActivated）后写回 + 派发 scroll 事件重算可视窗口。
- **KeepAlive 返回后行高错位**：缓存期间 ResizeObserver 把 clientWidth 读成 0，污染 viewportWidth → 恢复瞬间用兜底 200px 行高测量 → 行重叠/间距异常。修复：ResizeObserver 忽略宽度 0 + 恢复时 rAF 内先 measure 再派发 scroll。
- **FTS5 trigram 多字符查询是「片段 AND」不是短语**：`MATCH '2023'` 实际等价 `"202" AND "023"`——只要求两个 3 字符片段都出现、不要求连成完整词（带引号短语同样无相邻约束，实测与 AND 结果一致）。日期时间串碰巧同时含这两段（如 `20181207T120239` 的 T1202→202 + 0239→023）就误命中。修复：FTS 粗筛后加 `instr(文件名小写/ISO/紧凑时间, 查询词)` 连续子串精筛，多 token 逐词 AND。
