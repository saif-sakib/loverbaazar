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
product.sku = "Fixture SKU";
product.attrs = [{ name: "Brand", values: ["Fixture Brand"] }];
const productURL = `https://loverbaazar.com/product/${encodeURIComponent(product.slug)}/`;
const noindex = { slug: "seo-hidden-fixture", title: "Indexing fixture", html: "<p>One paragraph.</p>", seo: { robots: ["noindex"] } };
const duplicate = { slug: "seo-duplicate-fixture", title: "Duplicate fixture", html: "<p>One paragraph.</p>", seo: { canonical_url: "/" } };
store.pages.push(noindex, duplicate, { slug: "seo-draft-fixture", title: "Draft fixture", html: "<p>Private</p>", draft: true });
if (!store.cats.some(c => c.slug === "rice-cooker")) store.cats.push({ slug: "rice-cooker", name: "Rice Cooker", path: "rice-cooker" });
if (!store.cats.some(c => c.slug === "latest-product")) store.cats.push({ slug: "latest-product", name: "Latest Products", path: "latest-product" });
if (!store.tags.some(t => t.slug === "thin-fixture-tag")) store.tags.push({ slug: "thin-fixture-tag", name: "Thin Fixture Tag" });
const riceCookerFixture = {
  ...products[0],
  id: 9000002,
  slug: "fixture-rice-cooker-18l",
  name: "Fixture Kiam Rice Cooker 1.8L",
  short: "Double pot rice cooker for 4 to 6 people.",
  desc: "<p>Stainless body rice cooker.</p>",
  price: 1450,
  regular: 1900,
  condition: "new",
  inStock: true,
  cats: ["latest-product", "rice-cooker"],
  tags: ["thin-fixture-tag"],
  images: [{ src: "/logo/primary-logo.jpg" }],
  attrs: [{ name: "Brand", values: ["Kiam"] }],
  reviews: [],
  seo: {},
};
products.unshift(product);
products.push(riceCookerFixture);
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
const entities = html => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
  .map(match => JSON.parse(match[1]));

