# Performance checks

The storefront stays static. Public stock, catalogue and site-content reads use in-memory API snapshots and never acquire a database connection.

Inventory writes rebuild stock and catalogue snapshots. They keep the content snapshot because orders and product edits do not change site settings, categories or pages. Settings/content writes and startup still refresh every snapshot.

A local benchmark with 300 sample products and 30 iterations measured:

| Snapshot refresh | Database queries | Time per refresh |
| --- | ---: | ---: |
| Full | 8 | 10.5 ms |
| Inventory only | 3 | 6.6 ms |

These measure snapshot work on local PostgreSQL, not total checkout latency or live hosting performance. Run the benchmark only against a throwaway loopback database named `lb_test`: it truncates products and their dependent test data, and `safeTestDatabase()` in `apps/api/safety.go` deliberately refuses other database names such as `lb`.

```sh
cd apps/api
TEST_DATABASE_URL='postgres://postgres:dev@127.0.0.1:55433/lb_test?sslmode=disable' go test -run '^$' -bench BenchmarkSnapshotRefresh -benchtime=30x -count=1 .
```

The Worker caches stock for 60 seconds. After that, an available saved copy returns immediately while a background request refreshes it. Concurrent requests in one Worker instance share an origin request. Query strings share the same public cache key. Failed refreshes briefly cache the fallback for 15 seconds to reduce retries; they never extend the original fallback's one-day lifetime. Cache failures still permit a healthy origin response. Saved responses are marked so the browser can check once after the background refresh window; this lets newly published products become available without continuous polling.

The admin loads product data when a product task or search needs it. Simultaneous identical admin reads share one request; results are not cached after completion, so later reads can see updates.

Run cache checks from the repository root:

```sh
node --test edge/worker.test.mjs
```

Browser checks are documented in `apps/store/tests/README.md`. API correctness and race tests use the throwaway database described in `AGENTS.md`.
