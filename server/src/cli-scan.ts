/**
 * CLI 扫描脚本
 *
 * 用法：npm run scan
 * 用途：不启动 Web 服务，单独执行一次全量扫描入库（调试/预热用）。
 */
import { runScan, scanProgress } from './scanner/index.js'

runScan()
  .then(() => {
    console.log('扫描完成。', scanProgress)
    process.exit(0)
  })
  .catch((err) => {
    console.error('扫描失败:', err)
    process.exit(1)
  })
