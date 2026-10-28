# 本地照片库 Web 应用

用于浏览 iCloudPD 同步到本地的照片、实况照片和视频（支持虚拟滚动照片墙、缩放、日期定位、详情轮播和视频流式播放）。

## 目录结构

```
icloud-app/
├── docs/
│   ├── 架构设计文档.html
│   ├── iCloudPD照片库同步-架构功能设计.html   # P0 照片库拉取/认证/多库：架构与 API 规格
│   ├── 产品设计稿-照片库拉取同步.html          # P0 UI 设计基准（含 _shots/ 截图）
│   ├── CONTEXT-项目上下文快照.md
│   ├── 整体审查报告-2026-10-06.md   # 全项目代码审查：F-01~F-07 问题与修复进度
│   └── 整体审查报告-2026-10-27.md   # 全项目代码审查：R-01~R-30 问题与修复进度（30 项已全部落地）
├── iCloudPhoto/            # 照片库根（多库：iCloudPhoto/lib<id>/，icloudpd 输出，只读）
├── server/                 # Fastify 后端与媒体处理流水线
│   ├── src/
│   ├── scripts/
│   ├── vendor/              # 第三方二进制（ffmpeg-full/、icloudpd exe，均不提交 git）
│   ├── cache/               # 应用缓存（meta.db 注册表 + lib<id>/ 各库缓存，可重建）
│   ├── package.json
│   └── package-lock.json
└── web/                    # Vue 前端
    ├── src/
    ├── package.json
    └── package-lock.json
```

## 快速启动

**前置要求**：Windows、Node.js 22 或更高版本。

`server/` 和 `web/` 是独立项目，分别在各自目录运行 `npm ci` 安装依赖。安装后端依赖时，npm 会自动检查 FFmpeg；首次安装或文件缺失时会下载约 170MB 的套件。通常无需手动处理，下载失败时再使用后文的备用方案。

**启动前准备**：应用是**多照片库**模式——照片库通过网页端创建（首页引导：命名 → 链接 iCloud → 全量拉取）。照片库根目录为项目根的 `iCloudPhoto/`（每库 `iCloudPhoto/lib<id>/`，文件夹结构固定 `YYYY/MM/DD`）；各库缓存与会话在 `server/cache/lib<id>/`，库注册表 `server/cache/meta.db`。旧版单库模式可用 `PHOTO_LIBRARY` 指向已有照片库（作为激活库默认目录），但推荐走网页端多库引导。

```powershell
# 终端一：安装并启动后端
Set-Location .\server
npm ci
npm run dev
```

```powershell
# 终端二：安装并启动前端
Set-Location .\web
npm ci
npm run dev
```

打开 http://localhost:5173 查看照片墙。首次启动后端会先收集媒体文件，再优先处理目录日期较新的文件；扫描期间，首批资产入库后照片墙会自动显示已入库内容，扫描结束后再自动刷新一次以同步最终数据。扫描完成后，剩余网格缩略图进入后台生成队列；已显示照片的缩略图仍按需加载。目录日期只用于安排处理顺序，照片墙最终仍按实际拍摄时间排序。后端之后也会在启动时增量同步，并监听照片库的文件变化。

如需使用非默认照片库路径，可先在 `server/` 目录创建 `.env`：

```powershell
Set-Location .\server
Copy-Item .env.example .env
```

然后编辑 `server/.env`，设置 `PHOTO_LIBRARY`。

### 生产模式（单端口部署）

开发模式使用前端 5173 和后端 8899 两个端口。生产模式先构建前端，再由后端托管页面，本机访问 `http://127.0.0.1:8899`（后端默认监听 `0.0.0.0`，同一局域网内其他设备用 `http://<服务器IP>:8899` 访问）：

```powershell
Set-Location .\web
npm run build

Set-Location ..\server
npm run start
```

### 第三方二进制下载失败时（备用方案）

