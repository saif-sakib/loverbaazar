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
  return { worker, entries, cache, background, request, fresh };
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

test('legacy assets redirect only exact verified paths and preserve real 404s', async () => {
  const { default: worker } = await import(`data:text/javascript,${encodeURIComponent(source)}#assets-${version++}`);
  const originFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Asset redirects must not call the API'); };
  const env = { ASSETS: { fetch: async req => new URL(req.url).pathname === '/legacy-assets.json' ? Response.json({ '/wp-content/uploads/test.png': 'https://res.cloudinary.com/fixture/image/upload/test.png', '/wp-content/uploads/unsafe.png': 'https://evil.invalid/file' }) : new Response('Not found', { status: 404 }) } };
  for (const method of ['GET', 'HEAD']) {
    const r = await worker.fetch(new Request('https://shop.test/wp-content/uploads/test.png?size=300', { method }), env, {});
    assert.equal(r.status, 301); assert.equal(r.headers.get('Location'), 'https://res.cloudinary.com/fixture/image/upload/test.png');
  }
  for (const path of ['missing.png', 'unsafe.png']) assert.equal((await worker.fetch(new Request('https://shop.test/wp-content/uploads/' + path), env, {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://shop.test/wp-content/uploads/test.png', { method: 'POST' }), env, {})).status, 405);
  globalThis.fetch = originFetch;
});

test("WordPress search and approved numeric links redirect without forwarding to the API", async () => {
  const { worker } = await fixture();
  const paths = [];
  const env = { ASSETS: { fetch: async request => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return path === "/legacy-ids.json" ? Response.json({ "10": "/product/pressure-cooker/" }) : new Response("Not found", { status: 404 });
  } } };
  const get = path => worker.fetch(new Request("https://shop.test" + path), env, {});
  const search = await get("/?s=চাল+rice&redirect=https://unrelated.test");
  assert.equal(search.status, 301);
  assert.equal(search.headers.get("Location"), "/search/?q=%E0%A6%9A%E0%A6%BE%E0%A6%B2+rice");
  assert.equal((await get("/index.php?page_id=10")).headers.get("Location"), "/product/pressure-cooker/");
  assert.equal((await get("/?p=999")).status, 404);
  assert.deepEqual(paths, ["/legacy-ids.json", "/legacy-ids.json", "/index.php"]);
});

test("API errors include a Worker-assigned request reference and safe retry guidance", async () => {
  const { worker } = await fixture();
  let forwarded;
  globalThis.fetch = async (_url, options) => {
    forwarded = options.headers.get("X-Request-ID");
    return new Response("private provider error body", { status: 502, headers: { "Content-Type": "text/html" } });
  };
  const request = new Request("https://shop.test/api/ready", { headers: {"X-Request-ID":"untrusted"} });
  const res = await worker.fetch(request, { API_ORIGIN:"https://api.test", ORIGIN_SECRET:"fixture" }, {});
  assert.equal(res.status,503);
  assert.equal(res.headers.get("Retry-After"),"60");
  assert.match(forwarded,/^[a-f0-9]{32}$/);
  assert.equal(res.headers.get("X-Request-ID"),forwarded);
  assert.doesNotMatch(await res.text(),/private provider/);
});

test("publication invalidates stock cache without letting URL queries choose the cache key", async () => {
  const { worker } = await fixture();
  let release = "a".repeat(32);
  const env = {
    API_ORIGIN: "https://api.test", ORIGIN_SECRET:"fixture",
    ASSETS: { fetch: async () => Response.json({id: release}) },
  };
  let upstream = 0;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).search, "");
    return Response.json({products:{1:[++upstream,100,5]}},{headers:{"Cache-Control":"public, max-age=60"}});
  };
  const request = query => worker.fetch(new Request("https://shop.test/api/stock" + query),env,{});
  assert.equal((await (await request("?release=spoof")).json()).products[1][0],1);
  assert.equal((await (await request("?release=another")).json()).products[1][0],1);
  release = "b".repeat(32);
  assert.equal((await (await request("")).json()).products[1][0],2);
});

test("a sleeping origin's success-status HTML is not cached as stock", async () => {
  const f = await fixture();
  globalThis.fetch = async () => new Response("<html>Starting</html>", {headers:{"Content-Type":"text/html"}});
  assert.equal((await f.request()).status, 503);
  assert.equal(f.entries.size, 0);
});
