// Read-only browser acceptance against the disposable published mobile-flow fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

const baseURL = new URL(process.env.SHOP_URL || 'https://invalid.example');
assert.equal(process.env.LB_ISOLATED, '1', 'Use scripts/test-mobile.sh --acceptance');
assert.equal(baseURL.hostname, '127.0.0.1');
assert.ok(baseURL.port && baseURL.port !== '8787');
const engines = { chromium, firefox, webkit };
const selected = (process.env.SHOP_BROWSERS || 'chromium,firefox,webkit').split(',');
const screenshots = process.env.LB_SCREENSHOTS;
const product = '/product/mobile-fixture-cooker/';
const dimensions = [
  [320, 720], [360, 780], [375, 812], [390, 844], [414, 896],
  [844, 390], [768, 1024], [1440, 900],
];

if (screenshots) await fs.mkdir(screenshots, { recursive: true });
for (const name of selected) {
  assert.ok(engines[name], `Unknown browser ${name}`);
  const browser = await engines[name].launch();
  try {
    const context = await browser.newContext({
      baseURL: baseURL.href,
      hasTouch: true,
      viewport: { width: 375, height: 812 },
      ...(name === 'firefox' ? {} : { isMobile: true }),
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/stock', async route => {
      await new Promise(resolve => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.goto(product);
    await page.waitForFunction(() => document.querySelector('[data-main]')?.naturalWidth === 2);
    const add = page.locator('.buy button[data-add]:not([data-buy])');
    await add.click();
    await page.goto('/cart/');
    await page.locator('[data-cart]').getByText('Mobile fixture cooker', { exact: true }).waitFor();
    await page.locator('a[href="/checkout/"]:visible').first().click();
    await page.waitForURL('**/checkout/');
    await page.waitForFunction(() => document.querySelector('[data-sum]')?.textContent.includes('Mobile fixture cooker'));

    for (const route of ['/', product, '/cart/', '/checkout/', '/track/', '/admin/']) {
      await page.goto(route);
      if (route === product) await page.waitForFunction(() => document.querySelector('[data-main]')?.naturalWidth === 2);
      for (const [width, height] of dimensions) {
        await page.setViewportSize({ width, height });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${name} ${route} has page overflow at ${width}×${height}`);
      }
      if (screenshots && ['/checkout/', product, '/admin/'].includes(route)) {
        await page.setViewportSize({ width: 375, height: 812 });
        await page.screenshot({ path: `${screenshots}/${name}-${route.split('/')[1]}.png` });
      }
    }
    assert.deepEqual(errors, []);
    console.log(`PASS: ${name} ${browser.version()}, published image, cart and checkout under delayed stock requests, six routes at eight viewport sizes.`);
  } finally {
    await browser.close();
  }
}
