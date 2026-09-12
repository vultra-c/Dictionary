/**
 * 词典 · 冒烟测试 v2（Node 直跑：node tests/smoke.mjs）
 *
 * v2 差异：引擎已改为「包内数据文件 + 注入式 readRange 小窗随机读取」。
 * 本测试用 Node fs 切片实现同一 readRange 接口（忠实复现窗口逻辑），
 * 断言文件引擎行为与词表数据一致性。
 *
 * 覆盖：
 *   - 数据装载与索引（smp 头、词条数、字典序抽样）
 *   - 英文精确查询（apple/go/run）与字段完整性（音标/释义/变形标记）
 *   - 前缀扩散搜索（ap → 命中 apple）与英文候选联动（suggestEn）
 *   - 中文反查（"苹果" → 命中 apple）
 *   - 变形标记解析（parseExchange）与词形还原（went → =go:p；run 常规组）
 *   - 派生词规则（候选生成 + entriesFor 批量验证：create↔creation、use↔useful）
 *   - 统一查询调度 search（kind 识别）与异常输入不崩
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const DATA_DIR = path.resolve(new URL('../src/common/data/', import.meta.url).pathname)

// ---- 注入式 readRange：与设备端 dictfile.makeReader 同语义（pos/len 切片） ----
const fileCache = new Map()
function nodeRange(uri, pos, len, cb) {
  try {
    const file = path.join(DATA_DIR, path.basename(uri))
    if (!fileCache.has(file)) fileCache.set(file, fs.readFileSync(file))
    const buf = fileCache.get(file)
    const p = Math.max(0, pos)
    cb(new Uint8Array(buf.subarray(p, Math.min(buf.length, p + len))))
  } catch (e) {
    cb(null)
  }
}

const dict = await import('../src/common/logic/dict.js')
const forms = await import('../src/common/logic/forms.js')
const {
  init, ready, search, findExact, prefixQuery, suggestEn, entriesFor,
  count, normEn
} = dict
const { parseExchange, roleLabel, forwardDerive, reverseStem } = forms

// 回调 API 的 Promise 包装（顺序断言，全异步执行）
const pFindExact = (w) => new Promise((r) => findExact(w, r))
const pPrefix = (q, cap) => new Promise((r) => prefixQuery(q, cap, r))
const pSuggest = (q, cap) => new Promise((r) => suggestEn(q, cap, r))
const pSearch = (q, cap) => new Promise((r) => search(q, cap, r))
const pEntriesFor = (ws) => new Promise((r) => entriesFor(ws, r))
const pCount = () => new Promise((r) => count(r))

let passed = 0
function ok(cond, msg) {
  assert(cond, msg)
  passed++
  console.log('  ✓', msg)
}

init(nodeRange)
await new Promise((r, j) => ready((success) => success ? r() : j(new Error('引擎初始化失败（smp 装载 broken）'))))

console.log('[smoke] 数据与索引')
const N = await pCount()
ok(N > 60000, '词条数 > 6 万（smp 头读取，实得 ' + N + '）')
const datLen = fs.statSync(path.join(DATA_DIR, 'dict.dat')).size
ok(datLen > 1048576, 'dict.dat 负载非空且 > 1MB（' + (datLen / 1048576).toFixed(2) + 'MB）')
const smpLen = fs.statSync(path.join(DATA_DIR, 'dict.smp')).size
ok(smpLen < 256 * 1024, 'dict.smp 索引轻量驻留（' + (smpLen / 1024).toFixed(1) + 'KB < 256KB）')

// 字典序抽查（直接读 dict.dat 抽样验证排序前提；引擎二分依赖该性质）
{
  const txt = fs.readFileSync(path.join(DATA_DIR, 'dict.dat'), 'utf8')
  const lines = txt.split('\n')
  const mid = lines.length >> 1
  const lw = lines[mid - 1].split('\x01')[0]
  const rw = lines[mid].split('\x01')[0]
  ok(lw < rw, '抽查字典序: ' + lw + ' < ' + rw)
  ok(lines[0].split('\x01')[0] < lines[lines.length - 2].split('\x01')[0], '词条首尾字典序成立')
}

console.log('[smoke] 英文精确查询与字段完整性')
{
  const apple = await pFindExact('apple')
  ok(!!apple, 'apple 词条存在')
  ok(apple.word === 'apple', 'apple.word')
  ok(apple.ph === 'æpl', 'apple 音标 æpl（实测: ' + apple.ph + '）')
  ok(apple.trans.indexOf('苹果') >= 0, 'apple 释义含苹果')
  ok(apple.ex.indexOf('s:apples') === 0, 'apple 变形标记 s:apples')

  const goEntry = await pFindExact('go')
  ok(goEntry.ex.indexOf('p:went') >= 0, 'go 变形含 p:went')
  ok(goEntry.ex.indexOf('d:gone') >= 0, 'go 变形含 d:gone')
  ok(goEntry.ex.indexOf('i:going') >= 0, 'go 变形含 i:going')
  ok(goEntry.ex.indexOf('3:goes') >= 0, 'go 变形含 3:goes')

  const runEntry = await pFindExact('run')
  ok(!runEntry.ex.startsWith('='), 'run 不含自指反查标记')
  ok(runEntry.ex.indexOf('p:ran') >= 0, 'run 变形含 p:ran')

  const none = await pFindExact('no-such-word-zz')
  ok(none === null, '不存在词条返回 null')
}

console.log('[smoke] 前缀扩散搜索（ap → …，appl → apple）')
{
  const rows = await pPrefix('ap', 24)
  ok(rows.length > 5, "'ap' 前缀命中若干 (>5)，实得 " + rows.length)
  const words = rows.map((e) => e.word)
  ok(words.every((w) => w.indexOf('ap') === 0), "'ap' 扩散结果全部以 ap 开头（首: " + words[0] + ' 末: ' + words[words.length - 1] + '）')
  let sorted = true
  for (let k = 1; k < words.length; k++) if (words[k] < words[k - 1]) sorted = false
  ok(sorted, "'ap' 扩散结果字典序递增")

  const appl = (await pPrefix('appl', 24)).map((e) => e.word)
  ok(appl.every((w) => w.indexOf('appl') === 0), "'appl' 扩散全部以 appl 开头（首: " + appl[0] + '）')
  ok(appl.indexOf('apple') >= 0, "'appl' 扩散含 apple")
  ok(appl.indexOf('apply') >= 0 || appl.indexOf('apples') >= 0, "'appl' 扩散含 apply/apples")

  const sug = await pSuggest('appl', 12)
  ok(sug.length >= 2 && sug.indexOf('apple') >= 0, "suggestEn('appl') 含 apple")
  ok(sug.indexOf('appl') < 0, 'suggestEn 不含输入本身')
}

console.log('[smoke] 中文反查（苹果 → apple）')
{
  const rows = await pSearch('苹果', 60)
  ok(rows.kind === 'zh' && rows.rows.length >= 1, "'苹果' 反查至少命中 1 个词条（实得 " + rows.rows.length + '）')
  const words = rows.rows.map((e) => e.word)
  ok(words.indexOf('apple') >= 0, "'苹果' 反查含 apple（命中: " + words.slice(0, 8).join(', ') + ')')
}

console.log('[smoke] 变形标记解析与词形还原')
{
  const went = await pFindExact('went')
  ok(!!went && went.ex[0] === '=', 'went 为纯反查词条 (=go:p)')
  const ex = parseExchange(went.ex)
  ok(ex.lemma === 'go' && ex.role === 'p', 'went 反指词根 go，角色过去式')
  ok(roleLabel('p') === '过去式', "roleLabel('p') = 过去式")
  const lemma = await pFindExact(ex.lemma)
  ok(!!lemma, 'went 词根 go 在词典中可查')

  const goEx = parseExchange((await pFindExact('go')).ex)
  ok(!goEx.lemma, 'go 非反查词条')
  const kv = {}
  for (const f of goEx.forms) kv[f.k] = f.v
  ok(kv.p === 'went' && kv.d === 'gone' && kv.i === 'going' && kv['3'] === 'goes',
    'go 四态齐全: went/gone/going/goes')
  ok(goEx.forms.every((f) => f.label), '每个变形均带中文标签')
}

console.log('[smoke] 派生词规则（候选生成 + entriesFor 批量验证）')
{
  // 正查：候选生成 → 批量验证过滤（等效旧版 exists 逐一验证语义）
  const createCands = forwardDerive('create').map((d) => d.word)
  const createMap = await pEntriesFor(createCands)
  const createOk = createCands.filter((w) => createMap[w])
  ok(createOk.indexOf('creation') >= 0, 'create 派生含 creation（得: ' + createOk.slice(0, 9).join(',') + ')')
  ok(createOk.indexOf('creative') >= 0 || createOk.indexOf('creator') >= 0, 'create 派生含 creative/creator')

  const useCands = forwardDerive('use').map((d) => d.word)
  const useMap = await pEntriesFor(useCands)
  ok(useCands.some((w) => w === 'useful' && useMap[w]), 'use 派生含 useful')

  // 反查：同批验证（creation → create；useful → use；window 零误报由过滤保证）
  const crStems = reverseStem('creation')
  const crMap = await pEntriesFor(crStems.map((s) => s.stem))
  const crOk = crStems.filter((s) => crMap[s.stem])
  ok(crOk.some((s) => s.stem === 'create' && (s.suffix === 'ion' || s.suffix === 'ation' || s.suffix === 'tion')),
    'creation 词干还原含 create（得: ' + JSON.stringify(crOk.slice(0, 4)) + ')')

  const uStems = reverseStem('useful')
  const uMap = await pEntriesFor(uStems.map((s) => s.stem))
  ok(uStems.some((s) => s.stem === 'use' && uMap[s.stem]), 'useful 词干还原含 use')

  const winStems = reverseStem('window')
  const winMap = await pEntriesFor(winStems.map((s) => s.stem))
  ok(winStems.every((s) => !winMap[s.stem]), 'window 无词根候选经词典验证后全排除（零误报）')
}

console.log('[smoke] 统一查询调度与异常输入')
{
  const r1 = await pSearch('ap')
  ok(r1.kind === 'en' && r1.rows.length > 0, "search('ap') → en 且命中")
  const r2 = await pSearch('苹果')
  ok(r2.kind === 'zh' && r2.rows.length > 0, "search('苹果') → zh 且命中")
  ok((await pSearch('')).kind === 'none', "search('') → none")
  ok((await pSearch('!!!')).kind === 'none', "search('!!!') → none")
  const long = 'q'.repeat(40)
  const rq = await pSearch(long)
  ok(rq.kind === 'en' && rq.rows.length === 0, '超长输入不崩且无假命中')
  ok(normEn("Workers' Day") === 'workersday', "normEn 净化: Workers' Day → workersday")
  ok((await pFindExact('no-such-word-zz')) === null, '不存在词条返回 null')
}

console.log('[smoke] entriesFor 批量接口')
{
  const m = await pEntriesFor(['go', 'went', 'no-such-word-zz', 'Apple'])
  ok(m.go && m.go.word === 'go', 'entriesFor 命中 go')
  ok(m.went && m.went.ex[0] === '=', 'entriesFor 命中 went 反查词条')
  ok(m['nosuchwordzz'] === null, "entriesFor 未收录词为 null（'no-such-word-zz' 归一后也无命中）")
  ok(m.apple && m.apple.trans.indexOf('苹果') >= 0, "entriesFor 大小写归一('Apple' → apple)")
}

console.log('')
console.log('[smoke] 全部断言通过 (' + passed + ')')