`server/` 下执行 `npm ci` 时 postinstall 会自动下载安装 FFmpeg（含 libheif）与 icloudpd exe（均从[项目 Release 页面](https://github.com/isChen0111/icloud-app/releases/tag/vendor-binaries)下载；已存在则跳过）。若自动下载失败，可选以下任一方案：

1. 手动下载 `ffmpeg-full.zip`（FFmpeg）或 `icloudpd-1.32.3-windows-amd64.exe`（icloudpd），分别放到 `server/vendor/ffmpeg-full.zip` / `server/vendor/icloudpd-1.32.3-windows-amd64.exe`，再在 `server/` 目录运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/install-ffmpeg-full.ps1
   powershell -ExecutionPolicy Bypass -File scripts/install-icloudpd.ps1
   ```

2. 或设置环境变量 `FFMPEG_FULL_URL` / `ICLOUDPD_URL` 指向可访问的文件地址，再从 `server/` 目录重新运行 `npm ci`。

不要使用 `npm ci --ignore-scripts`，否则会跳过自动安装。若已使用该参数，可按上面的步骤手动安装。

### 环境变量（.env）

所有路径/端口都支持环境变量覆盖。在 `server/` 目录建 `.env`（照 `.env.example` 复制），启动脚本已自动加载（Node 原生 `--env-file-if-exists=.env`，文件不存在也不影响）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PHOTO_LIBRARY` | `<项目根>\\iCloudPhoto` | 激活库照片根默认目录（iCloudPD 输出，只读；多库下每库为 `iCloudPhoto\\lib<id>`） |
| `CACHE_DIR` | `<项目根>\\server\\cache` | 缓存根（多库下每库 `cache\\lib<id>`；注册表 `meta.db` 固定在此根） |
| `DB_PATH` | `<项目根>\\server\\cache\\library.db` | 激活库 SQLite 数据库文件（多库下按库目录自动派生） |
| `META_DB_PATH` | `<项目根>\\server\\cache\\meta.db` | 库注册表 DB（多库共享，不随库切换） |
| `ICLOUDPD_EXE` | `<项目根>\\server\\vendor\\icloudpd-1.32.3-windows-amd64.exe` | icloudpd 可执行文件（黑盒调用，版本锁定） |
| ~~`ICLOUDPD_RECENT`~~ | — | 已废弃（2026-10-13）：同步限量改由设置中心按库 `recentLimit` 配置，不再读取此变量 |
| `FFMPEG_DIR` | `<项目根>\\server\\vendor\\ffmpeg-full` | BtbN ffmpeg full 解压目录 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | （自动在 FFMPEG_DIR 内查找） | 直接指定可执行文件 |
| `PORT` | `8899` | 后端端口 |
| `HOST` | `0.0.0.0` | 后端监听地址（默认全网卡，同一局域网设备可用 `http://<服务器IP>:8899` 访问；设 `127.0.0.1` 可收回仅本机） |
| `SCAN_LIMIT` | `0`（全量） | 调试用，>0 只扫前 N 个文件 |

优先级：命令行临时设置 > `.env` 文件 > 代码默认值。同一时间不要两个后端实例连同一个 `library.db`（SQLite 写锁冲突）。

## 常用命令

| 命令 | 位置 | 作用 |
|---|---|---|
| `npm run dev` | `server/` | 启动后端开发服务 |
| `npm run start` | `server/` | 启动后端服务 |
| `npm run scan` | `server/` | 手动触发一次扫描同步 |
| `npm run dev` | `web/` | 启动前端开发服务 |
| `npm run build` | `web/` | 构建前端生产版本 |
| `npm test` | `server/` | 单元测试（node:test，78 用例：缩略图调度器、任务队列、扫描对账与端到端扫描、数据库迁移、接口、工具函数、视频 Range 解析、watcher 会话代数）。新增测试文件需手动加进 `package.json` 的 test 列表——该脚本是显式文件清单，不是 glob |
| `npm run postinstall` | `server/` | 安装/解压 BtbN ffmpeg full（含 libheif）+ icloudpd exe |

## API（开发参考）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/assets?cursor=&limit= | 照片墙分页（时间倒序，游标分页） |
| GET | /api/assets?offset=&limit= | 按全局序号取任意区间（照片墙全量骨架的懒加载取数） |
| GET | /api/assets/:id | 单个资产 + 前后邻居 id + 序号/总数 |
| GET | /api/assets/:id/info | 详情信息面板：实时解析 EXIF / ffprobe（设备/镜头/ISO/光圈/GPS 等） |
| GET | /api/thumb/:id?size=grid\|detail | 缩略图（懒生成；URL 带 rev=file_mtime 动态版本，源文件变化后浏览器自动换新图） |
| GET | /api/video/:id/stream | 视频流（HTTP Range） |
| GET | /api/video/:id/poster | 视频封面帧（rev 同缩略图） |
| GET | /api/stats | 库统计 + 扫描进度 + 预览图计数 + 队列指标（thumbQueueMetrics：运行/交互运行/交互等待/已跳过）+ 缩略图并发配置（thumbConcurrency）（扫描时只报已检查文件数；扫描结束后按数据库持久化状态提供全库总量/已处理/已生成/待处理/失败，重启后已生成进度不归零） |
| GET | /api/thumbnails/failed | 预览图失败文件清单及待处理/已忽略数量 |
| POST | /api/thumbnails/retry | 重试指定失败项或全部待处理失败项（body: `{ ids }` 或 `{ all: true }`） |
| POST | /api/thumbnails/ignore | 忽略或恢复失败提醒（body: `{ ids, ignored }` 或 `{ all: true, ignored }`） |
| POST | /api/scan | 触发扫描 |
| GET | /api/dates | 年月分组：{ ym, label, count, offset, thumbId, thumbRev }（offset=该月首资产全局位置） |
| GET | /api/search?q=&limit=&offset= | FTS5 全文搜索（文件名/日期子串，至少 3 字符；返回 total 真实计数 + months 匹配集月份分组 + offset 匹配流分页，搜索结果照片墙化；畸形输入返回空结果，真异常返回 500） |
| DELETE | /api/assets | 批量删除（body: `{ ids }`；会删除对应源文件，不可恢复） |
| GET | /api/libraries | 照片库列表（含激活标记/链接状态/账号/目录/照片视频计数） |
| POST | /api/libraries | 创建照片库（body: `{ name }`；已有激活库时不自动切换） |
| PATCH | /api/libraries/:id/active | 切换激活库（同步执行中或扫描进行中 409） |
| DELETE | /api/libraries/:id | 删除照片库（body: `{ removePhotos }`；必删注册+缓存，勾选才删本地照片；同步执行中或扫描进行中 409） |
| POST | /api/auth | 开始 iCloud 链接（spawn icloudpd webui auth-only） |
| POST | /api/auth/input | 输入密码/验证码（桥接 webui；防重锁） |
| GET | /api/auth | 认证状态轮询（starting/密码/校验/验证码/完成/失败） |
| POST | /api/auth/cancel | 取消认证 |
| POST | /api/library/:id/sync | 触发全量拉取/增量同步（body: `{ kind: full\|inc }`；仅当前激活库） |
| GET | /api/library/:id/sync | 同步任务状态（全局单任务） |
| DELETE | /api/library/:id/sync | 取消同步任务 |

## 功能概览

- 按日期浏览照片、实况照片和视频，支持搜索、日期跳转和详情浏览。
- **多照片库（P0）**：网页端创建/切换/删除照片库（右上角库切换下拉 + 设置中心）；链接 iCloud 账号（邮箱/密码/双重验证码，cookie 会话保存，过期可重新链接）；全量拉取 / 增量同步（单按钮四态，全局单任务，多库「等待执行」排队）；库名只是别名，目录按 `lib<id>` 稳定隔离。
- 照片墙采用虚拟滚动和图片懒加载；慢速滚动与滚轮操作持续加载，网格图并发上限以后端配置为准（默认 8，经 `/api/stats.thumbConcurrency` 同步）；拖动滚动条时每 250ms 检查一次位移，快速跨屏时跳过中途区域，缓慢移动（每次检查不超过约 1/5 屏）或停住时渐进加载当前视口，松开后优先加载最终视口，再补邻近图片。源文件被覆盖后，扫描比对签名（size+mtime）使旧缩略图失效重建，URL 的 rev（= 文件 mtime）自动变化，浏览器绕过 1 年强缓存强制拉新图（F-03 缓存失效闭环）。
- 顶栏资源状态提供照片库扫描数量和预览图后台处理进度；扫描文件数与照片/视频资产数分别按文件和入库资产统计。后台补图与用户请求共享最多 8 个并发槽位：后台任务始终入队但优先级最低，照片墙、搜索与详情触发的交互请求插队先执行，交互任务不足时后台填满剩余槽位——不需要等待时间窗口，浏览过程中也会持续消化后台任务；已开始运行的任务不会被抢占。失败项可点击查看原因、单项/批量重试或忽略提醒；忽略不会删除原文件，且可随时恢复提醒。
- 实况照片可按住播放；视频支持封面预览和流式播放。
- 照片库目录发生变化后会自动同步；删除照片是永久操作，源文件无法从应用恢复。
- 深浅主题和照片墙缩放设置会保存在当前浏览器中。

## 数据与隐私

- 照片、视频和数据库都保存在本地；应用不会将媒体上传到云端。
- `iCloudPhoto/lib<id>/` 是各照片库源目录，`server/cache/` 是应用缓存（`meta.db` 注册表 + `lib<id>/` 各库数据与可重建缓存）；两者都不会随 Git 克隆下载。
- 删除照片库会移除注册与缓存；勾选「同时删除本地照片副本」才会删除 `iCloudPhoto/lib<id>/` 下的源文件。
- 删除功能会尝试删除磁盘上的源文件。因权限或文件占用而未能删除时，界面会提示；请在确认前确保重要照片另有备份。

## 开发与架构文档

接口、扫描规则、媒体处理流程及架构细节请参阅[架构设计文档](./docs/架构设计文档.html)。README 侧重安装、运行和日常使用。
