/**
 * 词典数据生成器：ECDICT ecdict.csv → src/common/data/{dict.dat,dict.smp,zh.dat}
 *
 * 数据源（不入库，65MB 太大）：
 *   tools/ecdict.csv  ←  https://github.com/skywind3000/ECDICT/raw/master/ecdict.csv
 *
 * 运行：node tools/gen-dict.mjs [ecdict.csv 路径]
 *
 * 产物三件套（v2 文件引擎，v1 的单字符串 dict.js 已废弃，手环 JS 堆放不下）：
 *   dict.dat：行 word \x01 音标 \x02 中文释义(≤56字，≤2义项) \x03 变形标记 + '\n'，字典序 UTF-8；
 *   dict.smp：二分抽样索引（详见 tools/lib/dict-pack.mjs）；
 *   zh.dat   ：行 word \x02 释义，中文反查顺序扫描语料。
 * 变形标记两套编码：
 *   - 词根条目：k:v 逗号串，k∈{p 过去式,d 过去分词,i 现在分词,3 三单,s 复数,r 比较级,t 最高级}
 *   - 变形词条目：=词根:角色（如 went → =go:p，反向查询走这里）
 */
import fs from 'node:fs'
import { emitDictFiles } from './lib/dict-pack.mjs'

const SRC = process.argv[2] || new URL('./ecdict.csv', import.meta.url).pathname
const OUT_DIR = new URL('../src/common/data/', import.meta.url).pathname
// 「每一字节都要付利息」：CAP 决定词条规模上限，实测（见 README）~3.5 万主词条 + ~2.6 万反查词条
// 成品 rpk 约 3.4MB（含输入法与图片），距 7MB 红线富余量用于将来加常见短语。
const CAP = 35000

// ---------- CSV 全量解析（65MB 字符串一次性解析；引号内 "" 为转义） ----------
function parseCsv(text) {
  const rows = []
  let field = '', row = [], inQuote = false, started = false
  const n = text.length
  for (let i = 0; i < n; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue }
        inQuote = false; continue
      }
      field += c
      continue
    }
    if (c === '"') { inQuote = true; started = true; continue }
    if (c === ',') { row.push(field); field = ''; started = true; continue }
    if (c === '\n') {
      row.push(field); field = ''
      if (started) rows.push(row)
      row = []; started = false
      continue
    }
    if (c !== '\r') { field += c; started = true }
  }
  return rows
}

// ECDICT 字段内的换行是字面两字符 "\n"，先归一成真实换行
function flatText(t) { return t.indexOf('\\') >= 0 ? t.split('\\n').join('\n') : t }

function cleanTranslation(t) {
  if (!t) return ''
  const lines = flatText(t).split('\n')
  const keep = []
  let hasGeneral = false
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (!s || s.startsWith('[网络]')) continue
    if (!s.startsWith('[')) hasGeneral = true
    keep.push(s)
    if (keep.length >= 2) break
  }
  if (!keep.length) return ''
  // 已有通用义项时，专职领域义（[医]/[药]/[化]…）是噪音
  const filtered = (hasGeneral ? keep.filter(s => !s.startsWith('[')) : keep).slice(0, 2)
  if (!filtered.length) filtered.push(keep[0])
  let out = filtered.join('；')
  if (out.length > 56) {
    out = out.slice(0, 56)
    const cut = out.lastIndexOf('；')
    if (cut > 20) out = out.slice(0, cut)
  }
  // 剔除分隔符残留（防御）
  return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim()
}

const FORM_KEYS = { p: 1, d: 1, i: 1, 3: 1, s: 1, r: 1, t: 1 }
// 纯变形类释义（如 "go的过去式"）运行时用变形标记结构化重建，词条里不重复存储
const TRIVIAL_RE = /^[a-z]+的(过去式|过去分词|现在分词|第三人称单数|复数|比较级|最高级)([，,、；;].*)?$/
// 同字自指（如 run 条目 d:run 标成 lemma=run）是无效 lemma，回退为普通变形列表
function normExchange(ex, word) {
  if (ex.lemma && ex.lemma === word) { ex.lemma = ''; ex.role = '' }
  return ex
}
function normalizeTrans(trans, ex) {
  if (ex.lemma && TRIVIAL_RE.test(trans)) return ''
  return trans
}

function parseExchange(ex) {
  if (!ex) return { forms: [], lemma: '', role: '' }
  const parts = ex.split(/[,/]/).map(s => s.trim()).filter(Boolean)
  const forms = []
  let lemma = '', role = ''
  for (const seg of parts) {
    const k = seg[0]
    let v = seg[1] === ':' ? seg.slice(2) : seg.slice(1)
    v = v.trim().toLowerCase()
    if (k === '0') { lemma = v; continue }
    if (k === '1') { role = v; continue }
    if (FORM_KEYS[k] && /^[a-z]+$/.test(v)) forms.push(k + ':' + v)
  }
  return { forms, lemma, role }
}

