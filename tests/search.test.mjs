import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

// Import as ESM without changing the application's package/module conventions.
const source = await readFile(new URL('../src/common/search.js', import.meta.url), 'utf8');
const { createDictionary } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const ROOT = '/common/dict/';

function fixture() {
  const files = new Map();
  const reads = [];
  const put = (name, value) => files.set(ROOT + name + '.json', JSON.stringify(value));
  const entries = [
    ['act', 'ækt', 'v. 行动；表演', [[1, 'D']]],
    ['action', 'ækʃən', 'n. 行动；活动', [[0, 'D']]],
    ['apple', 'æpl', 'n. 苹果；苹果树', []],
    ['apply', 'əplaɪ', 'v. 申请；应用', [['3~applied~p', 'p']]],
    ['go', 'ɡəʊ', 'v. 去；走', [['4~went~p', 'p'], ['4~gone~d', 'd']]],
    ['good', 'ɡʊd', 'a. 好的；优良的', [['5~better~r', 'r']]],
    ['read', 'riːd', 'v. 阅读', [[7, 'D']]],
    ['readable', 'riːdəbl', 'a. 可读的', [[6, 'D']]],
    ['orchard', '', 'n. 果园；种有苹果的园地', []],
    ['fruit', '', 'n. 水果；结果', []]
  ];
  put('meta', { version: 1, count: entries.length, pageSize: 2,
    labels: { D: '派生词', p: '过去式', d: '过去分词', r: '比较级', 0: '原形' } });
  for (let i = 0; i < entries.length; i += 2) put('d-' + i / 2, entries.slice(i, i + 2));
  const english = [
    ['act', 0], ['act', 1], ['action', 0], ['action', 1], ['apple', 2], ['applied', 3], ['apply', 3],
    ['better', 5], ['fruit', 9], ['go', 4], ['gone', 4], ['good', 5], ['orchard', 8],
    ['read', 6], ['read', 7], ['readable', 6], ['readable', 7], ['went', 4]
  ];
  function indexes(kind, groups) {
    for (const [bucket, rows] of groups) {
      rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
      const descriptors = [];
      // Small test shards force equal keys and prefixes across page boundaries.
      for (let i = 0; i < rows.length; i += 3) {
        const chunk = rows.slice(i, i + 3);
        const name = kind + '-' + bucket + '-' + i / 3;
        put(name, chunk);
        descriptors.push([chunk[0][0], chunk.at(-1)[0], name]);
      }
      put(kind + '-' + bucket, descriptors);
    }
  }
  const groups = new Map([...'abcdefghijklmnopqrstuvwxyz'].map(char => [char, []]));
  for (const row of english) groups.get(row[0][0]).push(row);
  indexes('e', groups);
  const chinese = new Map(Array.from({ length: 256 }, (_, i) => [i, []]));
  for (let i = 0; i < entries.length; i++) {
    for (const char of new Set(entries[i][2].match(/[\u3400-\u9fff]/g))) {
      chinese.get(char.charCodeAt(0) % 256).push([char, i]);
    }
  }
  // Hash collision and a same-character false positive must be filtered.
  chinese.get('苹'.charCodeAt(0) % 256).push(['苹', 9]);
  indexes('c', chinese);
  const pinyin = new Map(Array.from({ length: 32 }, (_, i) => [i, []]));
  for (const row of [['ping', '苹'], ['guo', '果'], ['guo', '过'], ['lv', '绿']]) {
    const hash = [...row[0]].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 32;
    pinyin.get(hash).push(row);
  }
  indexes('p', pinyin);
  const readText = async path => {
    reads.push(path);
    if (!files.has(path)) throw new Error('Missing fixture: ' + path);
    return files.get(path);
  };
  return { dictionary: createDictionary(readText), files, reads, readText, put };
}

test('empty/unsupported input is empty and does not read files', async () => {
  const { dictionary, reads } = fixture();
  for (const query of ['', '  ', null, undefined, '123', '*']) {
    assert.deepEqual(await dictionary.search(query), { items: [], hasMore: false });
  }
  assert.deepEqual(await dictionary.candidates(''), []);
  assert.equal(reads.length, 0);
});

