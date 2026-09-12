/**
 * 词典运行时引擎 v2 —— 包内数据文件 + 小窗口随机读取（手表堆内存专版）
 *
 * 为什么不再是单字符串模块：
 *   手环 JS 堆极小，5.9MB 的 dict.js 数据模块加载即 OOM，依赖它的页面全崩。
 *   现改为包内资产文件（dict.dat / dict.smp / zh.dat），运行时用注入式 readRange
 *   按 2~66KB 小窗口随机/顺序读取，常驻内存 ≈ 抽样索引(~27KB) + 少量桶缓存(~20KB)。
 *
 * 纯逻辑约束：本模块不 import @system.*（页面/封装层注入 readRange，Node 可测）。
 *   readRange(uri, pos, length, cb(buf|null)) —— buf 为 Uint8Array。
 *
 * 查询路径（全部为回调异步，风格对齐 @system.*）：
 *   - 英文精确/前缀：smp 抽样索引在 RAM 二分定位「桶」→ 读 ≤2KB 桶窗 → 逐行扫；
 *   - 中文反查：zh.dat 顺序 64KB 窗口扫描（owned 区间判属 + word 去重），
 *     输入变化自动废弃旧扫描（全局 seq 舵标）。
 *
 * 数据格式（tools/lib/dict-pack.mjs 生成，勿手改产物）：
 *   dict.dat：word \x01 音标 \x02 释义 \x03 变形标记 + '\n'，按字典序排序，UTF-8；
 *   dict.smp：32B 头('DSMP'|ver|samples|entries|dictLen|zhLen|保留) + 每样本 8B
 *             [word 前6字母 packed u32 | 行首字节偏移 u32] 小端，桶跨度 ≤ ~1.7KB；
 *   zh.dat：word \x02 释义 + '\n'（仅释义非空词条）。
 */

const URI_DAT = '/common/data/dict.dat'
const URI_SMP = '/common/data/dict.smp'
const URI_ZH = '/common/data/zh.dat'

// 中文扫描窗口：owned 64KB 步进，左/右各放宽 720B（> 最大行长 640B，
// 保证行首落在 owned 内的行在 decode 缓冲中始终完整）
const ZH_STEP = 64 * 1024
const ZH_OVER = 720
const ZH_MAXLINE = 640
const ZH_CAP_DEF = 60

// ---------- 模块状态 ----------
let READ = null        // readRange 注入
let st = 'idle'        // idle | loading | ready | broken
let readyQ = []
let SMP_KEYS = null    // Uint32Array
let SMP_OFFS = null    // Uint32Array
let SAMPLE_N = 0
let ENTRY_N = 0
let DICT_LEN = 0
let ZH_LEN = 0
let querySeq = 0       // 中文扫描/查询废弃舵标

// 桶窗 LRU 缓存（击键连续命相邻桶，二次命中零 I/O）
const bucketCache = new Map()
const BUCKET_CACHE_MAX = 6

function cacheGet(i) {
  const v = bucketCache.get(i)
  if (v !== undefined) { bucketCache.delete(i); bucketCache.set(i, v) }
  return v
}
function cachePut(i, v) {
  bucketCache.set(i, v)
  if (bucketCache.size > BUCKET_CACHE_MAX) {
    const first = bucketCache.keys().next()
    bucketCache.delete(first.value)
  }
}

// ---------- 初始化（注入 + 预热 smp）----------
export function init(reader) {
  if (READ) return
  READ = reader
}

// 预热并开始装载抽样索引；幂等。cb 在 ready（或失败兜底为 ready 态但 broken 标记）后触发。
export function ready(cb) {
  if (cb) readyQ.push(cb)
  if (st === 'ready') { flushQ(); return }
  if (st === 'broken') { flushQ(); return }
  if (st === 'loading') return
  if (!READ) { st = 'broken'; flushQ(); return }
  st = 'loading'
  readPrefix()
}

function flushQ() {
  const q = readyQ
  readyQ = []
  for (let i = 0; i < q.length; i++) { try { q[i](st === 'ready') } catch (e) { /* 页面回调异常隔离 */ } }
}

// 一键接线 + 预热（页面只调这个）
export function warmup(reader) {
  init(reader)
  ready(null)
}

export function isReady() { return st === 'ready' }
export function isBroken() { return st === 'broken' }

