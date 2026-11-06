// Forwards /api/* to the Go API. Static pages never run this code.
const forward = (request, env, url) => {
  const headers = new Headers(request.headers);
  headers.set("X-Origin-Secret", env.ORIGIN_SECRET);
  return fetch(new URL(url.pathname + url.search, env.API_ORIGIN), { method: request.method, headers, body: request.body, redirect: "manual" });
};
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/stock") return forward(request, env, url);
    const hit = await caches.default.match(request); // one API call a minute at most, however busy the shop is
    if (hit) return hit;
    const res = await forward(request, env, url);
    if (res.ok) ctx.waitUntil(caches.default.put(request, res.clone()));
    return res;
  },
  // Render sleeps after 15 idle minutes. /api/health does not touch the database, so Neon still sleeps.
  scheduled(_e, env, ctx) {
    ctx.waitUntil(fetch(env.API_ORIGIN + "/api/health", { headers: { "X-Origin-Secret": env.ORIGIN_SECRET } }));
  },
};
