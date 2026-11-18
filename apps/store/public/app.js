// Storefront behaviour. Pages are static; prices, stock and live settings arrive from /api/stock.
// Always pass customer text through esc() before putting it in HTML.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  let storageUnavailable = false;
  const get = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (Array.isArray(d)) return Array.isArray(v) ? v : d;
      if (d && typeof d === "object") return v && typeof v === "object" && !Array.isArray(v) ? v : d;
      return v ?? d;
    } catch (e) {
      if (["SecurityError", "QuotaExceededError"].includes(e.name)) storageUnavailable = true;
      return d;
    }
  };
  const put = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch { storageUnavailable = true; storageNotice(); }
  };
  function storageNotice() {
    if ($("[data-storage-notice]")) return;
    const el = document.createElement("p"); el.className = "wrap note"; el.dataset.storageNotice = ""; el.setAttribute("role", "status");
    el.textContent = "Your browser cannot save your shopping state between pages. Enable site storage to keep your cart, or call " + PHONE + " to order.";
    $("main")?.prepend(el);
  }
  const taka = (n) => "৳" + Number(n).toLocaleString("en-IN");
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = (m) => {
    const t = $("[data-toast]");
    t.textContent = m;
    t.classList.add("on");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove("on"), 2200);
  };

  const PHONE = document.documentElement.dataset.phone || "";
  const ORDER_PLACED = "Thank you! Your order is placed. We'll call you to confirm.";
  const REVIEW_THANKS = "Thank you! Your review will appear after we check it.";
  const MESSAGE_THANKS = "Message sent. Thank you!";
  const MAX_QTY = 20;
  const PAGE = 24;
  const STATUS = {
    pending: "Order received",
    confirmed: "Confirmed",
    shipped: "On the way",
    delivered: "Delivered",
    cancelled: "Cancelled",
    returned: "Returned",
  };

  const readCart = () => Object.fromEntries(Object.entries(get("cart", {}))
    .filter(([id, qty]) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(qty) && qty > 0)
    .map(([id, qty]) => [id, Math.min(qty, MAX_QTY)]));
  const readWish = () => [...new Set(get("wish", []).filter((id) => Number.isSafeInteger(id) && id > 0))];
  let cart = readCart();
  let wish = readWish();
  const cartPrices = get("cartPrices", {});
  let index = null; // the search index, with live prices merged in
  let rawIndex = null;
  let stockLoaded = false;
  let retriedStaleStock = false;
  let stock = {}; // id: [price, regular, units], units capped at 99
  let live = null; // settings that take effect without a rebuild
  let repaintCheckout = () => {};

  const normalizePhone = (value) => {
    let n = String(value || "").replace(/[০-৯]/g, c => String(c.charCodeAt(0) - 0x09e6)).replace(/[\s()+-]/g, "");
    if (n.startsWith("880")) n = n.slice(2);
    else if (/^1\d{9}$/.test(n)) n = "0" + n;
    return n;
  };
  const showError = (el, message) => {
    el.textContent = message;
    el.tabIndex = -1;
    el.setAttribute("role", "alert");
    el.focus();
  };
  const api = async (path, body, method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000); // Allow a free API to wake up.
    try {
      const r = await fetch("/api" + path, {
        method: method || (body ? "POST" : "GET"),
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin", signal: controller.signal,
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        const id = r.headers.get("X-Request-ID") || "";
        const reference = r.status >= 500 && /^[a-f0-9]{32}$/i.test(id) ? ` Reference: ${id}.` : "";
        throw Object.assign(new Error((j?.error || `Service is busy. Please call ${PHONE}.`) + reference), { status: r.status });
      }
      if (!j) throw new Error("The shop response was interrupted. Please try again.");
      return j;
    } catch (e) {
      if (e.status || (e instanceof Error && e.message.startsWith("The shop response"))) throw e;
      throw new Error(`Could not reach the shop. Please check your connection, or call ${PHONE}.`);
    } finally { clearTimeout(timer); }
  };

  const maxFor = (id) => Math.min(MAX_QTY, stockLoaded ? (stock[id]?.[2] || 0) : MAX_QTY);

  async function items() {
    if (index) return index;
    rawIndex ||= fetch("/search-index.json")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .catch((e) => {
        rawIndex = null;
        throw e;
      });
    const raw = await rawIndex;
    if (index) return index; // simultaneous cart, search and recent-item renders share one merge
    const list = raw.map((p) => ({ ...p }));
    const known = stockLoaded;
    list.forEach((p) => {
      const s = stock[p.id];
      if (s) [p.price, p.regular, p.inStock] = [s[0], s[1], s[2] > 0];
      else if (known) p.inStock = false; // hidden in admin since the last Publish
    });
    return (index = list);
  }

  function badges() {
    const count = Object.values(cart).reduce((a, b) => a + b, 0);
    $$("[data-cart-count]").forEach((e) => {
      e.textContent = count;
      e.hidden = !count;
    });
    $$("[data-wish-count]").forEach((e) => {
      e.textContent = wish.length;
      e.hidden = !wish.length;
    });
    $$("[data-wish]").forEach((b) => {
      const saved = wish.includes(+b.dataset.wish);
      b.classList.toggle("on", saved);
      b.setAttribute("aria-pressed", String(saved));
    });
  }

  const saveCart = () => {
    put("cart", cart);
    badges();
  };
  const priceHtml = (price, regular) => `<b>${taka(price)}</b>${regular > price ? `<s>${taka(regular)}</s>` : ""}`;

  // Makes a static page match the latest prices and stock.
  function applyStock() {
    if (!stockLoaded) return;
    $$("[data-price-for]").forEach((e) => {
      const s = stock[e.dataset.priceFor];
      if (s) e.innerHTML = priceHtml(s[0], s[1]);
    });
    const percent = (s) => (s && s[1] > s[0] ? Math.round(((s[1] - s[0]) / s[1]) * 100) : 0);
    $$("[data-off]").forEach((e) => {
      const d = percent(stock[e.dataset.off]);
      e.textContent = `-${d}%`;
      e.hidden = !d;
    });
    $$("[data-save-for]").forEach((e) => {
      const d = percent(stock[e.dataset.saveFor]);
      e.textContent = `You save ${d}%`;
      e.hidden = !d;
    });
    $$("[data-add]").forEach((b) => {
      const s = stock[b.dataset.add];
      b.disabled = !(s && s[2] > 0);
      b.textContent = b.disabled ? "Sold out" : b.dataset.label;
    });
    $$("[data-stock-for]").forEach((e) => {
      const s = stock[e.dataset.stockFor];
      const units = s ? s[2] : 0;
      const left = live?.showLeft && units > 0 && units <= live.lowStock;
      e.textContent = !units ? "Sold out" : left ? `Only ${units} left` : "In stock";
      e.classList.toggle("no", !units);
    });
    $$("[data-qty]").forEach((i) => {
      i.max = maxFor($("[data-add]").dataset.add);
    });
    $$("[data-card]").forEach((c) => {
      const s = stock[c.dataset.id];
      c.dataset.price = s ? s[0] : c.dataset.price;
      c.dataset.stocked = s && s[2] > 0 ? "1" : "0";
    });
    $$("[data-grid]").forEach((g) => g._update?.());
  }

  function applyLive() {
    const n = $("[data-notice]");
    if (n && live) {
      n.textContent = live.notice || "";
      n.hidden = !live.notice;
    }
    // Payment numbers are live settings: an old number here could send money to the wrong place.
    const summary = $("[data-payment-summary]");
    if (summary && live) summary.textContent = live.payments.filter(p => p.enabled).map(p => p.label).join(" · ") || "Contact the shop for payment options";
    const feature = $("[data-payment-feature]");
    if (feature && live) feature.textContent = live.payments.find(p => p.enabled)?.label || "Payment options";
    const pay = $("[data-payments]");
    if (pay && live)
      pay.innerHTML = live.payments
        .filter((p) => p.enabled)
        .map((p) => esc(p.label) + (p.number ? `: ${esc(p.number)}` : ""))
        .join("<br>");
  }

  document.addEventListener("click", (e) => {
    const open = e.target.closest("details.mega");
    $$("details.mega[open]").forEach((d) => {
      if (d !== open) d.open = false;
    });
    const t = e.target.closest("[data-add],[data-wish],[data-del],[data-thumb],[data-again],[data-mine-order]");
    if (!t) return;
    if (t.dataset.add) {
      const id = t.dataset.add;
      // The quantity box belongs to the main product, not to the cards under it.
      const box = (t.closest(".buy") || t.closest(".buybar")) && $("[data-qty]");
      const want = (cart[id] || 0) + Math.max(1, Math.floor(+box?.value) || 1);
      if (!maxFor(id)) return toast("This product is sold out. Please choose another item.");
      cart[id] = Math.min(want, maxFor(id));
      const price = stock[id]?.[0] ?? +t.closest("[data-price]")?.dataset.price;
      if (Number.isFinite(price)) { cartPrices[id] = price; put("cartPrices", cartPrices); }
      saveCart();
      toast(cart[id] < want ? `You can order ${cart[id]} of this online` : "Added to cart");
      if (t.dataset.buy && storageUnavailable) return toast("Enable site storage to continue, or call " + PHONE + ".");
      if (t.dataset.buy) location.href = "/checkout/";
    }
    if (t.dataset.again) {
      JSON.parse(t.dataset.again).forEach((l) => {
        const qty = Math.min((cart[l.id] || 0) + l.qty, maxFor(l.id));
        if (qty > 0) cart[l.id] = qty;
      });
      saveCart();
      location.href = "/cart/";
    }
    if (t.dataset.mineOrder) {
      const f = $("[data-track]");
      f.order.value = t.dataset.mineOrder;
      f.phone.value = t.dataset.minePhone;
      f.requestSubmit();
    }
    if (t.dataset.wish) {
      const id = +t.dataset.wish;
      wish = wish.includes(id) ? wish.filter((x) => x !== id) : [...wish, id];
      put("wish", wish);
      badges();
      toast(wish.includes(id) ? "Saved to wishlist" : "Removed");
      if ($("[data-wishlist]")) renderWish();
    }
    if (t.dataset.del) {
      delete cart[t.dataset.del];
      saveCart();
      renderCart();
    }
    if (t.dataset.thumb) {
      const image = $("[data-main]");
      if (t.dataset.srcset) image.srcset = t.dataset.srcset;
      else image.removeAttribute("srcset");
      image.src = t.dataset.thumb;
      image.alt = t.dataset.alt || image.alt;
      image.dataset.zoom = t.dataset.zoom || t.dataset.thumb;
      $$("[data-thumb]").forEach((b) => { b.classList.toggle("on", b === t); b.setAttribute("aria-pressed", String(b === t)); });
    }
  });

  function grids() {
    $$("[data-grid]").forEach((g) => {
      const tools = g.previousElementSibling;
      const empty = g.nextElementSibling?.matches("[data-nomatch]") ? g.nextElementSibling : null;
      const more = g.parentElement.querySelector(":scope > [data-more]");
      const fields = { min: $("[data-min]", tools), max: $("[data-max]", tools), stock: $("[data-instock]", tools), brand: $("[data-brand]", tools), color: $("[data-color]", tools), sort: $("[data-sort]", tools) };
      let shown = PAGE;
      const restore = () => {
        const q = new URLSearchParams(location.search);
        Object.entries(fields).forEach(([key, el]) => {
          if (!el) return;
          if (key === "stock") el.checked = q.get(key) === "1";
          else el.value = q.get(key) || "";
        });
        shown = PAGE;
        if (Object.entries(fields).some(([k, el]) => k !== "sort" && el && (el.type === "checkbox" ? el.checked : el.value))) $("details", tools).open = true;
      };
      const update = () => {
        const low = Number(fields.min?.value || 0);
        const high = fields.max?.value === "" ? Infinity : Number(fields.max?.value ?? Infinity);
        const invalid = low < 0 || high < 0 || low > high;
        const error = $("[data-filter-error]", tools);
        if (error) { error.hidden = !invalid; error.textContent = invalid ? "Enter a maximum price at least as high as the minimum." : ""; }
        const cards = $$("[data-card]", g);
        const match = cards.filter((c) => !invalid && +c.dataset.price >= low && +c.dataset.price <= high &&
          (!fields.stock?.checked || c.dataset.stocked === "1") &&
          (!fields.brand?.value || JSON.parse(c.dataset.brands || "[]").includes(fields.brand.value)) &&
          (!fields.color?.value || JSON.parse(c.dataset.colors || "[]").includes(fields.color.value)));
        cards.forEach(c => { c.hidden = true; });
        match.slice(0, shown).forEach(c => { c.hidden = false; });
        if (more) more.hidden = match.length <= shown;
        if (empty) empty.hidden = match.length > 0;
        const count = $("[data-count]", tools);
        if (count) count.textContent = match.length;
        const active = Object.entries(fields).filter(([k, el]) => k !== "sort" && el && (el.type === "checkbox" ? el.checked : el.value !== "")).length;
        const badge = $("[data-filter-count]", tools);
        if (badge) badge.textContent = active ? `(${active} active)` : "";
      };
      const sort = () => {
        const by = { asc: (a,b) => a.dataset.price - b.dataset.price, desc: (a,b) => b.dataset.price - a.dataset.price,
          name: (a,b) => a.dataset.name.localeCompare(b.dataset.name) }[fields.sort?.value] || ((a,b) => b.dataset.id - a.dataset.id);
        $$("[data-card]", g).sort(by).forEach(c => g.append(c));
        update();
      };
      const change = () => {
        shown = PAGE;
        const url = new URL(location.href);
        Object.entries(fields).forEach(([key, el]) => {
          const value = el?.type === "checkbox" ? (el.checked ? "1" : "") : el?.value;
          if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
        });
        history.replaceState(null, "", url);
        sort();
      };
      g._update = sort;
      if (more) more.onclick = () => { shown += PAGE; update(); };
      Object.values(fields).forEach(el => el?.addEventListener("change", change));
      $("[data-reset-filters]", tools)?.addEventListener("click", () => {
        Object.values(fields).forEach(el => { if (el) { el.value = ""; if (el.type === "checkbox") el.checked = false; } });
        change();
      });
      addEventListener("popstate", () => { restore(); sort(); });
      restore(); sort();
    });
  }

  const card = (p) => `<article class="card" data-card data-id="${p.id}" data-name="${esc(p.name.toLowerCase())}" data-price="${p.price}" data-stocked="${p.inStock ? "1" : "0"}" data-brands="${esc(JSON.stringify(p.brands || []))}" data-colors="${esc(JSON.stringify(p.colors || []))}">
    <a class="thumb" href="/product/${esc(p.slug)}/"><img loading="lazy" src="${esc(p.thumb || "/placeholder.svg")}" alt="${esc(p.name)}" width="300" height="300"></a>
    <button class="heart" data-wish="${p.id}" aria-label="Add ${esc(p.name)} to wishlist">♥</button>
    <div class="body"><a class="name" href="/product/${esc(p.slug)}/">${esc(p.name)}</a>
    <div class="price" data-price-for="${p.id}">${priceHtml(p.price, p.regular)}</div>
    <span class="card-stock" data-stock-for="${p.id}">${p.inStock ? "In stock" : "Sold out"}</span>
    <button class="btn small" data-add="${p.id}" data-label="Add to cart" ${p.inStock ? "" : "disabled"}>${p.inStock ? "Add to cart" : "Sold out"}</button></div></article>`;

  async function renderWish() {
    const el = $("[data-wishlist]");
    if (!el) return;
    if (!wish.length) {
      el.innerHTML = "<p>Your wishlist is empty.</p>";
      badges();
      return;
    }
    const l = (await items()).filter((p) => wish.includes(p.id));
    el.innerHTML = (l.length < wish.length ? "<p class=note>Some saved products are no longer available.</p>" : "") + (l.map(card).join("") || "<p>Your wishlist is empty.</p>");
    badges();
  }

  // Each word typed must start a word of the product, so "rice" no longer finds every "price" tag.
  // Names that match best come first, then products in stock.
  const tokens = (s) => String(s ?? "").toLowerCase().split(/[^\p{L}\p{M}\p{N}.]+/u).filter(Boolean);
  const matches = (list, q) => {
    const words = tokens(q);
    if (!words.length) return [];
    const phrase = words.join(" "),
      glued = words.join("");
    return list
      .map((p) => {
        p._t ||= tokens(p.text);
        p._n ||= tokens(p.name);
        const name = p._n.join(" ");
        const found = words.every((w) => p._t.some((t) => t.startsWith(w))) ||
          (glued.length >= 4 && name.replaceAll(" ", "").includes(glued)); // "ricecooker" typed without the space
        if (!found) return null;
        let score = (" " + name).includes(" " + phrase) ? 100 : 0;
        score += words.filter((w) => p._n.some((t) => t.startsWith(w))).length * 10;
        if (p.inStock) score += 5;
        return [score, p];
      })
      .filter(Boolean)
      .sort((a, b) => b[0] - a[0])
      .map((x) => x[1]);
  };

  async function search() {
    const el = $("[data-results]");
    if (!el) return;
    const q = new URLSearchParams(location.search).get("q")?.trim() || "";
    if (!q) {
      $("h1").textContent = "Search";
      el.innerHTML = "<p>Type what you are looking for in the search box above.</p>";
      return;
    }
    $("[data-q]").textContent = q;
    if ($(".find input")) $(".find input").value = q;
    const l = matches(await items(), q);
    el.innerHTML = l.map(card).join("") || "<p>No products found. Try a shorter word.</p>";
    badges();
  }

  function suggestions() {
    const input = $("[data-suggest]"), box = $("[data-suggestions]");
    if (!input || !box) return;
    let timer, active = -1;
    const close = () => {
      box.hidden = true; active = -1;
      input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
    };
    input.addEventListener("input", () => {
      clearTimeout(timer); close();
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) return;
        const list = matches(await items().catch(() => []), q).slice(0, 6);
        if (input.value.trim() !== q) return;
        box.innerHTML = list.map((p,i) => `<a id="suggestion-${i}" role="option" aria-selected="false" tabindex="-1" href="/product/${esc(p.slug)}/"><img src="${esc(p.thumb || "/placeholder.svg")}" alt="" width="40" height="40" loading="lazy"><span>${esc(p.name)}</span><b>${taka(p.price)}</b></a>`).join("");
        box.hidden = !list.length;
        input.setAttribute("aria-expanded", String(!!list.length));
      }, 150);
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Escape" || e.key === "Tab") return close();
      const links = $$("a", box);
      if (box.hidden || !links.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
        links.forEach((a,i) => a.setAttribute("aria-selected", String(i === active)));
        input.setAttribute("aria-activedescendant", links[active].id);
        links[active].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && active >= 0) { e.preventDefault(); links[active].click(); }
    });
    document.addEventListener("click", e => { if (!e.target.closest(".find")) close(); });
  }

  async function totals() {
    if (!Object.keys(cart).length) return { lines: [], sub: 0 };
    const all = await items();
    const gone = Object.keys(cart).filter((id) => !all.some((x) => x.id == id));
    if (gone.length) { // removed from the shop since it was added, so don't keep counting it
      gone.forEach((id) => delete cart[id]);
      const notice = $("[data-cart-notice]");
      if (notice) { notice.hidden = false; notice.textContent = "Products no longer sold by the shop were removed from your cart."; }
      saveCart();
    }
    const lines = Object.entries(cart)
      .map(([id, qty]) => ({ p: all.find((x) => x.id == id), qty }))
      .filter((l) => l.p);
    return { lines, sub: lines.reduce((a, l) => a + l.p.price * l.qty, 0) };
  }

  async function renderCart() {
    const el = $("[data-cart]");
    if (!el) return;
    const { lines, sub } = await totals();
    lines.forEach(l => { if (!Number.isFinite(cartPrices[l.p.id])) cartPrices[l.p.id] = l.p.price; });
    put("cartPrices", cartPrices);
    el.innerHTML =
      lines
        .map(
          (l) => `<div class="line">
      <img src="${esc(l.p.thumb || "/placeholder.svg")}" alt="" width="64" height="64">
      <div class="cart-item-detail"><a href="/product/${esc(l.p.slug)}/">${esc(l.p.name)}</a><br>${taka(l.p.price)}${cartPrices[l.p.id] !== l.p.price ? `<strong class="price-change">Price changed from ${taka(cartPrices[l.p.id])}. Final total confirmed at checkout.</strong>` : ""} ${l.p.inStock ? "" : "<b>Sold out</b>"}${l.qty > maxFor(l.p.id) && l.p.inStock ? `<strong class="price-change">Only ${maxFor(l.p.id)} available. Update quantity.</strong>` : ""}<br>
      <button class="link" data-del="${l.p.id}">Remove</button></div>
      <input type="number" min="1" max="${maxFor(l.p.id)}" value="${l.qty}" data-line="${l.p.id}" aria-label="Quantity of ${esc(l.p.name)}">
    </div>`,
        )
        .join("") || "<p>Your cart is empty. <a class='link' href='/shop/'>Start shopping</a></p>";
    $("[data-sub]").textContent = taka(sub);
    const go = $("[data-to-checkout]");
    if (go) go.hidden = !lines.length || lines.some((l) => !l.p.inStock || l.qty > maxFor(l.p.id));
    const free = $("[data-free]");
    if (free && live?.freeOver)
      free.textContent = sub >= live.freeOver ? "You get free delivery." : `Add ${taka(live.freeOver - sub)} more for free delivery.`;
    $$("[data-line]").forEach((i) => {
      i.onchange = () => {
        cart[i.dataset.line] = Math.min(Math.max(1, maxFor(i.dataset.line)), Math.max(1, Math.floor(+i.value) || 1));
        saveCart();
        renderCart().then(() => $(`[data-line="${i.dataset.line}"]`)?.focus());
      };
    });
  }

  // Hash the full request, without storing customer details. Memory also works with blocked storage.
  let rememberedOrderKey;
  async function orderKey(payload) {
    const { turnstile, ...details } = payload;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(details)));
    const sig = [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
    let saved = rememberedOrderKey;
    try { saved ||= JSON.parse(sessionStorage.getItem("orderKey")); } catch {}
    if (saved?.sig === sig) return saved.key;
    const key = crypto.randomUUID();
    rememberedOrderKey = { sig, key };
    try { sessionStorage.setItem("orderKey", JSON.stringify(rememberedOrderKey)); } catch {}
    return key;
  }

  function checkout() {
    const f = $("[data-checkout]");
    if (!f) return;
    // Wired up before anything loads: a form without a handler would send the address in the URL.
    const submit = $("button[type=submit]", f),
      err = $("[data-err]"),
      msg = $("[data-coupon-msg]");
    const settings = () => live || JSON.parse(f.dataset.live);
    let lines = [],
      total = 0,
      discount = 0,
      code = "",
      agreed = 0;
    let placing = false, pendingRequest = null, applying = false;
    let failure = "";
    const details = $("[data-details-fields]", f);

    const options = (select, list, hint) => {
      const keep = select.value;
      select.innerHTML =
        (hint ? `<option value="">${esc(hint)}</option>` : "") +
        list
          .map((o) => `<option value="${esc(o.id)}">${esc(o.label)}${o.fee === undefined ? "" : ` (${o.fee ? `${taka(o.fee)} per piece` : "Free"})`}</option>`)
          .join("");
      if (list.some((o) => o.id === keep)) select.value = keep;
    };

    const paint = async () => {
      if (pendingRequest || placing) return; // Keep an uncertain order unchanged while checking it.
      const s = settings();
      const data = await totals();
      lines = data.lines;
      const empty = !lines.length;
      $("[data-empty]").hidden = !empty;
      f.hidden = empty;
      if (empty) return;
      // No area is chosen for the customer: the first one may be free, and a guess would be wrong.
      options(f.area, s.delivery, s.delivery.length > 1 ? "Choose your area" : "");
      options(
        f.payment,
        s.payments.filter((p) => p.enabled),
      );
      const zone = s.delivery.find((z) => z.id === f.area.value);
      const pay = s.payments.find((p) => p.id === f.payment.value);
      discount = Math.min(discount, data.sub);
      const goods = data.sub - discount;
      // The charge is per piece, as the server counts it: the goods are heavy to carry.
      const pieces = lines.reduce((a, l) => a + l.qty, 0);
      const fee = !zone || (s.freeOver > 0 && goods >= s.freeOver) ? 0 : zone.fee * pieces;
      total = agreed || goods + fee;
      $("[data-sum]").innerHTML =
        lines
          .map(
            (l) =>
              `<div class="row"><span>${esc(l.p.name)} × ${l.qty}${l.p.inStock ? "" : " <b>(sold out)</b>"}</span><b>${taka(l.p.price * l.qty)}</b></div>`,
          )
          .join("") +
        (discount ? `<div class="row"><span>Discount (${esc(code)})</span><b>−${taka(discount)}</b></div>` : "") +
        `<div class="row"><span>Delivery charge${fee && pieces > 1 ? ` (${taka(zone.fee)} × ${pieces})` : ""}</span><b>${!zone ? "Choose your area" : fee ? taka(fee) : "Free"}</b></div><div class="row total"><span>Total</span><span>${taka(total)}</span></div>`;
      $("[data-eta]").textContent = zone?.days ? `Usually arrives in ${zone.days}.` : "";
      $("[data-txn]").hidden = !pay?.number;
      f.txnid.required = !!pay?.number;
      f.txnid.minLength = pay?.number ? 6 : 0;
      $("[data-pay]").hidden = !pay?.number;
      $("[data-pay]").textContent = !pay?.number
        ? ""
        : zone
          ? `Send ${taka(total)} to ${pay.number}, then enter the transaction ID. The shop must verify this payment; submitting a reference does not confirm payment.`
          : "Choose your area to see the amount to send.";
      const sold = lines.find((l) => !l.p.inStock);
      const over = lines.find((l) => l.qty > maxFor(l.p.id));
      const short = data.sub < s.minOrder;
      const closed = $("[data-closed]");
      closed.hidden = s.ordersOpen;
      closed.textContent = s.ordersOpen ? "" : s.closedNote;
      submit.disabled = placing || applying || !s.ordersOpen || !!sold || !!over || short || !pay;
      $("[data-apply]").disabled = placing || applying;
      err.textContent = sold
        ? `${sold.p.name} is sold out. Please remove it from your cart.`
        : over
          ? `Only ${maxFor(over.p.id)} of ${over.p.name} can be ordered. Please update your cart.`
        : !pay
          ? "No payment method is available. Please contact the shop."
        : short
          ? `The minimum online order is ${taka(s.minOrder)}.`
          : failure;
    };

    const repaint = () => paint().catch((x) => {
      err.textContent = x.message || "Could not load your order. Please refresh and try again.";
      submit.disabled = true;
    });
    repaintCheckout = repaint;
    f.onchange = (e) => {
      if (pendingRequest || placing || e.target.name === "coupon") return;
      failure = "";
      agreed = 0; // the customer changed the order, so an earlier agreed total no longer applies
      repaint();
    };
    $("[data-apply]").onclick = async () => {
      if (applying || placing || pendingRequest) return;
      applying = true;
      submit.disabled = true;
      $("[data-apply]").disabled = true;
      code = f.coupon.value.trim().toUpperCase();
      discount = 0;
      agreed = 0;
      msg.textContent = "";
      if (code) {
        try {
          const r = await api("/coupon", { code, items: lines.map((l) => ({ id: l.p.id, qty: l.qty })) });
          discount = r.discount;
          msg.textContent = `Coupon applied: ${taka(discount)} off.`;
        } catch (x) {
          code = "";
          msg.textContent = x.message;
        }
      }
      applying = false;
      $("[data-apply]").disabled = false;
      repaint();
    };
    f.coupon.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("[data-apply]").click();
      }
    };

    api("/me")
      .then((u) => {
        if (!f.name.value) f.name.value = u.name;
        if (!f.phone.value) f.phone.value = u.phone;
        const last = u.orders[0];
        if (last && !f.address.value) f.address.value = last.address;
      })
      .catch(() => {});

    f.onsubmit = async (e) => {
      e.preventDefault();
      if (placing || submit.disabled || (!pendingRequest && !f.reportValidity())) return;
      // The bot check takes a moment. Pressing the button early shouldn't count as failing it.
      if ($(".cf-turnstile", f) && !new FormData(f).get("cf-turnstile-response")) {
        showError(err, "The security check isn't finished. Wait a moment, tick the box if you see one, then try again.");
        return;
      }
      const label = "Place order";
      placing = true;
      submit.disabled = true;
      $("[data-apply]").disabled = true;
      submit.textContent = "Placing your order…";
      err.textContent = "";
      failure = "";
      f.setAttribute("aria-busy", "true");
      let request, sent = false;
      try {
        const d = Object.fromEntries(new FormData(f));
        request = pendingRequest || {
          items: lines.map((l) => ({ id: l.p.id, qty: l.qty })),
          name: d.name,
          phone: normalizePhone(d.phone),
          email: d.email || "",
          address: d.address,
          area: d.area,
          payment: d.payment,
          txnid: d.txnid,
          note: d.note,
          coupon: code,
          expected: agreed || total,
        };
        details.disabled = true;
        request.key ||= await orderKey(request);
        request.turnstile = d["cf-turnstile-response"] || "";
        sent = true;
        const r = await api("/checkout", request);
        cart = {};
        rememberedOrderKey = null;
        saveCart();
        try {
          sessionStorage.removeItem("orderKey");
          sessionStorage.setItem("lastOrder", JSON.stringify({ number: r.number, phone: request.phone }));
        } catch {}
        // Guests have no account, so this device remembers their orders for the track page.
        put("myOrders", [{ number: r.number, phone: request.phone }, ...get("myOrders", [])].slice(0, 5));
        location.href = `/track/?order=${encodeURIComponent(r.number)}&new=1`;
      } catch (x) {
        const uncertain = sent && (!x.status || x.status >= 500 || (pendingRequest && x.status === 429));
        pendingRequest = uncertain ? request : null;
        details.disabled = !!pendingRequest;
        failure = uncertain ? "We could not confirm the response. Keep this page open. Do not send payment again. Press Check order status to safely retry the same order, or call " + PHONE + "." : x.message;
        showError(err, failure);
        placing = false;
        f.removeAttribute("aria-busy");
        submit.textContent = uncertain ? "Check order status" : label;
        submit.disabled = false;
        $("[data-apply]").disabled = !!pendingRequest;
        // The customer has now seen the new total, so pressing the button again accepts it.
        agreed = +(x.message.match(/total changed to ৳(\d+)/)?.[1] || 0);
        window.turnstile?.reset();
        if (x.status === 409) loadStock(true);
      }
    };
    repaint();
  }

  const orderHtml = (o) => {
    const out = o.status === "cancelled" || o.status === "returned";
    const steps = out ? [o.status] : ["pending", "confirmed", "shipped", "delivered"];
    const reached = steps.indexOf(o.status);
    const when = (s) => {
      const ev = (o.events || []).filter((x) => x.status === s).pop();
      return ev ? new Date(ev.at).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short" }) : "";
    };
    return `<div class="panel order"><h3>${esc(o.number)}</h3>
      <ol class="steps">${steps.map((s, i) => `<li class="${i <= reached ? "on" : ""}"><b>${esc(STATUS[s] || s)}</b><small>${esc(when(s))}</small></li>`).join("")}</ol>
      ${o.courier ? `<p class="meta">Courier: ${esc(o.courier)}${o.tracking ? `, tracking number ${esc(o.tracking)}` : ""}</p>` : ""}
      ${(o.items || []).map((i) => `<div class="row"><span>${esc(i.name)} × ${i.qty}</span><b>${taka(i.price * i.qty)}</b></div>`).join("")}
      ${o.discount ? `<div class="row"><span>Discount</span><b>−${taka(o.discount)}</b></div>` : ""}
      <div class="row"><span>Delivery charge</span><b>${o.shipping ? taka(o.shipping) : "Free"}</b></div>
      <div class="row total"><span>Total</span><span>${taka(o.total)}</span></div>
      ${(o.items || []).some((i) => i.id) ? `<button class="btn ghost" data-again="${esc(JSON.stringify(o.items.map((i) => ({ id: i.id, qty: i.qty }))))}">Buy again</button>` : ""}</div>`;
  };

  // The delivery lines on a product page, so the charge is no surprise at checkout.
  function applyDelivery() {
    const el = $("[data-delivery]");
    if (!el || !live) return;
    const free = live.freeOver > 0 ? `<li>Free delivery on orders of ${taka(live.freeOver)} or more</li>` : "";
    el.innerHTML =
      live.delivery.map((z) => `<li>${esc(z.label)}: <b>${z.fee ? `${taka(z.fee)} per piece` : "Free"}</b>${z.days ? `, ${esc(z.days)}` : ""}</li>`).join("") + free;
  }

  function rememberProduct() {
    const id = +($("[data-product]")?.dataset.product || 0);
    if (id) put("seen", [id, ...get("seen", []).filter((x) => x !== id)].slice(0, 9));
  }

  async function renderRecent() {
    const el = $("[data-recent]");
    if (!el) return;
    const here = +($("[data-product]")?.dataset.product || 0);
    const seen = get("seen", [])
      .filter((x) => x !== here)
      .slice(0, 4);
    if (!seen.length) {
      el.closest("[data-recent-wrap]").hidden = true;
      return;
    }
    const all = await items();
    const l = seen.map((id) => all.find((p) => p.id === id)).filter(Boolean);
    el.innerHTML = l.map(card).join("");
    el.closest("[data-recent-wrap]").hidden = !l.length;
    badges();
  }

  // On a phone the Add to cart button scrolls away, so a bar keeps it in reach.
  function buyBar() {
    const bar = $("[data-buybar]"),
      buy = $(".buy");
    if (!bar || !buy) return;
    const update = () => {
      const show = buy.getBoundingClientRect().bottom < 0;
      bar.classList.toggle("on", show);
      document.body.classList.toggle("has-buybar", show);
    };
    addEventListener("scroll", update, { passive: true });
    update();
  }

  // Product photo: hovering shows a magnified view beside it on a computer; a tap or click opens it full screen.
  function zoom() {
    const pic = $("[data-main]");
    if (!pic) return;
    const stage = pic.closest(".stage");
    const pane = document.createElement("div");
    pane.className = "zoompane";
    pane.hidden = true;
    stage.append(pane);
    const wide = matchMedia("(hover: hover) and (min-width: 900px)");
    const url = () => `url("${(pic.dataset.zoom || pic.currentSrc || pic.src).replace(/["\\\n]/g, encodeURIComponent)}")`;
    pic.addEventListener("mousemove", (e) => {
      if (!wide.matches) return;
      const r = pic.getBoundingClientRect();
      pane.style.backgroundImage = url();
      pane.style.backgroundPosition = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
      pane.hidden = false;
    });
    pic.addEventListener("mouseleave", () => {
      pane.hidden = true;
    });
    pic.addEventListener("click", () => {
      const box = document.createElement("dialog");
      box.className = "lightbox";
      box.setAttribute("aria-label", "Product image");
      box.innerHTML = `<img src="${esc(pic.dataset.zoom || pic.currentSrc || pic.src)}" alt="${esc(pic.alt)}"><button class="x" aria-label="Close">×</button>`;
      const close = () => {
        box.close();
        box.remove();
        pic.focus();
        removeEventListener("keydown", key);
      };
      const key = (e) => e.key === "Escape" && close();
      box.addEventListener("click", (event) => {
        if (event.target === box || event.target.closest("button")) close();
      });
      box.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
      addEventListener("keydown", key);
      document.body.append(box);
      box.showModal();
    });
    pic.tabIndex = 0;
    pic.setAttribute("role", "button");
    pic.setAttribute("aria-label", "Enlarge product image");
    pic.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pic.click();
      }
    });
  }

  function track() {
    const f = $("[data-track]");
    if (!f) return;
    const q = new URLSearchParams(location.search),
      out = $("[data-order]"),
      err = $("[data-err]");
    let tracking = false;
    const go = async () => {
      if (tracking) return;
      tracking = true;
      const button = $("button", f);
      button.disabled = true;
      button.textContent = "Finding order…";
      err.textContent = "";
      out.innerHTML = "";
      try {
        const o = await api(`/track?order=${encodeURIComponent(f.order.value)}&phone=${encodeURIComponent(normalizePhone(f.phone.value))}`);
        out.innerHTML =
          (q.get("new") ? `<p class="note">${esc(ORDER_PLACED)}</p>` : "") + orderHtml(o);
      } catch (x) {
        showError(err, x.message);
      } finally { tracking = false; button.disabled = false; button.textContent = "Track order"; }
    };
    f.onsubmit = (e) => {
      e.preventDefault();
      go();
    };
    const mine = get("myOrders", []).filter(o => o && typeof o.number === "string" && typeof o.phone === "string");
    const list = $("[data-mine]");
    if (list && mine.length) {
      list.hidden = false;
      $("div", list).innerHTML = mine
        .map(
          (o) => `<button class="btn ghost" data-mine-order="${esc(o.number)}" data-mine-phone="${esc(o.phone)}">${esc(o.number)}</button>`,
        )
        .join("");
    }
    if (!q.get("order")) return;
    f.order.value = q.get("order");
    f.phone.value = q.get("phone") || "";
    if (!f.phone.value) {
      try {
        const last = JSON.parse(sessionStorage.getItem("lastOrder"));
        if (last?.number === f.order.value) f.phone.value = last.phone;
      } catch {}
    }
    if (!f.phone.value) f.phone.value = mine.find(o => o.number === f.order.value)?.phone || "";
    if (f.phone.value) go();
  }

  function account() {
    const el = $("[data-account]");
    if (!el) return;
    const bind = (f, path, done) => {
      let busy = false;
      f.onsubmit = async e => {
        e.preventDefault();
        if (busy || !f.reportValidity()) return;
        const er = $(".err", f), button = $("button", f);
        er.textContent = "";
        const data = Object.fromEntries(new FormData(f));
        if (data.phone) data.phone = normalizePhone(data.phone);
        busy = true; button.disabled = true; f.setAttribute("aria-busy", "true");
        try { await api(path, data); await done(); }
        catch (x) { showError(er, x.message); }
        finally { busy = false; button.disabled = false; f.removeAttribute("aria-busy"); }
      };
    };
    const show = async () => {
      el.setAttribute("aria-busy", "true");
      try {
        const u = await api("/me");
        $("[data-auth]").hidden = true;
        el.innerHTML = `<div class="panel"><h2>Hello, ${esc(u.name)}</h2><p>${esc(u.phone)}</p><p class="err" role="alert" tabindex="-1" data-account-error></p><button class="btn ghost" data-out>Log out</button>
          <details class="change"><summary class="link">Change password</summary><form data-change>
          <label class="field">Current password<input name="old" type="password" required autocomplete="current-password"></label>
          <label class="field">New password (8+ characters)<input name="new" type="password" minlength="8" maxlength="72" required autocomplete="new-password"></label>
          <p class="err" role="alert" tabindex="-1"></p><button class="btn small">Save password</button></form></details></div>
          ${u.orders.map(orderHtml).join("") || "<p>No orders yet.</p>"}`;
        $("[data-out]").onclick = async e => {
          const button = e.currentTarget;
          if (button.disabled) return;
          button.disabled = true;
          try { await api("/logout", {}); location.reload(); }
          catch (x) { showError($("[data-account-error]"), x.message); button.disabled = false; }
        };
        const change = $("[data-change]");
        bind(change, "/password", () => { change.reset(); toast("Password changed"); });
      } catch (x) {
        if (x.status === 401) { el.innerHTML = ""; $("[data-auth]").hidden = false; }
        else {
          el.innerHTML = `<p class="err" role="alert">${esc(x.message)}</p><button class="btn ghost" data-retry-account>Try loading account again</button>`;
          $("[data-retry-account]").onclick = show;
        }
      } finally { el.removeAttribute("aria-busy"); }
    };
    $$("[data-form]").forEach(f => bind(f, "/" + f.dataset.form, show));
    show();
  }

  // Guard repeated taps and keep recoverable input errors in place.
  function simpleForm(f, path, thanks, extra = {}) {
    let busy = false;
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (busy || !f.reportValidity()) return;
      const er = $(".err", f), button = $("button[type=submit], button:not([type])", f);
      er.textContent = "";
      const data = Object.fromEntries(new FormData(f));
      if (data.phone) data.phone = normalizePhone(data.phone);
      if (data.rating) data.rating = +data.rating;
      busy = true; button.disabled = true; f.setAttribute("aria-busy", "true");
      try {
        await api(path, { ...data, ...extra });
        f.reset();
        let success = $(".form-success", f);
        if (!success) { success = document.createElement("p"); success.className = "form-success"; success.setAttribute("role", "status"); f.append(success); }
        success.textContent = thanks; success.tabIndex = -1; success.focus();
        toast(thanks);
      } catch (x) { showError(er, x.message); }
      finally { busy = false; button.disabled = false; f.removeAttribute("aria-busy"); }
    };
  }

  async function loadStock(reload) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 8000); // a sleeping API must not hold up the page
    try {
      const r = await fetch("/api/stock", { signal: timeout.signal, cache: reload ? "reload" : "default" });
      if (!r.ok) throw new Error();
      const snap = await r.json();
      // A saved snapshot renders immediately. Check once after the Worker's five-second
      // refresh window so newly published products do not stay disabled on this page.
      if (r.headers.get("X-Stock-Stale") === "1" && !retriedStaleStock) {
        retriedStaleStock = true;
        setTimeout(() => loadStock(true), 5500);
      }
      $("[data-stock-notice]")?.remove();
      stock = snap.products || {};
      stockLoaded = true;
      live = snap.settings || null;
      index = null;
      applyStock();
      applyLive();
      applyDelivery();
      await Promise.all([renderCart(), renderWish(), search(), renderRecent(), repaintCheckout()]);
    } catch {
      // Static browsing stays available; orders are always checked on the server.
      let notice = $("[data-stock-notice]");
      if (!notice) {
        notice = document.createElement("div"); notice.dataset.stockNotice = ""; notice.className = "wrap note";
        notice.setAttribute("role", "status");
        notice.innerHTML = 'Live availability could not be refreshed. Prices are checked at checkout. <button type="button" class="btn ghost small">Try again</button>';
        $("button", notice).onclick = () => { notice.remove(); loadStock(true); };
        $("main")?.prepend(notice);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const renderDynamic = () => Promise.allSettled([
    [renderCart, "[data-cart]"], [renderWish, "[data-wishlist]"], [search, "[data-results]"], [renderRecent, "[data-recent]"],
  ].map(async ([render, selector]) => {
    try { await render(); }
    catch {
      const el = $(selector);
      if (el) el.innerHTML = '<p role="alert">Could not load products. Please refresh the page to try again.</p>';
    }
  }));
  const syncCart = () => {
    cart = readCart();
    wish = readWish();
    badges();
    renderDynamic();
    repaintCheckout();
  };
  addEventListener("pageshow", (e) => { if (e.persisted) syncCart(); });
  addEventListener("storage", (e) => { if (!e.key || e.key === "cart" || e.key === "wish") syncCart(); });
  $$(".mobile-nav a, .nav > a, .icons a").forEach((a) => {
    if (a.pathname === location.pathname) a.setAttribute("aria-current", "page");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$("details.mega[open]").forEach((d) => (d.open = false));
  });

  const drawer = $("#category-drawer"), categoryButton = $("[data-categories]");
  categoryButton?.addEventListener("click", () => { drawer.showModal(); categoryButton.setAttribute("aria-expanded", "true"); });
  $("[data-close-categories]")?.addEventListener("click", () => drawer.close());
  drawer?.addEventListener("close", () => { categoryButton.setAttribute("aria-expanded", "false"); categoryButton.focus(); });
  document.addEventListener("focusin", e => { if (e.target.matches("input:not([type=checkbox]):not([type=radio]), textarea, select")) document.body.classList.add("is-editing"); });
  document.addEventListener("focusout", () => requestAnimationFrame(() => {
    document.body.classList.toggle("is-editing", !!document.activeElement?.matches("input:not([type=checkbox]):not([type=radio]), textarea, select"));
  }));
  document.addEventListener("error", e => {
    const image = e.target;
    if (image instanceof HTMLImageElement && !image.src.endsWith("/placeholder.svg")) { image.closest("picture")?.querySelectorAll("source").forEach(source => source.remove()); image.removeAttribute("srcset"); image.removeAttribute("data-zoom"); image.src = "/placeholder.svg"; }
  }, true);
  $$("img").forEach(image => { if (image.complete && !image.naturalWidth && image.getAttribute("src")) image.dispatchEvent(new Event("error")); });
  $$("[data-thumb]").forEach(b => b.setAttribute("aria-pressed", String(b.classList.contains("on"))));
  if (storageUnavailable) storageNotice();
  rememberProduct();
  badges();
  grids();
  suggestions();
  buyBar();
  zoom();
  track();
  account();
  checkout();
  $$("[data-contact]").forEach((f) => simpleForm(f, "/contact", MESSAGE_THANKS));
  $$("[data-review]").forEach((f) =>
    simpleForm(f, "/reviews", REVIEW_THANKS, { product: +f.dataset.review }),
  );
  renderDynamic();
  loadStock();
})();
