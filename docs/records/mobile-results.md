# Mobile verification — 18 November 2026

Tasks 9–16 have repository implementations and local verification. Tasks 9, 11, 13 and 15 are marked Done for that scope. Tasks 10, 12, 14 and 16 retain their explicit real-phone acceptance gate. No physical phone was attached to this environment.

| Check | Result |
| --- | --- |
| API tests with race detection | Passed using `GOTOOLCHAIN=go1.26.0 ./scripts/test-api.sh`; 25.665 seconds reported; independent disposable `lb_test` database removed afterward |
| Storefront/admin/browser contracts | 40/40 checks passed in the final full run (106.069 seconds); see source in `apps/store/tests/storefront.test.mjs` and `contracts.test.mjs` |
| Responsive matrix | Home, shop, cart, checkout, search, tracking, account, contact, wishlist and admin entry fit 320/360/375/390/414/768/1024/1440 CSS pixels; long Bangla/English product detail also checked at all eight widths |
| Admin sections | Overview, products, orders, categories, home, menu, shop settings, delivery/payment, customers, coupons, pages, blog, reviews and messages checked at 320/375/414 px; populated order controls additionally checked across 320–414 px |
| Accessibility/recovery | Category dialog keyboard/focus; suggestion selection/Escape; filter reload/reset/errors; 200% desktop-zoom-equivalent reflow; reduced motion; image fallback/zoom; keyboard editing hides fixed controls; focused form errors; phone touch sizes |
| Shopping state | Malformed/blocked storage, removed products, changed prices, remaining-stock limits, cross-tab cart updates and stale availability refresh tested |
| Checkout/support | Bangla phone normalization, manual transaction references, per-piece delivery, changed totals, duplicate taps, expired challenge stubs, lost-response replay with unchanged key/payload, corrected details/new key, wrong-phone tracking, expired account/outage retry and retained support input tested |
| Images/admin errors | Failed upload retains edits; successful uploads can reorder; only abandoned pending uploads are cleaned; failed saves do not Publish; duplicate order actions send once; obsolete section reads cannot replace current content; returning during a slow catalog load completes |
| Real isolated full-stack journey | Passed with `scripts/test-mobile.sh`: actual 375 px touch-emulated admin product creation → local Publish confirmation → real attribute filter → guest purchase → server-confirmed fee/total → receipt/privacy → confirm/ship → concurrent stock edit → repeated cancellation → CSV |
| Manual API race on full-stack fixture | Twenty parallel requests for one unit returned one 200 and nineteen 409; deliberately supplied browser price `1` was ignored; cancellation twice restored only one unit |
| Builds/publication | Repeated full Astro builds and local Publish confirmations succeeded using owned temporary output; no ordinary `dist` replacement or cloud deployment |
| Other checks | Go vet/formatting, JavaScript and shell syntax, `git diff --check` passed; representative phone/desktop screenshots reviewed and recorded in `docs/records/ui/` |

The real journey exposed two admin problems that are fixed: saved courier details left an unsaved flag that prevented subsequent navigation, and cached product data displayed pre-sale stock when reopening an editor. The editor now refreshes on opening while continuing to submit only a relative stock delta. Slow-response navigation and abandoned-image checks cover additional mobile failure paths.

The final integration runner uses its own loopback API/Worker, disposable PostgreSQL container and temporary static output. It removes those resources on success/failure. The existing `lbpg`, WordPress, Namecheap/Cloudflare domain routing, email service and cloud shop/database were not changed. No paid service or running infrastructure was added.

The static local build and final real Publish are evidence of local publication only. Actual GitHub/Render/Cloudflare publication acceptance remains task 8. Notifications and live Cloudinary uploads were not sent; photo-upload UI uses controlled route responses. Turnstile expiry was stubbed; a real widget on physical browsers still needs preview acceptance. Existing API tests cover the server trust boundaries.

## Physical-device acceptance still required

| Gate | Device/browser | Result |
| --- | --- | --- |
| Task 10: home/categories/search/back/landscape and one-hand navigation | Owner to record | Pending |
| Task 12: gallery/zoom, enlarged text, buy controls and overlays | Owner to record | Pending |
| Task 14: real software keyboard, actual preview Turnstile, field/error visibility and safe checkout retry | Owner to record | Pending |
| Task 16: photo upload/replacement, stock save and order fulfillment on a real phone | Owner to record | Pending |

Chromium touch emulation, screenshots and 720 CSS-pixel reflow do not prove iOS Safari, Android keyboard behavior, VoiceOver/TalkBack, browser text-scaling settings or a real Cloudinary/Turnstile integration. The remaining gates are recorded without claiming those devices/services were tested.

## Actions required

1. Merge the reviewed change and wait for the existing preview workflow to finish. Verify task 8's cloud Publish status if that acceptance is still open.
2. Follow the [real-phone checklist](../mobile-ui.md#actions-required), using disposable fixtures for orders/admin writes. Record device/browser and results in the table above.
3. Mark tasks 10/12/14/16 Done after those checks pass. Continue the numbered data/SEO/CI/CD/launch work before switching the domain or cancelling hosting.