test('English prefix is case-insensitive and crosses index shards', async () => {
  const { dictionary } = fixture();
  const result = await dictionary.search(' APp ');
  assert.deepEqual(result.items.map(item => item.word), ['apple', 'apply']);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['id', 'phonetic', 'translation', 'word']);
  assert.equal(result.hasMore, false);
  assert.deepEqual((await dictionary.search('zzz')).items, []);
});

test('Chinese phrase searches full substring and removes posting false positives', async () => {
  const { dictionary } = fixture();
  assert.deepEqual((await dictionary.search('苹果')).items.map(item => item.word), ['apple', 'orchard']);
  assert.deepEqual((await dictionary.search('苹果树')).items.map(item => item.word), ['apple']);
  assert.deepEqual((await dictionary.search('果苹')).items, []);
  assert.deepEqual((await dictionary.search('不存在')).items, []);
});

test('pagination counts unique matching items across shards', async () => {
  const { dictionary } = fixture();
  const first = await dictionary.search('a', 0, 2);
  const second = await dictionary.search('a', 2, 2);
  assert.deepEqual(first.items.map(item => item.word), ['act', 'action']);
  assert.equal(first.hasMore, true);
  assert.deepEqual(second.items.map(item => item.word), ['apple', 'apply']);
  assert.equal(second.hasMore, false);
  assert.deepEqual(await dictionary.search('a', 4, 2), { items: [], hasMore: false });
  assert.equal((await dictionary.search('苹果', 0, 1)).hasMore, true);
  assert.deepEqual((await dictionary.search('苹果', 1, 1)).items.map(item => item.word), ['orchard']);
});

test('exchange forms reverse lookup their lemma', async () => {
  const { dictionary } = fixture();
  for (const [form, lemma] of [['WENT', 'go'], ['gone', 'go'], ['better', 'good'], ['applied', 'apply']]) {
    assert.deepEqual((await dictionary.search(form)).items.map(item => item.word), [lemma]);
  }
  const go = await dictionary.get(4);
  assert.deepEqual(go.relations[0], { id: '4~went~p', word: 'went', label: '过去式' });
  const went = await dictionary.get(go.relations[0].id);
  assert.equal(went.word, 'went');
  assert.deepEqual(went.relations, [{ id: 4, word: 'go', label: '原形' }]);
  assert.equal((await dictionary.get('4')).word, 'go');
});

test('real derivations are navigable and searchable in both directions', async () => {
  const { dictionary } = fixture();
  for (const [left, right] of [[0, 1], [6, 7]]) {
    const a = await dictionary.get(left);
    const b = await dictionary.get(right);
    assert.deepEqual(a.relations, [{ id: right, word: b.word, label: '派生词' }]);
    assert.deepEqual(b.relations, [{ id: left, word: a.word, label: '派生词' }]);
    assert.ok((await dictionary.search(b.word)).items.some(item => item.id === left));
  }
  assert.deepEqual((await dictionary.get(2)).relations, []);
});

test('single-syllable pinyin supports case and umlaut normalization', async () => {
  const { dictionary } = fixture();
  assert.deepEqual(await dictionary.candidates(' PING '), ['苹']);
  assert.deepEqual(new Set(await dictionary.candidates('guo')), new Set(['果', '过']));
  for (const spelling of ['lv', 'lü', 'lu:']) assert.deepEqual(await dictionary.candidates(spelling), ['绿']);
  for (const spelling of ['pingguo', 'ping1', '苹果', null]) assert.deepEqual(await dictionary.candidates(spelling), []);
});

test('invalid pagination and IDs reject predictably', async () => {
  const { dictionary } = fixture();
  for (const [offset, limit] of [[-1, 12], [0, 0], [0, 101], [1.1, 12], [0, NaN], [Infinity, 12]]) {
    await assert.rejects(dictionary.search('a', offset, limit), RangeError);
  }
  for (const id of [-1, 10, null, 'x', '4~invented~p', '999~went~p', '../meta']) {
    await assert.rejects(dictionary.get(id), RangeError);
  }
  assert.throws(() => createDictionary(null), TypeError);
});

test('read failures propagate and do not poison subsequent requests', async () => {
  const base = fixture();
  let fail = true;
  const dictionary = createDictionary(async path => {
    if (fail) { fail = false; throw new Error('Storage unavailable'); }
    return base.readText(path);
  });
  await assert.rejects(dictionary.search('apple'), /Storage unavailable/);
  assert.equal((await dictionary.search('apple')).items[0].word, 'apple');
});

