// Reads the isolated fixture API and builds preview/production artifacts into temporary folders.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sizedImage, responsiveImage } from "../src/lib/image-delivery.mjs";

const assets = fileURLToPath(new URL("../", import.meta.url));
const fixture = new URL(process.env.SHOP_URL || "http://127.0.0.1:18788");
assert.equal(fixture.hostname, "127.0.0.1");
const readJSON = async path => {
  const response = await fetch(new URL(path, fixture));
  assert.ok(response.ok, path);
  return response.json();
};
const [products, store] = await Promise.all([readJSON("/api/catalog"), readJSON("/api/storefront")]);
const product = { ...products[0], id: 9000001, slug: "বিক্রয়-পরীক্ষা", name: "বাংলা পরীক্ষার পণ্য", short: "বাংলা বিবরণ ও তথ্য", desc: "<p>বাংলা পরীক্ষার পণ্য।</p>", price: 1250, regular: 1500, inStock: true, images: [{ src: "/logo/primary-logo.jpg" }], gtin: "012345678905", reviews: [], seo: { title: "পরীক্ষার দোকান", description: "<b>বাংলা বিবরণ</b> &amp; তথ্য", canonical_url: "http://www.loverbaazar.com/product/" + encodeURIComponent("বিক্রয়-পরীক্ষা").toLowerCase() } };
const productURL = `https://loverbaazar.com/product/${encodeURIComponent(product.slug)}/`;
const noindex = { slug: "seo-hidden-fixture", title: "Indexing fixture", html: "<p>One paragraph.</p>", seo: { robots: ["noindex"] } };
const duplicate = { slug: "seo-duplicate-fixture", title: "Duplicate fixture", html: "<p>One paragraph.</p>", seo: { canonical_url: "/" } };
store.pages.push(noindex, duplicate, { slug: "seo-draft-fixture", title: "Draft fixture", html: "<p>Private</p>", draft: true });
products.unshift(product);
const buildKey = "temporary-test-key";
const server = createServer((request, response) => {
  if (request.url !== "/api/build/fixture" || request.headers["x-build-key"] !== buildKey) return response.writeHead(404).end();
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ products, store }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const work = await mkdtemp(join(tmpdir(), "lb-seo-release-"));
const run = promisify(execFile);
const build = async (environment, dir) => {
  const env = { ...process.env, BUILD_ENV: environment, BUILD_ID: "fixture", BUILD_KEY: buildKey,
    SITE_ORIGIN: "https://loverbaazar.com", NO_COLOR: "1", PUBLIC_TURNSTILE_SITE: "test-site-key",
    CATALOG_URL: `http://127.0.0.1:${server.address().port}/api/catalog` };
  try {
    await run(process.execPath, ["node_modules/.bin/astro", "build", "--outDir", join(work, dir)], { cwd: assets, env, maxBuffer: 3_000_000 });
  } catch (error) {
    throw new Error(error.stdout?.split("\n").slice(-12).join("\n") + "\n" + error.stderr);
  }
};
const read = (dir, path) => readFile(join(work, dir, path), "utf8");

try {
  await build("production", "production");
  const page = await read("production", `product/${product.slug}/index.html`);
  const htmlLD = [...page.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(match => JSON.parse(match[1]));
  const offer = htmlLD.find(item => item["@type"] === "Product");
  assert.equal(offer.offers.price, 1250);
  assert.equal(offer.offers.availability, "https://schema.org/InStock");
  assert.equal(offer.offers.url, productURL);
  assert.equal(offer.gtin, product.gtin);
  assert.equal(offer.image[0], "https://loverbaazar.com/logo/primary-logo.jpg");
  assert.match(page, /<title>পরীক্ষার দোকান<\/title>/);
  assert.match(page, /lang="bn-BD"/);
  assert.ok(/content="বাংলা বিবরণ (?:&amp;|&#38;) তথ্য"/.test(page), "SEO description is escaped plain text");
  assert.match(page, /<h1[^>]*>বাংলা পরীক্ষার পণ্য<\/h1>/);
  const sitemap = await read("production", "sitemap-0.xml");
  assert.ok(sitemap.includes(productURL));
  assert.doesNotMatch(sitemap, /\/(admin|cart|checkout|search|track|wishlist|my-account|404|seo-hidden-fixture|seo-duplicate-fixture|seo-draft-fixture)\//);
  assert.match(await read("production", "seo-hidden-fixture/index.html"), /noindex, follow/);
  await assert.rejects(read("production", "seo-draft-fixture/index.html"), { code: "ENOENT" });
  assert.match(await read("production", "robots.txt"), /Sitemap: https:\/\/loverbaazar.com\/sitemap-index.xml/);
  const productionHeaders = await read("production", "_headers");
  assert.match(productionHeaders, /https:\/\/:worker\.:account\.workers\.dev\/\*\n  X-Robots-Tag: noindex, nofollow/);
  assert.doesNotMatch(productionHeaders, /^\/\*\n  X-Robots-Tag:/m);
  const feed = await read("production", "feed.xml");
  assert.match(feed, /<g:sale_price>1250 BDT<\/g:sale_price>/);
  await run("python3", ["-c", "import sys,xml.etree.ElementTree as ET\nfor x in sys.argv[1:]: ET.parse(x)", ...["feed.xml", "blog/feed.xml", "sitemap-index.xml", "sitemap-0.xml"].map(f => join(work, "production", f))]);

  product.price = 999;
  product.inStock = false;
  await build("preview", "preview");
  const next = await read("preview", `product/${product.slug}/index.html`);
  assert.match(next, /"price":999,"availability":"https:\/\/schema.org\/OutOfStock"/);
  assert.match(next, /<b>৳999<\/b>/);
  assert.match(await read("preview", "feed.xml"), /<g:sale_price>999 BDT<\/g:sale_price>\s*<g:availability>out_of_stock<\/g:availability>/);
  assert.match(await read("preview", "_headers"), /X-Robots-Tag: noindex, nofollow/);
  assert.match(next, /noindex, nofollow/);
  await assert.rejects(read("preview", "sitemap-index.xml"), { code: "ENOENT" });
  const source = "https://res.cloudinary.com/test/image/upload/f_auto,q_auto,w_300/v100/loverbaazar/products/example.webp";
  assert.equal(sizedImage(source, 640), "https://res.cloudinary.com/test/image/upload/c_limit,w_640/q_auto/f_auto/v100/loverbaazar/products/example.webp");
  assert.match(responsiveImage(source, "", [160, 320, 640]).srcset, /640w$/);
  assert.equal(sizedImage("https://loverbaazar.com/photo.jpg", 640), "https://loverbaazar.com/photo.jpg");
  console.log("Production sitemap, canonical, Bangla SEO, structured offers, preview noindex, changed offer/feed and image widths passed.");
} finally {
  server.close();
  await rm(work, { recursive: true, force: true });
}
