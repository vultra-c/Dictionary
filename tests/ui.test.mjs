import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const ux = await readFile(new URL('../src/pages/index/index.ux', import.meta.url), 'utf8');
const match = ux.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, 'The page must contain a script');
let script = match[1];
for (const [pattern, replacement] of [
  [/import\s*\{\s*createDictionary\s*\}\s*from\s*['"]\.\.\/\.\.\/common\/search['"];?/, 'const { createDictionary } = adapter;'],
  [/import\s+file\s+from\s*['"]@system.file['"];?/, 'const file = adapter.file;'],
  [/import\s+app\s+from\s*['"]@system.app['"];?/, 'const app = adapter.app;']
]) {
  assert.match(script, pattern, 'Expected UI dependency import');
  script = script.replace(pattern, replacement);
}
script = script.replace(/export\s+default\s+/, 'globalThis.definition = ');

const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const entry = (id, word = String(id)) => ({
  id, word, phonetic: '/test/', translation: '\u91ca\u4e49'.repeat(100),
  relations: [{ id: 0, word: 'base', label: '\u539f\u5f62' }]
});
const results = (word = 'apple', hasMore = false) => ({ items: [entry(0, word)], hasMore });

function fixture(t) {
  let now = 0;
  let timerId = 0;
  let terminated = 0;
  let readText;
  const timers = new Map();
  const calls = { search: [], candidates: [], get: [] };
  const api = Object.fromEntries(Object.keys(calls).map(method => [method, (...args) =>
    new Promise((resolve, reject) => calls[method].push({ args, resolve, reject }))]));
  const file = { readText: options => options.success({ text: 'fixture' }) };
  const context = vm.createContext({
    adapter: {
      createDictionary(reader) { readText = reader; return api; },
      file,
      app: { terminate() { terminated++; } }
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(script, context, { filename: 'index.ux.js', timeout: 1000 });
  const page = Object.assign({}, context.definition, plain(context.definition.private));
  page.onInit();
  t.after(() => page.onDestroy());
  return {
    page, calls, timers, file,
    get terminated() { return terminated; },
    readText: path => readText(path),
    tick(ms) {
      const end = now + ms;
      // Run only timers due within the requested interval, in deadline order.
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
    type(text) {
      for (const char of text) {
        const group = page.keys.find(key => key.value.includes(char));
        assert.ok(group, 'A keyboard group must contain ' + char);
        page.pressKey(group.value);
        assert.ok(page.keys.some(key => key.value === char));
        page.pressKey(char);
      }
    }
  };
}

test('English keyboard debounces each character and queries ap with limit 12', async t => {
  const f = fixture(t);
  f.type('a');
  f.tick(100);
  assert.equal(f.calls.search.length, 0);
  f.type('p');
  assert.equal(f.page.query, 'ap');
  assert.equal(f.page.loading, true);
  f.tick(159);
  assert.equal(f.calls.search.length, 0);
  f.tick(1);
  assert.deepEqual(f.calls.search[0].args, ['ap', 0, 12]);
  f.calls.search[0].resolve(results());
  await flush();
  assert.equal(f.page.items[0].word, 'apple');
  assert.equal(f.page.loading, false);
});

test('Chinese candidate selection appends consecutive characters to the query', async t => {
  const f = fixture(t);
  f.page.showKeyboard();
  f.page.switchLanguage();
  for (const [pinyin, char, query] of [
    ['ping', '\u82f9', '\u82f9'], ['guo', '\u679c', '\u82f9\u679c']
  ]) {
    f.type(pinyin);
    f.tick(119);
    assert.equal(f.page.candidateRows.length, 0);
    f.tick(1);
    const request = f.calls.candidates.at(-1);
    assert.deepEqual(request.args, [pinyin]);
    request.resolve([char]);
    await flush();
    f.page.chooseCandidate(f.page.candidateRows[0].text);
    assert.equal(f.page.query, query);
    assert.equal(f.page.pinyin, '');
    assert.equal(f.page.candidateRows.length, 0);
    assert.equal(f.page.keyboard, true);
  }
  f.tick(160);
  assert.deepEqual(f.calls.search.at(-1).args, ['\u82f9\u679c', 0, 12]);
});

test('stale search success and failure cannot overwrite the newest query', async t => {
  const f = fixture(t);
  f.type('a'); f.tick(160);
  f.type('p');
  f.calls.search[0].resolve(results('ant'));
  await flush();
  assert.equal(f.page.items.length, 0, 'Invalidate during the debounce window');
  assert.equal(f.page.loading, true);
  f.tick(160);
  f.type('p'); f.tick(160);
  f.calls.search[2].resolve(results('apple'));
  await flush();
  f.calls.search[1].reject(new Error('stale read failure'));
  await flush();
  assert.equal(f.page.items[0].word, 'apple');
  assert.equal(f.page.error, false);
  assert.equal(f.page.loading, false);
});

test('stale candidates cannot replace candidates for newer pinyin', async t => {
  const f = fixture(t);
  f.page.switchLanguage();
  f.type('pin'); f.tick(120);
  f.type('g'); f.tick(120);
  f.calls.candidates[1].resolve(['\u82f9']);
  await flush();
  f.calls.candidates[0].resolve(['\u54c1']);
  await flush();
  assert.equal(f.page.candidateRows[0].text, '\u82f9');
  f.page.switchLanguage();
  assert.equal(f.page.candidateRows.length, 0);
});

test('results remain bounded to 12 and expose pagination, empty, error and retry states', async t => {
  const f = fixture(t);
  f.type('a'); f.tick(160);
  f.calls.search[0].resolve({ items: Array.from({ length: 15 }, (_, id) => entry(id)), hasMore: true });
  await flush();
  assert.equal(f.page.items.length, 12);
  f.page.nextPage();
  assert.deepEqual(f.calls.search[1].args, ['a', 12, 12]);
  f.calls.search[1].resolve({ items: [], hasMore: false });
  await flush();
  assert.equal(f.page.pageNumber, 2);
  assert.equal(f.page.items.length, 0);
  assert.equal(f.page.loading, false);
  assert.equal(f.page.hasMore, false);
  assert.equal(f.page.error, false);
  f.page.previousPage();
  assert.deepEqual(f.calls.search[2].args, ['a', 0, 12]);
  f.calls.search[2].reject(new Error('read failure'));
  await flush();
  assert.equal(f.page.error, true);
  assert.equal(f.page.loading, false);
  f.page.retrySearch();
  f.calls.search[3].resolve(results());
  await flush();
  assert.equal(f.page.error, false);
  assert.equal(f.page.items[0].word, 'apple');
});

test('back closes keyboard, unwinds string/numeric detail IDs, returns home, then terminates', async t => {
  const f = fixture(t);
  f.page.openDetail('3~applied~p');
  f.calls.get[0].resolve(entry('3~applied~p', 'applied'));
  await flush();
  f.page.openDetail(f.page.relationRows[0].id);
  assert.deepEqual(f.calls.get[1].args, [0]);
  f.calls.get[1].resolve(entry(0, 'apply'));
  await flush();
  f.page.showKeyboard();
  f.page.onSwipe({ direction: 'right' });
  assert.equal(f.page.keyboard, false);
  assert.equal(f.page._detailId, 0);
  assert.equal(f.calls.get.length, 2);
  assert.equal(f.page.onBackPress(), true);
  assert.deepEqual(f.calls.get[2].args, ['3~applied~p']);
  f.calls.get[2].resolve(entry('3~applied~p', 'applied'));
  await flush();
  f.page.onSwipe({ direction: 'right' });
  assert.equal(f.page.view, 'search');
  assert.equal(f.terminated, 0);
  f.page.onSwipe({ direction: 'left' });
  assert.equal(f.terminated, 0);
  f.page.onBackPress();
  assert.equal(f.terminated, 1);
});

test('a detail response arriving after returning home is ignored', async t => {
  const f = fixture(t);
  f.page.openDetail(0);
  f.page.goBack();
  f.calls.get[0].resolve(entry(0));
  await flush();
  assert.equal(f.page.view, 'search');
  assert.equal(f.page.detailRows.length, 0);
});

test('destroy clears both debounce timers before they call the adapter', t => {
  const f = fixture(t);
  f.type('a');
  f.page.switchLanguage();
  f.type('ping');
  assert.equal(f.timers.size, 2);
  f.page.onDestroy();
  assert.equal(f.timers.size, 0);
  f.tick(1000);
  assert.equal(f.calls.search.length, 0);
  assert.equal(f.calls.candidates.length, 0);
});

for (const outcome of ['resolve', 'reject']) {
  test('destroy ignores in-flight search, candidates and detail ' + outcome, async t => {
    const f = fixture(t);
    f.type('a'); f.tick(160);
    f.page.switchLanguage(); f.type('ping'); f.tick(120);
    f.page.openDetail(0);
    f.page.onDestroy();
    const snapshot = plain(Object.fromEntries(Object.keys(f.page.private).map(key => [key, f.page[key]])));
    for (const [method, value] of [['search', results()], ['candidates', ['\u82f9']], ['get', entry(0)]]) {
      f.calls[method][0][outcome](outcome === 'resolve' ? value : new Error('late failure'));
    }
    await flush();
    for (const key of Object.keys(snapshot)) assert.deepEqual(plain(f.page[key]), snapshot[key], key);
  });
}

test('file adapter forwards URI, resolves data.text and rejects read failures', async t => {
  const f = fixture(t);
  f.file.readText = options => {
    assert.equal(options.uri, '/common/dict/meta.json');
    options.success({ text: '{"version":1}' });
  };
  assert.equal(await f.readText('/common/dict/meta.json'), '{"version":1}');
  const error = new Error('missing dictionary');
  f.file.readText = options => options.fail(error);
  await assert.rejects(f.readText('/missing'), error);
});
