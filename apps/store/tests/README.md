Run the shop through `./scripts/dev.sh` from the repository root. In another terminal:

```sh
cd apps/store
npm ci
npx playwright install chromium
npm run test:ui
```

The tests use the local shop at `http://127.0.0.1:8787`. `SHOP_URL` can override that address. `CHROME_PATH` can point to an existing Chromium executable instead of downloading one.

Shopping tests mock the catalogue, stock, account lookup, and checkout writes. Admin checks use the documented local admin token and read existing sections. They do not change settings or place real orders. Layout checks cover 320, 375, 768, and 1440 pixels; admin sections are checked at 375 pixels.

Backend tests still need their own throwaway database; see `AGENTS.md`. Never run those against the local shop database or production.
