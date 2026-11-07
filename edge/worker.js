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

async function stock(request, env, url, ctx) {
  const cache = caches.default;
  const hit = await cache.match(request); // one API call a minute at most, however busy the shop is
  if (hit) return hit;
  let res;
  try {
    res = await forward(request, env, url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const stale = new Response(res.clone().body, res);
      stale.headers.set("Cache-Control", "public, max-age=86400");
      ctx.waitUntil(Promise.all([cache.put(request, res.clone()), cache.put(staleKey(url), stale)]));
      return res;
    }
  } catch {
    // Timed out or unreachable: treated the same as an error answer below.
  }
  const saved = await cache.match(staleKey(url));
  if (saved) {
    const copy = new Response(saved.body, saved);
    copy.headers.set("Cache-Control", "no-store"); // the day-long life is for this cache, not for browsers
    return copy;
  }
  return res || new Response('{"error":"unavailable"}', { status: 503, headers: { "Content-Type": "application/json" } });
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
