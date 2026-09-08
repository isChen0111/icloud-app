/**
 * 搜索路由（P2 落地：FTS5 trigram 全文搜索）
 *
 * GET /api/search?q=<关键词>&limit=50
 *   对 文件名 + 拍摄时间 两列做子串匹配，返回时间倒序的资产列表。
 *
 * 设计要点：
 *  - 索引：assets_fts 是 trigram 分词器虚拟表（见 db/schema.ts），
 *    支持任意 3+ 字符子串命中（对标 iCloud 搜索框的"随便输一段就出结果"）。
 *  - 大小写：索引存小写文件名，查询也转小写 → 不区分大小写。
 *  - 清洗：FTS5 查询语法特殊字符（" * : ^ ( ) 与 AND/OR/NOT/NEAR）会破坏 MATCH；
 *    且日期里的 "-" 会被解析器误读为列分隔符（实测 "2024-09" → no such column: 09）。
 *    解法：所有非字母数字字符统一转空格，再丢弃 <3 字符的短 token
 *    （trigram 最小 3 字符，短 token 无法匹配反而会干扰）。
 *    "2024-09" → "2024"（宽匹配该年）；"202409" → 命中 date_compact 列。
 *  - 长度：整串过滤后为空或 <3 字符 → 直接返回空（前端提示至少 3 字符）。
 */
import type { FastifyInstance } from 'fastify'
import { getDb } from '../db/index.js'
import { toDto, type AssetRow } from './assets.js'

/** FTS5 查询清洗：小写 + 标点转空格 + 丢弃 <3 字符 token */
function sanitizeQuery(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, ' ') // 保留中英文数字，其余（-_.: 引号括号等）一律转空格
    .split(' ')
    .filter((t) => t.length >= 3)
    .join(' ')
    .trim()
}

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get('/api/search', async (req, reply) => {
    const { q, limit: limitRaw } = req.query as { q?: string; limit?: string }
    const limit = Math.min(Number(limitRaw ?? 50) || 50, 200)
    const query = sanitizeQuery(q ?? '')

    // trigram 最小 3 字符；不足时无法走索引，直接返回空（不降级为 LIKE 全扫）
    if (query.length < 3) {
      return reply.send({ query: q ?? '', items: [] })
    }

    // MATCH 子串匹配两列（search_text / date_taken 任一命中即可），join 回资产表取真实数据。
    // try/catch 兜底（审查 P2-B6）：清洗后仍有极少数输入会让 FTS5 抛语法错误
    // （如超长输入/畸形 token 组合），此时返回空结果而非 500。
    let rows: AssetRow[] = []
    try {
      rows = db
        .prepare(
          `SELECT a.* FROM assets_fts f
           JOIN assets a ON a.id = f.rowid
           WHERE assets_fts MATCH ?
           ORDER BY a.date_taken DESC, a.id DESC
           LIMIT ?`,
        )
        .all(query, limit) as AssetRow[]
    } catch (err) {
      console.warn(`[search] FTS 查询失败，返回空: ${query}`, (err as Error).message)
    }

    return reply.send({ query: q ?? '', items: rows.map(toDto) })
  })
}
