/**
 * 删除接口单元测试（审查 R-15 / R-16）
 *
 * 两条不变量：
 *   ① 源文件删不掉（非 ENOENT）→ 该资产的 DB 行必须保留，否则文件残留、记录消失，
 *      下次扫描以新 id 复活（用户的忽略/失败状态丢失）
 *   ② 扫描 / 同步在途时 DELETE 一律 409，避免与删除对账、icloudpd 写盘互相踩
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { unlinkAssetFiles, filterDeletable } from './assets.js'
import { libraryBusyGuard } from './libraries.js'
import { scanProgress } from '../scanner/index.js'
import { syncState, resetSyncState } from '../icloudpd/state.js'

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException
  e.code = code
  return e
}

test('unlinkAssetFiles：ENOENT 视为删除成功（用户手动删过 / 上次删了一半）', () => {
  const failed = unlinkAssetFiles('C:/lib', 1, ['2024/09/01/IMG_1.HEIC'], () => {
    throw errno('ENOENT')
  })
  assert.deepEqual(failed, [])
})

test('unlinkAssetFiles：EPERM（被占用）→ 报告失败，带 id / path / code', () => {
  const failed = unlinkAssetFiles('C:/lib', 42, ['2024/09/01/IMG_1.HEIC'], () => {
    throw errno('EPERM')
  })
  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, 42)
  assert.equal(failed[0].code, 'EPERM')
  assert.match(failed[0].path, /IMG_1\.HEIC$/)
})

test('unlinkAssetFiles：主文件成功、实况视频失败 → 只报实况视频', () => {
  const tried: string[] = []
  const failed = unlinkAssetFiles('C:/lib', 7, ['2024/09/01/IMG_7.HEIC', '2024/09/01/IMG_7_HEVC.MOV'], (p) => {
    tried.push(p)
    if (p.endsWith('.MOV')) throw errno('EBUSY')
  })
  assert.equal(tried.length, 2)
  assert.equal(failed.length, 1)
  assert.match(failed[0].path, /MOV$/)
  assert.equal(failed[0].code, 'EBUSY')
})

test('unlinkAssetFiles：无实况视频（null）不产生失败项', () => {
  const failed = unlinkAssetFiles('C:/lib', 3, ['2024/09/01/IMG_3.HEIC', null], () => {})
  assert.deepEqual(failed, [])
})

test('filterDeletable：文件删除失败的资产被排除在 DB 删除之外（R-15 核心）', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const deletable = filterDeletable(rows, new Set([2]))
  assert.deepEqual(deletable.map((r) => r.id), [1, 3])
})

test('libraryBusyGuard(delete-asset)：扫描中 → 409，文案指向「删除照片」', () => {
  resetSyncState()
  scanProgress.status = 'scanning'
  assert.equal(libraryBusyGuard('delete-asset'), '照片库扫描进行中，请稍候再删除照片')
  scanProgress.status = 'idle'
})

test('libraryBusyGuard(delete-asset)：同步中 → 409，文案指向「删除照片」', () => {
  scanProgress.status = 'idle'
  resetSyncState()
  syncState.status = 'running'
  assert.equal(libraryBusyGuard('delete-asset'), '同步任务执行中，请先等待完成或取消后再删除照片')
  resetSyncState()
})

test('libraryBusyGuard(delete-asset)：空闲 → 放行', () => {
  resetSyncState()
  scanProgress.status = 'idle'
  assert.equal(libraryBusyGuard('delete-asset'), null)
})