test('invalid JSON and schema errors reject and permit retry', async () => {
  const { dictionary, files, put } = fixture();
  files.set(ROOT + 'e-a.json', '{');
  await assert.rejects(dictionary.search('apple'), SyntaxError);
  put('e-a', {});
  await assert.rejects(dictionary.search('apple'), /Invalid dictionary shard/);
  put('e-a', []);
  assert.deepEqual((await dictionary.search('apple')).items, []);
  const broken = fixture();
  broken.put('meta', { version: 99 });
  await assert.rejects(broken.dictionary.get(0), /Invalid dictionary metadata/);
});

test('LRU caches at most four files and refreshes recently used files', async () => {
  const { dictionary, reads } = fixture();
  // Each candidate query loads a manifest and one data page, without entry pages.
  await dictionary.candidates('ping');
  await dictionary.candidates('guo');
  const before = reads.length;
  await dictionary.candidates('ping');
  assert.equal(reads.length, before);
  await dictionary.candidates('lv');
  const after = reads.length;
  await dictionary.candidates('guo');
  assert.equal(reads.length, after + 2);
});

test('concurrent operations serialize storage reads and survive rejection', async () => {
  const base = fixture();
  let active = 0;
  let peak = 0;
  const dictionary = createDictionary(async path => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    try { return await base.readText(path); } finally { active--; }
  });
  const results = await Promise.allSettled([
    dictionary.search('apple'), dictionary.get(-1), dictionary.candidates('guo'), dictionary.get(6)
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(peak, 1);
  assert.ok(base.reads.every(path => path.startsWith(ROOT) && path.endsWith('.json')));
});

test('Python pure parsers read WordNet lexical pointers and exchange without running generation', async () => {
  const script = new URL('../scripts/build_dictionary.py', import.meta.url);
  const program = String.raw`
import hashlib, io, runpy, sys, zipfile
module = runpy.run_path(sys.argv[1], run_name='dictionary_pure_test')
stream = io.BytesIO()
with zipfile.ZipFile(stream, 'w') as archive:
    archive.writestr('wordnet/data.noun', '00000002 00 n 02 movement 0 action 0 0 | noun\n')
    archive.writestr('wordnet/data.verb', '  License header\n00000001 00 v 02 act 0 move 0 1 + 00000002 n 0102 0 | verb\n00000004 00 v 01 read 0 0 0 | verb\n')
    archive.writestr('wordnet/data.adj', '00000003 00 a 01 readable(p) 0 1 + 00000004 v 0101 | adj\n')
    archive.writestr('wordnet/data.adv', '')
    archive.writestr('wordnet/LICENSE', 'fixture license')
edges, license_text = module['wordnet_edges'](stream.getvalue())
assert edges == {('act', 'action'), ('read', 'readable')}, edges
assert license_text == 'fixture license'
forms = list(module['exchange']({'word': 'go', 'exchange': 'p:went/d:gone/i:going/3:goes/0:go/1:s'}))
assert forms == [('p', 'went', 's'), ('d', 'gone', 's'), ('i', 'going', 's'), ('3', 'goes', 's')], forms
assert list(module['exchange']({'word': 'apple', 'exchange': ''})) == []
assert module['rank']({'word': 'apple', 'oxford': '1'}) < module['rank']({'word': 'rare', 'frq': '1'})
assert module['rank']({'word': 'apply', 'tag': 'cet4'}) < module['rank']({'word': 'rare'})
payload = b'fixture source'
module['urllib'].request.urlopen = lambda *args, **kwargs: io.BytesIO(payload)
assert module['download']('fixture', hashlib.sha256(payload).hexdigest()) == payload
blob_hash = hashlib.sha1(b'blob ' + str(len(payload)).encode() + b'\0' + payload).hexdigest()
assert module['download']('fixture', blob_hash, True) == payload
try:
    module['download']('fixture', 'incorrect hash')
    raise AssertionError('Source hash mismatch was accepted')
except ValueError:
    pass
print('Pure parser assertions passed; no download or generator execution')
`;
  const result = await promisify(execFile)('python3', ['-c', program, script.pathname], { timeout: 10000 });
  assert.match(result.stdout, /Pure parser assertions passed/);
});
