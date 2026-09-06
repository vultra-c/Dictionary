import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile('src/common/search.js', 'utf8');
const { createDictionary } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const dictionary = createDictionary(path => readFile('src' + path, 'utf8'));
async function find(query, word) {
  for (let offset = 0; offset < 18000; offset += 12) {
    const page = await dictionary.search(query, offset, 12);
    const match = page.items.find(item => item.word === word);
    if (match) return match;
    if (!page.hasMore) break;
  }
  assert.fail(`${query} must contain ${word}`);
}
for (const [query, word] of [['ap', 'apple'], ['苹果', 'apple'], ['went', 'go'], ['apples', 'apple']]) {
  await find(query, word);
}
for (const [left, right] of [['act', 'action'], ['action', 'act'], ['read', 'readable'], ['readable', 'read']]) {
  const entry = await dictionary.get((await find(left, left)).id);
  assert(entry.relations.some(item => item.word === right), `${left} -> ${right}`);
}
assert((await dictionary.candidates('ping')).includes('苹'));
assert((await dictionary.candidates('guo')).includes('果'));
console.log('Real dictionary acceptance passed: prefix, Chinese, inflections, derivations, pinyin.');
