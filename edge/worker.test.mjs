import { readFile } from 'node:fs/promises';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const source = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; });
let version = 0;
async function fixture() {
  const { default: worker } = await import(`data:text/javascript,${encodeURIComponent(source)}#${version++}`);
  const entries = new Map();
  const cache = {
    match: async key => entries.get(key.url)?.clone(),
    put: async (key, value) => entries.set(key.url, value.clone()),
  };
  globalThis.caches = { default: cache };
  const background = [];
  const ctx = { waitUntil: task => background.push(task) };
  const request = (query = '') => worker.fetch(new Request('https://shop.test/api/stock' + query), { API_ORIGIN: 'https://api.test', ORIGIN_SECRET: 'test-origin-secret' }, ctx);
  const fresh = () => new Response('{"products":{"1":[100,100,5]}}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
  return { entries, cache, background, request, fresh };
}

test('query variations and 20 simultaneous cold requests share one origin call', async () => {
  const f = await fixture();
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.test/api/stock');
    assert.equal(init.headers.get('X-Origin-Secret'), 'test-origin-secret');
    await gate;
    return f.fresh();
  };
  const pending = Array.from({ length: 20 }, (_, i) => f.request('?query=' + i));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  release();
  const responses = await Promise.all(pending);
  for (const response of responses) assert.equal((await response.json()).products['1'][2], 5);
  await f.request('?different=again');
  assert.equal(calls, 1);
});

test('saved stock returns before a slow origin finishes; refreshes run once', { timeout: 2000 }, async () => {
  const f = await fixture();
  f.entries.set('https://shop.test/api/stock-stale', f.fresh());
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async () => { calls++; await gate; return f.fresh(); };
  try {
    const responses = await Promise.all(Array.from({ length: 20 }, () => f.request()));
    assert.equal(calls, 1);
    assert.equal(responses[0].headers.get('Cache-Control'), 'no-store');
    assert.equal(responses[0].headers.get('X-Stock-Stale'), '1');
    assert.equal((await responses[0].json()).products['1'][0], 100);
  } finally { release(); await Promise.all(f.background); }
  assert.ok(f.entries.has('https://shop.test/api/stock'));
});

test('an unavailable origin gets a brief retry delay without renewing the day-old fallback', async () => {
  const f = await fixture();
  const saved = f.fresh();
  f.entries.set('https://shop.test/api/stock-stale', saved);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('asleep'); };
  assert.equal((await f.request()).status, 200);
  await Promise.all(f.background);
  assert.equal((await f.request()).headers.get('Cache-Control'), 'public, max-age=15');
  assert.equal(calls, 1);
  assert.equal(f.entries.get('https://shop.test/api/stock-stale'), saved);
});

test('no saved stock and unavailable API returns 503', async () => {
  const f = await fixture();
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal((await f.request()).status, 503);
});

test('cache write failures do not discard a healthy origin response', async () => {
  const f = await fixture();
  f.cache.put = async () => { throw new Error('cache unavailable'); };
  globalThis.fetch = async () => f.fresh();
  assert.equal((await f.request()).status, 200);
});
