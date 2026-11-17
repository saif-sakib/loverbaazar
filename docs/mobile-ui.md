# Mobile UI implementation — tasks 9–16

Implementation and automated acceptance are complete locally. Real Android/iPhone acceptance and owner approval remain pending for tasks 10, 12, 14 and 16. Chromium touch emulation is recorded as emulation. The domain, WordPress, customer database, email service and paid hosting were not changed.

## Shared design rules

`apps/store/src/styles/mobile.css` extends the existing brand system for both store and admin. New components use phone defaults and grow at 480, 861 and 901 CSS pixels. Existing unrelated styles remain in `site.css`/`admin.css`.

- Spacing: 4/8/12/16/24/32 px; page gutters 12–24 px; existing 1280 px maximum width.
- Type: 16 px body and form controls; compact card/helper text; long English/Bangla names wrap. Main interactive controls have a practical 44 px target, visible focus, labeled fields and external scripts compatible with CSP.
- Colors retain the brand: primary `#b3122e`, ink `#1a1716`, muted `#6d655e`, positive `#2c6e50`. Computed contrast: primary/white 6.90:1, muted/page background 5.38:1, positive/white 6.08:1. These measurements cover those pairs, not a claim of a complete WCAG audit.
- Native dialogs contain focus and support Escape. Forms announce errors and focus actionable failure messages. Support successes persist inline. Responsive table regions are keyboard focusable. Reduced motion includes pseudo-elements; zoom is allowed; bottom navigation/buy controls retain safe-area spacing.
- Phone headers scroll with the page. Category links are in a native dialog and the horizontal navigation remains available. Fixed shopping controls yield while editing a field. Phone contact actions live in the category drawer, so floating chat buttons do not cover catalog cards; desktop floating contacts remain. Admin save controls stay in the document flow on phones.

## Implemented behavior

| Task | Changes | Acceptance evidence |
| --- | --- | --- |
| 9 | Shared phone styles, focus/error/loading/empty patterns, control sizes, reduced motion, wrapping and safe areas | Eight-width layout matrix, reflow equivalent to 200% desktop zoom, touch-control assertions and reviewed screenshots |
| 10 | Shorter home hero; categories before shopping-information blocks; native category drawer; keyboard search suggestions; payment labels from actual live settings | Keyboard/open/close/focus tests; narrow and landscape-sized layouts. Physical keyboard/one-hand evaluation pending |
| 11 | Labeled collapsible filters, stock/price/sort, reset/invalid/no-result states; URL restoration; actual descriptive brand/color attributes; sort retained after stock refresh | URL/reload/reset/live-price tests; real fixture brand filtering. Seeded catalog has no multi-choice brand/color filters, so none are invented |
| 12 | Real specifications/SKU; omit unknown manufacturer from Product schema; delivery and buying links; gallery selection state; accessible zoom and failed-image fallback; reachable buy controls | Long Bangla/English title and eight-width product checks, keyboard zoom, failed-photo checks. Physical touch/overlay review pending |
| 13 | Removed-product notice, changed-price explanations, stock-limit guidance, focus-preserving quantity edits, cross-tab state, malformed-storage tolerance and blocked-storage explanation | Empty/stale/removed/overstock/price-change/two-tab/storage tests |
| 14 | Bangla phone normalization, optional email, per-piece delivery, coupon feedback, manual-payment verification explanation, no late prefill over typed fields | Real guest purchase and server total; mocked duplicate/security/changed-total/failure cases. Physical keyboard/security-widget acceptance pending |
| 15 | Optional account/legacy-password/recovery guidance; retry for account outages; guarded login/logout/password/contact/review requests; persistent success/errors; normalized tracking input; malformed saved-order tolerance | Wrong-phone privacy and expired-session/outage/support-error tests; existing API auth/abuse tests |
| 16 | Phone order rows; touch targets; contained tables; safe duplicate action handling; real Publish status; payment verification reminder; fresh editor stock; preserved stock deltas; saved fulfillment no longer blocks navigation; ignore obsolete section reads | All admin sections at three phone widths; real create/Publish/fulfill/concurrent-stock/cancel/export flow; failed-save/double-submit/slow-read tests. Owner's real-phone acceptance pending |

