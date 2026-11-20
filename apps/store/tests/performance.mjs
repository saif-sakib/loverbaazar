// Run against the isolated Wrangler fixture or an explicitly selected storefront.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = new URL(process.env.SHOP_URL || "http://127.0.0.1:18788");
const browser = await chromium.launch();
const setup = await browser.newPage();
await setup.goto(base.href);
const product = await setup.locator('a[href^="/product/"]').first().getAttribute("href");
const category = await setup.locator('a[href^="/product-category/"]').first().getAttribute("href");
await setup.close();
let failed = false;

try {
  assert.ok(product && category);
  for (const path of ["/", "/shop/", "/online-shopping-jashore/", category, product, "/how-to-buy/"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.lab = { lcp: 0, cls: 0, interaction: 0 };
      let session = 0, start = 0, last = 0;
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          session = e.startTime - last < 1000 && e.startTime - start < 5000 ? session + e.value : e.value;
          if (session === e.value) start = e.startTime;
          last = e.startTime;
          window.lab.cls = Math.max(window.lab.cls, session);
        }
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver(list => {
        window.lab.lcp = list.getEntries().at(-1).startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (e.interactionId) window.lab.interaction = Math.max(window.lab.interaction, e.duration);
      }).observe({ type: "event", durationThreshold: 16 });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 125, downloadThroughput: 200000, uploadThroughput: 93750 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const requests = new Map();
    cdp.on("Network.responseReceived", ({requestId, type, response}) => requests.set(requestId, { type, url: response.url, bytes: 0 }));
    cdp.on("Network.loadingFinished", ({requestId, encodedDataLength}) => {
      if (requests.has(requestId)) requests.get(requestId).bytes = encodedDataLength;
    });
    for (const cache of ["cold", "warm"]) {
      requests.clear();
      await page.goto(new URL(path, base).href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.waitForTimeout(3800);
      const bytes = (type, firstParty = false) => [...requests.values()].filter(r => (!type || r.type === type) && (!firstParty || r.url.startsWith(base.origin + "/"))).reduce((sum, r) => sum + r.bytes, 0);
      const transfer = { total: bytes(), js: bytes("Script", true), css: bytes("Stylesheet", true), image: bytes("Image"), font: bytes("Font") };
      await page.locator("[data-categories]:visible").click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      const vitals = await page.evaluate(() => window.lab);
      console.log(JSON.stringify({ path, cache, transfer, vitals }));
      const limits = { total: 1_000_000, js: 75_000, css: 40_000, image: 700_000, font: 90_000 };
      if (Object.keys(limits).some(key => transfer[key] > limits[key])) failed = true;
    }
    await context.close();
  }
} finally {
  await browser.close();
}
if (failed && process.env.REPORT_ONLY !== "1") process.exitCode = 1;
