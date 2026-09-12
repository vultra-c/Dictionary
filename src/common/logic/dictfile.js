/**
 * 词典数据文件读取封装层（@system.file）
 * 本模块依赖 @system.*，只能被页面（.ux）/app.ux import，纯逻辑库（dict/forms）不得依赖。
 *
 * 产出注入 dict.init() 的 readRange(uri, pos, len, cb(buf|null))：
 *   - 走 file.readArrayBuffer（官方文档确认支持包内资源路径 '/common/...' 与
 *     position/length 部分读取），引擎按 2~66KB 小窗口随机取读；
 *   - 串行队列：手环 I/O 与 JS 桥并发有限，所有读取依次经过同一承诺链，
 *     避免多窗口并发读导致的桥层压力与乱序风险；
 *   - buffer 形态全归一：真机不同固件可能回传 Uint8Array / ArrayBuffer / 字节数组，
 *     统一落成 Uint8Array 交给引擎（诊断字节一个版本内定位之谜）；
 *   - 每次调用独立完成态，fail/异常一律回 null（引擎按 broken/空结果兜底，不炸页面）。
 */
import file from '@system.file'

// 任意形态的 buffer → Uint8Array；归一失败回 null
function normalize(buf) {
  if (!buf) return null
  if (buf instanceof Uint8Array) return buf
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf)
  // 纯字节数组兜底（个别固件桥层回传 number[]）
  if (typeof buf.length === 'number' && buf.length >= 0) {
    const out = new Uint8Array(buf.length)
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] & 255
    return out
  }
  return null
}

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
          success: (data) => finish(normalize(data && data.buffer)),
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

/**
 * 诊断用读取（绕过串行队列，返回原始返回体形貌摘要；仅调试版使用）。
 * cb(report) —— report 为单行文本，形如
 *   'ok u8 32 DSMP'  /  'ok ab 27392 D...' / 'fail 300' / 'throw ...'
 */
export function diagRead(uri, pos, len, cb) {
  const done = { v: false }
  const finish = (s) => { if (!done.v) { done.v = true; cb(s) } }
  try {
    file.readArrayBuffer({
      uri: uri,
      position: pos,
      length: len,
      success: (data) => {
        const raw = data && data.buffer
        let shape = 'null'
        if (raw) {
          shape = raw instanceof Uint8Array ? 'u8'
            : raw instanceof ArrayBuffer ? 'ab'
              : (typeof raw.length === 'number' ? 'arr' : typeof raw)
        }
        const norm = normalize(raw)
        if (!norm) { finish('norm_null ' + shape); return }
        let magic = ''
        for (let i = 0; i < Math.min(4, norm.length); i++) magic += String.fromCharCode(norm[i])
        finish('ok ' + shape + ' ' + norm.length + ' ' + magic)
      },
      fail: (d, code) => finish('fail ' + code)
    })
  } catch (e) {
    finish('throw ' + (e && e.message ? e.message : e))
  }
}