console.log('读取源文件:', SRC)
console.time('parse')
const rows = parseCsv(fs.readFileSync(SRC, 'utf8'))
console.timeEnd('parse')
console.log('CSV 总行数:', rows.length)

const picked = []
let skippedName = 0
for (const row of rows) {
  if (row.length < 11 || row[0] === 'word') continue
  const word = row[0]
  if (!/^[a-z]+$/.test(word)) continue        // 纯小写字母（JW* 之类专卖/大写专名舍弃）
  if (word.length < 2 || word.length > 18) continue
  const collins = +row[5] || 0
  const oxford = +row[6] || 0
  const tag = row[7] || ''
  const bnc = +row[8] || 0
  const frq = +row[9] || 0
  if (!(oxford > 0 || collins > 0 || tag || (frq > 0 && frq <= 45000) || (bnc > 0 && bnc <= 30000))) continue
  const trans = cleanTranslation(row[3])
  if (!trans) continue
  // 仅人名/地名且无任何质量信号 → 跳过
  if (/^\[(人名|地名)|\]/.test(trans) && !collins && !oxford && !tag) { skippedName++; continue }
  const ex = normExchange(parseExchange(row[10]), word)
  const rank = Math.min(frq > 0 ? frq : 9e9, bnc > 0 ? bnc : 9e9)
  const ph0 = (row[1] || '').replace(/["'」]|^['"]|['"]$/g, '').trim().slice(0, 22)
  const ph = ph0.toLowerCase().replace(/[^a-z]/g, '') === word ? '' : ph0
  picked.push({ w: word, ph, tr: normalizeTrans(trans, ex), ex, rank, sig: collins * 100 + (oxford ? 60 : 0) + (tag ? 10 : 0) })
}
console.log('过滤后候选:', picked.length, '(剔除纯人名/地名:', skippedName + ')')

// 同词如有多个 rank 不应出现（ECDICT 按词唯一）；直接按质量排序截断
picked.sort((a, b) => a.rank - b.rank || b.sig - a.sig || (a.w < b.w ? -1 : 1))
const uniq = picked.slice(0, CAP)
console.log('择优截断:', uniq.length)

// —— 少一拨补录：变形反查词条（如 went → =go:p）——
// ECDICT 中真变形词条目常无词频信号被上面的过滤漏掉，但它们正是反向查询的车票。
// 规则：有 lemma 回指 + 有释义 + 词根在保留集内才补录。
const keptSet = new Set(uniq.map(e => e.w))
const extra = []
for (const row of rows) {
  if (row.length < 11 || row[0] === 'word') continue
  const word = row[0]
  if (!/^[a-z]+$/.test(word) || word.length < 2 || word.length > 18) continue
  if (keptSet.has(word)) continue
  const ex = normExchange(parseExchange(row[10]), word)
  if (!ex.lemma || !keptSet.has(ex.lemma)) continue
  const trans = cleanTranslation(row[3])
  const ph0 = (row[1] || '').replace(/["'"]|^['"]|['"]$/g, '').trim().slice(0, 22)
  const ph = ph0.toLowerCase().replace(/[^a-z]/g, '') === word ? '' : ph0
  extra.push({ w: word, ph, tr: normalizeTrans(trans, ex), ex })
}
for (const e of extra) uniq.push(e)
console.log('变形反查补录:', extra.length)

uniq.sort((a, b) => (a.w < b.w ? -1 : a.w > b.w ? 1 : 0))
const entries = []
for (const e of uniq) {
  let exStr = ''
  if (e.ex.lemma) exStr = '=' + e.ex.lemma + ':' + (e.ex.role || '')
  else if (e.ex.forms.length) exStr = e.ex.forms.slice(0, 6).join(',')
  entries.push({ w: e.w, ph: e.ph, tr: e.tr, exStr })
}
const stats = emitDictFiles(entries, OUT_DIR)
const formsCnt = uniq.filter(e => !e.ex.lemma && e.ex.forms.length).length
const lemmaCnt = uniq.filter(e => e.ex.lemma).length
console.log('含变形词条:', formsCnt, '反向词条:', lemmaCnt)
console.log('产出:', OUT_DIR, 'dict.dat ' + stats.dictMB + 'MB + zh.dat ' + stats.zhMB + 'MB + dict.smp ' + stats.smpKB + 'KB',
  '（样本', stats.sampleCount, '，词条', stats.entryCount, '，中文语料', stats.zhCount, '）')
