# 本地照片库 Web 应用

用于浏览 iCloudPD 同步到本地的照片、实况照片和视频（支持虚拟滚动照片墙、缩放、日期定位、详情轮播和视频流式播放）。

## 目录结构

```
icloud-app/
├── docs/
│   ├── 架构设计文档.html
│   └── CONTEXT-项目上下文快照.md
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

打开 http://localhost:5173 查看照片墙。首次启动后端会扫描照片库并建立索引，照片较多时需要等待；缩略图会在浏览时按需生成。后端之后也会在启动时增量同步，并监听照片库的文件变化。

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
| `npm run fix-size` | `server/` | 维护命令：从原媒体重新读取像素尺寸 |
| `npm run fix-thumbs` | `server/` | 维护命令：重建缩略图缓存 |

## API（开发参考）

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
| DELETE | /api/assets | 批量删除（body: `{ ids }`；会删除对应源文件，不可恢复） |

## 功能概览

- 按日期浏览照片、实况照片和视频，支持搜索、日期跳转和详情浏览。
- 照片墙采用虚拟滚动和图片懒加载，适合浏览较大的本地照片库。
- 实况照片可按住播放；视频支持封面预览和流式播放。
- 照片库目录发生变化后会自动同步；删除照片是永久操作，源文件无法从应用恢复。
- 深浅主题和照片墙缩放设置会保存在当前浏览器中。

## 数据与隐私

- 照片、视频和数据库都保存在本地；应用不会将媒体上传到云端。
- `iCloudPhoto/` 是源照片库，`server/cache/` 是数据库和可重建缓存；两者都不会随 Git 克隆下载。
- 删除功能会尝试删除磁盘上的源文件。因权限或文件占用而未能删除时，界面会提示；请在确认前确保重要照片另有备份。

## 开发与架构文档

接口、扫描规则、媒体处理流程及架构细节请参阅[架构设计文档](./docs/架构设计文档.html)。README 侧重安装、运行和日常使用。
