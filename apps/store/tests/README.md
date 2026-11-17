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

This starts `LB_ISOLATED=1` on ports 18081/18788/55436, creates fixture products through admin, Publishes locally, places a guest order, checks fulfillment/concurrent stock/cancellation/CSV and races 20 buyers for one unit. The runner removes its server, Worker and database on success or failure. `LB_API_PORT`, `LB_STORE_PORT`, `LB_DB_PORT` select different free ports. `CHROME_PATH` selects Chromium; optional `LB_SCREENSHOTS=/tmp/lb-mobile-check` retains fixture screenshots. All writes stay on the owned loopback shop; no customer email or cloud publication is sent.

Physical Android/iPhone acceptance steps and screenshots: [mobile UI report](../../../docs/mobile-ui.md). Browser emulation does not establish real keyboard, screen-reader or Safari behavior.
