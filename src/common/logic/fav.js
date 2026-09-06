/**
 * 生词本（@system.storage 持久化）
 * 存储键 dict_favs → JSON 数组（最新在前，上限 200，自动去重）。
 * 只能被页面（.ux）import。
 */
import storage from '@system.storage'

const KEY = 'dict_favs'
const MAX = 200
let cache = null

function persist(cb) {
  storage.set({
    key: KEY,
    value: JSON.stringify(cache),
    success: () => cb && cb(true),
    fail: () => cb && cb(false)
  })
}

export function loadFavs(cb) {
  if (cache) { cb && cb(cache); return }
  storage.get({
    key: KEY,
    success: (data) => {
      let arr = []
      try { arr = data ? JSON.parse(data) : [] } catch (e) { arr = [] }
      cache = Array.isArray(arr) ? arr : []
      cb && cb(cache)
    },
    fail: () => { cache = []; cb && cb(cache) }
  })
}

export function isFav(word) {
  return !!cache && cache.indexOf(word) >= 0
}

// 切换收藏态；返回 'added'|'removed'|null（null=未初始化）
export function toggleFav(word, cb) {
  if (!cache || !word) { cb && cb(null); return null }
  const i = cache.indexOf(word)
  if (i >= 0) {
    cache.splice(i, 1)
    persist(cb)
    return 'removed'
  }
  cache.unshift(word)
  if (cache.length > MAX) cache = cache.slice(0, MAX)
  persist(cb)
  return 'added'
}

export function clearFavs(cb) {
  cache = []
  persist(cb)
}
