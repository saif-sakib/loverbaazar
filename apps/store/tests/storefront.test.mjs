// Start ./scripts/dev.sh first. These tests mock writes and never place real orders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseURL = process.env.SHOP_URL || 'http://127.0.0.1:8787';
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
});
after(async () => { await browser?.close(); });
const products = [
  { id: 1, slug: 'p1', name: 'Test cooker', text: 'test cooker', price: 1000, regular: 1200, inStock: true },
  { id: 2, slug: 'p2', name: 'Test kettle', text: 'test kettle', price: 500, regular: 500, inStock: true },
];
const settings = {
  ordersOpen: true, closedNote: 'Orders closed', notice: '', minOrder: 0, freeOver: 0,
  delivery: [{ id: 'local', label: 'Local', fee: 60 }],
  payments: [{ id: 'cod', label: 'Cash on delivery', enabled: true, number: '' }, { id: 'mobile', label: 'Mobile payment', enabled: true, number: 'test-number' }],
};
async function shop(run, { cart = {}, wish = [], stock = { 1: [1000, 1200, 10], 2: [500, 500, 10] }, live = {} } = {}) {
  const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 } });
  const errors = [];
  context.on('page', page => page.on('pageerror', e => errors.push(e.message)));
  await context.addInitScript(({ cart, wish }) => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (!localStorage.getItem('test-initialized')) {
      localStorage.setItem('cart', JSON.stringify(cart));
      localStorage.setItem('wish', JSON.stringify(wish));
      localStorage.setItem('test-initialized', '1');
    }
  }, { cart, wish });
  await context.route('**/*', r => r.request().resourceType() === 'image' ? r.abort() : r.continue());
  await context.route('**/search-index.json', r => r.fulfill({ json: products }));
  await context.route('**/api/stock', r => r.fulfill({ json: { products: stock, settings: { ...settings, ...live } } }));
  await context.route('**/api/me', r => r.fulfill({ status: 401, json: { error: 'Sign in' } }));
  const page = await context.newPage();
  try { await run(page, context); assert.deepEqual(errors, [], 'No browser JavaScript errors'); }
  finally { await context.close(); }
}
async function ready(page, path) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

test('malformed saved shopping data does not break the storefront', () => shop(async page => {
  await ready(page, '/search/?q=test');
  assert.equal(await page.locator('[data-add]:enabled').count(), 2);
  assert.equal(await page.locator('[data-cart-count]:visible').count(), 0);
}, { cart: { 1: 'bad', 2: -2, garbage: 5 }, wish: { invalid: true } }));

test('an empty live catalogue disables every static add button', () => shop(async page => {
  await ready(page, '/shop/');
  assert.equal(await page.locator('[data-add]:enabled').count(), 0);
}, { stock: {} }));

test('cart updates across tabs, including quantities and totals', () => shop(async (page, context) => {
  await ready(page, '/cart/');
  const other = await context.newPage();
  await ready(other, '/search/?q=test');
  await other.locator('[data-add="1"]').click();
  await page.waitForFunction(() => document.querySelector('[data-line="1"]')?.value === '1');
  assert.equal(await page.locator('[data-sub]').textContent(), '৳1,000');
}));

test('checkout blocks a quantity greater than remaining stock', () => shop(async page => {
  await ready(page, '/checkout/');
  assert.match(await page.locator('[data-err]').textContent(), /Only 1/);
  assert.equal(await page.locator('button[type="submit"]').isDisabled(), true);
}, { cart: { 1: 2 }, stock: { 1: [1000, 1200, 1] } }));

test('manual payments require a transaction reference; duplicate submits send one request', () => shop(async (page, context) => {
  let requests = 0;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  await context.route('**/api/checkout', async r => { requests++; await pending; await r.fulfill({ status: 400, json: { error: 'Please check the order' } }); });
  await ready(page, '/checkout/');
  await page.locator('[name="name"]').fill('Test buyer');
  await page.locator('[name="phone"]').fill('01710000000');
  await page.locator('[name="address"]').fill('Test address, Bangladesh');
  await page.locator('[name="payment"]').selectOption('mobile');
  await page.waitForFunction(() => document.querySelector('[name="txnid"]').required);
  assert.equal(await page.locator('[name="txnid"]').evaluate(e => e.checkValidity()), false);
  await page.locator('[name="txnid"]').fill('TEST12345');
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').disabled);
  await page.locator('[data-checkout]').evaluate(f => f.dispatchEvent(new Event('submit', { cancelable: true })));
  assert.equal(requests, 1);
  finish();
  await page.waitForFunction(() => document.querySelector('[data-err]').textContent.includes('Please check'));
} , { cart: { 1: 1 } }));

