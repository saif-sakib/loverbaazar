import assert from "node:assert/strict";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const baseURL = process.env.SHOP_URL || "http://127.0.0.1:18788";
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const checked = [];
const scan = async (name) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  for (const violation of violations) {
    console.error(JSON.stringify({ name, id: violation.id, impact: violation.impact, nodes: violation.nodes.slice(0, 10).map(n => [n.target, n.failureSummary]) }));
  }
  checked.push({ name, violations: violations.length });
};

try {
  await page.goto("/");
  const product = await page.locator('a[href^="/product/"]').first().getAttribute("href");
  const category = await page.locator('a[href^="/product-category/"]').first().getAttribute("href");
  for (const route of ["/", category, product, "/shop/", "/search/?q=cooker", "/cart/", "/wishlist/", "/checkout/", "/track/", "/my-account/", "/contact-us/", "/privacy-policy/", "/admin/"]) {
    await page.goto(route);
    await scan(route);
  }
  await page.goto("/");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").getAttribute("href"), "#main");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(":focus").getAttribute("id"), "main");
  const categories = page.locator("[data-categories]:visible");
  await categories.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("dialog[open]").count(), 1);
  await scan("open category dialog");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.matches("[data-categories]"));
  await page.goto(product);
  const image = page.locator("[data-main]");
  await image.focus();
  await page.keyboard.press("Enter");
  await scan("open product image");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.equal(await image.evaluate(el => el === document.activeElement), true);

  if (process.env.LB_ISOLATED === "1") {
    assert.equal(new URL(baseURL).hostname, "127.0.0.1");
    await page.goto("/admin/");
    await page.locator("#tok").fill("local-admin-token-for-this-computer-only");
    await page.locator("#login button").click();
    await page.waitForSelector("#app:not([hidden])");
    await page.goto("/admin/#new-product");
    await page.waitForSelector("#pf");
    await page.locator("#pf summary").filter({ hasText: "Search and social settings" }).click();
    await scan("admin product editor and search settings");
  }

  // Reflow at two narrow CSS viewport sizes, including the 320 px WCAG width.
  for (const width of [320, 720]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/", "/shop/", product, "/checkout/", "/admin/"]) {
      await page.goto(route);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflowed at ${width}px`);
    }
  }
  console.log(JSON.stringify(checked));
  assert.equal(checked.reduce((total, item) => total + item.violations, 0), 0);
} finally {
  await browser.close();
}
