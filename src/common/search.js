const ROOT = '/common/dict/';

export function createDictionary(readText) {
  if (typeof readText !== 'function') throw new TypeError('readText must be a function');
  const cache = new Map();
  // Serialize operations so simultaneous UI requests cannot load unbounded pages.
  let queue = Promise.resolve();
  function serial(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }
  async function load(name) {
    if (cache.has(name)) {
      const value = cache.get(name);
      cache.delete(name);
      cache.set(name, value);
      return value;
    }
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid dictionary path');
    const text = await readText(ROOT + name + '.json');
    const value = JSON.parse(text);
    if (name === 'meta') {
      if (!value || value.version !== 1 || !Number.isInteger(value.pageSize) || value.pageSize < 1 ||
          !Number.isInteger(value.count) || value.count < 0 || value.count > 18000 || !value.labels) {
        throw new Error('Invalid dictionary metadata');
      }
    } else if (!Array.isArray(value)) throw new Error('Invalid dictionary shard: ' + name);
    if (cache.size === 4) cache.delete(cache.keys().next().value);
    cache.set(name, value);
    return value;
  }
  async function record(id) {
    const meta = await load('meta');
    if (!Number.isInteger(id) || id < 0 || id >= meta.count) throw new RangeError('Unknown dictionary id');
    const page = await load('d-' + Math.floor(id / meta.pageSize));
    const row = page[id % meta.pageSize];
    if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== 'string' ||
        typeof row[1] !== 'string' || typeof row[2] !== 'string' || !Array.isArray(row[3])) {
      throw new Error('Invalid dictionary entry');
    }
    return row;
  }
  function item(id, row) {
    return { id, word: row[0], phonetic: row[1], translation: row[2] };
  }
  async function scan(kind, bucket, key, prefix, visit) {
    const manifest = await load(kind + '-' + bucket);
    const end = prefix ? key + '\uffff' : key;
    for (const descriptor of manifest) {
      if (!Array.isArray(descriptor) || descriptor.length !== 3) throw new Error('Invalid index manifest');
      const [first, last, name] = descriptor;
      if (last < key || first > end) continue;
      const rows = await load(name);
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') {
          throw new Error('Invalid index row');
        }
        if ((prefix ? row[0].indexOf(key) === 0 : row[0] === key) && await visit(row[1]) === false) return;
      }
    }
  }
  async function getEntry(id) {
    if (typeof id === 'string' && /^\d+~[a-z]+(?:[-'][a-z]+)*~[pdi3rts]$/.test(id)) {
      const [base, word, code] = id.split('~');
      const row = await record(Number(base));
      if (!row[3].some(relation => relation[0] === id && relation[1] === code)) {
        throw new RangeError('Unknown dictionary id');
      }
      const meta = await load('meta');
      return { id, word, phonetic: '', translation: row[2],
        relations: [{ id: Number(base), word: row[0], label: meta.labels['0'] }] };
    }
    if (typeof id === 'string' && /^\d+$/.test(id)) id = Number(id);
    const row = await record(id);
    const meta = await load('meta');
    const relations = [];
    for (const [target, code] of row[3]) {
      const word = typeof target === 'string' && target.includes('~')
        ? target.split('~')[1] : (await record(target))[0];
      relations.push({ id: target, word, label: meta.labels[code] || code });
    }
    return { ...item(id, row), relations };
  }
  return {
    search(query, offset = 0, limit = 12) {
      return serial(async () => {
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new RangeError('Invalid pagination');
        }
        const key = typeof query === 'string' ? query.trim().toLowerCase() : '';
        if (!key) return { items: [], hasMore: false };
        const han = key.match(/[\u3400-\u9fff]/);
        if (!han && !/^[a-z]+(?:[-'][a-z]+)*[-']?$/.test(key)) return { items: [], hasMore: false };
        const meta = await load('meta');
        const seen = new Uint8Array(meta.count);
        const items = [];
        let matched = 0;
        const visit = async id => {
          if (!Number.isInteger(id) || id < 0 || id >= meta.count) throw new Error('Invalid posting id');
          if (seen[id]) return true;
          seen[id] = 1;
          const row = await record(id);
          if (han && !row[2].includes(key)) return true;
          if (matched++ < offset) return true;
          items.push(item(id, row));
          return items.length <= limit;
        };
        await scan(han ? 'c' : 'e', han ? han[0].charCodeAt(0) % 256 : key[0],
          han ? han[0] : key, !han, visit);
        return { items: items.slice(0, limit), hasMore: items.length > limit };
      });
    },
    get(id) { return serial(() => getEntry(id)); },
    candidates(pinyin) {
      return serial(async () => {
        const key = typeof pinyin === 'string' ? pinyin.trim().toLowerCase().replace(/u:|ü/g, 'v') : '';
        if (!/^[a-z]+$/.test(key)) return [];
        let hash = 0;
        for (let i = 0; i < key.length; i++) hash += key.charCodeAt(i);
        const results = [];
        await scan('p', hash % 32, key, false, char => { results.push(char); });
        return results;
      });
    }
  };
}
