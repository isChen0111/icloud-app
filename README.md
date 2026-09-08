# 本地 iCloud 照片浏览器

在本地完整复刻 iCloud 网页端的照片浏览体验（虚拟滚动照片墙 / 缩放 / 日期定位 / 详情轮播 / 实况照片 / 视频流式播放）。

## 目录结构

```
icloud-app/
├── iCloudPhoto/          # 照片库（iCloudPD 拉取，只读，162.8GB）
├── iCloudTool/           # iCloudPD 工具（与本应用无关）
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
│   │   └── routes/             # API 路由（assets/thumb/video/stats/search）
│   ├── scripts/                # 运维脚本（fix-size / fix-thumbs / install-ffmpeg）
│   ├── vendor/                 # BtbN ffmpeg full 版（含 libheif，HEIC 解码必需）
│   └── cache/                  # 缩略图 thumbs/ + library.db + stats.json（可删，会重建）
└── web/                  # 前端：Vue 3 + Vite + TS + Pinia
    └── src/
        ├── views/              # 照片墙 GridView / 详情 DetailView
        ├── components/         # GridScroller / GridItem + detail/（LivePhoto/VideoStage）
        ├── stores/             # Pinia 数据缓存
        ├── composables/        # 懒加载等组合式函数
        ├── api/                # API 客户端（含缩略图 rev 版本号）
        ├── router/             # hash 路由（#/photo/:id）
        └── types.ts            # 前后端共享类型
```

## 快速启动

```bash
# 1. 后端（端口 8899，首次启动自动扫描入库）
cd server
npm install          # postinstall 会自动装带 libheif 的 ffmpeg full 版（HEIC 解码必需）
npm run dev

# 2. 前端（新终端，端口 5173）
cd web
npm install
npm run dev
```

打开 http://127.0.0.1:5173 即见照片墙。

> 说明：后端首次启动会全量扫描照片库（~2 万媒体文件 / 11,009 资产，约几分钟），扫描完成后缩略图由
> 后台队列按需预热；浏览时未生成的缩略图会现场生成（冷 0.7s / 热 25ms）。

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
| GET | /api/assets?offset=&limit= | 按全局序号跳页（日期定位用，跳后可用游标接续） |
| GET | /api/assets/:id | 单个资产 + 前后邻居 id |
| GET | /api/thumb/:id?size=grid\|detail\|blur | 缩略图（懒生成） |
| GET | /api/video/:id/stream | 视频流（HTTP Range） |
| GET | /api/video/:id/poster | 视频封面帧 |
| GET | /api/stats | 库统计 + 扫描进度 |
| POST | /api/scan | 触发扫描 |
| GET | /api/dates | 年月分组：{ ym, label, count, offset }（offset=该月首资产全局位置） |
| GET | /api/search?q=&limit= | FTS5 全文搜索（文件名/日期子串，至少 3 字符） |

## 设计要点速记

- **虚拟滚动**：网格按行虚拟化，只挂载视口附近的 ~100 个 DOM 节点（1.2 万资产也不卡）。
- **缩略图懒生成**：首次浏览某张图才生成 320px WebP（~25KB），生成后永久缓存；同资产并发去重（in-flight Map）。
- **缩略图缓存失效**：接口 `Cache-Control: max-age=1年`（无 immutable）+ ETag 协商；前端 URL 带 `rev` 版本号——内容变更（如生成参数修复）后 bump `THUMB_REV` 即可强制浏览器重新拉取。
- **HEIC 解码**：sharp 官方预编译无 HEVC 插件，用 BtbN ffmpeg full 版（libheif）解码后再交 sharp 缩放。
- **实况照片**：静止帧（HEIC）+ 配对视频（_HEVC.MOV），按住播放（**带原声**）、松开暂停复位。
- **视频流**：原生 `<video>` + HTTP Range 206，拖动进度条零延迟。
- **FTS5 搜索**：trigram 分词器支持任意子串（搜 "9188" 或 "202409" 都秒出）；索引存小写文件名 + 原始/紧凑日期，入库时同步、启动时校验回填。
- **配对规则**：基名相同即配对（`IMG_1234.HEIC ⇄ IMG_1234_HEVC.MOV`，`_HEVC` 后缀归一），无时间差校验（iCloudPD 的 suffix 命名天然保证一一对应）。

## 已实测验证（2026-09-08 E2E）

| 功能 | 结果 |
|---|---|
| 全量扫描入库 | 11,009 资产（照片 3,781 + 实况 5,635 + 视频 1,593） |
| 照片墙虚拟滚动 | 5 列/3 列切换正常，DOM 稳定 ~16 行，滚动流畅 |
| 滚动翻页 | 接近底部自动加载下一页（游标分页） |
| 缩略图懒加载 | blur 占位秒出 → 320px 缩略图淡入，滚过即请求、离开即回收 |
| 详情页 | hash 深链 `#/photo/:id`，键盘 ←→ 切换邻居 |
| 实况照片 | 静止帧 + 按住播放（HEVC 流 206 播放验证通过） |
| 视频 | poster 封面 + Range 流 + 时长/控件正常 |
| **日期分组定位（P1）** | 网格内月份头行 + 顶部吸顶月份指示器 + 右侧月份快速定位条（108 个月，点击 → offset 跳页直达该月首行，高亮跟随滚动） |
| **FTS5 搜索（P2）** | 搜索框防抖 300ms → trigram 子串匹配（文件名不区分大小写 / 日期宽匹配 / 紧凑日期），Esc 退出回照片墙，点结果进详情 |
| **稳定性修复（2026-09-08）** | 代码审查 12 项问题全部修复：stats 异步缓存（首屏 229ms）、原图宽高 11,009 条修正、EXIF 方向缩略图重建（fix-thumbs 103 张）、浏览器缩略图缓存失效链路（rev=2 + 去 immutable）、实况按住带原声、详情/搜索竞态守卫、扫描容错等 |
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
- **Windows npm 安装**：GitHub 二进制下载不通时用 npmmirror 二进制镜像（见上文安装说明）。
