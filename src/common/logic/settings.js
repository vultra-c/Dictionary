/**
 * 词典应用设置（@system.storage 持久化）
 * 存储键 dict_settings → JSON：{ keepScreenOn: bool, vibrate: bool }
 * 本模块依赖 @system.*，只能被页面（.ux）import，纯逻辑库（dict/forms）不得依赖。
 */
import storage from '@system.storage'
import brightness from '@system.brightness'
import app from '@system.app'

const KEY = 'dict_settings'
const DEF = { keepScreenOn: false, vibrate: true }
let cache = null

export function loadSettings(cb) {
  if (cache) { cb && cb(cache); return }
  storage.get({
    key: KEY,
    success: (data) => {
      cache = Object.assign({}, DEF)
      try { if (data) Object.assign(cache, JSON.parse(data)) } catch (e) { /* 数据损坏回默认 */ }
      cb && cb(cache)
    },
    fail: () => {
      cache = Object.assign({}, DEF)
      cb && cb(cache)
    }
  })
}

export function saveSettings(next, cb) {
  cache = Object.assign({}, DEF, next)
  storage.set({
    key: KEY,
    value: JSON.stringify(cache),
    success: () => cb && cb(true),
    fail: () => cb && cb(false)
  })
}

export function getVibrate() {
  return cache ? cache.vibrate !== false : DEF.vibrate
}

/** 应用常亮设置（立即生效）。能力探针 + 失败回调，退出应用由系统复位。 */
export function applyKeepScreenOn(on, cb) {
  let usable = true
  try {
    usable = !!(app.canIUse && app.canIUse('@system.brightness.setKeepScreenOn'))
  } catch (e) { usable = true }
  if (!usable) { cb && cb(false, '当前设备不支持常亮设置'); return }
  brightness.setKeepScreenOn({
    keepScreenOn: !!on,
    success: () => cb && cb(true),
    fail: () => cb && cb(false, '常亮设置失败')
  })
}
