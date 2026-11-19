// Submits canonical production sitemap URLs to IndexNow after Cloudflare promotion.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entityMap = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXML = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => entityMap[name]);

export function isValidIndexNowKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9-]{8,128}$/.test(key) && key.toLowerCase() !== "robots";
}

export function validateProductionOrigin(siteOrigin, storeURL = "") {
  if (!siteOrigin) throw new Error("Missing SITE_ORIGIN for IndexNow");
  let url;
  try {
    url = new URL(siteOrigin);
  } catch {
    throw new Error("Invalid SITE_ORIGIN for IndexNow");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.href !== url.origin + "/" || url.username || url.password) {
    throw new Error("SITE_ORIGIN must be a bare HTTPS origin");
  }
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".workers.dev") ||
    host.endsWith(".local")
  ) {
    throw new Error(`Refusing IndexNow submission for non-production host: ${host}`);
  }
  if (storeURL) {
    let store;
    try {
      store = new URL(storeURL);
    } catch {
      throw new Error("Invalid STORE_URL for IndexNow");
    }
    if (store.origin !== url.origin) {
      throw new Error("STORE_URL origin does not match SITE_ORIGIN");
    }
  }
  return url;
}

export function extractSitemapUrls(xmlText, expectedOrigin) {
  const origin = new URL(expectedOrigin).origin;
  const urls = [];
  const seen = new Set();
  for (const match of xmlText.matchAll(/<loc>([\s\S]*?)<\/loc>/g)) {
    const raw = unescapeXML(match[1].trim());
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("Sitemap contains an invalid URL");
    }
    if (parsed.origin !== origin) {
      throw new Error(`Sitemap URL origin mismatch: expected ${origin}, got ${parsed.origin}`);
    }
    if (!seen.has(parsed.href)) {
      seen.add(parsed.href);
      urls.push(parsed.href);
    }
  }
  return urls;
}

export async function collectProductionUrls(distDir, siteOrigin) {
  const origin = new URL(siteOrigin).origin;
  const indexXML = await readFile(join(distDir, "sitemap-index.xml"), "utf8");
  const childSitemaps = extractSitemapUrls(indexXML, origin);
  const urls = [];
  const seen = new Set();
  for (const childURL of childSitemaps) {
    const { pathname } = new URL(childURL);
    if (!/^\/sitemap-\d+\.xml$/.test(pathname)) {
      throw new Error(`Unexpected child sitemap path: ${pathname}`);
    }
    const childXML = await readFile(join(distDir, pathname.slice(1)), "utf8");
    for (const pageURL of extractSitemapUrls(childXML, origin)) {
      if (!seen.has(pageURL)) {
        seen.add(pageURL);
        urls.push(pageURL);
      }
    }
  }
  return urls;
}

export async function verifyKeyFile({ siteOrigin, key, fetchImpl = fetch }) {
  if (!isValidIndexNowKey(key)) throw new Error("Invalid IndexNow key");
  const origin = validateProductionOrigin(siteOrigin);
  const keyURL = new URL(`/${key}.txt`, origin);
  const response = await fetchImpl(keyURL, {
    cache: "no-store",
    redirect: "error",
    headers: { "User-Agent": "loverbaazar-release/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`IndexNow key file verification returned HTTP ${response.status}`);
  }
  const body = (await response.text()).trim();
  if (body !== key) {
    throw new Error("IndexNow key file content does not match the configured key");
  }
}

export async function submitIndexNow({
  siteOrigin,
  key,
  urls,
  endpoint = "https://api.indexnow.org/indexnow",
  batchSize = 10000,
  fetchImpl = fetch,
  verifyKey = true,
  report = console.log,
}) {
  if (!isValidIndexNowKey(key)) throw new Error("Invalid IndexNow key");
  const origin = validateProductionOrigin(siteOrigin);
  const list = [];
  const seen = new Set();
  for (const entry of urls) {
    let parsed;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error("Invalid URL in IndexNow submission list");
    }
    if (parsed.origin !== origin.origin) {
      throw new Error(`URL origin mismatch: expected ${origin.origin}, got ${parsed.origin}`);
    }
    if (!seen.has(parsed.href)) {
      seen.add(parsed.href);
      list.push(parsed.href);
    }
  }
  if (!list.length) return { ok: true, submitted: 0, batches: 0 };
  if (verifyKey) await verifyKeyFile({ siteOrigin: origin.href, key, fetchImpl });

  const size = Math.min(Math.max(1, Number(batchSize) || 10000), 10000);
  const batches = [];
  for (let i = 0; i < list.length; i += size) {
    batches.push(list.slice(i, i + size));
  }
  const keyLocation = new URL(`/${key}.txt`, origin).href;
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "loverbaazar-release/1.0",
      },
      body: JSON.stringify({ host: origin.host, key, keyLocation, urlList: batch }),
      signal: AbortSignal.timeout(20000),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`IndexNow batch ${index + 1}/${batches.length} returned HTTP ${response.status}`);
    }
    report(`IndexNow batch ${index + 1}/${batches.length}: submitted ${batch.length} URLs for ${origin.host} (HTTP ${response.status}).`);
  }
  return { ok: true, submitted: list.length, batches: batches.length };
}

async function main() {
  const buildEnv = process.env.BUILD_ENV || "preview";
  const key = (process.env.INDEXNOW_KEY || "").trim();
  if (buildEnv !== "production" || !key) {
    console.log("Skipping IndexNow notification (non-production build or INDEXNOW_KEY unset).");
    return;
  }
  const origin = validateProductionOrigin(process.env.SITE_ORIGIN, process.env.STORE_URL || "");
  const distDir = resolve(process.env.DIST_DIR || "dist");
  const urls = await collectProductionUrls(distDir, origin.href);
  await submitIndexNow({ siteOrigin: origin.href, key, urls });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "IndexNow submission failed.");
    process.exitCode = 1;
  }
}
