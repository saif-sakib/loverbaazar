# LoverBaazar

Bangladesh home-appliance shop. Replaces WordPress at loverbaazar.com.

**Hard rule: $0 running cost.** No card on any account, and nothing that can bill past a limit. Only the domain costs money. So no AWS, R2, Vercel Pro or paid plans until the owner asks to migrate.

**Stack:** Astro static store and admin (`apps/store`) · Go API, chi + pgx (`apps/api`: `main.go` core, `shop.go` customers, `admin.go` admin) · Cloudflare Worker (`edge/worker.js`) · Neon Postgres · Render Free · Cloudinary · Brevo.

## Roadmap and task execution

- The owner's numbered A-to-Z plan is [docs/roadmap.md](docs/roadmap.md). The architectural audit and verification baseline are in [docs/architecture-audit.md](docs/architecture-audit.md).
- When the owner says "do task N", use that exact task number, check its dependencies and current implementation, then complete its implementation, relevant tests and documentation. Preserve task numbers; append new tasks instead of renumbering them.
- Track each task in the roadmap as Planned, In progress, Blocked or Done. Mark Done only with its acceptance checks and evidence recorded. If account access, owner data or an owner-operated step is missing, finish independent work and record the exact remaining action; do not describe the whole task as complete.
- Planning is not permission to deploy, change DNS, cancel hosting or buy services. The owner will move the domain after readiness and product-data checks pass. Follow the `go-live` skill for the eventual switch; prepare and test the concrete change before requesting any confirmation that skill requires.
- Keep Namecheap WordPress available through preparation and the agreed rollback period. Keep domain registration at Namecheap. Retire Stellar Plus only after the new store, order handling, backups, assets and replacement email arrangements pass their checks, and the owner authorizes cancellation. Do not incur a hosting renewal to create the overlap.
- Keep the current free stack until measured limits or business needs justify a migration and the owner explicitly approves a budget. A future Namecheap or other VPS is an option to evaluate then, not a dependency for this launch.

## Mobile-first UI

- Design and implement the storefront and admin for phones first. Start with the narrow layout and progressively enhance it for larger screens; prefer `min-width` breakpoints for new or substantially rewritten styles.
- Check 320, 360, 375, 390 and 414 px phone widths, then tablet and desktop. No page-level sideways scrolling; wide admin data may use a clearly contained scroll area.
- Use touch controls at least 44 × 44 CSS px where practical, readable text, visible keyboard focus, labeled fields, useful error/loading/empty states, and accessible contrast. Preserve zoom and reduced-motion preferences.
- Verify sticky navigation, product buy bars, chat buttons, safe areas and the software keyboard never cover form fields, errors, prices or primary actions. Guest checkout stays the shortest purchase path.
- Prioritize real Android/iPhone usability and slow mobile networks. Desktop screenshots and mocked browser tests alone do not establish mobile readiness.

Foundation contracts, environment setup and release protocol: [docs/foundation.md](docs/foundation.md).

## Run and check

    ./scripts/dev.sh                     # shop on :8787, API on :8080, Ctrl+C stops
    (cd apps/api && gofmt -l . && go vet .)
    ./scripts/test-api.sh                # isolated lb_test database; race checks and cleanup

`astro dev` cannot reach `/api`. Always test through `dev.sh`. Local admin token: `local-admin-token-for-this-computer-only`. Every setting is listed in `.env.example`; real secrets live in the hosting dashboards, never in the repo.

## Rules

- Browsing must never touch the database. Prices and stock come from `/api/stock`, an in-memory snapshot. Only writes refresh it.
- The server computes every total. Never trust browser prices.
- Change stock only with relative updates: `SET stock=stock-$1 WHERE stock>=$1`. Admin saves send `stockDelta`, never a stock number.
- Inside a transaction, query only through `tx`. A second pool connection there can deadlock checkout.
- Public read endpoints serve in-memory snapshots. Call `refresh()` after any write that changes them.
- Money is whole taka in BIGINT. No ×100.
- `/api/health` must never touch the database.
- Keep all old URLs: `/product/x/`, `/product-category/a/b/`, `/product-tag/x/`, trailing slashes.
- Static paths use `fileSlug()`. Percent-encoded Bangla slugs answer 404 without it.
- Checkout needs no login. Keep it that way: guests are protected by `fraudCheck`, rate limits and Turnstile.
- Escape customer text with `esc()` in `app.js` and the admin page.
- Admin edits to names, photos, new products, categories, pages or `site` settings need Publish. Price, stock, coupons and `live` settings are live.
- Images live on Cloudinary as `loverbaazar/products/<category>/<product>-1`, with `pages/`, `blog/` and `site/` beside it. No random names.
- Never put a real secret in `.env.example`. It is committed, and the repo is public.
- Fixing seeded pages, posts or categories on a live shop: add an entry with a new `id` to `apps/api/content-updates.json`. Each runs once and keeps the admin's own rewrites.
- Settings defaults live only in `apps/api/defaults.json`. Don't hard-code shop details, delivery charges or payment numbers.
- `script-src` has no `unsafe-inline`: keep JavaScript in `public/*.js`.
- End every final report with an **Actions required** section listing clear, step-by-step instructions for anything the user must do (such as setting environment variables in `.env` or Render/Cloudflare, restarting `./scripts/dev.sh`, clicking Publish in admin, or pushing to deploy).

## Saving tokens

- Don't read `apps/store/src/data/*`, `apps/api/seed/*`, `data/raw/*` or `dist`. They're large generated data.
- Read only the file you're changing. `docs/go-live.md` is for launch only.
- Don't start long-running commands in the foreground.
- Don't use `pkill -f` with text that appears in your own command. It kills your shell.

Skills (read the SKILL.md before that task): `.claude/skills/run-local`, `.claude/skills/test-shop`, `.claude/skills/go-live`. Stack reasons: `PLAN.md`.
