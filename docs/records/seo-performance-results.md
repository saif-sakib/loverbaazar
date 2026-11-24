# Tasks 24–30 verification, 18 November 2026

Tests used disposable local data and the publicly accessible WordPress sitemaps. The final WordPress export and Cloudinary transfer are pending. The release workflow, Search Console ownership and production analytics were verified only through local or documented paths where account access is required.

## URL and indexing checks

The public comparison processed 348 unique paths. The candidate preserved 336 directly and mapped eight to existing destinations. Four require a decision after the real export. Those are `/category/information/`, `/category/new-arrival/`, `/category/slider/` and `/sample-page/`. The private ledger remains outside Git. This public comparison has no private Rank Math, Search Console, traffic or complete asset inventory.

Local Wrangler returned 301 for equivalent slash/no-slash aliases, 301 for legacy `?s=` search and 404 for an unknown numeric link or arbitrary pagination. The asset and numeric mapping tests verify exact targets and negative cases. The production-shaped build test checked valid XML, canonical product with a percent-encoded Bangla URL, one product heading, GTIN checksum output, noindex exclusions, canonical duplicate removal and a draft with no artifact. It verified a new price and sold-out state in visible initial HTML, JSON-LD and product RSS. The preview version carried noindex/nofollow and had no sitemap. The API race suite also verified the publish snapshot preserves earlier editorial data during a price/stock refresh.

### Search Console field data, 19 November 2026

The exported Web Vitals charts show 13 November, before the storefront replacement. Mobile reported 218 poor and 23 needing improvement. Desktop reported 207 poor and 34 needing improvement. LCP was the main poor issue. Both device reports also showed layout shifts. The Google field data uses a rolling 28-day window. [Core Web Vitals report](https://support.google.com/webmasters/answer/9205520)

A controlled Chromium check against the live replacement store on 19 November sampled home, shop, category and product pages. Cold emulated mobile LCP ranged from 0.96 to 2.05 seconds, with CLS below 0.001. The sampled mobile pages met the transfer budgets. Cold desktop LCP ranged from 0.61 to 1.46 seconds, with CLS below 0.015. Recheck the live field report as new visits accumulate.

## Measured mobile profile

Chromium 390×844, DPR 2, 125 ms added latency, approximately 1.6 Mbit/s download and 4× CPU slowdown. Bytes are decimal KB of completed transfer from Chromium network events during the test window. Cold uses a fresh page context and warm revisits the same path in that context. Values are from one paired run and depend on image completion, caching and network conditions. The old WordPress photos are still in these fixture pages. After numbers cannot establish savings from migrated Cloudinary images.

| Route | Cold total before → after | Cold image before → after | Cold LCP before → after | Warm LCP after | Cold CLS after | Slowest cold scripted interaction after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Home | 316 → 350 KB | 252 → 244 KB | 2.23 → 0.69 s | 0.38 s | 0.00034 | 80 ms |
| Shop | 448 → 481 KB | 361 → 352 KB | 2.18 → 1.15 s | 0.40 s | 0.00024 | 72 ms |
| Rice Cooker category | 261 → 294 KB | 197 → 188 KB | 0.72 → 0.80 s | 0.48 s | 0.00035 | 56 ms |
| Kiam Induction Cooker H-77 | 94 → 266 KB | 32 → 162 KB | 0.63 → 0.71 s | 0.29 s | 0.00027 | 64 ms |

The product's baseline cold image transfer was still incomplete in the test window. Later baseline warm image requests transferred another 99 KB. The difference is an unreliable estimate of image change on that page. The new Bangla font accounts for approximately 45 KB where used. The first-party JS peak was 14.9 KB and CSS 8.8 KB, down from 11.2 KB of CSS. Fonts peaked at 72.1 KB. All four pages met the transfer thresholds in this run. The slowest warm scripted interaction was 80 ms and warm CLS was 0 in the test window. Lab interaction duration is distinct from field INP.

## Accessibility and transaction checks

- 40 browser checks, 12 Worker and release helper checks, 16 migration unit checks, the API race suite and disposable full-stack guest checkout/publication passed.
- The initial WCAG-tagged axe scan flagged hero and admin contrast, logo names and inline link identification. The refreshed build passed the same scans with no violations across the tested public pages and admin states.
- Keyboard checks covered skip-link focus, category drawer and product zoom activation, Escape and focus return. Reflow checks ran at 320 and 720 CSS px. A complete disposable guest order used Bangla digits and verified tracking privacy. On the server, a short-form Bangla phone number, checkout retry and independent request failure verified one committed-order metric, a separate request event for each attempt, exclusion of the alternate preview host and omission of private fields from aggregate logs.
- Physical Android and iPhone, VoiceOver/TalkBack, real 200% browser zoom, actual questions about product text and accuracy, and mobile field data remain pending. Zero scans reported here do not certify all WCAG criteria across the full site.

## Actions required

1. Follow the [WordPress backup and export instructions](../wordpress-export.md), then provide the local folder path.
2. Review actual URL outcomes and merchandising, policy, SEO and asset metadata with the [acceptance guide](../seo-performance.md). Rerun the builds and mobile profile using the approved real catalog.
3. Complete the documented hosted refresh, Search Console and device checks before the relevant roadmap tasks are marked Done.
