/**
 * 词典数据文件读取封装层（@system.file）
 * 本模块依赖 @system.*，只能被页面（.ux）/app.ux import，纯逻辑库（dict/forms）不得依赖。
 *
 * 产出注入 dict.init() 的 readRange(uri, pos, len, cb(buf|null))：
 *   - 走 file.readArrayBuffer（官方文档确认支持包内资源路径 '/common/...' 与
 *     position/length 部分读取），引擎按 2~66KB 小窗口随机取读；
 *   - 串行队列：手环 I/O 与 JS 桥并发有限，所有读取依次经过同一承诺链，
 *     避免多窗口并发读导致的桥层压力与乱序风险；
 *   - 每次调用独立完成态，fail/异常一律回 null（引擎按 broken/空结果兜底，不炸页面）。
 */
import file from '@system.file'

export function makeReader() {
  let chain = Promise.resolve()
  return function readRange(uri, pos, len, cb) {
    chain = chain.then(() => new Promise((resolve) => {
      let done = false
      const finish = (buf) => {
        if (done) return
        done = true
        resolve(buf)
      }
      try {
        file.readArrayBuffer({
          uri: uri,
          position: pos,
          length: len,
          success: (data) => {
            const buf = data && data.buffer ? data.buffer : null
            finish(buf && buf.length >= 0 ? buf : null)
          },
          fail: () => finish(null)
        })
      } catch (e) {
        finish(null)
      }
    })).then((buf) => {
      try { cb(buf) } catch (e) { /* 页面/引擎回调异常隔离，队列不断 */ }
      return null
    })
  }
}
