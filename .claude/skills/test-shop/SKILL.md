---
name: test-shop
description: Check LoverBaazar still works after a change to checkout, stock, admin or the Worker
---
First run the API tests against a throwaway database, never `lbpg` (they erase every table):

    docker run -d --rm --name lbtest -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=lb -p 55433:5432 postgres:17-alpine
    cd apps/api && TEST_DATABASE_URL='postgres://postgres:dev@127.0.0.1:55433/lb?sslmode=disable' go test -count=1 .
    docker rm -f lbtest

Then start with the `run-local` skill and check by hand with `curl`, using `A=127.0.0.1:8787/api`:

1. POST `$A/checkout` with an extra `"price":1`. The total must use the database price.
2. Set one product to `stock=1` and send 20 parallel checkouts. Expect one 200 and nineteen 409.
3. Cancel an order twice in admin. Stock must return once only.
4. `/api/admin/orders` without a token must return 401.
5. Track an order with the wrong phone. Expect 404.
6. For UI changes, use Playwright: buy a product, then add a product in admin and Publish. Check 375 px width for sideways scroll.

Delete test data afterwards.