function readPrefix() {
  READ(URI_SMP, 0, 32, (head) => {
    if (!head || head.length < 32 || sigOk(head) !== 1) return broke()
    const m1 = u32(head, 8), m2 = u32(head, 12), m3 = u32(head, 16), m4 = u32(head, 20)
    // 合理域守卫（文件被错误打包/截断时直接 broken，绝不崩）
    if (m1 <= 0 || m1 > 20000 || m2 <= 0 || m2 > 1000000 || m3 <= 0 || m4 <= 0) return broke()
    SAMPLE_N = m1; ENTRY_N = m2; DICT_LEN = m3; ZH_LEN = m4
    if (DICT_LEN > 32 * 1048576 || ZH_LEN > 32 * 1048576) return broke()
    READ(URI_SMP, 32, SAMPLE_N * 8, (body) => {
      if (!body || body.length < SAMPLE_N * 8) return broke()
      SMP_KEYS = new Uint32Array(SAMPLE_N)
      SMP_OFFS = new Uint32Array(SAMPLE_N)
      for (let i = 0; i < SAMPLE_N; i++) {
        SMP_KEYS[i] = u32(body, i * 8)
        SMP_OFFS[i] = u32(body, i * 8 + 4)
      }
      // 偏移单调性抽查（损坏文件直接 broken）
      if (SMP_OFFS[0] !== 0 || SMP_OFFS[SAMPLE_N - 1] >= DICT_LEN) return broke()
      st = 'ready'
      flushQ()
    })
  })
}

function sigOk(b) {
  return (b[0] === 68 && b[1] === 83 && b[2] === 77 && b[3] === 80) ? 1 : 0 // 'DSMP'
}
function broke() {
  st = 'broken'
  flushQ()
}

function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

// ---------- 手算 UTF-8 解码 ----------
// Vela 运行时 TextDecoder 可用性无文档保障，自行解码（窗口 ≤66KB，逐字节足够快）。
// 无法确认的多字节序列 → U+FFFD；分隔符 \x01/\x02/\x03/\n 均为单字节 ASCII，
// 不会与多字节序列（延续字节 ≥0x80）混淆，窗口边界切割对行解析安全。
function decodeU8(buf, from, to) {
  const chars = []
  let i = from
  while (i < to) {
    const b0 = buf[i]
    if (b0 < 128) { chars.push(b0); i++; continue }
    let n = 0, cp = 0
    if (b0 >= 194 && b0 <= 223) { n = 1; cp = b0 & 31 }
    else if (b0 >= 224 && b0 <= 239) { n = 2; cp = b0 & 15 }
    else if (b0 >= 240 && b0 <= 244) { n = 3; cp = b0 & 7 }
    else { chars.push(65533); i++; continue }
    let ok = true
    for (let k = 1; k <= n; k++) {
      if (i + k >= to) { ok = false; break }
      const bk = buf[i + k]
      if (bk < 128 || bk > 191) { ok = false; break }
      cp = (cp << 6) | (bk & 63)
    }
    if (!ok) { chars.push(65533); i++; continue }
    if (cp < 65536) { chars.push(cp) } else {
      cp -= 65536
      chars.push(55296 + (cp >> 10), 56320 + (cp & 1023))
    }
    i += n + 1
  }
  // 分块展开：受限 JSC 对 apply 实参数目有上限（~65535），66KB 窗口一次性 apply 可能越限
  let out = ''
  for (let i = 0; i < chars.length; i += 8192) {
    out += String.fromCharCode.apply(null, chars.slice(i, i + 8192))
  }
  return out
}

// 整窗解码（String.fromCharCode 单次展开上限内：≤66KB 安全）
function decodeWhole(buf) {
  return decodeU8(buf, 0, buf.length)
}

// word 前 6 字母 → packed key（与 tools/lib/dict-pack.mjs 一致，32 进制序）
function packKey6(q) {
  let key = 0
  for (let i = 0; i < 6; i++) {
    const c = i < q.length ? q.charCodeAt(i) : 0
    const v = c >= 97 && c <= 122 ? c - 96 : 0
    key = key * 32 + v
  }
  return key
}

