// Real writes: invoke only through scripts/test-mobile.sh, which owns a disposable stack.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const baseURL = process.env.SHOP_URL;
const url = new URL(baseURL || 'https://invalid.example');
assert.equal(process.env.LB_ISOLATED, '1', 'Use scripts/test-mobile.sh');
assert.equal(url.hostname, '127.0.0.1', 'Only the owned loopback fixture is allowed');
assert.ok(url.port && url.port !== '8787', 'Do not use the ordinary local shop');
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
const headers = { 'X-Admin-Token': 'local-admin-token-for-this-computer-only' };
const errors = [];
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGOYo2wHRAwQCgAdMgP1kQ5QGAAAAABJRU5ErkJggg==', 'base64');
context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
const shotDir = process.env.LB_SCREENSHOTS;
if (shotDir) await fs.mkdir(shotDir, { recursive: true });
const canInspectPDF = spawnSync('pdftotext', ['-v']).status === 0;
if (process.env.CI === 'true') assert.ok(canInspectPDF, 'Install poppler-utils for the invoice layout check.');

function inspectInvoice(pdf, multipage) {
  if (!canInspectPDF) return;
  const extract = (format) => {
    const result = spawnSync('pdftotext', [format, '-', '-'], { input: pdf, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const pages = [...extract('-bbox').matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)];
  assert.ok(multipage ? pages.length > 1 : pages.length === 1, 'Invoice pagination');
  for (const [, width, height, page] of pages) {
    assert.equal(Number(width).toFixed(2), '595.28');
    assert.equal(Number(height).toFixed(2), '841.89');
    assert.match(page, />Amount<\/word>/, 'Repeat item column headings');
    for (const [, left, right] of page.matchAll(/<word xMin="([\d.]+)" yMin="[^"]+" xMax="([\d.]+)"/g)) {
      assert.ok(Number(left) >= 44 && Number(right) <= Number(width) - 44, 'Invoice text stays inside A4 margins');
    }
  }
  const content = extract('-layout');
  assert.doesNotMatch(content, /private-fixture@example|Private staff fixture note/i);
  const lastPage = content.trimEnd().split('\f').at(-1);
  assert.match(lastPage, multipage ? /Order total +৳ *30,050$/m : /Order total +৳ *550$/m);
  if (multipage) {
    assert.match(lastPage, /রাইস কুকার · Item 60/);
  } else {
    assert.match(content, /House 12 <Unit B>, Example Road/);
    assert.match(content, /Discount \(FIXTURE\)\s+−৳\s*50/);
    assert.match(content, /Transaction reference\s+FIXTURE-TXN-42/);
  }
}

const shot = async (page, name) => { if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: false }); };
const request = async (method, path, data, admin = true) => {
  const r = await context.request.fetch(path, { method, data, headers: admin ? headers : {} });
  const out = await r.json();
  assert.equal(r.status(), 200, `${method} ${path}: ${JSON.stringify(out)}`);
  return out;
};
try {
  await context.addInitScript(() => { if (location.protocol === 'http:') sessionStorage.setItem('t', 'local-admin-token-for-this-computer-only'); });
  const missingAPI = await context.request.get('/api/not-a-fixture-route');
  assert.equal(missingAPI.status(), 404);
  assert.equal(missingAPI.headers()['cache-control'], 'no-store');
  assert.deepEqual(await missingAPI.json(), { error: 'not found' });

  for (const [source, destination] of [
    ['/product-category/chair/page/1/', '/product-category/chair/'],
    ['/product/kiam-pressure-cooker-kiam-5-5-queen', '/product/kiam-pressure-cooker-kiam-5-5-queen/'],
  ]) {
    const redirect = await context.request.get(source, { maxRedirects: 0 });
    assert.equal(redirect.status(), 301, source);
    assert.equal(redirect.headers().location, destination, source);
    const target = await context.request.get(destination, { maxRedirects: 0 });
    assert.equal(target.status(), 200, destination);
  }
  const missingLegacyPage = await context.request.get('/product-category/chair/page/2/', { maxRedirects: 0 });
  assert.equal(missingLegacyPage.status(), 404);

  const admin = await context.newPage();
  await request('PUT', '/api/admin/content/cat/fixture-kitchen', { name: 'Fixture Kitchen' });
  await request('PUT', '/api/admin/content/page/fixture-warranty', { title: 'Fixture warranty', html: '<p>Local warranty fixture.</p>' });
  const unpublished = await context.request.get('/fixture-warranty/');
  assert.equal(unpublished.status(), 404);
  await admin.goto('/admin/#new-product');
  await admin.locator('#pf [name="name"]').fill('Mobile fixture cooker');
  await admin.locator('#pf [name="price"]').fill('1000');
  await admin.locator('#pf [name="stock"]').fill('2');
  await admin.locator('#pf input[name="cat"][value="fixture-kitchen"]').check();
  await admin.locator('#up').setInputFiles({ name: 'fixture-photo.png', mimeType: 'image/png', buffer: photo });
  await admin.waitForFunction(() => document.querySelector('#imgs img')?.naturalWidth === 2);
  assert.match(await admin.locator('#imgs img').getAttribute('src'), /^blob:/);
  await shot(admin, 'admin-editor-375');
  await admin.locator('#pf .stick button').first().click();
  await admin.waitForSelector('#rows');
  const catalog = await request('GET', '/api/admin/products');
  const products = Array.isArray(catalog) ? catalog : catalog.products;
  const product = products.find(p => p.name === 'Mobile fixture cooker');
  assert.ok(product);
  assert.match(product.images[0].src, /^\/uploads\//);
  await shot(admin, 'admin-product-375');
  // Controlled, genuine fixture attributes exercise filters without altering real products.
  await request('PUT', `/api/admin/products/${product.id}`, { ...product, attrs: [{ name: 'Brand', values: ['Fixture A'] }], stockDelta: 0 });
  await request('POST', '/api/admin/products', { name: 'Mobile fixture kettle', slug: 'mobile-fixture-kettle', price: 500, regular: 500, stock: 1, attrs: [{ name: 'Brand', values: ['Fixture B'] }] });
  await admin.locator('#pub2').click();
  await admin.waitForFunction(() => document.querySelector('#dirtybar').hidden, null, { timeout: 90000 });
  const publication = await request('GET', '/api/admin/publish');
  assert.equal(publication.latest.state, 'published');
  const deployed = await request('GET', '/release.json', undefined, false);
  assert.equal(deployed.id, publication.latest.id);
  assert.equal(deployed.environment, 'local');
  // The local asset watcher can reload new paths after release.json becomes visible.
  let uploaded = await context.request.get(product.images[0].src);
  for (let retry = 0; uploaded.status() === 404 && retry < 16; retry++) {
    await uploaded.dispose();
    await new Promise(resolve => setTimeout(resolve, 250));
    uploaded = await context.request.get(product.images[0].src);
  }
  assert.equal(uploaded.status(), 200);
  assert.match(uploaded.headers()['content-type'], /^image\/png/);
  assert.deepEqual(await uploaded.body(), photo);
  const warranty = await context.request.get('/fixture-warranty/');
  assert.equal(warranty.status(), 200);
  assert.match(await warranty.text(), /Local warranty fixture/);
  const group = await context.request.get('/product-category/fixture-kitchen/');
  assert.equal(group.status(), 200);
  assert.match(await group.text(), /Mobile fixture cooker/);
  const buyer = await context.newPage();
  await buyer.goto('/shop/');
  const mobileLinks = ['/shop/', '/wishlist/', '/track/', '/cart/'];
  for (const width of [320, 360, 375, 390, 414, 860]) {
    await buyer.setViewportSize({ width, height: 812 });
    const bar = buyer.locator('.mobile-nav a:visible');
    assert.deepEqual(await bar.evaluateAll(links => links.map(link => link.getAttribute('href'))), mobileLinks);
    for (const href of mobileLinks) {
      assert.equal(await buyer.locator(`header a[href="${href}"]:visible, footer a[href="${href}"]:visible`).count(), 0, `${href} is duplicated at ${width}px`);
    }
    assert.equal(await buyer.locator('header a[href="/my-account/"]').isVisible(), true);
    assert.equal(await buyer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await buyer.setViewportSize({ width: 1024, height: 812 });
  assert.equal(await buyer.locator('.mobile-nav').isVisible(), false);
  for (const href of mobileLinks) {
    assert.equal(await buyer.locator(`header a[href="${href}"]`).isVisible(), true);
  }
  await buyer.setViewportSize({ width: 375, height: 812 });
  await buyer.locator('.filter-panel summary').click();
  await buyer.locator('[data-brand]').selectOption('Fixture A');
  assert.equal(await buyer.locator('[data-card]:visible').count(), 1);
  await shot(buyer, 'filters-375');
  await buyer.goto(`/product/${product.slug}/`);
  await buyer.waitForFunction(() => document.querySelector('[data-main]')?.naturalWidth === 2);
  const stock = await request('GET', '/api/stock', undefined, false);
  const paidZone = stock.settings.delivery.find(zone => zone.fee > 0);
  assert.ok(paidZone, 'Fixture requires a paid delivery zone');
  const delivery = buyer.locator('[data-delivery]');
  const quantity = buyer.locator('[data-qty]');
  assert.doesNotMatch(await delivery.textContent(), /charged per item/i);
  assert.ok(await buyer.getByRole('button', { name: 'Decrease quantity' }).isDisabled());
  await buyer.getByRole('button', { name: 'Increase quantity' }).click();
  assert.equal(await quantity.inputValue(), '2');
  const freeForTwo = stock.settings.freeOver > 0 && 2000 >= stock.settings.freeOver;
  const deliveryAmount = freeForTwo ? 'Free' : '৳' + (paidZone.fee * 2).toLocaleString('en-IN');
  await buyer.waitForFunction(({ label, amount }) =>
    [...document.querySelectorAll('[data-delivery] li')].some(row =>
      row.textContent.startsWith(label + ':') && row.querySelector('b')?.textContent === amount),
  { label: paidZone.label, amount: deliveryAmount });
  const zoneRow = delivery.locator('li').filter({ hasText: paidZone.label });
  assert.equal(await zoneRow.locator('b').textContent(), deliveryAmount);
  assert.equal((await delivery.textContent()).includes('Delivery is charged per item for this area (2 items).'), !freeForTwo);
  await buyer.getByRole('button', { name: 'Decrease quantity' }).click();
  assert.equal(await quantity.inputValue(), '1');
  assert.doesNotMatch(await delivery.textContent(), /charged per item/i);
  await buyer.locator('.buy button[data-add]:not([data-buy])').click();
  await buyer.goto('/cart/');
  await buyer.locator('[data-cart]').getByText('Mobile fixture cooker', { exact: true }).waitFor();
  await buyer.locator('a[href="/checkout/"]:visible').first().click();
  await buyer.waitForURL('**/checkout/');
  const summary = buyer.getByRole('region', { name: 'Your order' });
  await summary.locator('.checkout-item').filter({ hasText: 'Mobile fixture cooker' }).waitFor();
  assert.equal(await buyer.locator('.find input').isVisible(), true);
  await shot(buyer, 'checkout-summary-375');
  await buyer.locator('[name="name"]').fill('Mobile fixture buyer');
  await buyer.locator('[name="phone"]').fill('০১৭১০০০০০০০');
  await buyer.locator('[name="address"]').fill('Fixture address, Jashore, Bangladesh');
  const area = stock.settings.delivery[0];
  const cod = stock.settings.payments.find(p => p.enabled && !p.number);
  assert.ok(cod, 'Local fixture must have a non-prepaid method');
  await buyer.locator('[name="area"]').selectOption(area.id);
  await buyer.locator('[name="payment"]').selectOption(cod.id);
  await buyer.locator('h1').click();
  await shot(buyer, 'checkout-375');
  await buyer.locator('button[type="submit"]').click();
  await buyer.waitForURL('**/track/**', { timeout: 90000 });
  await buyer.waitForSelector('[data-order] .order');
  const number = new URL(buyer.url()).searchParams.get('order');
  assert.ok(number);
  const orders = await request('GET', '/api/admin/orders');
  const order = orders.orders.find(o => o.number === number);
  assert.equal(order.total, 1000 + (stock.settings.freeOver && 1000 >= stock.settings.freeOver ? 0 : area.fee));
  assert.equal(order.phone, '01710000000');
  await shot(buyer, 'receipt-375');
  const wrongPhone = await context.request.get(`/api/track?order=${number}&phone=01999999999`);
  assert.equal(wrongPhone.status(), 404);
  const unauth = await context.request.get('/api/admin/orders');
  assert.equal(unauth.status(), 401);
  await admin.goto('/admin/#orders');
  const row = admin.locator('[data-order-row]', { hasText: number });
  const manage = row.getByRole('button', { name: 'Manage' });
  const details = admin.locator(`[id="d-${number}"]`);
  assert.equal(await details.isVisible(), false);
  assert.equal(await row.getByRole('combobox').count(), 0);
  await manage.click();
  const status = details.locator('[name="status"]');
  const saveOrder = details.getByRole('button', { name: 'Save order' });
  assert.equal(await saveOrder.isEnabled(), false);
  await status.selectOption('confirmed');
  assert.equal((await request('GET', '/api/admin/orders')).orders.find(o => o.number === number).status, 'pending');
  await saveOrder.click();
  await row.locator('.tag.confirmed').waitFor();
  await manage.click();
  await details.locator('[name="courier"]').fill('Fixture courier');
  await details.locator('[name="tracking"]').fill('FIXTURE-123');
  await status.selectOption('shipped');
  await saveOrder.click();
  await row.locator('.tag.shipped').waitFor();
  const shipment = (await request('GET', '/api/admin/orders')).orders.find(o => o.number === number);
  assert.equal(shipment.courier, 'Fixture courier');
  assert.equal(shipment.tracking, 'FIXTURE-123');
  assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot(admin, 'admin-orders-375');
  // Relative stock edit while an existing editor holds an older stock value.
  await admin.goto(`/admin/#product/${product.id}`);
  const stockField = admin.locator('#pf [name="stock"]');
  await stockField.waitFor();
  assert.equal(await stockField.inputValue(), '1');
  await request('PATCH', `/api/admin/products/${product.id}`, { stockDelta: -1 });
  await stockField.fill('4'); // +3 from what this editor saw; current DB 0 +3 => 3.
  await shot(admin, 'admin-editor-375');
  await admin.locator('#pf .stick button').first().click();
  await admin.waitForSelector('#rows');
  const afterEdit = await request('GET', '/api/admin/products');
  assert.equal((Array.isArray(afterEdit) ? afterEdit : afterEdit.products).find(p => p.id === product.id).stock, 3);
  await request('PUT', `/api/admin/orders/${number}`, { status: 'cancelled' });
  await request('PUT', `/api/admin/orders/${number}`, { status: 'cancelled' });
  const afterCancel = await request('GET', '/api/admin/products');
  assert.equal((Array.isArray(afterCancel) ? afterCancel : afterCancel.products).find(p => p.id === product.id).stock, 4);
  const csv = await context.request.get('/api/admin/orders.csv', { headers });
  assert.equal(csv.status(), 200); assert.match(await csv.text(), new RegExp(number));
  // An authenticated customer applies a real coupon, then loses the response after the server commits.
  await request('PUT', '/api/admin/coupons/FIXTURE', { kind: 'amount', value: 50, minOrder: 0, maxUses: 1, expires: '', active: true });
  await buyer.goto('/my-account/');
  const signup = buyer.locator('[data-form="register"]');
  await signup.locator('[name="name"]').fill('Signed-in fixture buyer');
  await signup.locator('[name="phone"]').fill('01710000201');
  await signup.locator('[name="password"]').fill('disposable-test-password');
  await signup.getByRole('button', {name:'Create account'}).click();
  await buyer.getByRole('heading', {name:'Hello, Signed-in fixture buyer'}).waitFor();
  await buyer.setViewportSize({ width: 375, height: 600 });
  await buyer.goto('/product/mobile-fixture-kettle/');
  await buyer.locator('[data-buybar] [data-buy]').click();
  await buyer.waitForURL('**/checkout/');
  await buyer.waitForFunction(() => document.querySelector('[data-checkout] [name="phone"]').value === '01710000201');
  const pay = stock.settings.payments.find(p => p.enabled && p.number);
  const outside = stock.settings.delivery.find(z => z.fee > 0);
  assert.ok(pay && outside, 'Fixture requires manual payment and a paid delivery zone');
  await buyer.locator('[name="address"]').fill('House 12 <Unit B>, Example Road, near the community centre, Jashore, Bangladesh');
  await buyer.getByText('Add email or delivery note', {exact:true}).click();
  await buyer.locator('[name="email"]').fill('private-fixture@example.invalid');
  await buyer.locator('[name="area"]').selectOption(outside.id);
  await buyer.locator('[name="payment"]').selectOption(pay.id);
  assert.match(await buyer.locator('[data-pay]').textContent(), /must verify this payment/);
  await buyer.locator('[name="txnid"]').fill('FIXTURE-TXN-42');
  await buyer.getByText('Have a coupon?', {exact:true}).click();
  await buyer.locator('[name="coupon"]').fill('fixture');
  await buyer.locator('[data-apply]').click();
  await buyer.locator('[data-coupon-msg]').getByText(/Coupon applied/).waitFor();
  let committed;
  await buyer.route('**/api/checkout', async route => {
    const response = await route.fetch();
    committed = { status: response.status(), body: await response.json() };
    await route.abort('failed');
  }, { times: 1 });
  await buyer.getByRole('button', {name:'Place order'}).click();
  const retry = buyer.getByRole('button', {name:'Check order status'});
  await retry.waitFor();
  assert.equal(committed.status, 200);
  const paidOrder = committed.body;
  assert.equal(paidOrder.total, 450 + (stock.settings.freeOver && 450 >= stock.settings.freeOver ? 0 : outside.fee));
  await retry.click();
  await buyer.waitForURL('**/track/**');
  await buyer.locator('[data-order] .order').waitFor();
  assert.equal(new URL(buyer.url()).searchParams.get('order'), paidOrder.number);
  await buyer.goto('/my-account/');
  await buyer.getByRole('heading', {name:paidOrder.number}).waitFor();
  const confirmed = await request('GET', '/api/admin/orders');
  const saved = confirmed.orders.filter(o => o.phone === '01710000201');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].discount, 50);
  assert.equal(saved[0].status, 'pending');
  assert.equal(saved[0].email, 'private-fixture@example.invalid');
  await request('PUT', `/api/admin/orders/${paidOrder.number}`, {adminNote: 'Private staff fixture note'});
  // The deployed CSP blocks blob workers. Exercise the full branded download
  // under that policy even when the local asset server omits custom headers.
  const productionHeaders = await fs.readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = productionHeaders.match(/^  Content-Security-Policy: (.+)$/m)?.[1];
  assert.ok(csp);
  const withProductionCSP = async route => {
    const response = await route.fetch();
    await route.fulfill({response, headers: {...response.headers(), 'content-security-policy': csp}});
  };
  await admin.route('**/admin/', withProductionCSP);
  await admin.addInitScript(() => {
    window.print = () => { document.body.dataset.printCalled = 'yes'; };
    window.open = () => { document.body.dataset.openCalled = 'yes'; };
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective === 'worker-src') document.body.dataset.workerBlocked = 'yes';
    });
  });
  await admin.route('**/invoice-assets/latin.woff', route => route.abort(), {times: 1});
  await admin.goto('/admin/#orders');
  const invoiceButton = admin.locator('[data-order-row]', { hasText: paidOrder.number }).getByRole('button', { name: 'Invoice' });
  assert.equal(await admin.evaluate(() => performance.getEntriesByType('resource')
    .some(entry => entry.name.includes('/invoice-assets/'))), false, 'Load the PDF engine only when requested.');
  await invoiceButton.click();
  const invoice = admin.getByRole('dialog', {name: `Invoice ${paidOrder.number}`});
  await invoice.waitFor();
  assert.match(await invoice.textContent(), /House 12 <Unit B>, Example Road/);
  assert.match(await invoice.locator('.invoice-total').textContent(), /Order total৳550/);
  assert.doesNotMatch(await invoice.textContent(), /private-fixture@example|Private staff fixture note/i);
  const retryPDF = invoice.getByRole('button', {name: 'Retry PDF'});
  await retryPDF.waitFor({timeout: 10000});
  assert.equal(await invoice.getByRole('status').textContent(), 'Could not prepare the PDF.');
  await retryPDF.click();
  const download = async (button, number, sampleName) => {
    const openTabs = context.pages().length;
    const [file] = await Promise.all([admin.waitForEvent('download', {timeout: 20000}), button.click()]);
    assert.equal(file.suggestedFilename(), `${number}.pdf`);
    assert.equal(context.pages().length, openTabs);
    const output = await fs.readFile(await file.path());
    assert.equal(output.subarray(0, 5).toString(), '%PDF-');
    if (shotDir) await file.saveAs(`${shotDir}/${sampleName}`);
    return output;
  };
  const savePDF = invoice.getByRole('link', {name: 'Download PDF'});
  await savePDF.waitFor({timeout: 10000});
  for (const [width, height] of [[320, 568], [360, 812], [375, 812], [390, 812], [414, 812], [768, 850], [1024, 600], [1440, 900]]) {
    await admin.setViewportSize({width, height});
    const fits = await invoice.evaluate(box => {
      const bounds = box.getBoundingClientRect();
      const preview = box.querySelector('#invoice-preview');
      return bounds.left >= 8 && bounds.top >= 8 && bounds.right <= innerWidth - 8 &&
        bounds.bottom <= innerHeight - 8 && preview.scrollWidth <= preview.clientWidth;
    });
    assert.ok(fits, `Invoice preview fits ${width}×${height}`);
  }
  await shot(admin, 'invoice-preview-desktop');
  await admin.setViewportSize({width: 375, height: 812});
  await shot(admin, 'invoice-preview-375');
  inspectInvoice(await download(savePDF, paidOrder.number, 'invoice-fixture.pdf'), false);
  assert.equal(await admin.locator('body').getAttribute('data-print-called'), null);
  assert.equal(await admin.locator('body').getAttribute('data-open-called'), null);
  assert.equal(await admin.locator('body').getAttribute('data-worker-blocked'), null);
  await invoice.getByRole('button', {name: 'Close'}).click();
  await admin.waitForFunction(() => document.querySelector('#invoice-preview').childElementCount === 0);
  assert.equal(await invoiceButton.evaluate(button => button === document.activeElement), true);

  // Render real pagination through the same download button with a large
  // synthetic invoice. The PDF fixture is independent of print preferences.
  const items = Array.from({ length: 60 }, (_, index) => ({
    name: index % 2 ? `রাইস কুকার · Item ${index + 1} ${'LongCode'.repeat(15)}` : `Fixture item ${index + 1}`,
    qty: 1, price: 500,
  }));
  const largeOrder = { ...saved[0], number: 'LB-PDF-LARGE', items, subtotal: 30000,
    total: 30000 + saved[0].shipping - saved[0].discount };
  const route = '**/api/admin/orders?*';
  const ordersMock = async request => request.fulfill({ json: { orders: [largeOrder], total: 1, sales: largeOrder.total, size: 50 } });
  await admin.route(route, ordersMock);
  await admin.reload();
  await admin.setViewportSize({ width: 1440, height: 900 });
  await admin.locator('[data-order-row]', { hasText: largeOrder.number }).getByRole('button', { name: 'Invoice' }).click();
  const largeInvoice = admin.getByRole('dialog', {name: `Invoice ${largeOrder.number}`});
  inspectInvoice(await download(largeInvoice.getByRole('link', {name: 'Download PDF'}),
    largeOrder.number, 'invoice-multipage-fixture.pdf'), true);
  assert.equal(await admin.locator('body').getAttribute('data-worker-blocked'), null);
  await largeInvoice.getByRole('button', {name: 'Close'}).click();
  await admin.setViewportSize({ width: 375, height: 812 });
  await admin.unroute(route, ordersMock);
  await admin.unroute('**/admin/', withProductionCSP);
  await admin.reload();
  const coupon = await request('GET', '/api/admin/coupons');
  assert.equal(coupon.find(c => c.code === 'FIXTURE').used, 1);
  const paidProducts = await request('GET', '/api/admin/products');
  assert.equal((Array.isArray(paidProducts) ? paidProducts : paidProducts.products).find(p => p.slug === 'mobile-fixture-kettle').stock, 0);

  const lastUnit = await request('POST', '/api/admin/products', { name: 'Last unit fixture', slug: 'last-unit-fixture', price: 1250, regular: 1250, stock: 1 });
  const race = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const start = performance.now();
    const r = await context.request.post('/api/checkout', { data: { items: [{ id: lastUnit.id, qty: 1, price: 1 }], name: 'Race fixture', phone: `01710000${String(i + 100).padStart(3, '0')}`, address: 'Disposable race fixture address', area: area.id, payment: cod.id } });
    return { status: r.status(), out: await r.json(), ms: performance.now() - start };
  }));
  assert.equal(race.filter(r => r.status === 200).length, 1);
  assert.equal(race.filter(r => r.status === 409).length, 19);
  const durations = race.map(result => result.ms).sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * .95) - 1];
  console.log(`Warm checkout race at 20 concurrent requests: p95 ${Math.round(p95)} ms, max ${Math.round(durations.at(-1))} ms.`);
  const winner = race.find(r => r.status === 200).out;
  assert.equal(winner.total, 1250 + (stock.settings.freeOver && 1250 >= stock.settings.freeOver ? 0 : area.fee));
  await request('PUT', `/api/admin/orders/${winner.number}`, { status: 'cancelled' });
  await request('PUT', `/api/admin/orders/${winner.number}`, { status: 'cancelled' });
  const finalProducts = await request('GET', '/api/admin/products');
  assert.equal((Array.isArray(finalProducts) ? finalProducts : finalProducts.products).find(p => p.id === lastUnit.id).stock, 1);
  assert.deepEqual(errors, []);
  await admin.goto('/admin/#operations');
  await admin.getByRole('heading', { name: 'API and checkout' }).waitFor();
  assert.match(await admin.locator('#view').textContent(), /API ready/);
  assert.match(await admin.locator('#view').textContent(), /Order email paused or unavailable/);
  console.log('PASS: isolated publication, mobile navigation, guest checkout, logged-in coupon/manual payment with a safe retry, direct invoice downloads, fulfillment, cancellation, stock and last-unit race.');
} finally { await context.close(); await browser.close(); }