test('checkout explains when no payment method is available', () => shop(async page => {
  await ready(page, '/checkout/');
  assert.match(await page.locator('[data-err]').textContent(), /No payment method/);
  assert.equal(await page.locator('button[type="submit"]').isDisabled(), true);
}, { cart: { 1: 1 }, live: { payments: [] } }));

test('product loading failures show recovery text', () => shop(async (page, context) => {
  await context.route('**/search-index.json', r => r.fulfill({ status: 503, body: '' }));
  await ready(page, '/cart/');
  assert.match(await page.locator('[data-cart]').textContent(), /refresh/);
}, { cart: { 1: 1 } }));

test('live prices retain the selected catalogue sorting', () => shop(async (page, context) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/api/stock', async r => {
    await gate;
    const cards = await page.locator('[data-card]').evaluateAll(els => els.map((el, i) => [el.dataset.id, [i + 1, i + 1, 10]]));
    await r.fulfill({ json: { products: Object.fromEntries(cards), settings } });
  });
  await page.goto('/shop/');
  await page.locator('[data-sort]').selectOption('asc');
  release();
  await page.waitForLoadState('networkidle');
  const prices = await page.locator('[data-card]').evaluateAll(els => els.map(el => +el.dataset.price));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
}));

test('main pages fit small screens and desktop', { timeout: 90000 }, () => shop(async page => {
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/shop/', '/cart/', '/checkout/', '/search/?q=test', '/track/', '/admin/']) {
      await ready(page, path);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${path} at ${width}px overflows`);
      assert.equal(await page.locator('[data-toast]').isVisible(), false, 'Empty toast should be hidden');
      if (path === '/checkout/') assert.equal(await page.locator('.floats').isVisible(), false, 'Chat buttons must not cover checkout fields');
    }
  }
}, { cart: { 1: 1 } }));

test('product image opens and closes with the keyboard', () => shop(async page => {
  await ready(page, '/shop/');
  const href = await page.locator('.card .thumb').first().getAttribute('href');
  await ready(page, href);
  await page.locator('[data-main]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('dialog').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await page.locator('[data-main]').evaluate(e => e === document.activeElement), true);
}));

test('admin remains usable when session storage is blocked', () => shop(async page => {
  await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } }));
  await ready(page, '/admin/');
  assert.equal(await page.locator('#login').isVisible(), true);
  await page.locator('#tok').fill('local-admin-token-for-this-computer-only');
  await page.locator('.login-btn').click();
  await page.waitForFunction(() => !document.querySelector('#app').hidden);
  await page.waitForFunction(() => document.querySelector('#view').textContent.trim() !== 'Loading…');
  assert.equal(await page.locator('#app').isVisible(), true);
}));

test('admin sections fit a 375px screen', () => shop(async page => {
  await page.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  await ready(page, '/admin/');
  for (const tab of ['dashboard', 'products', 'orders', 'categories', 'home', 'menu', 'shop', 'delivery', 'customers', 'coupons', 'pages', 'blog', 'reviews', 'messages']) {
    await page.locator(`#tabs a[href="#${tab}"]`).click();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Admin ${tab} overflows`);
    assert.equal(await page.locator('#err').textContent(), '', `Admin ${tab} failed`);
  }
}));

test('a changed server total is visible before retrying checkout', () => shop(async (page, context) => {
  await context.route('**/api/checkout', r => r.fulfill({ status: 409, json: { error: 'the total changed to ৳1300. Please check your order and try again' } }));
  await ready(page, '/checkout/');
  await page.locator('[name="name"]').fill('Test buyer');
  await page.locator('[name="phone"]').fill('01710000000');
  await page.locator('[name="address"]').fill('Test address, Bangladesh');
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-sum] .total').textContent.includes('1,300'));
  assert.match(await page.locator('[data-err]').textContent(), /1300/);
}, { cart: { 1: 1 } }));
