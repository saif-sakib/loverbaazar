// Forwards /api/* to the Go API. Static pages never run this code.
const forward = (request, env, url, init = {}) => {
  const headers = new Headers(request.headers);
  headers.set("X-Shop-Host", new URL(request.url).host);
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
const staleKey = (key) => new Request(key.url.replace("/api/stock", "/api/stock-stale"));
const globalStaleKey = (originURL) => new Request(new URL("/api/stock-stale", originURL));
const stockForegroundMs = (env) => Number(env?.STOCK_FOREGROUND_MS) || 5000;
const stockUpstreamMs = (env) => Number(env?.STOCK_UPSTREAM_MS) || 28000;

function waitWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  return Promise.race([
    promise.then((value) => ({ done: true, value })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

async function findStale(cache, key, globalStale) {
  const releaseStale = staleKey(key);
  const direct = await cache.match(releaseStale).catch(() => undefined);
  if (direct) return direct;
  if (globalStale && globalStale.url !== releaseStale.url) {
    return cache.match(globalStale).catch(() => undefined);
  }
  return undefined;
}

function publicStockRequest(request, originURL) {
  const headers = new Headers({ Accept: "application/json" });
  for (const name of ["X-Request-ID", "CF-Connecting-IP"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request(originURL, { method: "GET", headers });
}

async function stockKey(env, url) {
  const key = new URL(url);
  try {
    const metadata = await env.ASSETS.fetch(new Request(new URL("/release.json", url)));
    if (metadata.ok) {
      const { id } = await metadata.json();
      if (/^[a-f0-9]{32}$/i.test(id)) key.searchParams.set("release", id);
    }
  } catch { /* Local fixtures and older artifacts can fall back to the default cache. */ }
  return new Request(key);
}

// Share an origin request while it is in flight, including across background refreshes.
const pendingStock = new Map();
function refreshStock(request, env, originURL, cache, key, globalStale = globalStaleKey(originURL)) {
  if (pendingStock.has(key.url)) return pendingStock.get(key.url);
  const pending = (async () => {
    let res;
    try {
      res = await forward(publicStockRequest(request, originURL), env, originURL, { signal: AbortSignal.timeout(stockUpstreamMs(env)) });
      if (res.ok && res.headers.get("Content-Type")?.includes("application/json")) {
        const body = await res.text();
        const freshHeaders = new Headers(res.headers);
        freshHeaders.set("Content-Type", "application/json");
        freshHeaders.set("Cache-Control", res.headers.get("Cache-Control") || "public, max-age=60");
        const fresh = new Response(body, { status: res.status, headers: freshHeaders });

        const staleHeaders = new Headers(freshHeaders);
        staleHeaders.set("Cache-Control", "public, max-age=86400");
        const releaseStale = staleKey(key);
        const writes = [
          cache.put(key, fresh.clone()),
          cache.put(releaseStale, new Response(body, { status: res.status, headers: staleHeaders })),
        ];
        if (globalStale && globalStale.url !== releaseStale.url) {
          writes.push(cache.put(globalStale, new Response(body, { status: res.status, headers: staleHeaders })));
        }
        await Promise.all(writes).catch(() => {});
        return fresh;
      }
    } catch {
      // An asleep or unavailable origin must not interrupt cached browsing.
    }
    const saved = await findStale(cache, key, globalStale);
    if (saved) {
      const body = await saved.text();
      const headers = new Headers(saved.headers);
      headers.set("Content-Type", "application/json");
      // Briefly cache the fallback too, so a sleeping API is not retried on every visit.
      // Do not extend the day-long stale copy's lifetime.
      headers.set("Cache-Control", "public, max-age=15");
      headers.set("X-Stock-Stale", "1");
      const fallback = new Response(body, { status: 200, headers });
      await cache.put(key, fallback.clone()).catch(() => {});
      return fallback;
    }
    if (res && !res.ok) {
      const text = await res.text().catch(() => "");
      return new Response(text, { status: res.status, headers: res.headers });
    }
    await res?.body?.cancel().catch(() => {});
    return busy(503);
  })().finally(() => pendingStock.delete(key.url));
  pendingStock.set(key.url, pending);
  return pending;
}

async function stock(request, env, url, ctx) {
  // Stock is public and independent of query strings, cookies and user identity.
  // Use one cache entry so arbitrary query strings cannot bypass the cache.
  const originURL = new URL("/api/stock", url.origin);
  const key = await stockKey(env, originURL);
  const globalStale = globalStaleKey(originURL);
  const cache = caches.default;
  const hit = await cache.match(key).catch(() => undefined);
  if (hit) return hit;
  const saved = await cache.match(staleKey(key)).catch(() => undefined);
  if (saved) {
    ctx?.waitUntil?.(refreshStock(request, env, originURL, cache, key, globalStale));
    const copy = new Response(saved.body, saved);
    copy.headers.set("Cache-Control", "no-store");
    copy.headers.set("X-Stock-Stale", "1");
    return copy; // do not make the customer wait for the API to wake up
  }
  const pending = refreshStock(request, env, originURL, cache, key, globalStale);
  ctx?.waitUntil?.(pending);
  const raced = await waitWithin(pending, stockForegroundMs(env));
  if (raced.done) return raced.value.clone();
  if (globalStale.url !== staleKey(key).url) {
    const prior = await cache.match(globalStale).catch(() => undefined);
    if (prior) {
      const copy = new Response(prior.body, prior);
      copy.headers.set("Cache-Control", "no-store");
      copy.headers.set("X-Stock-Stale", "1");
      return copy;
    }
  }
  return busy(503, 5);
}

// Only the homepage and old WP entry points enter the Worker for query links.
async function legacyEntry(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request);
  const query = url.searchParams;
  const redirect = to => new Response(null, { status: 301, headers: { Location: to, "Cache-Control": "public, max-age=3600" } });
  if (query.has("s")) {
    const search = query.get("s").trim().slice(0, 160);
    if (search) return redirect("/search/?" + new URLSearchParams({ q: search }));
  }
  const idParam = ["p", "page_id", "product_id"].find(name => query.has(name));
  if (idParam) {
    const id = query.get(idParam);
    if (/^[1-9]\d{0,15}$/.test(id)) {
      try {
        const response = await env.ASSETS.fetch(new Request(new URL("/legacy-ids.json", url)));
        const to = response.ok ? (await response.json())[id] : undefined;
        if (typeof to === "string" && /^\/(?!\/)[^?\\#]*\/$/.test(to)) return redirect(to);
      } catch { /* Treat the missing lookup as an unresolved legacy URL. */ }
    }
    return env.ASSETS.fetch(new Request(new URL("/index.php", url), { method: request.method }));
  }
  return env.ASSETS.fetch(request);
}

async function apiResponse(request, env, url, ctx) {
  const id = crypto.randomUUID().replaceAll("-", "");
  const headers = new Headers(request.headers);
  headers.set("X-Request-ID", id);
  const upstreamRequest = new Request(request, {headers});
  let response;
  try {
    response = url.pathname === "/api/stock" && request.method === "GET"
      ? await stock(upstreamRequest, env, url, ctx)
      : await forward(upstreamRequest, env, url);
    const type = response.headers.get("Content-Type") || "";
    const expectsJSON = url.pathname !== "/api/health" && url.pathname !== "/api/admin/orders.csv";
    if ((!response.ok || expectsJSON) && !type.includes("application/json")) {
      const status = response.status === 429 ? 429 : 503;
      await response.body?.cancel().catch(() => {});
      response = busy(status);
    }
  } catch {
    response = busy(503);
  }
  const result = new Response(response.body, response);
  result.headers.set("X-Request-ID", id);
  return result;
}

function busy(status, retryAfter = status === 429 ? 30 : 60) {
  return Response.json({ error: status === 429
    ? "Too many attempts. Please wait before trying again."
    : "The shop is busy right now. Please try again in a minute." }, {
    status, headers: {"Cache-Control": "no-store", "Retry-After": String(retryAfter)},
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.php") return legacyEntry(request, env, url);
    if (!url.pathname.startsWith("/api/")) {
      if (!url.pathname.startsWith("/wp-content/")) return env.ASSETS.fetch(request);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      try {
        const mapResponse = await env.ASSETS.fetch(new Request(new URL("/legacy-assets.json", url)));
        if (mapResponse.ok) {
          const map = await mapResponse.json();
          const target = map[url.pathname];
          if (typeof target === "string") {
            const destination = new URL(target);
            if (destination.protocol === "https:" && destination.hostname === "res.cloudinary.com" && !destination.username && !destination.password) return new Response(null, { status: 301, headers: { Location: destination.href, "Cache-Control": "public, max-age=3600" } });
          }
        }
      } catch { /* Unmapped or invalid assets keep their real static 404. */ }
      return env.ASSETS.fetch(request);
    }
    return apiResponse(request, env, url, ctx);
  },
  // Existing schedules can be removed in the dashboard. No automatic keep-awake traffic.
  scheduled() {},
};
