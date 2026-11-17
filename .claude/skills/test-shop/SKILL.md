---
name: test-shop
description: Check LoverBaazar still works after a change to checkout, stock, admin or the Worker
---
First run the API tests against a throwaway database, never `lbpg` (they erase every table):

    ./scripts/test-api.sh

The script owns a disposable loopback PostgreSQL container named `lb-test-*` and database `lb_test`; it removes that container afterward. Manual URLs must use a disposable database named `lb_test`; `lb`/`lbpg` and remote/host-override URLs are refused.

Then start an isolated full-stack fixture with `LB_ISOLATED=1 ./scripts/dev.sh` (or the alternate ports in docs/foundation.md). Never change ordinary local-shop data for these checks. Check by hand with `curl`, using `A=127.0.0.1:8787/api`:

1. POST `$A/checkout` with an extra `"price":1`. The total must use the database price.
2. Set one product to `stock=1` and send 20 parallel checkouts. Expect one 200 and nineteen 409.
3. Cancel an order twice in admin. Stock must return once only.
4. `/api/admin/orders` without a token must return 401.
5. Track an order with the wrong phone. Expect 404.
6. For UI changes, use Playwright: buy a product, then add a product in admin and Publish. Check 375 px width for sideways scroll.

Delete test data afterwards.