// ---------- 桶定位与桶窗读取 ----------
// 最后一个 key ≤ packKey6(q) 的样本；没有则返回 -1（[0, SMP_OFFS[0]] 隐式首段）
function bucketOf(q) {
  const k = packKey6(q)
  let lo = 0, hi = SAMPLE_N - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (SMP_KEYS[mid] <= k) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

function bucketRange(i) {
  const start = i < 0 ? 0 : SMP_OFFS[i]
  const end = i + 1 >= SAMPLE_N ? DICT_LEN : SMP_OFFS[i + 1]
  return [start, end]
}

// 行解析：word \x01 ph \x02 trans \x03 ex
function parseLine(line) {
  const s1 = line.indexOf('\x01')
  const s2 = line.indexOf('\x02', s1 + 1)
  const s3 = line.indexOf('\x03', s2 + 1)
  return {
    word: line.slice(0, s1),
    ph: line.slice(s1 + 1, s2),
    trans: line.slice(s2 + 1, s3),
    ex: line.slice(s3 + 1)
  }
}

// 读取并缓存第 i 桶（i=-1 为首段），cb(entries[{word,ph,trans,ex}])
function readBucket(i, cb) {
  const cached = cacheGet(i)
  if (cached) { cb(cached); return }
  const [start, end] = bucketRange(i)
  if (end <= start) { cachePut(i, []); cb([]); return }
  READ(URI_DAT, start, end - start, (buf) => {
    if (buf === null) { cb(null); return } // I/O 失败不上缓存，可重试
    const text = decodeWhole(buf)
    const parts = text.split('\n')
    const entries = []
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k]
      if (!p) continue
      entries.push(parseLine(p))
    }
    cachePut(i, entries)
    cb(entries)
  })
}

// ---------- 英文查询 ----------
export function normEn(q) {
  return String(q || '').toLowerCase().replace(/[^a-z]/g, '')
}

function withReady(cb) {
  if (st === 'ready') { cb(true); return }
  if (st === 'broken') { cb(false); return }
  ready(function () { cb(st === 'ready') })
}

// 精确查询：cb(entry|null)
export function findExact(q, cb) {
  q = normEn(q)
  if (!q) { cb(null); return }
  withReady((ok) => {
    if (!ok) { cb(null); return }
    readBucket(bucketOf(q), (entries) => {
      cb(pickExact(entries, q))
    })
  })
}

function pickExact(entries, q) {
  if (!entries) return null
  for (let i = 0; i < entries.length; i++) {
    const w = entries[i].word
    if (w === q) return entries[i]
    if (w > q) break
  }
  return null
}

// 前缀扩散：cb(rows[])，从字首 ≥q 处收集 startsWith(q) 的连续段
export function prefixQuery(q, cap, cb) {
  q = normEn(q)
  const max = cap || 24
  if (!q) { cb([]); return }
  withReady((ok) => {
    if (!ok) { cb([]); return }
    const out = []
    const b0 = bucketOf(q)
    const step = (bi, depth) => {
      if (out.length >= max || depth > 8) { cb(out.slice(0, max)); return }
      if (bi > SAMPLE_N - 1) { cb(out); return } // 已无后续桶（末桶跨至文件尾）
      readBucket(bi, (entries) => {
        if (entries === null) { cb(out); return }
        let sawGe = false
        let done = false
        for (let i = 0; i < entries.length && out.length < max; i++) {
          const w = entries[i].word
          if (!sawGe) {
            if (w < q) continue
            sawGe = true
          }
          if (startsWithStr(w, q)) { out.push(entries[i]) }
          else { done = true; break } // 字典序越过后即离开前缀段
        }
        if (done || out.length >= max) { cb(out.slice(0, max)); return }
        step(bi + 1, depth + 1)
      })
    }
    step(b0, 0)
  })
}

// str.startsWith 兼容（部分老 JSC 无 String.prototype.startsWith）
function startsWithStr(s, p) {
  return s.length >= p.length && s.slice(0, p.length) === p
}

// 键盘英文联动候选（不含输入本身）
export function suggestEn(q, cap, cb) {
  prefixQuery(q, (cap || 12) + 1, (rows) => {
    const out = []
    const ql = String(q || '').toLowerCase()
    for (let i = 0; i < rows.length && out.length < (cap || 12); i++) {
      if (rows[i].word === ql) continue
      out.push(rows[i].word)
    }
    cb(out)
  })
}

// 批量取词（生词本/候选验证）：cb(map{word: entry|null})；同桶命中缓存，I/O 最少化
export function entriesFor(words, cb) {
  const map = {}
  const list = []
  const seen = {}
  for (let i = 0; i < words.length; i++) {
    const w = normEn(words[i])
    if (!w || seen[w]) continue
    seen[w] = true
    list.push(w)
  }
  let i = 0
  const next = () => {
    if (i >= list.length) { cb(map); return }
    const w = list[i++]
    findExact(w, (e) => { map[w] = e; next() })
  }
  next()
}

