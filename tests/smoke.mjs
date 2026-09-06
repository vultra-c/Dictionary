/**
 * 词典 · 冒烟测试（Node 直跑：node tests/smoke.mjs）
 *
 * 覆盖：
 *   - 数据装载与索引（词条数、字典序、行偏移一致性）
 *   - 英文精确查询（apple/go/run）与字段完整性（音标/释义/变形标记）
 *   - 前缀扩散搜索（ap → 命中 apple）
 *   - 英文候选联动（suggestEn）
 *   - 中文反查（"苹果" → 命中 apple）
 *   - 变形标记解析（parseExchange：词根条目 p/d/i/3/s；反查词条 "=go:p"）
 *   - 词形还原（went → go 经 ex 反指；run 常规变形组）
 *   - 派生词规则（create → creation 正查；creation → create 反查；useful → use）
 *   - 统一查询调度 search（kind 识别）
 *   - 异常输入（空串/非法字符/超长）不崩溃且不产生假命中
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DICT_DATA, DICT_COUNT } = require('../src/common/data/dict.js')

const dictMod = await import('../src/common/logic/dict.js')
const formsMod = await import('../src/common/logic/forms.js')
const dict = dictMod.default || dictMod
const forms = formsMod.default || formsMod
const {
  count, entryAt, wordAt, findExact, prefixQuery, suggestEn,
  zhQuery, search, normEn
} = dict
const { parseExchange, roleLabel, forwardDerive, reverseStem } = forms

let passed = 0
function ok(cond, msg) {
  assert(cond, msg)
  passed++
  console.log('  ✓', msg)
}

console.log('[smoke] 数据与索引')
ok(DICT_COUNT === count(), 'DICT_COUNT 与实际行数一致 (' + count() + ')')
ok(DICT_DATA.length > 1000000, '词条负载非空且 > 1MB')
ok(findExact('apple') >= 0, 'apple 词条存在')
const appleIdx = findExact('apple')
ok(wordAt(appleIdx) === 'apple', 'wordAt(apple) === apple')

// 字典序检查（抽样中段，保证二分前提成立）
{
  const mid = count() >> 1
  const lw = wordAt(mid - 1), rw = wordAt(mid)
  ok(lw < rw, '抽查字典序: ' + lw + ' < ' + rw)
  const w0 = wordAt(0), wLast = wordAt(count() - 1)
  ok(w0 < wLast, '词条首尾字典序成立: ' + w0 + ' … ' + wLast)
}

console.log('[smoke] 英文精确查询与字段完整性')
const apple = entryAt(appleIdx)
ok(apple.word === 'apple', 'entryAt(apple).word')
ok(apple.ph === 'æpl', 'apple 音标 æpl（实测: ' + apple.ph + '）')
ok(apple.trans.indexOf('苹果') >= 0, 'apple 释义含苹果')
ok(apple.ex.indexOf('s:apples') === 0, 'apple 变形标记 s:apples')

const goEntry = entryAt(findExact('go'))
ok(goEntry.ex.indexOf('p:went') >= 0, 'go 变形含 p:went')
ok(goEntry.ex.indexOf('d:gone') >= 0, 'go 变形含 d:gone')
ok(goEntry.ex.indexOf('i:going') >= 0, 'go 变形含 i:going')
ok(goEntry.ex.indexOf('3:goes') >= 0, 'go 变形含 3:goes')

// run：自指 lemma 已回退为常规变形列表（不再出现 =run）
const runEntry = entryAt(findExact('run'))
ok(!runEntry.ex.startsWith('='), 'run 不含自指反查标记')
ok(runEntry.ex.indexOf('p:ran') >= 0, 'run 变形含 p:ran')

console.log('[smoke] 前缀扩散搜索（ap → …，appl → apple）')
{
  const rows = prefixQuery('ap', 24)
  ok(rows.length > 5, "'ap' 前缀命中若干 (>5)，实得 " + rows.length)
  const words = rows.map(wordAt)
  // 前缀匹配连续性：所有命中均以 ap 开头
  ok(words.every(w => w.indexOf('ap') === 0), "'ap' 扩散结果全部以 ap 开头（首: " + words[0] + ' 末: ' + words[words.length - 1] + '）')
  // 字典序递增（与词表一致，无倒序抖动）
  let sorted = true
  for (var k = 1; k < words.length; k++) if (words[k] < words[k - 1]) sorted = false
  ok(sorted, "'ap' 扩散结果字典序递增")
  // 明细前缀：appl 前列即 apple 族（applaud 一族按字典序排前）
  const appl = prefixQuery('appl', 24).map(wordAt)
  ok(appl.every(w => w.indexOf('appl') === 0), "'appl' 扩散全部以 appl 开头（首: " + appl[0] + '）')
  ok(appl.indexOf('apple') >= 0, "'appl' 扩散含 apple")
  ok(appl.indexOf('apply') >= 0 || appl.indexOf('apples') >= 0, "'appl' 扩散含 apply/apples")
}
{
  const sug = suggestEn('appl', 12)
  ok(sug.length >= 2 && sug.indexOf('apple') >= 0, "suggestEn('appl') 含 apple")
  ok(sug.indexOf('appl') < 0, 'suggestEn 不含输入本身')
}

console.log('[smoke] 中文反查（苹果 → apple）')
{
  const rows = zhQuery('苹果', 60)
  ok(rows.length >= 1, "'苹果' 反查至少命中 1 个词条（实得 " + rows.length + '）')
  const words = rows.map(wordAt)
  ok(words.indexOf('apple') >= 0, "'苹果' 反查含 apple（命中: " + words.slice(0, 8).join(', ') + ')')
}

console.log('[smoke] 变形标记解析与词形还原')
{
  const went = entryAt(findExact('went'))
  ok(went.ex[0] === '=', 'went 为纯反查词条 (=go:p)')
  const ex = parseExchange(went.ex)
  ok(ex.lemma === 'go' && ex.role === 'p', "went 反指词根 go，角色过去式")
  ok(roleLabel('p') === '过去式', "roleLabel('p') = 过去式")
  const lemmaSeek = findExact(ex.lemma)
  ok(lemmaSeek >= 0, 'went 词根 go 在词典中可查')

  const goEx = parseExchange(entryAt(findExact('go')).ex)
  ok(!goEx.lemma, 'go 非反查词条')
  const kv = {}
  for (const f of goEx.forms) kv[f.k] = f.v
  ok(kv.p === 'went' && kv.d === 'gone' && kv.i === 'going' && kv['3'] === 'goes',
    'go 四态齐全: went/gone/going/goes')
  ok(goEx.forms.every(f => f.label), '每个变形均带中文标签')
}

console.log('[smoke] 派生词规则')
{
  const exists = (w) => findExact(w) >= 0
  const derivs = forwardDerive('create', exists).map(d => d.word)
  ok(derivs.indexOf('creation') >= 0, 'create 派生含 creation（得: ' + derivs.slice(0, 9).join(',') + ')')
  ok(derivs.indexOf('creative') >= 0 || derivs.indexOf('creator') >= 0, 'create 派生含 creative/creator')
  const useD = forwardDerive('use', exists).map(d => d.word)
  ok(useD.indexOf('useful') >= 0, 'use 派生含 useful')

  const stems = reverseStem('creation', exists)
  ok(stems.some(s => s.stem === 'create' && (s.suffix === 'ion' || s.suffix === 'ation' || s.suffix === 'tion')),
    'creation 词干还原含 create（得: ' + JSON.stringify(stems.slice(0, 4)) + ')')
  const u = reverseStem('useful', exists)
  ok(u.some(s => s.stem === 'use'), 'useful 词干还原含 use')
  // 无根词不误报
  const neutral = reverseStem('window', exists)
  ok(neutral.every(s => exists(s.stem)), 'reverseStem 结果全部经词典验证')
}

console.log('[smoke] 统一查询调度与异常输入')
{
  const r1 = search('ap')
  ok(r1.kind === 'en' && r1.rows.length > 0, "search('ap') → en 且命中")
  const r2 = search('苹果')
  ok(r2.kind === 'zh' && r2.rows.length > 0, "search('苹果') → zh 且命中")
  ok(search('').kind === 'none', "search('') → none")
  ok(search('!!!').kind === 'none', "search('!!!') → none")
  const long = 'q'.repeat(40)
  const rq = search(long)
  ok(rq.kind === 'en' && rq.rows.length === 0, '超长输入不崩且无假命中')
  ok(normEn("Workers' Day") === 'workersday', "normEn 净化: Workers' Day → workersday")
  ok(findExact('no-such-word-zz') < 0, '不存在词条返回 -1')
}

console.log('')
console.log('[smoke] 全部断言通过 (' + passed + ')')
