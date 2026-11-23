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

test('delivery shows the order fee and explains quantity only for paid multi-item orders', async () => {
  for (const { cart, freeOver, charge, explanation } of [
    { cart: { 1: 1 }, freeOver: 0, charge: '৳60', explanation: false },
    { cart: { 1: 2 }, freeOver: 0, charge: '৳120', explanation: true },
    { cart: { 1: 1, 2: 1 }, freeOver: 0, charge: '৳120', explanation: true },
    { cart: { 1: 2 }, freeOver: 1500, charge: 'Free', explanation: false },
  ]) {
    await shop(async page => {
      await ready(page, '/checkout/');
      assert.equal(await page.locator('[name="area"] option:checked').textContent(), `Local (${charge})`);
      const summary = page.locator('[data-sum]');
      const delivery = summary.locator('.row').filter({ hasText: 'Delivery charge' });
      assert.equal(await delivery.locator('b').textContent(), charge);
      const text = await summary.textContent();
      assert.doesNotMatch(text, /per piece/i);
      assert.equal(text.includes('delivery charge is multiplied by 2'), explanation);
    }, { cart, live: { freeOver } });
  }
});

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

test('main pages fit small screens and desktop', { timeout: 180000 }, () => shop(async page => {
  for (const width of [320, 360, 375, 390, 414, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/shop/', '/cart/', '/checkout/', '/search/?q=test', '/track/', '/my-account/', '/contact-us/', '/wishlist/', '/admin/']) {
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
  assert.equal(await page.locator('dialog.lightbox').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog.lightbox').count(), 0);
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

test('admin sections fit 320, 375 and 414px screens', () => shop(async page => {
  await page.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  await ready(page, '/admin/');
  for (const width of [320, 375, 414]) {
   await page.setViewportSize({ width, height: 812 });
  for (const tab of ['dashboard', 'analytics', 'products', 'orders', 'categories', 'home', 'menu', 'shop', 'delivery', 'customers', 'coupons', 'pages', 'blog', 'reviews', 'messages']) {
    await page.locator('#admin-section').selectOption(tab);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Admin ${tab} overflows`);
    assert.equal(await page.locator('#err').textContent(), '', `Admin ${tab} failed`);
  }
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


test('admin settings have one save bar and preserve hidden and unrelated settings', () => shop(async (page, context) => {
  await page.addInitScript(() => { if (location.protocol === 'http:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  const original = await (await context.request.get('/api/admin/settings', { headers: { 'X-Admin-Token': 'local-admin-token-for-this-computer-only' } })).json();
  let concurrentChange = false, saved;
  await context.route('**/api/admin/settings', async r => {
    if (r.request().method() === 'PUT') { saved = r.request().postDataJSON(); return r.fulfill({ json: {} }); }
    return r.fulfill({ json: { live: { ...original.live, maxPending: 7 }, site: { ...original.site, name: concurrentChange ? 'Updated in another tab' : original.site.name } } });
  });
  await ready(page, '/admin/#home');
  assert.equal(await page.locator('[data-save]').count(), 0);
  assert.equal(await page.locator('#sf .stick').count(), 1);
  concurrentChange = true;
  await page.locator('[name="heroTitle"]').fill('Updated welcome');
  assert.match(await page.locator('.save-status').textContent(), /Unsaved/);
  await page.locator('#sf .stick button').first().click();
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'All changes saved');
  assert.equal(saved.site.hero.title, 'Updated welcome');
  assert.equal(saved.site.name, 'Updated in another tab');
  assert.equal(saved.live.maxPending, 7);
}));

test('admin failed saves retain edits and never publish; double submit sends once', () => shop(async (page, context) => {
  await page.addInitScript(() => { if (location.protocol === 'http:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  let writes = 0, publishes = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/api/admin/settings', async r => {
    if (r.request().method() !== 'PUT') return r.continue();
    writes++; await gate;
    return r.fulfill({ status: 503, json: { error: 'Try saving again' } });
  });
  await context.route('**/api/admin/publish', r => { if(r.request().method()==='GET') return r.continue(); publishes++; return r.fulfill({ json: {} }); });
  await ready(page, '/admin/#shop');
  await page.locator('[name="name"]').fill('Unsaved shop name');
  await page.locator('#savepub').click();
  await page.waitForFunction(() => document.querySelector('#sf').inert);
  await page.locator('#sf').evaluate(f => f.dispatchEvent(new Event('submit', { cancelable: true })));
  await page.locator('#admin-section').selectOption('orders');
  await page.waitForFunction(() => location.hash === '#shop');
  assert.equal(await page.locator('#admin-section').inputValue(), 'shop');
  release();
  await page.waitForFunction(() => !document.querySelector('#sf').inert);
  assert.equal(writes, 1); assert.equal(publishes, 0);
  assert.equal(await page.locator('[name="name"]').inputValue(), 'Unsaved shop name');
  assert.match(await page.locator('.save-status').textContent(), /Could not save/);
}));

test('invalid settings cannot publish and a later Save does not publish unexpectedly', () => shop(async (page, context) => {
  await page.addInitScript(() => { if (location.protocol === 'http:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  let writes = 0, publishes = 0;
  await context.route('**/api/admin/settings', r => {
    if (r.request().method() !== 'PUT') return r.continue();
    writes++; return r.fulfill({ json: {} });
  });
  await context.route('**/api/admin/publish', r => { if(r.request().method()==='GET') return r.continue(); publishes++; return r.fulfill({ json: {} }); });
  await ready(page, '/admin/#shop');
  await page.locator('[name="email"]').fill('invalid-email');
  await page.locator('#savepub').click();
  assert.equal(writes, 0); assert.equal(publishes, 0);
  await page.locator('[name="email"]').fill('shop@example.com');
  await page.locator('#sf .stick button').first().click();
  await page.waitForFunction(() => document.querySelector('.save-status')?.textContent === 'All changes saved');
  assert.equal(writes, 1); assert.equal(publishes, 0);
}));


test('admin overview loads dashboard once and defers product data until needed', () => shop(async (page, context) => {
  await page.addInitScript(() => { if (location.protocol === 'http:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  const requests = [];
  context.on('request', r => { if (r.url().includes('/api/admin/')) requests.push(new URL(r.url()).pathname); });
  await ready(page, '/admin/');
  assert.equal(requests.filter(p => p === '/api/admin/dashboard').length, 1);
  assert.equal(requests.filter(p => p === '/api/admin/products' || p.startsWith('/api/admin/content/')).length, 0);
  await page.locator('#admin-section').selectOption('products');
  await page.waitForSelector('#rows tr');
  assert.equal(requests.filter(p => p === '/api/admin/products').length, 1);
}));


test('saved stock is retried once so a newly published product becomes available', () => shop(async (page, context) => {
  let requests = 0;
  await context.route('**/api/stock', r => {
    requests++;
    return r.fulfill({ headers: requests === 1 ? { 'X-Stock-Stale': '1' } : {}, json: { products: requests === 1 ? {} : { 1: [1000, 1200, 3] }, settings } });
  });
  await ready(page, '/search/?q=test');
  assert.equal(await page.locator('[data-add="1"]').isDisabled(), true);
  await page.waitForFunction(() => !document.querySelector('[data-add="1"]').disabled, null, { timeout: 10000 });
  assert.equal(requests, 2);
}));

test('publication confirms a watched deployment once and keeps pending edits visible', () => shop(async (page, context) => {
  await page.addInitScript(() => sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'));
  let latest = { id: 'older-release', state: 'published' };
  let dirty = true;
  await context.route('**/api/admin/publish', route => {
    if (route.request().method() === 'POST') {
      latest = { id: 'new-release', state: 'queued' };
      return route.fulfill({ json: { id: latest.id, message: 'Queued' } });
    }
    return route.fulfill({ json: { dirty, latest } });
  });
  await ready(page, '/admin/');
  assert.equal(await page.locator('#dirtybar').isVisible(), true);
  assert.equal(await page.locator('#ok').isVisible(), false, 'An older release is silent on sign-in');
  await page.locator('#pub2').click();
  await page.getByText('Publish queued…', { exact: true }).waitFor();
  assert.equal(await page.locator('#dirtybar').isVisible(), true);
  latest.state = 'published';
  dirty = false;
  await page.getByText('Published. Customers now see your changes.', { exact: true }).waitFor();
  assert.equal(await page.locator('#dirtybar').isVisible(), false);
  await page.waitForFunction(() => document.querySelector('#ok').hidden, null, { timeout: 12000 });
  await page.reload();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#ok').isVisible(), false, 'Reloading does not repeat the confirmation');
}));

test('a publication that finishes before the first status check still confirms', () => shop(async (page, context) => {
  await page.addInitScript(() => sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'));
  let latest = { id: 'older-release', state: 'published' };
  await context.route('**/api/admin/publish', route => {
    if (route.request().method() === 'POST') {
      latest = { id: 'fast-release', state: 'published' };
      return route.fulfill({ json: { id: latest.id, message: 'Queued' } });
    }
    return route.fulfill({ json: { dirty: false, latest } });
  });
  await ready(page, '/admin/');
  assert.equal(await page.locator('#ok').isVisible(), false);
  await page.locator('#pub2').click();
  await page.getByText('Published. Customers now see your changes.', { exact: true }).waitFor();
}));

test('a superseded or mismatched publication clears the queued banner cleanly', () => shop(async (page, context) => {
  await page.addInitScript(() => sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'));
  let latest = { id: 'older-release', state: 'published' };
  let dirty = true;
  await context.route('**/api/admin/publish', route => {
    if (route.request().method() === 'POST') {
      latest = { id: 'watched-release', state: 'queued' };
      return route.fulfill({ json: { id: latest.id, message: 'Publication queued. Saved edits remain pending until deployment is confirmed.' } });
    }
    return route.fulfill({ json: { dirty, latest } });
  });
  await ready(page, '/admin/');
  await page.locator('#pub2').click();
  await page.getByText('Publish queued…', { exact: true }).waitFor();
  latest = { id: 'different-newer-release', state: 'published' };
  dirty = false;
  await page.getByText('Published. Customers now see your changes.', { exact: true }).waitFor();
  assert.equal(await page.locator('#dirtybar').isVisible(), false);
}));

test('a stale publication status response cannot clear newly saved edits',()=>shop(async(page,context)=>{
 await page.addInitScript(()=>sessionStorage.setItem('t','local-admin-token-for-this-computer-only'));
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 let saved=false;
 // Each status answer reflects the moment it was requested, so only the pre-save answer is stale.
 await context.route('**/api/admin/publish',async r=>{const dirty=saved;await gate;return r.fulfill({json:{dirty,latest:{state:'published'}}});});
 await context.route('**/api/admin/settings',r=>{if(r.request().method()!=='PUT')return r.continue();saved=true;return r.fulfill({json:{}});});
 try {
  await page.goto('/admin/#shop');
  await page.locator('[name="name"]').fill('Newly saved shop');
  await page.locator('#sf .stick button').first().click();
  await page.waitForFunction(()=>document.querySelector('.save-status')?.textContent==='All changes saved');
  release();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#dirtybar').isVisible(),true);
 } finally {release();}
}));

test('publish with nothing new never queues a build and says so', () => shop(async (page, context) => {
  await page.addInitScript(() => sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'));
  let posts = 0;
  await context.route('**/api/admin/publish', route => {
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ json: { state: 'unchanged', message: 'Nothing new to publish. The website already shows your saved edits.' } }); }
    return route.fulfill({ json: { dirty: false, latest: { id: 'live', state: 'published' } } });
  });
  await ready(page, '/admin/');
  assert.equal(await page.locator('#dirtybar').isVisible(), false);
  await page.locator('#pub2').click();
  await page.getByText(/Nothing new to publish/).waitFor();
  assert.equal(posts, 1);
  assert.equal(await page.locator('#dirtybar').isVisible(), false);
}));

test('a failed publication stays visible with its reason, build log and retry', () => shop(async (page, context) => {
  await page.addInitScript(() => sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'));
  const run = 'https://github.com/owner/repo/actions/runs/42';
  let latest = { id: 'live', state: 'published' };
  await context.route('**/api/admin/publish', route => {
    if (route.request().method() === 'POST') { latest = { id: 'try', state: 'running', run }; return route.fulfill({ json: { id: 'try', state: 'queued', message: 'Publish started.' } }); }
    return route.fulfill({ json: { dirty: true, latest, history: [latest] } });
  });
  await ready(page, '/admin/');
  await page.locator('#pub').click();
  await page.getByText('Publishing your website…', { exact: true }).waitFor();
  assert.equal(await page.locator('#pub').isDisabled(), true);
  assert.equal(await page.locator('#pub2').isDisabled(), true);
  assert.equal(await page.locator('#publog').getAttribute('href'), run);
  latest = { id: 'try', state: 'failed', run, error: 'The website build failed. <b>x</b>' };
  await page.getByText('Publish failed', { exact: true }).waitFor({ timeout: 12000 });
  assert.match(await page.locator('#dirtymsg').textContent(), /The website build failed\. <b>x<\/b> Your saved edits are safe/);
  assert.equal(await page.locator('#dirtybar.failed').isVisible(), true);
  assert.equal(await page.locator('#publog').isVisible(), true);
  assert.equal(await page.locator('#pub').textContent(), 'Retry publish');
  assert.equal(await page.locator('#pub').isDisabled(), false);
  assert.equal(await page.locator('#pub2').isDisabled(), false);
  await page.reload();
  await page.getByText('Publish failed', { exact: true }).waitFor();
}));

test('a non-dirty failed publication can be dismissed from the banner and stays in operations history', () => shop(async (page, context) => {
  await page.addInitScript(() => sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'));
  const run = 'https://github.com/owner/repo/actions/runs/99';
  const failed = { id: 'code-fail', state: 'failed', run, error: 'Cloudflare deployment failed.', created: '2026-11-23T12:00:00Z' };
  await context.route('**/api/admin/publish', route => route.fulfill({ json: { dirty: false, latest: failed, history: [failed] } }));
  await ready(page, '/admin/');
  await page.getByText('Last publish failed', { exact: true }).waitFor();
  assert.equal(await page.locator('#pub').isVisible(), false);
  assert.equal(await page.locator('#publog').isVisible(), true);
  assert.equal(await page.locator('#pubdismiss').isVisible(), true);
  await page.locator('#pubdismiss').click();
  assert.equal(await page.locator('#dirtybar').isVisible(), false);
  await page.reload();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#dirtybar').isVisible(), false);
  await page.goto('/admin/#operations');
  await page.getByText('Website publishing', { exact: true }).waitFor();
  assert.match(await page.locator('#pub-panel').textContent(), /Cloudflare deployment failed\./);
}));

test('phone categories are keyboard accessible and restore focus after closing', () => shop(async page => {
  await page.setViewportSize({ width: 320, height: 640 });
  await ready(page, '/');
  const button = page.locator('[data-categories]');
  await button.focus(); await page.keyboard.press('Enter');
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByRole('dialog', { name: 'Shop by category' }).isVisible(), true);
  assert.ok(await page.locator('.drawer-links a').count() > 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-categories]').getAttribute('aria-expanded') === 'false');
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  assert.equal(await button.evaluate(el => el === document.activeElement), true);
}));

test('search suggestions announce the active keyboard selection and Escape closes them', () => shop(async page => {
  await ready(page, '/');
  const input = page.locator('[data-suggest]');
  await input.fill('test');
  await page.waitForFunction(() => document.querySelector('[data-suggest]').getAttribute('aria-expanded') === 'true');
  await page.keyboard.press('ArrowDown');
  assert.equal(await input.getAttribute('aria-activedescendant'), 'suggestion-0');
  assert.equal(await page.locator('#suggestion-0').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('[data-suggestions]').isVisible(), false);
}));

test('catalog filters restore from URLs, reject reversed prices, and reset cleanly', () => shop(async page => {
  await ready(page, '/shop/?min=99999999&sort=asc');
  assert.equal(await page.locator('[data-min]').inputValue(), '99999999');
  assert.equal(await page.locator('[data-nomatch]').isVisible(), true);
  await page.locator('[data-max]').fill('1');
  await page.locator('[data-max]').press('Tab');
  assert.equal(await page.locator('[data-filter-error]').isVisible(), true);
  await page.reload();
  assert.equal(await page.locator('[data-max]').inputValue(), '1');
  await page.locator('[data-reset-filters]').click();
  assert.equal(new URL(page.url()).search, '');
  assert.equal(await page.locator('[data-nomatch]').isVisible(), false);
  assert.equal(await page.locator('[data-filter-error]').isVisible(), false);
  assert.ok(await page.locator('[data-card]:visible').count() > 0);
}));

test('brand and color filters use actual catalog attributes', () => shop(async page => {
  await ready(page, '/shop/');
  await page.locator('.filter-panel summary').click();
  let checked = 0;
  for (const [field, key] of [['[data-brand]', 'brands'], ['[data-color]', 'colors']]) {
    if (!await page.locator(field).count()) continue;
    const value = await page.locator(`${field} option`).nth(1).getAttribute('value');
    await page.locator(field).selectOption(value);
    const values = await page.locator('[data-card]:visible').evaluateAll((els, key) => els.map(el => JSON.parse(el.dataset[key])), key);
    assert.ok(values.length > 0);
    assert.ok(values.every(list => list.includes(value)));
    await page.locator(field).selectOption('');
    checked++;
  }
  if (!checked) {
    const counts = await page.locator('[data-card]').evaluateAll(els => ['brands', 'colors'].map(key => new Set(els.flatMap(el => JSON.parse(el.dataset[key] || '[]'))).size));
    assert.ok(counts.every(n => n <= 1), 'Do not invent attribute filters without real choices');
  }
}));

test('removed cart products and changed prices are explained', () => shop(async page => {
  await page.addInitScript(() => localStorage.setItem('cartPrices', JSON.stringify({ 1: 900 })));
  await ready(page, '/cart/');
  assert.match(await page.locator('[data-cart-notice]').textContent(), /removed/);
  assert.match(await page.locator('.price-change').textContent(), /changed from ৳900/);
  assert.equal(await page.locator('[data-sub]').textContent(), '৳1,000');
}, { cart: { 1: 1, 99999999: 1 } }));

async function fillCheckout(page) {
  await ready(page, '/checkout/');
  await page.locator('[name="name"]').fill('Test buyer');
  await page.locator('[name="phone"]').fill('+৮৮০ ১৭১০-০০০০০০');
  await page.locator('[name="address"]').fill('Test address, Bangladesh');
}

test('uncertain checkout retries keep one request key and unchanged details with blocked session storage', () => shop(async (page, context) => {
  await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
  const sent = [];
  await context.route('**/api/checkout', r => { sent.push(r.request().postDataJSON()); return r.abort('failed'); });
  await fillCheckout(page);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').textContent === 'Check order status');
  assert.match(await page.locator('[data-err]').textContent(), /Do not send payment again/);
  assert.equal(await page.locator('[name="name"]').isDisabled(), true);
  assert.equal(await page.locator('[data-err]').evaluate(el => el === document.activeElement), true);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').textContent === 'Check order status');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].phone, '01710000000');
}, { cart: { 1: 1 } }));

test('deterministic checkout errors preserve input and changed delivery details get a new key', () => shop(async (page, context) => {
  const sent = [];
  await context.route('**/api/checkout', r => { sent.push(r.request().postDataJSON()); return r.fulfill({ status: 400, json: { error: 'Please correct the address' } }); });
  await fillCheckout(page);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-err]').textContent === 'Please correct the address');
  assert.equal(await page.locator('[name="name"]').inputValue(), 'Test buyer');
  assert.equal(await page.locator('[name="address"]').isDisabled(), false);
  await page.locator('[name="address"]').fill('Different test address, Bangladesh');
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-err]').textContent === 'Please correct the address');
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].key, sent[1].key);
}, { cart: { 1: 1 } }));

test('expired bot challenges show a focused error and allow a fresh challenge', () => shop(async (page, context) => {
  let sent = 0;
  await context.route('**/api/checkout', r => { sent++; return r.fulfill({ status: 403, json: { error: 'Please complete the security check again' } }); });
  await fillCheckout(page);
  await page.evaluate(() => {
    const widget = document.createElement('div'); widget.className = 'cf-turnstile';
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'cf-turnstile-response';
    widget.append(input); document.querySelector('[data-checkout] aside').append(widget);
    window.turnstile = { reset() { input.value = ''; } };
  });
  await page.locator('button[type="submit"]').click();
  assert.equal(sent, 0);
  assert.match(await page.locator('[data-err]').textContent(), /security check/);
  await page.locator('[name="cf-turnstile-response"]').evaluate(el => { el.value = 'expired-test'; });
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-err]').textContent.includes('again'));
  assert.equal(sent, 1);
  assert.equal(await page.locator('[name="cf-turnstile-response"]').inputValue(), '');
  assert.equal(await page.locator('[name="name"]').isDisabled(), false);
}, { cart: { 1: 1 } }));

test('support forms retain failed input and guard repeated taps', () => shop(async (page, context) => {
  let sent = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/api/contact', async r => { sent++; await gate; return r.fulfill({ status: 429, json: { error: 'Please wait before sending another message' } }); });
  await ready(page, '/contact-us/');
  const form = page.locator('[data-contact]');
  await form.locator('[name="name"]').fill('রহিম');
  await form.locator('[name="contact"]').fill('০১৭১০০০০০০০');
  await form.locator('[name="body"]').fill('Please help with my order');
  await form.locator('button').click();
  await form.evaluate(f => f.dispatchEvent(new Event('submit', { cancelable: true })));
  release();
  await page.waitForFunction(() => document.querySelector('[data-contact] .err').textContent.includes('wait'));
  assert.equal(sent, 1);
  assert.equal(await form.locator('[name="body"]').inputValue(), 'Please help with my order');
  assert.equal(await form.locator('.err').evaluate(el => el === document.activeElement), true);
}));

test('tracking rejects a wrong phone without exposing an order and tolerates malformed saved orders', () => shop(async (page, context) => {
  await page.addInitScript(() => localStorage.setItem('myOrders', JSON.stringify([null, {}, { number: 'LB-TEST', phone: '01710000000' }])));
  let phone;
  await context.route('**/api/track?*', r => { phone = new URL(r.request().url()).searchParams.get('phone'); return r.fulfill({ status: 404, json: { error: 'Order not found. Check your order number and phone.' } }); });
  await ready(page, '/track/');
  await page.locator('[name="order"]').fill('LB-TEST');
  await page.locator('[name="phone"]').fill('০১৭১০০০০০০০');
  await page.locator('[data-track] button').click();
  await page.waitForFunction(() => document.querySelector('[data-err]').textContent.includes('not found'));
  assert.equal(phone, '01710000000');
  assert.equal(await page.locator('[data-order]').textContent(), '');
  assert.equal(await page.locator('[data-mine-order]').count(), 1);
}));

test('account loading failures have a retry and expired sessions offer optional login', () => shop(async (page, context) => {
  let fail = true;
  await context.route('**/api/me', r => r.fulfill({ status: fail ? 503 : 401, json: { error: fail ? 'Shop is waking up' : 'Sign in' } }));
  await ready(page, '/my-account/');
  assert.equal(await page.locator('[data-auth]').isVisible(), false);
  fail = false;
  await page.locator('[data-retry-account]').click();
  await page.waitForFunction(() => !document.querySelector('[data-auth]').hidden);
  assert.equal(await page.locator('[data-form="login"]').isVisible(), true);
}));

test('phone forms yield fixed navigation while editing and controls meet touch sizes', () => shop(async page => {
  await ready(page, '/checkout/');
  await page.locator('[name="name"]').focus();
  assert.equal(await page.locator('.mobile-nav').isVisible(), false);
  const box = await page.locator('button[type="submit"]').boundingBox();
  assert.ok(box.height >= 44);
  await page.locator('h1').click();
  await page.waitForFunction(() => !document.body.classList.contains('is-editing'));
  assert.equal(await page.locator('.mobile-nav').isVisible(), true);
}, { cart: { 1: 1 } }));

test('reduced motion and 200 percent layout reflow remain usable', () => shop(async page => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // A desktop viewport reduced to 720 CSS pixels represents 200% desktop zoom reflow.
  await page.setViewportSize({ width: 720, height: 450 });
  await ready(page, '/shop/');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.filter-panel summary').click();
  assert.equal(await page.locator('[data-min]').isVisible(), true);
  const duration = await page.locator('.btn').first().evaluate(el => getComputedStyle(el).transitionDuration);
  assert.ok(duration.split(',').every(value => parseFloat(value) <= 0.001));
}));

test('blocked shopping storage explains its limits and keeps the current page usable', () => shop(async page => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
  await ready(page, '/search/?q=test');
  await page.locator('[data-add="1"]').click();
  assert.equal(await page.locator('[data-storage-notice]').isVisible(), true);
  assert.match(await page.locator('[data-storage-notice]').textContent(), /between pages/);
  assert.ok(await page.locator('[data-cart-count]:visible').count() > 0);
}));

test('mobile order controls prevent duplicate updates and show payment verification guidance', () => shop(async (page, context) => {
  await page.addInitScript(() => sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'));
  const order = { number: 'LB-FIXTURE', name: 'Fixture buyer', phone: '01710000000', email: 'fixture@example.invalid', address: 'Fixture address', area: 'local', total: 1060, payment: 'Mobile payment', txn_id: 'FIXTURE123', status: 'pending', items: [{ name: 'Cooker', qty: 1, price: 1000 }] };
  let updates = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/api/admin/orders?*', r => r.fulfill({ json: { orders: [order], total: 1, sales: 1060, size: 50 } }));
  await context.route('**/api/admin/orders/LB-FIXTURE', async r => {
    updates++;
    if (order.status === 'pending') {
      assert.deepEqual(r.request().postDataJSON(), { status: 'confirmed', expectedStatus: 'pending' });
      order.status = 'confirmed';
      return r.fulfill({ json: { emailQueued: false } });
    }
    assert.deepEqual(r.request().postDataJSON(), { status: 'shipped', expectedStatus: 'confirmed' });
    await gate;
    order.status = 'shipped';
    return r.fulfill({ json: { emailQueued: true } });
  });
  await ready(page, '/admin/#orders');
  for (const width of [320, 360, 375, 390, 414]) {
    await page.setViewportSize({ width, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('[data-order-row]').isVisible(), true);
  }
  await page.getByRole('button', { name: 'Manage' }).click();
  assert.equal(await page.locator('.order-payment-note').isVisible(), true);
  await page.locator('[name="status"]').selectOption('confirmed');
  assert.equal(await page.locator('.order-mail-note').textContent(), 'Order email: fixture@example.invalid');
  await page.getByRole('button', { name: 'Save order' }).click();
  await page.waitForSelector('[data-order-row] .tag.confirmed');
  assert.equal(await page.locator('#ok').textContent(), 'Order saved.');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.locator('[name="status"]').selectOption('shipped');
  assert.match(await page.locator('.order-mail-note').textContent(), /shipping email to fixture@example.invalid/);
  await page.getByRole('button', { name: 'Save order' }).click();
  await page.locator('form[data-n]').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  release();
  await page.waitForSelector('[data-order-row] .tag.shipped');
  assert.match(await page.locator('#ok').textContent(), /Customer email queued/);
  assert.equal(updates, 2);
}));

test('late admin reads cannot replace a newly selected section', () => shop(async (page, context) => {
  await page.addInitScript(() => sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/api/admin/customers?*', async r => { await gate; await r.continue(); });
  await ready(page, '/admin/');
  await page.locator('#admin-section').selectOption('customers');
  await page.waitForSelector('#clist');
  await page.locator('#admin-section').selectOption('pages');
  await page.waitForSelector('#view #newdoc');
  release();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#head h1').textContent(), 'Pages');
  assert.equal(await page.locator('#clist').count(), 0);
  assert.equal(await page.locator('#err').textContent(), '');
}));

test('long Bangla product names, image failures and purchase controls fit all target widths', () => shop(async page => {
  await ready(page, '/shop/');
  const href = await page.locator('.card .thumb').first().getAttribute('href');
  await ready(page, href);
  await page.locator('.pd h1').evaluate(el => { el.textContent = 'বাংলাদেশের রান্নাঘরের জন্য রাইস কুকার এবং দীর্ঘ নামের গৃহস্থালি পণ্য SuperLongModelWithoutSpaces1234567890'; });
  await page.waitForFunction(() => document.querySelector('[data-main]').src.endsWith('/placeholder.svg'));
  for (const width of [320, 360, 375, 390, 414, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Product at ${width}px`);
    const buttons = await page.locator('.buy button').evaluateAll(els => els.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
    assert.ok(buttons.every(box => box.width >= 44 && box.height >= 44));
  }
}));

test('product photos stay local until Save and survive a rejected save without uploading discarded files', () => shop(async (page, context) => {
  await page.addInitScript(() => { if (location.protocol === 'http:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  let uploads = 0;
  let saves = [];
  await context.route('**/api/admin/image?*', r => { uploads++; return r.abort(); });
  await context.route('**/api/admin/products', async r => {
    if (r.request().method() !== 'POST') return r.continue();
    saves.push(r.request().postDataBuffer().toString('latin1'));
    return saves.length === 1 ? r.fulfill({ status: 502, json: { error: 'Fixture save rejected' } }) : r.fulfill({ json: { ok: true, id: 123 } });
  });
  await ready(page, '/admin/#new-product');
  const abandoned = { name: 'abandoned.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64') };
  await page.locator('#pf [name="name"]').fill('Unsaved photo fixture');
  await page.locator('#up').setInputFiles(abandoned);
  assert.match(await page.locator('#imgs img').getAttribute('src'), /^blob:/);
  page.once('dialog', d => d.accept());
  await page.locator('#back').click();
  await page.waitForSelector('#rows');
  assert.equal(uploads, 0);
  assert.equal(saves.length, 0);

  await page.locator('#new').click();
  await page.locator('#pf [name="name"]').fill('Saved photo fixture');
  await page.locator('#pf [name="price"]').fill('1250');
  await page.locator('#pf [name="stock"]').fill('1');
  await page.locator('#up').setInputFiles([{ ...abandoned, name: 'discarded.png' }, { ...abandoned, name: 'retained.png' }]);
  const last = await page.locator('#imgs img').last().getAttribute('src');
  await page.locator('#imgs [data-r]').first().click();
  assert.equal(await page.locator('#imgs img').first().getAttribute('src'), last);
  const touch = await page.locator('#imgs [data-x]').last().boundingBox();
  assert.ok(touch.width >= 44 && touch.height >= 44);
  await page.locator('#imgs [data-x]').last().click();
  await page.locator('#pf .stick button').first().click();
  await page.waitForFunction(() => document.querySelector('#err').textContent.includes('Fixture save rejected'));
  assert.equal(await page.locator('#imgs img').count(), 1);
  assert.equal(await page.locator('#imgs img').getAttribute('src'), last);
  await page.locator('#pf .stick button').first().click();
  await page.waitForSelector('#rows');
  assert.equal(uploads, 0);
  assert.equal(saves.length, 2);
  for (const body of saves) {
    assert.match(body, /retained\.png/);
    assert.doesNotMatch(body, /discarded\.png|abandoned\.png|blob:/);
  }
  const key = body => body.match(/name="saveKey"\r\n\r\n([a-f0-9]{32})/)[1];
  assert.equal(key(saves[0]), key(saves[1]));
}));

test('returning to products during a slow catalog read finishes the latest navigation', () => shop(async (page, context) => {
  await page.addInitScript(() => { if (location.protocol === 'http:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/api/admin/products', async r => { await gate; await r.continue(); });
  await ready(page, '/admin/');
  const requested = page.waitForRequest(r => new URL(r.url()).pathname === '/api/admin/products');
  await page.locator('#admin-section').selectOption('products');
  await requested;
  await page.locator('#admin-section').selectOption('pages');
  await page.waitForSelector('#newdoc');
  await page.locator('#admin-section').selectOption('products');
  release();
  await page.waitForSelector('#rows');
  assert.equal(await page.locator('#head h1').textContent(), 'Products');
  assert.equal(await page.locator('#err').textContent(), '');
}));

test('admin analytics renders business insights, enriched products, countries, escapes text, and toggles months', () => shop(async (page, context) => {
  await page.addInitScript(() => { if (location.protocol === 'http:' || location.protocol === 'https:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  const days = Array.from({ length: 7 }, (_, i) => ({
    day: `2026-11-${15 + i}`,
    visitors: 10 + i * 5,
    pageviews: 25 + i * 10,
    orders: i === 6 ? 2 : 1,
    sales: i === 6 ? 2500 : 1000,
    hasVisitors: true,
    sampleRate: 1,
    finalized: i < 6,
  }));
  const months = Array.from({ length: 12 }, (_, i) => {
    const dt = new Date(Date.UTC(2025, 11 + i, 1));
    const ym = dt.toISOString().slice(0, 7);
    const label = dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const current = i === 11;
    const prev = i === 10;
    return {
      month: ym,
      label,
      current,
      visitors: current ? 420 : prev ? 350 : 0,
      pageviews: current ? 1100 : prev ? 900 : 0,
      orders: current ? 12 : prev ? 10 : 0,
      sales: current ? 24000 : prev ? 19000 : 0,
      daysRecorded: current ? 21 : prev ? 31 : 0,
      daysInPeriod: current ? 21 : 31,
      sampledDays: 0,
      avgPerDay: current ? 20 : prev ? 11.3 : null,
      changePct: current ? 20 : null,
    };
  });
  const basePayload = {
    configured: true,
    missingConfig: [],
    source: 'cloudflare_rum',
    sourceLabel: 'Cloudflare Web Analytics (human visits, bot-filtered)',
    timezone: 'Asia/Dhaka',
    syncedAt: '2026-11-21T11:00:00Z',
    stale: false,
    syncError: '',
    lowStock: 5,
    today: days[6],
    yesterday: days[5],
    last7Days: { visitors: 175, pageviews: 385, orders: 8, sales: 8500, daysRecorded: 7, prevVisitors: 140, prevPageviews: 300, prevOrders: 6, prevSales: 6000, prevDaysRecorded: 7, days },
    months,
    breakdowns: {
      windowDays: 7,
      topPages: [
        { path: '/product/rice-cooker/', title: 'Kiam Rice Cooker 1.8L', kind: 'product', productId: 42, price: 2450, stock: 0, sold30d: 4, visits: 44, pageviews: 90 },
        { path: '/<img src=x onerror=alert(1)>', title: '<img src=x onerror=alert(1)>', kind: 'page', visits: 3, pageviews: 5 },
      ],
      referrers: [{ source: 'Google Search', visits: 110, pageviews: 150 }, { source: 'Direct / shared link<script>x</script>', visits: 35, pageviews: 70 }],
      devices: [{ device: 'Mobile', visits: 150, pageviews: 320 }],
      countries: [{ country: 'BD', visits: 168, pageviews: 370 }],
    },
  };
  let syncCalls = 0;
  await context.route('**/api/admin/analytics', r => r.fulfill({ json: basePayload }));
  await context.route('**/api/admin/analytics/sync', r => {
    syncCalls++;
    const updatedDays = days.map((d, idx) => idx === 6 ? { ...d, visitors: 55, pageviews: 120 } : d);
    return r.fulfill({ json: { ...basePayload, today: updatedDays[6], last7Days: { ...basePayload.last7Days, visitors: 190, days: updatedDays } } });
  });

  for (const width of [320, 375, 414]) {
    await page.setViewportSize({ width, height: 812 });
    await ready(page, '/admin/#analytics');
    await page.waitForSelector('#refresh-analytics');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Analytics ${width}px overflow`);
  }

  assert.equal(await page.locator('#head h1').textContent(), 'Visitor & sales insights');
  const viewText = await page.locator('#view').textContent();
  assert.match(viewText, /Stock opportunity: Kiam Rice Cooker 1\.8L/);
  assert.match(viewText, /Bangladesh/);
  assert.match(viewText, /Sold out/);
  assert.doesNotMatch(viewText, /Dec 2025/);
  assert.equal(await page.locator('#view img').count(), 0);
  assert.equal(await page.locator('#view script').count(), 0);

  await page.locator('#toggle-months').click();
  assert.match(await page.locator('#view').textContent(), /Dec 2025/);

  await page.locator('#refresh-analytics').click();
  await page.waitForFunction(() => document.querySelector('.analytics-tiles')?.textContent?.includes('55'));
  assert.equal(syncCalls, 1);

  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Analytics 1440px overflow');
}));

test('front page silently recovers when /api/stock returns 503 during cold start', () => shop(async (page, context) => {
  let requests = 0;
  await page.clock.install();
  await context.route('**/api/stock', r => {
    requests++;
    if (requests === 1) return r.fulfill({ status: 503, json: { error: 'The shop is busy' } });
    return r.fulfill({
      json: {
        products: { 1: [1000, 1200, 10] },
        settings: { ...settings, payments: [{ id: 'bkash', label: 'bKash', enabled: true, number: '017' }] },
      },
    });
  });
  const first = page.waitForResponse(r => r.url().includes('/api/stock'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await first;
  await page.evaluate(() => new Promise(queueMicrotask));
  assert.equal(requests, 1);
  assert.equal(await page.locator('[data-stock-notice]').count(), 0);
  const second = page.waitForResponse(r => r.url().includes('/api/stock'));
  await page.clock.runFor(4100);
  await second;
  await page.waitForFunction(() => document.querySelector('[data-payment-feature]')?.textContent === 'bKash');
  assert.equal(requests, 2);
  assert.equal(await page.locator('[data-stock-notice]').count(), 0);
}));

test('prolonged stock outage shows notice only after retries exhaust, and Try again recovers', () => shop(async (page, context) => {
  let requests = 0;
  let healthy = false;
  await page.clock.install();
  await context.route('**/api/stock', r => {
    requests++;
    if (!healthy) return r.fulfill({ status: 503, json: { error: 'The shop is busy' } });
    return r.fulfill({
      json: {
        products: { 1: [1000, 1200, 10] },
        settings: { ...settings, payments: [{ id: 'nagad', label: 'Nagad', enabled: true, number: '015' }] },
      },
    });
  });
  const first = page.waitForResponse(r => r.url().includes('/api/stock'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await first;
  await page.evaluate(() => new Promise(queueMicrotask));
  assert.equal(requests, 1);
  assert.equal(await page.locator('[data-stock-notice]').count(), 0);

  const delays = [4000, 6000, 8000, 10000, 12000, 15000];
  for (let i = 0; i < delays.length; i++) {
    const next = page.waitForResponse(r => r.url().includes('/api/stock'));
    await page.clock.runFor(delays[i] + 100);
    await next;
    await page.evaluate(() => new Promise(queueMicrotask));
    assert.equal(requests, i + 2);
    if (i < delays.length - 1) {
      assert.equal(await page.locator('[data-stock-notice]').count(), 0);
    }
  }
  await page.locator('[data-stock-notice]').waitFor();

  healthy = true;
  const recovered = page.waitForResponse(r => r.url().includes('/api/stock'));
  await page.locator('[data-stock-notice] button').click();
  await recovered;
  await page.waitForFunction(() => !document.querySelector('[data-stock-notice]') && document.querySelector('[data-payment-feature]')?.textContent === 'Nagad');
  assert.equal(requests, 8);
}));

test('failed stale background refresh does not show notice when stock is already loaded', () => shop(async (page, context) => {
  let requests = 0;
  await page.clock.install();
  await context.route('**/api/stock', r => {
    requests++;
    if (requests === 1) {
      return r.fulfill({ headers: { 'X-Stock-Stale': '1' }, json: { products: { 1: [1000, 1200, 10] }, settings } });
    }
    return r.fulfill({ status: 503, json: { error: 'The shop is busy' } });
  });
  const first = page.waitForResponse(r => r.url().includes('/api/stock'));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await first;
  await page.evaluate(() => new Promise(queueMicrotask));
  for (const delay of [5500, 10000, 15000, 20000]) {
    const next = page.waitForResponse(r => r.url().includes('/api/stock'));
    await page.clock.runFor(delay + 100);
    await next;
    await page.evaluate(() => new Promise(queueMicrotask));
  }
  assert.equal(requests, 5);
  assert.equal(await page.locator('[data-stock-notice]').count(), 0);
}));

test('search-index failure in Recently Viewed on front page does not trigger stock notice', () => shop(async (page, context) => {
  await page.addInitScript(() => localStorage.setItem('seen', JSON.stringify([1])));
  await context.route('**/search-index.json', r => r.fulfill({ status: 503, body: '' }));
  await ready(page, '/');
  assert.equal(await page.locator('[data-stock-notice]').count(), 0);
}));

test('ads.js initializes slots lazily, collapses unfilled slots, and avoids horizontal overflow', () => shop(async page => {
  await ready(page, '/');
  await page.evaluate(() => {
    const main = document.querySelector('main');
    const aside = document.createElement('aside');
    aside.className = 'ad-slot';
    aside.setAttribute('aria-label', 'Advertisement');
    aside.dataset.adSlotWrap = '';
    aside.innerHTML = '<span class="ad-slot-label">Advertisement</span><div class="ad-slot-frame"><ins class="adsbygoogle" style="display:block;width:100%"></ins></div>';
    main.append(aside);
  });
  await page.addScriptTag({ url: '/ads.js' });
  await page.locator('[data-ad-slot-wrap]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => Array.isArray(window.adsbygoogle) && window.adsbygoogle.length === 1);
  for (const width of [320, 375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Ad slot overflowed at ${width}px`);
  }
  await page.evaluate(() => {
    document.querySelector('ins.adsbygoogle').dataset.adStatus = 'unfilled';
  });
  await page.waitForFunction(() => document.querySelector('[data-ad-slot-wrap]').hidden === true);
  assert.equal(await page.locator('[data-ad-slot-wrap]').isVisible(), false);
}));