try {
  await build("production", "production");
  const home = await read("production", "index.html");
  assert.match(home, /<title>Lover Baazar \| [^<]+<\/title>/);
  assert.match(home, /<meta name="description" content="Lover Baazar in Vekutia, Jashore\. /);
  assert.match(home, /<meta property="og:site_name" content="Lover Baazar">/);
  const headings = [...home.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
  assert.equal(headings.length, 1);
  assert.equal(headings[0][1].replace(/<[^>]+>/g, "").trim(), "Lover Baazar");
  assert.match(home, /<strong lang="en-BD">Everything for your home, at wholesale prices\.<\/strong>/);
  assert.match(home, /<link rel="canonical" href="https:\/\/loverbaazar.com\/">/);
  assert.match(home, /<meta name="robots" content="index, follow/);
  const homeEntities = entities(home);
  const websites = homeEntities.filter(item => item["@type"] === "WebSite");
  const shops = homeEntities.filter(item => item["@type"] === "Store");
  assert.equal(websites.length, 1);
  assert.equal(shops.length, 1);
  assert.equal(websites[0].name, "Lover Baazar");
  assert.equal(websites[0].alternateName, "LoverBaazar");
  assert.equal(shops[0].name, "LoverBaazar");
  assert.equal(shops[0].alternateName, "Lover Baazar");
  assert.equal(websites[0].url, "https://loverbaazar.com/");
  assert.equal(shops[0].url, "https://loverbaazar.com/");
  assert.equal(websites[0].publisher["@id"], shops[0]["@id"]);
  assert.deepEqual(shops[0].hasMerchantReturnPolicy, {
    "@type": "MerchantReturnPolicy", merchantReturnLink: "https://loverbaazar.com/terms-conditions/",
  });
  const page = await read("production", `product/${product.slug}/index.html`);
  const htmlLD = entities(page);
  assert.ok(!htmlLD.some(item => ["WebSite", "Store"].includes(item["@type"])));
  const productLD = htmlLD.find(item => item["@type"] === "Product");
  assert.equal(productLD.offers.price, 1250);
  assert.equal(productLD.offers.availability, "https://schema.org/InStock");
  assert.equal(productLD.offers.url, productURL);
  assert.equal(productLD.offers.seller["@id"], shops[0]["@id"]);
  assert.equal(productLD.gtin, product.gtin);
  assert.equal(productLD.brand.name, "Fixture Brand");
  assert.equal(productLD.image[0], "https://loverbaazar.com/logo/primary-logo.jpg");
  for (const key of ["sku", "aggregateRating", "review"]) assert.ok(!(key in productLD));
  assert.match(page, /SKU: Fixture SKU/);
  assert.match(page, /href="https:\/\/loverbaazar.com\/terms-conditions\/">Returns and exchanges<\/a>/);
  assert.match(page, /<title>পরীক্ষার দোকান<\/title>/);
  assert.match(page, /lang="bn-BD"/);
  assert.ok(/content="বাংলা বিবরণ (?:&amp;|&#38;) তথ্য"/.test(page), "SEO description is escaped plain text");
  assert.match(page, /<h1[^>]*>বাংলা পরীক্ষার পণ্য<\/h1>/);
  const sitemap = await read("production", "sitemap-0.xml");
  assert.equal(sitemap.match(/<loc>https:\/\/loverbaazar.com\/<\/loc>/g)?.length, 1);
  assert.ok(sitemap.includes(productURL));
  assert.doesNotMatch(sitemap, /\/(admin|cart|checkout|search|track|wishlist|my-account|404|seo-hidden-fixture|seo-duplicate-fixture|seo-draft-fixture)\//);
  assert.match(await read("production", "seo-hidden-fixture/index.html"), /noindex, follow/);
  await assert.rejects(read("production", "seo-draft-fixture/index.html"), { code: "ENOENT" });
  const riceCat = await read("production", "product-category/rice-cooker/index.html");
  assert.match(riceCat, /<title>Rice Cooker Price in Bangladesh \| Lover Baazar<\/title>/);
  assert.match(riceCat, /<h1[^>]*>Rice Cooker Price in Bangladesh<\/h1>/);
  assert.match(riceCat, /<meta name="description" content="Compare \d+ Rice Cooker prices in Bangladesh [^"]*৳[^"]*Lover Baazar/);
  const riceCatLD = entities(riceCat).find(item => item["@type"] === "CollectionPage");
  assert.ok(riceCatLD && riceCatLD.mainEntity["@type"] === "ItemList" && riceCatLD.mainEntity.numberOfItems >= 1);
  assert.match(riceCat, /Rice Cooker Price List in Bangladesh/);
  assert.match(riceCat, /<table class="price-table">[\s\S]*Fixture Kiam Rice Cooker 1\.8L/);
  const rcPage = await read("production", "product/fixture-rice-cooker-18l/index.html");
  assert.match(rcPage, /<title>Fixture Kiam Rice Cooker 1\.8L Price in Bangladesh \| Lover Baazar<\/title>/);
  assert.match(rcPage, /<meta name="description" content="Fixture Kiam Rice Cooker 1\.8L price in Bangladesh is ৳1,450 at Lover Baazar\./);
  const rcLD = entities(rcPage);
  const rcProductLD = rcLD.find(item => item["@type"] === "Product");
  assert.equal(rcProductLD.category, "Rice Cooker");
  assert.equal(rcProductLD.offers.itemCondition, "https://schema.org/NewCondition");
  assert.equal(rcProductLD.offers.hasMerchantReturnPolicy.merchantReturnLink, "https://loverbaazar.com/terms-conditions/");
  assert.equal(rcProductLD.offers.priceSpecification.price, 1900);
  assert.equal(rcProductLD.offers.priceSpecification.priceType, "https://schema.org/StrikethroughPrice");
  const rcCrumbs = rcLD.find(item => item["@type"] === "BreadcrumbList").itemListElement.map(item => item.name);
  assert.ok(rcCrumbs.includes("Rice Cooker") && !rcCrumbs.includes("Latest Products"));
  const shopHTML = await read("production", "shop/index.html");
  assert.match(shopHTML, /Browse categories/);
  const shopLD = entities(shopHTML).find(item => item["@type"] === "CollectionPage");
  assert.ok(shopLD && shopLD.mainEntity["@type"] === "ItemList" && shopLD.mainEntity.numberOfItems >= 2);
  const thinTag = await read("production", "product-tag/thin-fixture-tag/index.html");
  assert.match(thinTag, /noindex, follow/);
  assert.doesNotMatch(sitemap, /\/product-tag\/thin-fixture-tag\//);
  assert.ok(sitemap.includes("https://loverbaazar.com/product-category/rice-cooker/"));
  assert.ok(sitemap.includes("https://loverbaazar.com/product/fixture-rice-cooker-18l/"));
  assert.match(await read("production", "robots.txt"), /Sitemap: https:\/\/loverbaazar.com\/sitemap-index.xml/);
  assert.match(await read("production", "_redirects"), /^\/page-sitemap\.xml \/sitemap-index\.xml 301$/m);
  const productionHeaders = await read("production", "_headers");
  assert.match(productionHeaders, /https:\/\/:worker\.:account\.workers\.dev\/\*\n  X-Robots-Tag: noindex, nofollow/);
  assert.doesNotMatch(productionHeaders, /^\/\*\n  X-Robots-Tag:/m);
  const feed = await read("production", "feed.xml");
  assert.match(feed, /<g:sale_price>1250 BDT<\/g:sale_price>/);
  assert.match(feed, /<g:product_type>Rice Cooker<\/g:product_type>/);
  assert.match(feed, /<g:condition>new<\/g:condition>/);
  await run("python3", ["-c", "import sys,xml.etree.ElementTree as ET\nfor x in sys.argv[1:]: ET.parse(x)", ...["feed.xml", "blog/feed.xml", "sitemap-index.xml", "sitemap-0.xml"].map(f => join(work, "production", f))]);

  product.price = 999;
  product.inStock = false;
  product.sku = "  LB-0125  ";
  product.reviews = [{ name: "Fixture customer", rating: 5, body: "Review fixture" }];
  store.pages.find(page => page.slug === "terms-conditions").draft = true;
  await build("preview", "preview");
  const next = await read("preview", `product/${product.slug}/index.html`);
  const nextProduct = entities(next).find(item => item["@type"] === "Product");
  assert.equal(nextProduct.sku, "LB-0125");
  assert.equal(nextProduct.aggregateRating.reviewCount, 1);
  assert.equal(nextProduct.review[0].reviewBody, "Review fixture");
  assert.match(next, /Review fixture/);
  assert.doesNotMatch(next, /Returns and exchanges/);
  assert.match(next, /"price":999,"availability":"https:\/\/schema.org\/OutOfStock"/);
  assert.match(next, /<b>৳999<\/b>/);
  assert.match(await read("preview", "feed.xml"), /<g:sale_price>999 BDT<\/g:sale_price>\s*<g:availability>out_of_stock<\/g:availability>/);
  assert.match(await read("preview", "_headers"), /X-Robots-Tag: noindex, nofollow/);
  const previewHome = await read("preview", "index.html");
  assert.match(previewHome, /noindex, nofollow/);
  assert.ok(!entities(previewHome).find(item => item["@type"] === "Store").hasMerchantReturnPolicy);
  assert.doesNotMatch(await read("preview", "_redirects"), /page-sitemap\.xml/);
  assert.match(next, /noindex, nofollow/);
  await assert.rejects(read("preview", "sitemap-index.xml"), { code: "ENOENT" });
  const source = "https://res.cloudinary.com/test/image/upload/f_auto,q_auto,w_300/v100/loverbaazar/products/example.webp";
  assert.equal(sizedImage(source, 640), "https://res.cloudinary.com/test/image/upload/c_limit,w_640/q_auto/f_auto/v100/loverbaazar/products/example.webp");
  assert.match(responsiveImage(source, "", [160, 320, 640]).srcset, /640w$/);
  assert.equal(sizedImage("https://loverbaazar.com/photo.jpg", 640), "https://loverbaazar.com/photo.jpg");
  console.log("Homepage identity, production sitemap, canonical, Bangla SEO, structured offers, preview noindex, changed offer/feed and image widths passed.");
} finally {
  server.close();
  await rm(work, { recursive: true, force: true });
}
