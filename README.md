# 本地照片库 Web 应用

用于浏览 iCloudPD 同步到本地的照片、实况照片和视频（支持虚拟滚动照片墙、缩放、日期定位、详情轮播和视频流式播放）。

## 目录结构

```
icloud-app/
├── docs/
│   ├── 架构设计文档.html
│   ├── CONTEXT-项目上下文快照.md
│   └── 整体审查报告-2026-10-06.md   # 全项目代码审查：F-01~F-07 问题与修复进度
├── server/                 # Fastify 后端与媒体处理流水线
│   ├── src/
│   ├── scripts/
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

**启动前准备照片库**：照片库不会随项目克隆。将媒体文件放在项目根目录的 `iCloudPhoto/`，或在 `server/.env` 中设置 `PHOTO_LIBRARY` 指向已有照片库。应用只读取该目录；应用内的删除操作会删除对应源文件。

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

开发模式使用前端 5173 和后端 8899 两个端口。生产模式先构建前端，再由后端托管页面，访问 `http://127.0.0.1:8899`：

```powershell
Set-Location .\web
npm run build

Set-Location ..\server
npm run start
```

### FFmpeg 下载失败时（备用方案）

如果自动下载失败，可选以下任一方案：

1. 从[项目 Release 页面](https://github.com/isChen0111/icloud-app/releases/tag/vendor-binaries)手动下载 `ffmpeg-full.zip`，放到 `server/vendor/ffmpeg-full.zip`，然后在 `server/` 目录运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/install-ffmpeg-full.ps1
   ```

2. 或设置环境变量 `FFMPEG_FULL_URL` 指向可访问的文件地址，再从 `server/` 目录重新运行 `npm ci`。

不要使用 `npm ci --ignore-scripts`，否则会跳过 FFmpeg 自动安装。若已使用该参数，可按上面的步骤手动安装 FFmpeg。

### 环境变量（.env）

所有路径/端口都支持环境变量覆盖。在 `server/` 目录建 `.env`（照 `.env.example` 复制），启动脚本已自动加载（Node 原生 `--env-file-if-exists=.env`，文件不存在也不影响）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PHOTO_LIBRARY` | `<项目根>\\iCloudPhoto` | 照片库根目录（iCloudPD 输出，只读） |
| `CACHE_DIR` | `<项目根>\\server\\cache` | 缩略图/封面/转码缓存目录 |
| `DB_PATH` | `<项目根>\\server\\cache\\library.db` | SQLite 数据库文件 |
| `FFMPEG_DIR` | `<项目根>\\server\\vendor\\ffmpeg-full` | BtbN ffmpeg full 解压目录 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | （自动在 FFMPEG_DIR 内查找） | 直接指定可执行文件 |
| `PORT` | `8899` | 后端端口 |
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
| `npm test` | `server/` | 单元测试（node:test，12 用例：缩略图调度器 9 + ffmpeg 超时 2 + 后台挂起上限 1） |
| `npm run fix-size` | `server/` | 维护命令：从原媒体重新读取像素尺寸 |
| `npm run fix-thumbs` | `server/` | 维护命令：重建缩略图缓存 |

## API（开发参考）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/assets?cursor=&limit= | 照片墙分页（时间倒序，游标分页） |
| GET | /api/assets?offset=&limit= | 按全局序号取任意区间（照片墙全量骨架的懒加载取数） |
| GET | /api/assets/:id | 单个资产 + 前后邻居 id + 序号/总数 |
| GET | /api/assets/:id/info | 详情信息面板：实时解析 EXIF / ffprobe（设备/镜头/ISO/光圈/GPS 等） |
| GET | /api/thumb/:id?size=grid\|detail | 缩略图（懒生成） |
| GET | /api/video/:id/stream | 视频流（HTTP Range） |
| GET | /api/video/:id/poster | 视频封面帧 |
| GET | /api/stats | 库统计 + 扫描进度 + 预览图计数 + 队列指标（thumbQueueMetrics：运行/交互运行/交互等待/已跳过）+ 缩略图并发配置（thumbConcurrency）（扫描时只报已检查文件数；扫描结束后按数据库持久化状态提供全库总量/已处理/已生成/待处理/失败，重启后已生成进度不归零） |
| GET | /api/thumbnails/failed | 预览图失败文件清单及待处理/已忽略数量 |
| POST | /api/thumbnails/retry | 重试指定失败项或全部待处理失败项（body: `{ ids }` 或 `{ all: true }`） |
| POST | /api/thumbnails/ignore | 忽略或恢复失败提醒（body: `{ ids, ignored }` 或 `{ all: true, ignored }`） |
| POST | /api/thumbnails/activity | 通知后端用户正在浏览，暂停启动无关的后台预览图任务 |
| POST | /api/scan | 触发扫描 |
| GET | /api/dates | 年月分组：{ ym, label, count, offset, thumbId }（offset=该月首资产全局位置） |
| GET | /api/search?q=&limit=&offset= | FTS5 全文搜索（文件名/日期子串，至少 3 字符；返回 total 真实计数 + months 匹配集月份分组 + offset 匹配流分页，搜索结果照片墙化；畸形输入返回空结果，真异常返回 500） |
| DELETE | /api/assets | 批量删除（body: `{ ids }`；会删除对应源文件，不可恢复） |

## 功能概览

- 按日期浏览照片、实况照片和视频，支持搜索、日期跳转和详情浏览。
- 照片墙采用虚拟滚动和图片懒加载；慢速滚动与滚轮操作持续加载，网格图并发上限以后端配置为准（默认 8，经 `/api/stats.thumbConcurrency` 同步）；拖动滚动条时每 250ms 检查一次位移，快速跨屏时跳过中途区域，缓慢移动（每次检查不超过约 1/5 屏）或停住时渐进加载当前视口，松开后优先加载最终视口，再补邻近图片。
- 顶栏资源状态提供照片库扫描数量和预览图后台处理进度；扫描文件数与照片/视频资产数分别按文件和入库资产统计。后台补图与用户请求共享最多 8 个并发槽位：浏览时暂停启动新的后台任务，已运行任务结束后将空出的槽位优先分给当前请求；停止活动 30 秒后后台补图恢复并可使用全部槽位。失败项可点击查看原因、单项/批量重试或忽略提醒；忽略不会删除原文件，且可随时恢复提醒。
- 实况照片可按住播放；视频支持封面预览和流式播放。
- 照片库目录发生变化后会自动同步；删除照片是永久操作，源文件无法从应用恢复。
- 深浅主题和照片墙缩放设置会保存在当前浏览器中。

## 数据与隐私

- 照片、视频和数据库都保存在本地；应用不会将媒体上传到云端。
- `iCloudPhoto/` 是源照片库，`server/cache/` 是数据库和可重建缓存；两者都不会随 Git 克隆下载。
- 删除功能会尝试删除磁盘上的源文件。因权限或文件占用而未能删除时，界面会提示；请在确认前确保重要照片另有备份。

## 开发与架构文档

接口、扫描规则、媒体处理流程及架构细节请参阅[架构设计文档](./docs/架构设计文档.html)。README 侧重安装、运行和日常使用。
