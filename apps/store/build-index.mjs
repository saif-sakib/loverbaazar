import { readFile, writeFile } from "node:fs/promises";

const escapeXML = s => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const xml = content => `<?xml version="1.0" encoding="UTF-8"?>\n${content}\n`;
const namespace = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
const allowedPath = /^\/(?!\/)(?:[\p{L}\p{M}\p{N}a-z0-9._~%/-])*$/iu;

function cleanPath(value, site) {
  if (!allowedPath.test(value) || /%(?:2f|5c)/i.test(value)) throw new Error(`Invalid legacy path: ${value}`);
  const decoded = decodeURIComponent(value);
  if (decoded.includes("%") || !allowedPath.test(decoded) || decoded.split("/").some(part => part === "." || part === "..")) throw new Error(`Invalid legacy path: ${value}`);
  return new URL(decoded, site).pathname;
}

export async function buildIndex(dir, pages, site, environment, { indexNowKey = "" } = {}) {
  const production = environment === "production";
  const key = String(indexNowKey ?? "").trim();
  if (key && (!/^[A-Za-z0-9-]{8,128}$/.test(key) || key.toLowerCase() === "robots")) {
    throw new Error("INDEXNOW_KEY must be 8–128 ASCII letters, digits or hyphens");
  }
  const write = (filename, body) => writeFile(new URL(filename, dir), body);
  const generated = new Map();
  for (const { pathname } of pages) {
    if (pathname === "404" || pathname === "404/") continue;
    const path = new URL(`/${pathname ? pathname.replace(/\/$/, "") + "/" : ""}`, site).pathname;
    const html = await readFile(new URL(`.${path}index.html`, dir), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    const canonical = head.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    const robots = head.match(/<meta name="robots" content="([^"]+)"/)?.[1] || "";
    generated.set(path, { canonical, indexable: !!canonical && !/\bnoindex\b/i.test(robots) });
  }

  if (production) {
    const urls = [];
    for (const [path, entry] of generated) {
      if (!entry.indexable) continue;
      const own = new URL(path, site).href;
      if (entry.canonical === own) {
        urls.push(own);
      } else {
        const target = new URL(entry.canonical);
        const destination = generated.get(target.pathname);
        if (target.origin !== site.origin || !destination?.indexable || destination.canonical !== target.href) {
          throw new Error(`Canonical must point directly to a public indexable page: ${path} → ${entry.canonical}`);
        }
      }
    }
    const sitemaps = [];
    urls.sort();
    for (let start = 0; start < urls.length; start += 1000) {
      const file = `sitemap-${start / 1000}.xml`;
      sitemaps.push(file);
      await write(file, xml(`<urlset ${namespace}>${urls.slice(start, start + 1000).map(url => `<url><loc>${escapeXML(url)}</loc></url>`).join("")}</urlset>`));
    }
    await write("sitemap-index.xml", xml(`<sitemapindex ${namespace}>${sitemaps.map(file => `<sitemap><loc>${escapeXML(new URL(file, site).href)}</loc></sitemap>`).join("")}</sitemapindex>`));
  }

  // Discover noindex utility pages in production so crawlers can see their directive.
  await write("robots.txt", production ? `User-agent: *\nDisallow: /api/\nSitemap: ${new URL("sitemap-index.xml", site).href}\n` : "User-agent: *\nDisallow: /\n");
  const legacy = JSON.parse(await readFile(new URL("./legacy-urls.json", import.meta.url), "utf8"));
  const aliases = new Map();
  for (const [source, target] of Object.entries(legacy.paths)) {
    const from = cleanPath(source, site);
    const to = cleanPath(target, site);
    if (!production && to === "/sitemap-index.xml") continue;
    if (generated.has(from) || aliases.has(from) || from === to) throw new Error(`Legacy alias collides with an existing route: ${from}`);
    if (to === "/sitemap-index.xml" || to === "/feed.xml" || to === "/blog/feed.xml" || generated.has(to)) {
      aliases.set(from, to);
      if (from.endsWith("/") && from.length > 1) {
        const withoutSlash = from.slice(0, -1);
        if (aliases.has(withoutSlash)) throw new Error(`Legacy alias already covers ${withoutSlash}`);
        aliases.set(withoutSlash, to);
      }
    }
    else if (production) throw new Error(`Legacy alias has no built destination: ${from} → ${to}`);
  }
  for (const to of aliases.values()) {
    if (aliases.has(to)) throw new Error(`Legacy alias chain: ${to}`);
  }
  if (aliases.size > 2000) throw new Error("Cloudflare Static Assets allows 2000 exact redirects");
  await write("_redirects", [...aliases].map(([from, to]) => `${from} ${to} 301`).join("\n") + "\n");
  const ids = {};
  for (const [id, target] of Object.entries(legacy.ids)) {
    const to = cleanPath(target, site);
    if (!/^[1-9]\d{0,15}$/.test(id)) throw new Error(`Invalid legacy post ID: ${id}`);
    if (generated.has(to)) ids[id] = to;
    else if (production) throw new Error(`Legacy ID has no built destination: ${id} → ${to}`);
  }
  await write("legacy-ids.json", JSON.stringify(ids));
  if (production && key) {
    const keyPath = `/${key}.txt`;
    if (generated.has(keyPath) || aliases.has(keyPath)) {
      throw new Error(`IndexNow key file collides with an existing route: ${keyPath}`);
    }
    await write(`${key}.txt`, key);
  }
}