All product links remain in static HTML, including cards revealed by Show more. The current roughly 290-product catalog does not require a new pagination route scheme for this UI change. Existing product/category/tag URLs and trailing slashes remain intact. Filter queries do not change the existing path-only canonical. Search, account, cart and checkout retain their existing noindex policy; broader SEO work remains tasks 24 onward.

Attributes are descriptive, not selectable inventory variants. Do not sell a product requiring an unrepresented size/color/model choice until its data and inventory representation are reconciled in the catalog tasks. Warranty, included items, returns and legacy descriptions still need the real-data/content review in tasks 17–23; no manufacturer, warranty period or review was invented by this UI work.

## Checkout recovery contract

The API still computes every price, discount, fee and stock update. The browser sends product IDs/quantities and an expected total for explicit confirmation. It never supplies an authoritative line price.

A request key is bound to a SHA-256 signature of the full checkout details. Session storage contains an opaque signature/key, not the address or transaction reference; a memory fallback handles blocked session storage. An edited request gets a new key. The API remains the final idempotency/privacy boundary.

While submitting, checkout details are locked. Network interruptions, unreadable responses and server failures keep the original request in memory and show **Check order status**, reusing the same details/key. This is a guarded replay of `/checkout`, not a separate tracking lookup. The customer is told to keep the page open and avoid a second payment. Known validation failures unlock the form and retain inputs. Expired challenges can be renewed. Requests allow up to 90 seconds for a sleeping free API; static browsing still works when availability refresh fails and has a retry control.

Addresses/payment references are not persisted to recover across browser closure. If a customer closes or reloads an uncertain checkout, they should contact the shop before submitting a new order/payment. Fully blocked shopping storage cannot preserve a cart across document navigation; the page explains enabling site storage or ordering by phone. It remains usable without crashing.

## Verification

The checks use separate PostgreSQL containers and temporary static output. They never erase `lbpg` or run destructive tests against Neon. `scripts/test-mobile.sh` refuses occupied ports, owns its fixture and cleans it up on success/failure.

```sh
# API suite: independent throwaway lb_test database, includes race detection
GOTOOLCHAIN=go1.26.0 ./scripts/test-api.sh

# Real mobile journey: starts and cleans up its own full stack
CHROME_PATH=/path/to/chromium ./scripts/test-mobile.sh

# Mocked UI suite: point only to an already-running isolated dev.sh fixture
SHOP_URL=http://127.0.0.1:18787 CHROME_PATH=/path/to/chromium \
  node --test apps/store/tests/*.test.mjs
```

Results are in [mobile verification results](mobile-results.md). UI tests emulate Chromium; the 720 CSS-pixel reflow check represents a 1440 px desktop viewport at 200% zoom. It does not prove device font scaling, VoiceOver/TalkBack, Safari rendering or a hardware keyboard.

## Screenshots

Representative viewport captures, locally built from fixture/seed content:

| Screen | Evidence |
| --- | --- |
| Phone home | [375 px](ui/home-375.png) |
| Phone catalog | [375 px](ui/catalog-375.png) |
| Phone purchase controls | [375 px](ui/product-375.png) |
| Phone checkout | [375 px](ui/checkout-375.png) |
| Phone admin product editor | [375 px](ui/admin-editor-375.png) |
| Phone order fulfillment | [375 px](ui/admin-orders-375.png) |
| Desktop home | [1440 px](ui/home-1440.png) |

## Actions required

1. Review/merge the change and let the existing preview deployment finish. Complete pending task 8 publication acceptance on preview before treating the release as cloud-verified.
2. On a real Android phone and, if available, an iPhone, open the updated preview. Check home/category/search, filters/back, product photos/zoom, cart and the delivery/payment form with the keyboard open and in landscape. Check enlarged text and a screen reader where available. Confirm no primary control is clipped or covered.
3. Use the disposable local fixture for test purchases/admin changes, or an explicitly isolated preview data source. Create and Publish a fixture product, buy as a guest, verify tracking, then update stock and fulfill/cancel the order. Check phone photo upload/replacement and a failed/retried save. Do not place fake orders in the customer database or transfer real money for these checks.
4. Record phone model, browser/version, result and any issue in `docs/mobile-results.md`. Mark tasks 10/12/14/16 Done only after their physical checks pass. Continue real-data, SEO, CI/CD and launch tasks in their existing order. Keep WordPress/domain/hosting unchanged until launch acceptance.
