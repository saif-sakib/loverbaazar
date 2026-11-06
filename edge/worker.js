// Forwards /api/* to Lambda with a secret header. Everything else is served as static files without running this code.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.API_ORIGIN);
    const headers = new Headers(request.headers);
    headers.set("X-Origin-Secret", env.ORIGIN_SECRET);
    return fetch(target, { method: request.method, headers, body: request.body, redirect: "manual" });
  },
};
