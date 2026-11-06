---
name: test-shop
description: Check LoverBaazar still works after a change to checkout, stock, admin or the Worker
---
Start with the `run-local` skill, then with `curl`, using `A=127.0.0.1:8787/api`:

1. POST `$A/checkout` with an extra `"price":1`. The total must use the database price.
2. Set one product to `stock=1` and send 20 parallel checkouts. Expect one 200 and nineteen 409.
3. Cancel an order twice in admin. Stock must return once only.
4. `/api/admin/orders` without a token must return 401.
5. Track an order with the wrong phone. Expect 404.
6. For UI changes, use Playwright: buy a product, then add a product in admin and Publish. Check 375 px width for sideways scroll.

Delete test data afterwards.
