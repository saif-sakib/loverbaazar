// Forwards /api/* to the Go API. Static pages never run this code.
const forward = (request, env, url, init = {}) => {
  const headers = new Headers(request.headers);
  headers.delete("Host"); // Render routes by host name, so it must see its own
  headers.set("X-Origin-Secret", env.ORIGIN_SECRET);
  // Set here, not read from the browser, so nobody can dodge the API's rate limits.
  headers.set("X-Client-IP", request.headers.get("CF-Connecting-IP") || "");
  return fetch(new URL(url.pathname + url.search, env.API_ORIGIN), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    ...init,
  });
};

// Kept for a day: if the API is asleep or down, browsers still get recent prices straight away.
const staleKey = (url) => new Request(url.origin + "/api/stock-stale");

// Share an origin request while it is in flight, including across background refreshes.
const pendingStock = new Map();
function refreshStock(request, env, url, cache, key) {
  if (pendingStock.has(key.url)) return pendingStock.get(key.url);
  const pending = (async () => {
    let res;
    try {
      res = await forward(request, env, url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const stale = new Response(res.clone().body, res);
        stale.headers.set("Cache-Control", "public, max-age=86400");
        await Promise.all([cache.put(key, res.clone()), cache.put(staleKey(url), stale)]).catch(() => {});
        return res;
      }
    } catch {
      // An asleep or unavailable origin must not interrupt cached browsing.
    }
    const saved = await cache.match(staleKey(url)).catch(() => undefined);
    if (saved) {
      const fallback = new Response(saved.body, saved);
      // Briefly cache the fallback too, so a sleeping API is not retried on every visit.
      // Do not extend the day-long stale copy's lifetime.
      fallback.headers.set("Cache-Control", "public, max-age=15");
      fallback.headers.set("X-Stock-Stale", "1");
      await cache.put(key, fallback.clone()).catch(() => {});
      return fallback;
    }
    return res || new Response('{"error":"unavailable"}', { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  })().finally(() => pendingStock.delete(key.url));
  pendingStock.set(key.url, pending);
  return pending;
}

async function stock(request, env, url, ctx) {
  // Stock is public and independent of query strings, cookies and user identity.
  // Use one cache entry so arbitrary query strings cannot bypass the cache.
  const originURL = new URL("/api/stock", url.origin);
  const key = new Request(originURL);
  const cache = caches.default;
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return hit;
  const saved = await cache.match(staleKey(originURL)).catch(() => undefined);
  if (saved) {
    ctx.waitUntil(refreshStock(request, env, originURL, cache, key));
    const copy = new Response(saved.body, saved);
    copy.headers.set("Cache-Control", "no-store");
    copy.headers.set("X-Stock-Stale", "1");
    return copy; // do not make the customer wait for the API to wake up
  }
  return (await refreshStock(request, env, originURL, cache, key)).clone();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/stock" && request.method === "GET") return stock(request, env, url, ctx);
    try {
      return await forward(request, env, url);
    } catch {
      return new Response('{"error":"The shop is busy right now. Please try again in a minute."}', {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
  // Render sleeps after 15 idle minutes. /api/health does not touch the database, so Neon still sleeps.
  scheduled(_e, env, ctx) {
    ctx.waitUntil(fetch(env.API_ORIGIN + "/api/health", { headers: { "X-Origin-Secret": env.ORIGIN_SECRET } }));
  },
};
