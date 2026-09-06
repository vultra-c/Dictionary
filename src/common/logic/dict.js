/**
 * 词典运行时引擎（纯 JS，不依赖 @system.*，Node 可直接测试）
 *
 * 数据：common/data/dict.js 导出的 DICT_DATA 单一长字符串（~4.7MB），
 * 每行一条词条 `word \x01 音标 \x02 中文释义 \x03 变形标记`，按字典序排序。
 *
 * 内存策略（手表堆内存红线）：
 *   - 懒初始化：OFF 行偏移表（Uint32Array，~250KB）首次使用时一次性扫描建好；
 *   - 常驻内存只有原字符串 + OFF，没有任何「词条对象数组」；
 *   - 查询命中才按行解析出小对象，随用随弃。
 *
 * 查询路径：
 *   - 英文精确/前缀：对 word 字段做二分（小写、去空）；
 *   - 中文反查：DATA.indexOf(q) 原语扫描（C 级速度），筛出落在释义字段的命中行。
 */
import { DICT_DATA } from '../data/dict.js'

const D = DICT_DATA
let OFF = null   // Uint32Array，行起始偏移
let N = 0        // 行数

// ---------- 索引（一次性，幂等） ----------
function ensure() {
  if (OFF) return
  // 两遍扫描：第一遍数行（indexOf 是原语速度，比逐 char 快）
  let cnt = 1
  for (let p = D.indexOf('\n'); p >= 0; p = D.indexOf('\n', p + 1)) cnt++
  OFF = new Uint32Array(cnt + 1)
  OFF[0] = 0
  let i = 1
  for (let p = D.indexOf('\n'); p >= 0; p = D.indexOf('\n', p + 1)) OFF[i++] = p + 1
  OFF[cnt] = D.length + 1 // 哨兵：末行结束位置 +1
  N = cnt
}

export function count() { ensure(); return N }

// ---------- 行内字段取用 ----------
// 行区间 [OFF[i], OFF[i+1]-1)，结构 word \x01 ph \x02 trans \x03 ex
function fieldStart(i, code) {
  const from = OFF[i]
  const end = OFF[i + 1] - 1
  const p = D.indexOf(String.fromCharCode(code), from)
  return (p === -1 || p >= end) ? end : p
}

// word 字段与 query（已小写化净化）比较：返回 -1/0/1，不做字符串分配
function cmpWord(q, i) {
  let a = OFF[i]
  const b = fieldStart(i, 1)
  let j = 0
  const qn = q.length
  while (a < b && j < qn) {
    const ca = D.charCodeAt(a)
    const cq = q.charCodeAt(j)
    // 字典全小写，直接比较
    if (ca !== cq) return ca < cq ? -1 : 1
    a++; j++
  }
  if (j === qn) return (a === b) ? 0 : 1   // q 是行词的前缀
  return -1                                // 行词是 q 的前缀
}

// 行词是否以 q（已净化小写）开头：非分配逐 char 判定
function startsWithPrefix(q, i) {
  let a = OFF[i]
  const b = fieldStart(i, 1)
  for (let j = 0; j < q.length; j++) {
    if (a >= b) return false         // 行词比 q 短
    if (D.charCodeAt(a) !== q.charCodeAt(j)) return false
    a++
  }
  return true
}

export function wordAt(i) {
  return D.slice(OFF[i], fieldStart(i, 1))
}

export function entryAt(i) {
  const s1 = fieldStart(i, 1)
  const s2 = fieldStart(i, 2)
  const s3 = fieldStart(i, 3)
  const end = OFF[i + 1] - 1
  return {
    word: D.slice(OFF[i], s1),
    ph: D.slice(s1 + 1, s2),
    trans: D.slice(s2 + 1, s3),
    ex: D.slice(s3 + 1, end)
  }
}

// ---------- 英文查询 ----------
// 净化输入：小写、仅 a-z
export function normEn(q) {
  return String(q || '').toLowerCase().replace(/[^a-z]/g, '')
}

// 第一个 cmpWord(q, i) <= 0 的行号；不存在返回 N
function lowerBound(q) {
  let lo = 0, hi = N
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cmpWord(q, mid) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function findExact(q) {
  ensure()
  if (!q) return -1
  const i = lowerBound(q)
  return (i < N && cmpWord(q, i) === 0) ? i : -1
}

// 前缀扩散搜索：ap → apple/apply/apart…（字典序连续段，逐行验证前缀 stem）
export function prefixQuery(q, cap) {
  ensure()
  const out = []
  if (!q) return out
  const max = cap || 24
  let i = lowerBound(q)
  while (i < N && out.length < max && startsWithPrefix(q, i)) {
    out.push(i)
    i++
  }
  return out
}

// 键盘英文联动候选：出词列表（不含输入本身），供 candidate row
export function suggestEn(q, cap) {
  const idx = prefixQuery(normEn(q), (cap || 12) + 1)
  const out = []
  const ql = String(q || '').toLowerCase()
  for (let k = 0; k < idx.length && out.length < (cap || 12); k++) {
    const w = wordAt(idx[k])
    if (w === ql) continue
    out.push(w)
  }
  return out
}

// ---------- 中文反查 ----------
// 释义字段（第 3 段，S2 与 S3 之间）中含 q 的词条
export function zhQuery(q, cap) {
  ensure()
  const out = []
  if (!q) return out
  const max = cap || 60
  const lit = String(q)
  let pos = 0
  const seenLo = [0] // OFF 单调，无需 Set，保持线性
  while (out.length < max) {
    const p = D.indexOf(lit, pos)
    if (p === -1) break
    pos = p + 1
    // 回卷找行首
    const ls = D.lastIndexOf('\n', p - 1) + 1
    if (ls < seenLo[seenLo.length - 1]) continue // 同行重复命中，跳过
    // 命中须在释义段：行首到 p 之间恰有 2 个分隔符（\x01、\x02）
    let seps = 0, ok = true
    for (let a = ls; a < p; a++) {
      const c = D.charCodeAt(a)
      if (c === 10) { ok = false; break } // lp 越过行尾（防御）
      if (c === 1 || c === 2 || c === 3) seps++
    }
    if (!ok || seps !== 2) continue
    // ls → 行号：OFF 单调递增，二分定位
    let lo = 0, hi = N - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (OFF[mid] <= ls) lo = mid
      else hi = mid - 1
    }
    seenLo.push(ls)
    out.push(lo)
  }
  return out
}

// ---------- 查询调度：统一入口 ----------
// 返回 { kind: 'en'|'zh'|'none', exact: -1|idx, rows: [idx...] }
export function search(raw, cap) {
  const q = String(raw || '').trim()
  if (!q) return { kind: 'none', exact: -1, rows: [] }
  if (/[一-鿿]/.test(q)) {
    return { kind: 'zh', exact: -1, rows: zhQuery(q, cap || 60) }
  }
  const w = normEn(q)
  if (!w) return { kind: 'none', exact: -1, rows: [] }
  const exact = findExact(w)
  const rows = prefixQuery(w, cap || 24)
  return { kind: 'en', exact, rows }
}
