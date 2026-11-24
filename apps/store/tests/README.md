Run the shop through `./scripts/dev.sh` from the repository root. In another terminal:

```sh
cd apps/store
npm ci
npx playwright install chromium
npm run test:ui
```

The tests use the local shop at `http://127.0.0.1:8787`. `SHOP_URL` can override that address. `CHROME_PATH` can point to an existing Chromium executable instead of downloading one.

Shopping tests mock the catalogue, stock, account lookup, and checkout writes. Admin checks use the documented local admin token and read existing sections. They do not change settings or place real orders. Layout checks cover 320, 360, 375, 390, 414, 768, 1024 and 1440 pixels; admin sections are checked at 320, 375 and 414 pixels. Recovery checks cover uncertain checkout responses, request-bound retries, blocked storage, changed totals, expired challenges, support errors and stale admin reads.

Backend tests still need their own throwaway database; see `AGENTS.md`. Never run those against the local shop database or production.

Worker cache regression tests run from the repository root with `node --test edge/worker.test.mjs`. Snapshot benchmark measurements and their scope are in `docs/performance.md`.

Real integration checks own a disposable database and build output:

```sh
# From the repository root; never reuses the ordinary local shop.
./scripts/test-mobile.sh
```

This starts a loopback fixture on ports 18081 and 18788 with a Docker-assigned database port. It exercises real product, photo, page and category publication, guest and authenticated purchases, coupon and payment-reference handling, a lost checkout response, fulfillment and a 20-buyer inventory race. The runner removes its server, Worker, database, uploads and build output. `LB_API_PORT`, `LB_STORE_PORT` and `LB_DB_PORT` can specify alternate ports. `LB_SCREENSHOTS=/tmp/lb-mobile-check` retains fixture screenshots.

For release acceptance, install the Playwright browser engines in `apps/store` using `npx playwright install chromium firefox webkit`, then run `./scripts/test-mobile.sh --acceptance` from the root. This also runs the SEO build, storefront and accessibility suites. `SHOP_BROWSERS` can select engines for hosts that lack Firefox or WebKit system dependencies.

Physical Android/iPhone acceptance steps and screenshots: [mobile UI report](../../../docs/mobile-ui.md). Browser emulation does not establish real keyboard, screen-reader or Safari behavior.

WordPress migration checks use their own disposable databases and private temporary artifacts:

```sh
PYTHONPATH=scripts python3 -m unittest discover -s scripts/migration -p 'test_*.py' -v
./scripts/test-migration.sh
./scripts/test-wordpress-export.sh
```

Run these from the repository root. The last command downloads local WordPress/MariaDB Docker fixtures and WooCommerce; it does not use the real site or publish a port. See [migration results](../../../docs/records/migration-results.md). Real inventory comes only from an approved export/review; legacy `in_stock` flags do not prove a quantity. Disposable `LB_ISOLATED=1` demos use explicit synthetic fixture stock.
