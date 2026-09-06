/**
 * 词形与派生规则（纯 JS，不依赖 @system.*）
 *
 * 变形标记（词条 ex 字段）两套编码：
 *   "=go:p"      —— 反向词条：went 是 go 的过去式（FROM_LEMMA）
 *   "p:ran,…"    —— 词根条目：常规变形 k:v 列表
 * 除此之外本模块提供派生词规则引擎：
 *   forwardDerive —— 规则生成候选派生词，逐一回査字典验证（如 create → creation/creative/creator）；
 *   reverseStem  —— 搜索未命中或派生词反查时，按后缀剥离+词干恢复规则猜词根
 *                  （如 creation → create，useful → use）。
 * 规则引擎不维护词表：候选一律经字典存在性验证后才出现，零误报、零存储成本。
 */

export const FORM_LABELS = {
  p: '过去式', d: '过去分词', i: '现在分词', 3: '三单',
  s: '复数', r: '比较级', t: '最高级'
}

// 解析 ex 字段 → { lemma, role, forms:[{k,label,v}] }
export function parseExchange(ex) {
  if (!ex) return { lemma: '', role: '', forms: [] }
  if (ex[0] === '=') {
    const cut = ex.indexOf(':')
    return {
      lemma: cut > 0 ? ex.slice(1, cut) : ex.slice(1),
      role: cut > 0 ? ex.slice(cut + 1) : '',
      forms: []
    }
  }
  const forms = []
  const parts = ex.split(',')
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    const k = seg[0]
    const v = seg.slice(2)
    if (FORM_LABELS[k] && v) forms.push({ k, label: FORM_LABELS[k], v })
  }
  return { lemma: '', role: '', forms }
}

export function roleLabel(roleK) {
  return FORM_LABELS[roleK] || ''
}

// ---------- 派生规则 ----------
// [后缀, 词干恢复变换集(反查用), 词干还原说明]
// 变换按序尝试，字典验证通过即收。
const SUFFIXES = [
  // ion 必列：create→creation（e→空转换）是最高频派生型
  ['ion', ['', 'e', 'te']],
  ['ation', ['', 'e']],
  ['ition', ['', 'e']],
  ['tion', ['', 'e', 'te']],
  ['sion', ['', 't', 'de']],
  ['ment', ['']],
  ['ness', ['', 'i>y']],
  ['ity', ['', 'e', 'i>y']],
  ['able', ['', 'e']],
  ['ible', ['']],
  ['ous', ['', 'e']],
  ['ive', ['', 'e', 'f']],
  ['ful', ['', 'e']],
  ['less', ['']],
  ['ly', ['', 'e', 'i>y']],
  ['er', ['', 'undouble']],
  ['or', ['', 'e']],
  ['ist', ['', 'e', 'y']],
  ['ism', ['', 'e']],
  ['ic', ['', 'e']],
  ['ical', ['']],
  ['al', ['', 'e']],
  ['ish', ['']],
  ['ize', ['', 'e']],
  ['ise', ['', 'ze']],
  ['ify', ['']],
  ['en', ['', 'undouble']],
  ['ship', ['']],
  ['age', ['', 'e']],
  ['ure', ['', 'e']],
  ['ance', ['']],
  ['ence', ['']],
  ['ary', ['', 'ate']],
  ['ory', ['']],
  ['th', ['', 'e']]
]

// 词干尾字母双写还原（run+er: "runn" → "run"）
function undouble(stem) {
  if (stem.length < 2) return ''
  const a = stem[stem.length - 1]
  const b = stem[stem.length - 2]
  return (a === b && 'bcdfgklmnprstz'.indexOf(a) >= 0) ? stem.slice(0, -1) : ''
}

// 反查规则变换："i>y" 表示 stem 以 i 结尾 → 换 y（happi → happy）
function applyTransform(stem, tf) {
  if (!stem) return ''
  if (tf === '') return stem
  if (tf === 'undouble') return undouble(stem)
  if (tf === 'i>y') return stem[stem.length - 1] === 'i' ? stem.slice(0, -1) + 'y' : ''
  if (tf.length === 1) return stem + tf
  return ''
}

/**
 * 派生词反查：query 命中失败或查派生词根时使用。
 * 返回 [{suffix, stem, via}] via 为规则痕迹（'辅双'/'e补'等），字典验证由调用方提供。
 * exists(word) → 词在词典本条目中返回 true
 */
export function reverseStem(q, exists) {
  const out = []
  if (!q || q.length < 4) return out
  for (const [sfx, tfs] of SUFFIXES) {
    if (out.length >= 6) break
    if (!q.endsWith(sfx) || q.length <= sfx.length + 1) continue
    const stem0 = q.slice(0, q.length - sfx.length)
    const tried = {}
    for (const tf of tfs) {
      const cand = applyTransform(stem0, tf)
      // 无变换时也防重（stem 本身）
      const cands = []
      if (cand) cands.push(cand)
      if (tf === '' && stem0) cands.push(stem0)
      for (const c of cands) {
        if (!c || tried[c]) continue
        tried[c] = true
        if (exists(c)) { out.push({ suffix: sfx, stem: c }); break }
      }
      if (out.length && out[out.length - 1].suffix === sfx) break
    }
  }
  return out
}

/**
 * 派生词正查：对词 word 规则生成候选，exists 过滤。
 * 后缀集与 SUFFIXES 一致；base 变换集 = {word, dropE, y→i, 双写辅音}。
 * 返回 [{word: cand, suffix}]
 */
export function forwardDerive(word, exists) {
  const out = []
  if (!word || word.length < 2) return out
  const bases = [word]
  if (word.endsWith('e') && word.length > 2) bases.push(word.slice(0, -1))
  if (word.endsWith('y') && word.length > 2) bases.push(word.slice(0, -1) + 'i')
  const last = word[word.length - 1]
  if ('bcdfgklmnprstz'.indexOf(last) >= 0 && word.length >= 3
    && 'aeiou'.indexOf(word[word.length - 2]) >= 0
    && 'aeiou'.indexOf(word[word.length - 3]) < 0) {
    bases.push(word + last) // 单音节结尾重读双写：big → bigger（走 er 已在常规变形，此路径者派生 biggish 等）
  }
  const seen = { }
  seen[word] = true
  for (const [sfx] of SUFFIXES) {
    for (const b of bases) {
      const cand = b + sfx
      if (seen[cand]) continue
      if (exists(cand)) { seen[cand] = true; out.push({ word: cand, suffix: sfx }) }
    }
    if (out.length >= 12) break
  }
  return out
}