// ---------- 中文反查（zh.dat 顺序窗口扫描）----------
// 行：word \x02 trans；命中须在释义段（行首至命中间恰 1 个 \x02 分隔符）
export function zhQuery(q, cap, cb) {
  const lit = String(q || '')
  const max = cap || ZH_CAP_DEF
  if (!lit) { cb([]); return }
  const seq = querySeq
  withReady((ok) => {
    if (!ok) { cb([]); return }
    const rows = []
    const seenWords = {}
    let start = 0
    const scanWindow = () => {
      if (seq !== querySeq) return // 输入已更新，废弃本轮扫描
      if (rows.length >= max || start >= ZH_LEN) { cb(rows); return }
      const end = Math.min(ZH_LEN, start + ZH_STEP)
      const readStart = Math.max(0, start - ZH_OVER)
      const readEnd = Math.min(ZH_LEN, end + ZH_OVER)
      READ(URI_ZH, readStart, readEnd - readStart, (buf) => {
        if (seq !== querySeq) return
        if (buf === null) { cb(rows); return }
        const text = decodeWhole(buf)
        if (collectZhWindow(text, lit, readStart, start, end, rows, seenWords, max) < 0) {
          cb(rows); return
        }
        start = end
        scanWindow()
      })
    }
    scanWindow()
  })
}

// 在 decode 串中收集命中行；返回 0 正常，-1 防御中断
function collectZhWindow(text, lit, readStart, ownStart, ownEnd, rows, seenWords, max) {
  let pos = 0
  let guard = 0
  while (rows.length < max) {
    if (++guard > 4000) return -1
    const p = text.indexOf(lit, pos)
    if (p === -1) break
    pos = p + 1
    // 回卷找行首（decode 串内）。逼近缓冲左缘仍无 \n → 行不完整，跳过
    const ls = text.lastIndexOf('\n', Math.max(0, p - 1)) + 1
    if (p - ls > ZH_MAXLINE) continue
    // 全局行首偏移估值（±4B）；落在 owned 外的由相邻窗口负责（见 dedup 双保险）
    const g = ls + readStart
    if (g < ownStart - 4 || g >= ownEnd + 4) continue
    // 行尾
    let le = text.indexOf('\n', p)
    if (le === -1) le = text.length
    if (le - ls > ZH_MAXLINE + 8) continue
    const line = text.slice(ls, le)
    const s2 = line.indexOf('\x02')
    if (s2 <= 0) continue
    // 命中位置须落在释义段：word 之后
    if (p - ls < s2 + 1) continue
    // 段内不能再有第二分隔符（一行只有 word \x02 trans）
    if (line.indexOf('\x02', s2 + 1) >= 0) continue
    const word = line.slice(0, s2)
    if (seenWords[word]) continue
    seenWords[word] = true
    rows.push({ word, ph: '', trans: line.slice(s2 + 1), ex: '' })
  }
  return 0
}

// ---------- 查询调度：统一入口 ----------
// cb({ kind: 'en'|'zh'|'none', exact: boolean, rows: [{word,ph,trans,ex}] })
export function search(raw, cap, cb) {
  const q = String(raw || '').trim()
  const seq = ++querySeq
  if (!q) { cb({ kind: 'none', exact: false, rows: [] }); return }
  if (/[一-鿿]/.test(q)) {
    zhQuery(q, cap || ZH_CAP_DEF, (rows) => {
      if (seq !== querySeq) return
      cb({ kind: 'zh', exact: false, rows })
    })
    return
  }
  const w = normEn(q)
  if (!w) { cb({ kind: 'none', exact: false, rows: [] }); return }
  prefixQuery(w, cap || 60, (rows) => {
    if (seq !== querySeq) return
    const exact = rows.length > 0 && rows[0].word === w
    cb({ kind: 'en', exact, rows })
  })
}

// 词条总数（smp 头携带；未 ready 时回 0，兼容旧签名 cb 形式）
export function count(cb) {
  if (cb) { withReady((ok) => cb(ok ? ENTRY_N : 0)); return }
  return st === 'ready' ? ENTRY_N : 0
}
