/**
 * 数据库 Schema（SQLite / better-sqlite3）
 *
 * 设计要点：
 * 1. 一张 assets 表存所有媒体资产（照片/视频/实况照片），主资产概念：
 *    - type='photo'  ：普通照片
 *    - type='video'  ：普通视频
 *    - type='live'   ：实况照片（静止帧为主资产，live_video 字段指向配对视频）
 * 2. file_path 为唯一键，支持「增量重扫」——同一路径再次扫描时 UPSERT 更新。
 * 3. thumb_status / detail_status / poster_status 记录缩略图生成状态，
 *    避免重复生成（这是"懒生成"流水线的状态机）。
 */

/** 建表 SQL（幂等：IF NOT EXISTS） */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS assets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- 相对库根目录的路径，如 "2025/02/17/IMG_1234.HEIC"（唯一键）
  file_path     TEXT UNIQUE NOT NULL,

  -- 主资产类型：photo | video | live
  type          TEXT NOT NULL,

  -- 原文件名（含扩展名）
  filename      TEXT NOT NULL,

  -- 拍摄时间（ISO8601）。优先级：EXIF DateTimeOriginal > 目录 YYYY/MM/DD > 文件修改时间
  date_taken    TEXT NOT NULL,

  -- 宽高（像素）。视频为解码后的原始分辨率
  width         INTEGER,
  height        INTEGER,

  -- 视频时长（秒）；照片为 NULL
  duration      REAL,

  -- EXIF 方向（1~8），渲染时前端据此旋转
  orientation   INTEGER DEFAULT 1,

  -- GPS 经纬度（可选）
  gps_lat       REAL,
  gps_lon       REAL,

  -- 实况照片配对视频的相对路径（仅 type='live' 有值）
  live_video    TEXT,

  -- 缩略图生成状态机：pending → done | error
  thumb_status  TEXT DEFAULT 'pending',
  detail_status TEXT DEFAULT 'pending',
  poster_status TEXT DEFAULT 'pending',

  -- 文件校验和（预留：检测文件变化）
  checksum      TEXT
);

-- 拍摄时间倒序索引：照片墙按时间倒序分页（核心查询）
CREATE INDEX IF NOT EXISTS idx_assets_date ON assets(date_taken DESC, id DESC);

-- 类型索引：统计照片/视频数量
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);

-- ============ FTS5 全文搜索（P2 落地） ============
-- 用 trigram（3 字符滑动窗口）分词器：支持「任意子串」匹配，等于把 LIKE '%xx%' 变成走索引。
-- 为什么不用默认 unicode61？它按单词切 token，"IMG_9188" 会被切成 "IMG"、"9188"，
-- 用户搜 "9188" 或 "918" 这种中间片段就命中不了；trigram 能命中任意 3+ 字符片段。
-- 三列都索引：
--   search_text  小写文件名（搜索不区分大小写）
--   date_taken   原始 ISO 时间，支持搜 "2024-09"（清洗后按 2024 宽匹配）
--   date_compact 去标点紧凑日期 "2024-09-13T08:40:28" → "20240913T084028"，支持搜 "202409"
-- rowid 与 assets.id 对齐（显式指定），便于 join 与按 id 同步。
-- 注意：FTS5 虚拟表不支持 ALTER 加列，schema 变更只能重建；
-- 这里 DROP+CREATE，每次启动由 db/index.ts 的一致性回填重建索引（11k 行毫秒级，可接受）。
DROP TABLE IF EXISTS assets_fts;
CREATE VIRTUAL TABLE assets_fts USING fts5(
  search_text,
  date_taken,
  date_compact,
  tokenize = 'trigram'
);
`
