// Reads the isolated fixture API and builds preview/production artifacts into temporary folders.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
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
  short: "Cash on delivery available. Delivery time 4-7 days. Free delivery in Jashore. Delivery available only in Jashore. Double pot rice cooker for 4 to 6 people.",
  desc: "<p>Stainless body rice cooker.</p>",
  price: 1450,
  regular: 1900,
  condition: "new",
  inStock: true,
  cats: ["latest-product", "rice-cooker"],
  tags: ["thin-fixture-tag"],
  images: [
    { src: "https://res.cloudinary.com/test/image/upload/f_auto,q_auto/loverbaazar/products/rice-cooker/fixture-rice-cooker-18l-1.jpg" },
    { src: "https://res.cloudinary.com/test/image/upload/f_auto,q_auto/loverbaazar/products/rice-cooker/fixture-rice-cooker-18l-2.jpg" },
  ],
  attrs: [{ name: "Brand", values: ["Kiam"] }],
  reviews: [],
  seo: {},
};
products.unshift(product);
products.push(riceCookerFixture);
const buildKey = "temporary-test-key";
const buildScratch = join(assets, ".astro");
await mkdir(buildScratch, { recursive: true });
const work = await mkdtemp(join(buildScratch, "lb-seo-release-"));
const server = createServer((request, response) => {
  if (request.url !== "/api/build/fixture" || request.headers["x-build-key"] !== buildKey) return response.writeHead(404).end();
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ products, store }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const run = promisify(execFile);
const build = async (environment, dir, productSlot = "0987654321") => {
  const env = { ...process.env, BUILD_ENV: environment, BUILD_ID: "fixture", BUILD_KEY: buildKey,
    GITHUB_SHA: "f".repeat(40),
    SITE_ORIGIN: "https://loverbaazar.com", NO_COLOR: "1", PUBLIC_TURNSTILE_SITE: "test-site-key",
    CATALOG_URL: `http://127.0.0.1:${server.address().port}/api/catalog`,
    INDEXNOW_KEY: "0123456789abcdef0123456789abcdef",
    BING_SITE_VERIFICATION: "0123456789ABCDEF0123456789ABCDEF",
    GOOGLE_SITE_VERIFICATION: "fixture_google_verify_token_12345",
    CLOUDFLARE_WEB_ANALYTICS_TOKEN: "0123456789abcdef0123456789abcdef",
    ADSENSE_SLOT_CONTENT: "1234567890",
    ADSENSE_SLOT_PRODUCT: productSlot };
  try {
    await run(process.execPath, ["node_modules/.bin/astro", "build", "--outDir", join(work, dir)], { cwd: assets, env, maxBuffer: 3_000_000 });
  } catch (error) {
    throw new Error(error.stdout?.split("\n").slice(-12).join("\n") + "\n" + error.stderr);
  }
};
const read = (dir, path) => readFile(join(work, dir, path), "utf8");
const entities = html => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
  .map(match => JSON.parse(match[1]));

async function verifyProductAd(html, csp) {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const path = `/product/${riceCookerFixture.slug}/`;
    const page = await browser.newPage({ viewport: { width: 320, height: 812 } });
    let requests = 0;
    let blocked = false;
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.origin) return route.abort();
      if (url.pathname === path) return route.fulfill({ contentType: "text/html", body: html, headers: { "Content-Security-Policy": csp } });
      if (url.pathname.startsWith("/_astro/") || ["/ads.js", "/app.js", "/search-index.json"].includes(url.pathname)) {
        return route.fulfill({ path: join(work, "production", url.pathname) });
      }
      if (url.pathname === "/api/stock") {
        return route.fulfill({ json: { products: { [riceCookerFixture.id]: [1450, 1900, 1] }, settings: store.live } });
      }
      return route.abort();
    });
    await page.route("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=*", route => {
      requests++;
      if (blocked) return route.abort();
      return route.fulfill({ contentType: "text/javascript", body: `document.querySelector("ins.adsbygoogle").dataset.adStatus = "filled";` });
    });

    await page.goto(new URL(path, fixture).href);
    assert.equal(requests, 0, "AdSense loaded before the shopper reached the ad");
    const slot = page.getByRole("complementary", { name: "Advertisements" });
    const banner = slot.locator("ins.adsbygoogle");
    await slot.evaluate(element => element.scrollIntoView({ block: "center" }));
    await slot.locator('ins[data-ad-status="filled"]').waitFor({ state: "visible", timeout: 5000 });
    for (const width of [320, 360, 375, 390, 414, 768, 1440]) {
      await page.setViewportSize({ width, height: 812 });
      await slot.evaluate(element => element.scrollIntoView({ block: "center" }));
      const box = await banner.boundingBox();
      const expected = width < 500 ? [320, 50] : width < 800 ? [468, 60] : [728, 90];
      assert.deepEqual([box.width, box.height], expected, `Ad size at ${width}px`);
      assert.ok(box.x >= 0 && box.x + box.width <= width, `Ad fits at ${width}px`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}px`);
      if (width < 860) {
        const buy = page.locator("[data-buybar] [data-buy]");
        await buy.click({ trial: true, timeout: 5000 });
        assert.ok(box.y + box.height < (await buy.boundingBox()).y, `Mobile Buy now stays clear at ${width}px`);
      }
    }
    assert.equal(requests, 1, "Resizing initiated another ad request");
    await banner.evaluate(element => { element.dataset.adStatus = "unfilled"; });
    await slot.waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(await page.locator("[data-ad-slot-wrap]").getAttribute("hidden"), "");

    blocked = true;
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(new URL(path, fixture).href);
    assert.equal(requests, 1, "AdSense loaded at the top of a fresh product view");
    await slot.evaluate(element => element.scrollIntoView({ block: "center" }));
    await slot.waitFor({ state: "hidden", timeout: 5000 });
    assert.equal(requests, 2, "The blocked ad attempt should occur once");
  } finally {
    await browser.close();
  }
}

try {
  await build("production", "production");
  const home = await read("production", "index.html");
  assert.match(home, /<title>Lover Baazar \| Home Appliances &amp; Furniture in Bangladesh<\/title>/);
  assert.match(home, /<meta name="description" content="Lover Baazar\. Shop rice cookers, [^"]*Delivery across Bangladesh\."/);
  assert.match(home, /href="\/how-to-buy\/#delivery" data-delivery-coverage(?:="true")?>\s*Delivery across Bangladesh\s*<\/a>/);
  assert.match(home, /<meta property="og:site_name" content="Lover Baazar">/);
  const headings = [...home.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
  assert.equal(headings.length, 1);
  assert.equal(headings[0][1].replace(/<[^>]+>/g, "").trim(), "Lover Baazar");
  assert.match(home, /<p class="hero-title" lang="en-BD"[^>]*>Cookware, appliances &amp; furniture<\/p>/);
  assert.match(home, /<link rel="canonical" href="https:\/\/loverbaazar.com\/">/);
  assert.match(home, /<meta name="robots" content="index, follow/);
  assert.match(home, /<link rel="icon" href="\/favicon\.ico" sizes="16x16 32x32 48x48">/);
  assert.match(home, /<link rel="shortcut icon" href="\/favicon\.ico">/);
  assert.match(home, /<link rel="icon" type="image\/png" sizes="48x48" href="\/favicon-48x48\.png">/);
  assert.match(home, /<link rel="icon" type="image\/png" sizes="96x96" href="\/favicon-96x96\.png">/);
  assert.match(home, /<link rel="icon" type="image\/png" sizes="32x32" href="\/favicon-32x32\.png">/);
  assert.match(home, /<link rel="icon" type="image\/png" sizes="192x192" href="\/icon-192\.png">/);
  assert.match(home, /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png">/);
  assert.match(home, /<link rel="manifest" href="\/site\.webmanifest">/);
  assert.doesNotMatch(home, /<link rel="icon"[^>]*favicon\.svg/);
  assert.match(home, /<meta name="msvalidate\.01" content="0123456789ABCDEF0123456789ABCDEF">/);
  assert.match(home, /<meta name="google-site-verification" content="fixture_google_verify_token_12345">/);
  assert.match(home, /src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js"[^>]*0123456789abcdef0123456789abcdef/);
  for (const icon of ["favicon.ico", "favicon-32x32.png", "favicon-48x48.png", "favicon-96x96.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
    assert.ok((await readFile(join(work, "production", icon))).length > 0, `${icon} is non-empty`);
  }
  const manifest = JSON.parse(await read("production", "site.webmanifest"));
  assert.ok(manifest.icons.some(icon => icon.sizes === "192x192") && manifest.icons.some(icon => icon.sizes === "512x512"));
  assert.equal(await read("production", "0123456789abcdef0123456789abcdef.txt"), "0123456789abcdef0123456789abcdef");
  assert.equal(await read("production", "ads.txt"), "google.com, pub-2212378495306002, DIRECT, f08c47fec0942fa0\n");
  for (const adRoute of ["blog/index.html", `${store.posts[0].slug}/index.html`]) {
    const adHTML = await read("production", adRoute);
    assert.match(adHTML, /<meta name="google-adsense-account" content="ca-pub-2212378495306002">/, `${adRoute} missing AdSense meta`);
    assert.match(adHTML, /src="https:\/\/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js\?client=ca-pub-2212378495306002"/, `${adRoute} missing AdSense script`);
    assert.match(adHTML, /<script src="\/ads\.js" defer fetchpriority="low"><\/script>/, `${adRoute} missing ads.js loader`);
    assert.match(adHTML, /<aside class="ad-slot"[^>]*data-ad-slot-wrap[^>]*>[\s\S]*Advertisement[\s\S]*data-ad-format="horizontal"/, `${adRoute} missing horizontal AdSlot`);
  }
  for (const path of ["index.html", "shop/index.html", "offers/index.html", "online-shopping-jashore/index.html", "product-category/rice-cooker/index.html"]) {
    const shoppingHTML = await read("production", path);
    assert.doesNotMatch(shoppingHTML, /googlesyndication\.com|google-adsense-account|data-ad-slot-wrap|src="\/ads\.js"/, `${path} loaded ads`);
  }
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
  assert.equal(shops[0].address.streetAddress, "Vekutia");
  assert.equal(shops[0].address.addressLocality, "Jashore");
  assert.equal(shops[0].address.addressRegion, "Khulna Division");
  assert.equal(shops[0].address.addressCountry, "BD");
  assert.equal(shops[0].openingHours, "Sa,Su,Mo,Tu,We,Th 09:00-21:00");
  assert.ok(Array.isArray(shops[0].areaServed) && shops[0].areaServed.some(a => a.name === "Jashore" && a.alternateName?.includes("Jessore")) && shops[0].areaServed.some(a => a.name === "Bangladesh"));
  assert.match(home, /href="\/online-shopping-jashore\/"/);
  assert.match(home, /Free delivery in Jashore/);
  const expectedReturnPolicy = {
    "@type": "MerchantReturnPolicy",
    applicableCountry: "BD",
    returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
    merchantReturnDays: 7,
    returnMethod: "https://schema.org/ReturnByMail",
    returnFees: "https://schema.org/ReturnFeesCustomerResponsibility",
    merchantReturnLink: "https://loverbaazar.com/terms-conditions/",
  };
  assert.deepEqual(shops[0].hasMerchantReturnPolicy, expectedReturnPolicy);
  const terms = await read("production", "terms-conditions/index.html");
  assert.match(terms, /return within 7 days of delivery/);
  assert.match(terms, /5–7 business days via bKash, Nagad, Rocket, or bank transfer/);
  assert.doesNotMatch(terms, /return policy lasts 30 days|\{returns\}/);
  const page = await read("production", `product/${product.slug}/index.html`);
  assert.doesNotMatch(page, /name="(?:msvalidate\.01|google-site-verification)"/);
  const htmlLD = entities(page);
  assert.ok(!htmlLD.some(item => ["WebSite", "Store"].includes(item["@type"])));
  const productLD = htmlLD.find(item => item["@type"] === "Product");
  assert.equal(productLD.offers.price, 1250);
  assert.equal(productLD.offers.availability, "https://schema.org/InStock");
  assert.equal(productLD.offers.url, productURL);
  assert.equal(productLD.offers.seller["@id"], shops[0]["@id"]);
  assert.equal(productLD.offers.hasMerchantReturnPolicy.returnPolicyCategory, "https://schema.org/MerchantReturnFiniteReturnWindow");
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
  assert.doesNotMatch(page, /data-photo-step/);
  const sitemap = await read("production", "sitemap-0.xml");
  assert.equal(sitemap.match(/<loc>https:\/\/loverbaazar.com\/<\/loc>/g)?.length, 1);
  assert.ok(sitemap.includes(productURL));
  assert.doesNotMatch(sitemap, /\/(admin|cart|checkout|search|track|wishlist|my-account|404|seo-hidden-fixture|seo-duplicate-fixture|seo-draft-fixture)\//);
  const hiddenFixtureHTML = await read("production", "seo-hidden-fixture/index.html");
  assert.match(hiddenFixtureHTML, /noindex, follow/);
  assert.doesNotMatch(hiddenFixtureHTML, /<link rel="stylesheet"/);
  assert.doesNotMatch(hiddenFixtureHTML, /rel="preconnect" href="https:\/\/res\.cloudinary\.com"/);
  await assert.rejects(read("production", "seo-draft-fixture/index.html"), { code: "ENOENT" });
  const riceCat = await read("production", "product-category/rice-cooker/index.html");
  assert.match(riceCat, /<title>Rice Cooker Price in Bangladesh \| Lover Baazar<\/title>/);
  assert.match(riceCat, /<h1[^>]*>Rice Cooker Price in Bangladesh<\/h1>/);
  assert.match(riceCat, /<meta name="description" content="Compare \d+ Rice Cooker prices in Bangladesh [^"]*৳[^"]*Lover Baazar/);
  assert.match(riceCat, /<meta name="description" content="[^"]*Free delivery in Jashore[^"]*">/);
  const riceCatLD = entities(riceCat).find(item => item["@type"] === "CollectionPage");
  assert.ok(riceCatLD && riceCatLD.mainEntity["@type"] === "ItemList" && riceCatLD.mainEntity.numberOfItems >= 1);
  assert.match(riceCat, /Rice Cooker Price List in Bangladesh/);
  assert.match(riceCat, /<table class="price-table">[\s\S]*Fixture Kiam Rice Cooker 1\.8L/);
  const rcPage = await read("production", "product/fixture-rice-cooker-18l/index.html");
  assert.equal(rcPage.match(/data-ad-slot-wrap(?=[\s=>])/g)?.length, 1);
  assert.match(rcPage, /You may also like[\s\S]*<aside class="ad-slot ad-slot-product"[^>]*data-ad-defer-script/);
  assert.match(rcPage, /<ins class="adsbygoogle lb_product_ad"[^>]*data-ad-slot="0987654321">/);
  assert.match(rcPage, /<script src="\/ads\.js\?v=f{40}" defer fetchpriority="low"><\/script>/);
  assert.doesNotMatch(rcPage, /googlesyndication\.com|google-adsense-account|data-full-width-responsive/);
  assert.match(rcPage, /src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js"[^>]*0123456789abcdef0123456789abcdef/);
  for (const privateRoute of ["checkout", "cart", "my-account", "track", "search", "wishlist", "contact-us", "privacy-policy", "terms-conditions", "about-us", "how-to-buy", "admin", "seo-hidden-fixture"]) {
    const restrictedHTML = await read("production", `${privateRoute}/index.html`);
    if (privateRoute !== "contact-us" && privateRoute !== "privacy-policy" && privateRoute !== "terms-conditions" && privateRoute !== "about-us" && privateRoute !== "how-to-buy" && privateRoute !== "admin") {
      assert.doesNotMatch(restrictedHTML, /cloudflareinsights\.com/, `analytics beacon leaked on /${privateRoute}/`);
    }
    assert.doesNotMatch(restrictedHTML, /googlesyndication\.com|google-adsense-account|data-ad-slot-wrap/, `AdSense leaked on /${privateRoute}/`);
  }
  assert.match(await read("production", "checkout/index.html"), /class="cf-turnstile"[^>]*data-size="compact"[^>]*data-appearance="interaction-only"/);
  assert.match(rcPage, /<title>Fixture Kiam Rice Cooker 1\.8L Price in Bangladesh \| Lover Baazar<\/title>/);
  assert.match(rcPage, /<meta name="description" content="Fixture Kiam Rice Cooker 1\.8L price in Bangladesh is ৳1,450 at Lover Baazar\./);
  assert.match(rcPage, /<meta name="description" content="[^"]*Delivery in Jashore only[^"]*">/);
  assert.match(rcPage, /<span class="delivery-label" data-jashore-label>Jashore only<\/span>/);
  assert.match(rcPage, /<div class="ticker"[^>]*>\s*<div>\s*<span>\s*<a href="\/how-to-buy\/#delivery" data-delivery-coverage>\s*Delivery across Bangladesh\s*<\/a>/);
  assert.doesNotMatch(rcPage, /Delivery available only in Jashore\./);
  assert.match(rcPage, /Double pot rice cooker for 4 to 6 people\./);
  assert.doesNotMatch(rcPage, /Delivery time 4-7 days/);
  const localDelivery = rcPage.match(/<ul class="delivery" data-delivery[^>]*>([\s\S]*?)<\/ul>/)?.[1];
  assert.match(localDelivery || "", /Inside Jashore[\s\S]*3–5 days/);
  assert.doesNotMatch(localDelivery || "", /Outside Jashore/);
  const rcLD = entities(rcPage);
  const rcProductLD = rcLD.find(item => item["@type"] === "Product");
  assert.equal(rcProductLD.category, "Rice Cooker");
  assert.equal(rcProductLD.offers.itemCondition, "https://schema.org/NewCondition");
  assert.deepEqual(rcProductLD.offers.hasMerchantReturnPolicy, expectedReturnPolicy);
  assert.equal(rcProductLD.offers.priceSpecification.price, 1900);
  assert.equal(rcProductLD.offers.priceSpecification.priceType, "https://schema.org/StrikethroughPrice");
  const rcCrumbs = rcLD.find(item => item["@type"] === "BreadcrumbList").itemListElement.map(item => item.name);
  assert.ok(rcCrumbs.includes("Rice Cooker") && !rcCrumbs.includes("Latest Products"));
  assert.doesNotMatch(home, /<link rel="stylesheet"/);
  assert.match(home, /<style>/);
  assert.match(home, /<script src="\/app\.js\?v=f{40}" defer fetchpriority="low">/);
  assert.doesNotMatch(rcPage, /<link rel="stylesheet"/);
  assert.match(rcPage, /<link rel="preconnect" href="https:\/\/res\.cloudinary\.com" crossorigin>/);
  assert.match(rcPage, /<link rel="preload" as="image"[^>]*imagesrcset="[^"]*640w"[^>]*fetchpriority="high">/);
  assert.match(rcPage, /<img class="main" data-main[^>]*srcset="[^"]*640w"[^>]*data-zoom="https:\/\/res\.cloudinary\.com\/test\/image\/upload\/c_limit,w_960\/q_auto\/f_auto\/loverbaazar\/products\/rice-cooker\/fixture-rice-cooker-18l-1\.jpg"[^>]*decoding="sync" fetchpriority="high">/);
  assert.doesNotMatch(rcPage, /<img class="main"[^>]*960w/);
  assert.equal(rcPage.match(/data-photo-step="/g)?.length, 4);
  const shopHTML = await read("production", "shop/index.html");
  assert.match(shopHTML, /Browse categories/);
  const shopLD = entities(shopHTML).find(item => item["@type"] === "CollectionPage");
  assert.ok(shopLD && shopLD.mainEntity["@type"] === "ItemList" && shopLD.mainEntity.numberOfItems >= 2);
  const jashorePage = await read("production", "online-shopping-jashore/index.html");
  assert.match(jashorePage, /<link rel="canonical" href="https:\/\/loverbaazar\.com\/online-shopping-jashore\/">/);
  assert.match(jashorePage, /<h1[^>]*>Online Shopping in Jashore \(Jessore\)<\/h1>/);
  assert.match(jashorePage, /lang="bn-BD"/);
  assert.doesNotMatch(jashorePage, /<link rel="stylesheet"/);
  const jashoreLD = entities(jashorePage);
  assert.ok(jashoreLD.some(item => item["@type"] === "CollectionPage"));
  assert.ok(jashoreLD.some(item => item["@type"] === "FAQPage" && Array.isArray(item.mainEntity) && item.mainEntity.length >= 4));
  assert.ok(jashoreLD.some(item => item["@type"] === "BreadcrumbList"));
  assert.ok(sitemap.includes("https://loverbaazar.com/online-shopping-jashore/"));
  const thinTag = await read("production", "product-tag/thin-fixture-tag/index.html");
  assert.match(thinTag, /noindex, follow/);
  assert.doesNotMatch(sitemap, /\/product-tag\/thin-fixture-tag\//);
  assert.ok(sitemap.includes("https://loverbaazar.com/product-category/rice-cooker/"));
  assert.ok(sitemap.includes("https://loverbaazar.com/product/fixture-rice-cooker-18l/"));
  assert.match(await read("production", "robots.txt"), /Sitemap: https:\/\/loverbaazar.com\/sitemap-index.xml/);
  assert.match(await read("production", "_redirects"), /^\/page-sitemap\.xml \/sitemap-index\.xml 301$/m);
  assert.match(await read("production", "_redirects"), /^\/online-shopping-jessore\/ \/online-shopping-jashore\/ 301$/m);
  const productionHeaders = await read("production", "_headers");
  assert.match(productionHeaders, /https:\/\/:worker\.:account\.workers\.dev\/\*\n  X-Robots-Tag: noindex, nofollow/);
  assert.match(productionHeaders, /\/_astro\/\*\n  Cache-Control: public, max-age=31536000, immutable/);
  assert.match(productionHeaders, /\/app\.js\n  Cache-Control: public, max-age=300, stale-while-revalidate=86400/);
  assert.match(productionHeaders, /\/ads\.js\n  Cache-Control: public, max-age=300, stale-while-revalidate=86400/);
  assert.match(productionHeaders, /\/ads\.txt\n  Cache-Control: public, max-age=86400/);
  assert.match(productionHeaders, /\/logo\/\*\n  Cache-Control: public, max-age=2592000/);
  assert.match(productionHeaders, /\/release\.json\n  Cache-Control: no-store/);
  assert.doesNotMatch(productionHeaders, /^\/\*\n  X-Robots-Tag:/m);
  const prodCSP = productionHeaders.match(/^  Content-Security-Policy: (.+)$/m)?.[1] || "";
  assert.match(prodCSP, /script-src[^;]*https:\/\/static\.cloudflareinsights\.com/);
  assert.match(prodCSP, /script-src[^;]*https:\/\/pagead2\.googlesyndication\.com/);
  assert.match(prodCSP, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(prodCSP, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);
  assert.doesNotMatch(prodCSP, /script-src[^;]*'unsafe-inline'/);
  assert.match(prodCSP, /connect-src[^;]*https:\/\/cloudflareinsights\.com/);
  await verifyProductAd(rcPage, prodCSP);
  for (const restrictedPrefix of ["/admin/\\*", "/checkout/\\*", "/cart/\\*", "/my-account/\\*", "/track/\\*"]) {
    const block = productionHeaders.match(new RegExp(`^${restrictedPrefix}\\n  Content-Security-Policy: (.+)$`, "m"))?.[1] || "";
    assert.ok(block, `Missing strict CSP override for ${restrictedPrefix}`);
    assert.doesNotMatch(block, /googlesyndication\.com|doubleclick\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/);
    assert.doesNotMatch(block, /script-src[^;]*'unsafe-inline'/);
  }
  const feed = await read("production", "feed.xml");
  assert.match(feed, /<g:sale_price>1250 BDT<\/g:sale_price>/);
  assert.match(feed, /<g:product_type>Rice Cooker<\/g:product_type>/);
  assert.match(feed, /<g:condition>new<\/g:condition>/);
  assert.match(feed, /<g:additional_image_link>https:\/\/res\.cloudinary\.com\/test\/image\/upload\/f_auto,q_auto\/loverbaazar\/products\/rice-cooker\/fixture-rice-cooker-18l-2\.jpg<\/g:additional_image_link>/);
  for (const [entry] of feed.matchAll(/<item>[\s\S]*?<\/item>/g)) {
    const hasUpi = /<g:(?:brand|gtin|mpn)>/.test(entry);
    assert.equal(entry.includes("<g:identifier_exists>no</g:identifier_exists>"), !hasUpi);
  }
  await run("python3", ["-c", "import sys,xml.etree.ElementTree as ET\nfor x in sys.argv[1:]: ET.parse(x)", ...["feed.xml", "blog/feed.xml", "sitemap-index.xml", "sitemap-0.xml"].map(f => join(work, "production", f))]);

  await build("production", "product-ads-disabled", "");
  const adFreeProduct = await read("product-ads-disabled", "product/fixture-rice-cooker-18l/index.html");
  assert.doesNotMatch(adFreeProduct, /googlesyndication\.com|data-ad-slot-wrap|src="\/ads\.js/);

  product.price = 999;
  product.inStock = false;
  product.sku = "  LB-0125  ";
  product.reviews = [{ name: "Fixture customer", rating: 5, body: "Review fixture" }];
  store.pages.find(page => page.slug === "terms-conditions").draft = true;
  store.live.delivery = store.live.delivery.filter(zone => zone.id === "jashore");
  await build("preview", "preview");
  const next = await read("preview", `product/${product.slug}/index.html`);
  assert.doesNotMatch(next, /googlesyndication\.com|data-ad-slot-wrap|src="\/ads\.js/);
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
  assert.match(previewHome, /data-delivery-coverage(?:="true")?>\s*Delivery information\s*<\/a>/);
  assert.doesNotMatch(previewHome, /name="(?:msvalidate\.01|google-site-verification|google-adsense-account)"/);
  assert.doesNotMatch(previewHome, /cloudflareinsights\.com|googlesyndication\.com|data-ad-slot-wrap/);
  await assert.rejects(read("preview", "ads.txt"), { code: "ENOENT" });
  await assert.rejects(read("preview", "0123456789abcdef0123456789abcdef.txt"), { code: "ENOENT" });
  const previewStore = entities(previewHome).find(item => item["@type"] === "Store");
  assert.ok(!previewStore.hasMerchantReturnPolicy);
  assert.deepEqual(previewStore.areaServed.map(area => area.name), ["Jashore"]);
  assert.ok(!nextProduct.offers.hasMerchantReturnPolicy);
  assert.doesNotMatch(await read("preview", "_redirects"), /page-sitemap\.xml/);
  assert.match(next, /noindex, nofollow/);
  await assert.rejects(read("preview", "sitemap-index.xml"), { code: "ENOENT" });
  const source = "https://res.cloudinary.com/test/image/upload/f_auto,q_auto,w_300/v100/loverbaazar/products/example.webp";
  assert.equal(sizedImage(source, 640), "https://res.cloudinary.com/test/image/upload/c_limit,w_640/q_auto/f_auto/v100/loverbaazar/products/example.webp");
  assert.match(responsiveImage(source, "", [160, 320, 640]).srcset, /640w$/);
  assert.equal(sizedImage("https://loverbaazar.com/photo.jpg", 640), "https://loverbaazar.com/photo.jpg");
  console.log("Homepage identity, production sitemap, canonical, Bangla SEO, structured offers, ad placement and loading, preview noindex, changed offer/feed and image widths passed.");
} finally {
  server.close();
  await rm(work, { recursive: true, force: true });
}
