// Storefront behaviour. Pages are static; prices, stock and live settings arrive from /api/stock.
// Always pass customer text through esc() before putting it in HTML.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const get = (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  };
  const put = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  };
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

  let cart = get("cart", {});
  let wish = get("wish", []);
  let index = null; // the search index, with live prices merged in
  let stock = {}; // id: [price, regular, units], units capped at 99
  let live = null; // settings that take effect without a rebuild
  let repaintCheckout = () => {};

  const api = async (path, body, method) => {
    let r;
    try {
      r = await fetch("/api" + path, {
        method: method || (body ? "POST" : "GET"),
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
      });
    } catch {
      throw new Error(`Could not reach the shop. Please check your connection, or call ${PHONE}.`);
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Service is busy. Please call ${PHONE}.`), { status: r.status });
    return j;
  };

  const maxFor = (id) => Math.min(MAX_QTY, stock[id] ? stock[id][2] || 1 : MAX_QTY);

  async function items() {
    if (index) return index;
    const list = await (await fetch("/search-index.json")).json();
    const known = Object.keys(stock).length > 0;
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
    $$("[data-wish]").forEach((b) => b.classList.toggle("on", wish.includes(+b.dataset.wish)));
  }

  const saveCart = () => {
    put("cart", cart);
    badges();
  };
  const priceHtml = (price, regular) => `<b>${taka(price)}</b>${regular > price ? `<s>${taka(regular)}</s>` : ""}`;

  // Makes a static page match the latest prices and stock.
  function applyStock() {
    if (!Object.keys(stock).length) return;
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
      cart[id] = Math.min(want, maxFor(id));
      saveCart();
      toast(cart[id] < want ? `You can order ${cart[id]} of this online` : "Added to cart");
      if (t.dataset.buy) location.href = "/checkout/";
    }
    if (t.dataset.again) {
      JSON.parse(t.dataset.again).forEach((l) => {
        cart[l.id] = Math.min((cart[l.id] || 0) + l.qty, maxFor(l.id));
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
      $("[data-main]").src = t.dataset.thumb;
      $$("[data-thumb]").forEach((b) => b.classList.toggle("on", b === t));
    }
  });

  function grids() {
    $$("[data-grid]").forEach((g) => {
      const tools = g.previousElementSibling;
      const empty = g.nextElementSibling?.matches("[data-nomatch]") ? g.nextElementSibling : null;
      const more = g.parentElement.querySelector(":scope > [data-more]");
      let shown = PAGE;
      const update = () => {
        const low = +($("[data-min]", tools)?.value || 0);
        const high = +($("[data-max]", tools)?.value || Infinity);
        const inStock = $("[data-instock]", tools)?.checked;
        const cards = $$("[data-card]", g);
        const match = cards.filter((c) => +c.dataset.price >= low && +c.dataset.price <= high && (!inStock || c.dataset.stocked === "1"));
        cards.forEach((c) => {
          c.hidden = true;
        });
        match.slice(0, shown).forEach((c) => {
          c.hidden = false;
        });
        if (more) more.hidden = match.length <= shown;
        if (empty) empty.hidden = match.length > 0;
        const count = $("[data-count]", tools);
        if (count) count.textContent = match.length;
      };
      const sort = () => {
        const by =
          {
            asc: (a, b) => a.dataset.price - b.dataset.price,
            desc: (a, b) => b.dataset.price - a.dataset.price,
            name: (a, b) => a.dataset.name.localeCompare(b.dataset.name),
          }[$("[data-sort]", tools)?.value] || ((a, b) => b.dataset.id - a.dataset.id);
        $$("[data-card]", g)
          .sort(by)
          .forEach((c) => g.append(c));
        update();
      };
      g._update = update;
      if (more)
        more.onclick = () => {
          shown += PAGE;
          update();
        };
      $("[data-sort]", tools)?.addEventListener("change", sort);
      ["[data-min]", "[data-max]", "[data-instock]"].forEach((s) =>
        $(s, tools)?.addEventListener("input", () => {
          shown = PAGE;
          update();
        }),
      );
      update();
    });
  }

  const card = (p) => `<article class="card">
    <a class="thumb" href="/product/${esc(p.slug)}/"><img loading="lazy" src="${esc(p.thumb)}" alt="${esc(p.name)}" width="300" height="300"></a>
    <button class="heart" data-wish="${p.id}" aria-label="Add ${esc(p.name)} to wishlist">♥</button>
    <div class="body"><a class="name" href="/product/${esc(p.slug)}/">${esc(p.name)}</a>
    <div class="price">${priceHtml(p.price, p.regular)}</div>
    <button class="btn small" data-add="${p.id}" data-label="Add to cart" ${p.inStock ? "" : "disabled"}>${p.inStock ? "Add to cart" : "Sold out"}</button></div></article>`;

  async function renderWish() {
    const el = $("[data-wishlist]");
    if (!el) return;
    const l = (await items()).filter((p) => wish.includes(p.id));
    el.innerHTML = l.map(card).join("") || "<p>Your wishlist is empty.</p>";
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
    const input = $("[data-suggest]"),
      box = $("[data-suggestions]");
    if (!input || !box) return;
    let timer;
    const close = () => {
      box.hidden = true;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) return close();
        const l = matches(await items().catch(() => []), q).slice(0, 6);
        box.innerHTML = l
          .map(
            (p) =>
              `<a href="/product/${esc(p.slug)}/"><img src="${esc(p.thumb)}" alt="" width="40" height="40" loading="lazy"><span>${esc(p.name)}</span><b>${taka(p.price)}</b></a>`,
          )
          .join("");
        box.hidden = !l.length;
      }, 150);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".find")) close();
    });
  }

  async function totals() {
    const all = await items();
    const gone = Object.keys(cart).filter((id) => !all.some((x) => x.id == id));
    if (gone.length) { // removed from the shop since it was added, so don't keep counting it
      gone.forEach((id) => delete cart[id]);
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
    el.innerHTML =
      lines
        .map(
          (l) => `<div class="line">
      <img src="${esc(l.p.thumb)}" alt="" width="64" height="64">
      <div><a href="/product/${esc(l.p.slug)}/">${esc(l.p.name)}</a><br>${taka(l.p.price)} ${l.p.inStock ? "" : "<b>Sold out</b>"}<br>
      <button class="link" data-del="${l.p.id}">Remove</button></div>
      <input type="number" min="1" max="${maxFor(l.p.id)}" value="${l.qty}" data-line="${l.p.id}" aria-label="Quantity of ${esc(l.p.name)}">
    </div>`,
        )
        .join("") || "<p>Your cart is empty. <a class='link' href='/shop/'>Start shopping</a></p>";
    $("[data-sub]").textContent = taka(sub);
    const go = $("[data-to-checkout]");
    if (go) go.hidden = !lines.length || lines.some((l) => !l.p.inStock);
    const free = $("[data-free]");
    if (free && live?.freeOver)
      free.textContent = sub >= live.freeOver ? "You get free delivery." : `Add ${taka(live.freeOver - sub)} more for free delivery.`;
    $$("[data-line]").forEach((i) => {
      i.onchange = () => {
        cart[i.dataset.line] = Math.min(maxFor(i.dataset.line), Math.max(1, Math.floor(+i.value) || 1));
        saveCart();
        renderCart();
      };
    });
  }

  // One key per cart, so a retry after a lost connection can't place a second order.
  function orderKey(lines) {
    const sig = lines.map((l) => `${l.p.id}x${l.qty}`).join();
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem("orderKey"));
    } catch {}
    if (saved?.sig === sig) return saved.key;
    const key = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    try {
      sessionStorage.setItem("orderKey", JSON.stringify({ sig, key }));
    } catch {}
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
      total = goods + fee;
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
      $("[data-pay]").textContent = !pay?.number
        ? ""
        : zone
          ? `Send ${taka(total)} to ${pay.number}, then enter the transaction ID.`
          : "Choose your area to see the amount to send.";
      const sold = lines.find((l) => !l.p.inStock);
      const short = data.sub < s.minOrder;
      const closed = $("[data-closed]");
      closed.hidden = s.ordersOpen;
      closed.textContent = s.ordersOpen ? "" : s.closedNote;
      submit.disabled = !s.ordersOpen || !!sold || short;
      err.textContent = sold
        ? `${sold.p.name} is sold out. Please remove it from your cart.`
        : short
          ? `The minimum online order is ${taka(s.minOrder)}.`
          : err.textContent;
    };

    repaintCheckout = paint;
    f.onchange = (e) => {
      if (e.target.name === "coupon") return;
      agreed = 0; // the customer changed the order, so an earlier agreed total no longer applies
      paint();
    };
    $("[data-apply]").onclick = async () => {
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
      paint();
    };
    f.coupon.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("[data-apply]").click();
      }
    };

    api("/me")
      .then((u) => {
        f.name.value = u.name;
        f.phone.value = u.phone;
        const last = u.orders[0];
        if (last) f.address.value = last.address;
      })
      .catch(() => {});

    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!f.reportValidity()) return;
      // The bot check takes a moment. Pressing the button early shouldn't count as failing it.
      if ($(".cf-turnstile", f) && !new FormData(f).get("cf-turnstile-response")) {
        err.textContent = "The security check isn't finished. Wait a moment, tick the box if you see one, then press Place order again.";
        return;
      }
      const label = submit.textContent;
      submit.disabled = true;
      submit.textContent = "Placing your order…";
      err.textContent = "";
      try {
        const d = Object.fromEntries(new FormData(f));
        const r = await api("/checkout", {
          items: lines.map((l) => ({ id: l.p.id, qty: l.qty })),
          name: d.name,
          phone: d.phone,
          email: d.email || "",
          address: d.address,
          area: d.area,
          payment: d.payment,
          txnid: d.txnid,
          note: d.note,
          coupon: code,
          key: orderKey(lines),
          expected: agreed || total,
          turnstile: d["cf-turnstile-response"] || "",
        });
        cart = {};
        saveCart();
        try {
          sessionStorage.removeItem("orderKey");
          sessionStorage.setItem("lastOrder", JSON.stringify({ number: r.number, phone: d.phone }));
        } catch {}
        // Guests have no account, so this device remembers their orders for the track page.
        put("myOrders", [{ number: r.number, phone: d.phone }, ...get("myOrders", [])].slice(0, 5));
        location.href = `/track/?order=${encodeURIComponent(r.number)}&new=1`;
      } catch (x) {
        err.textContent = x.message;
        submit.textContent = label;
        submit.disabled = false;
        // The customer has now seen the new total, so pressing the button again accepts it.
        agreed = +(x.message.match(/total changed to ৳(\d+)/)?.[1] || 0);
        window.turnstile?.reset();
        if (x.status === 409) loadStock(true);
      }
    };
    paint();
  }

  const orderHtml = (o) => {
    const out = o.status === "cancelled" || o.status === "returned";
    const steps = out ? [o.status] : ["pending", "confirmed", "shipped", "delivered"];
    const reached = steps.indexOf(o.status);
    const when = (s) => {
      const ev = (o.events || []).filter((x) => x.status === s).pop();
      return ev ? new Date(ev.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
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
    const url = () => `url("${(pic.currentSrc || pic.src).replace(/["\\\n]/g, encodeURIComponent)}")`;
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
      const box = document.createElement("div");
      box.className = "lightbox";
      box.innerHTML = `<img src="${esc(pic.currentSrc || pic.src)}" alt="${esc(pic.alt)}"><button class="x" aria-label="Close">×</button>`;
      const close = () => {
        box.remove();
        removeEventListener("keydown", key);
      };
      const key = (e) => e.key === "Escape" && close();
      box.onclick = close;
      addEventListener("keydown", key);
      document.body.append(box);
    });
  }

  function track() {
    const f = $("[data-track]");
    if (!f) return;
    const q = new URLSearchParams(location.search),
      out = $("[data-order]"),
      err = $("[data-err]");
    const go = async () => {
      err.textContent = "";
      try {
        const o = await api(`/track?order=${encodeURIComponent(f.order.value)}&phone=${encodeURIComponent(f.phone.value)}`);
        out.innerHTML =
          (q.get("new") ? `<p class="note">${esc(ORDER_PLACED)}</p>` : "") + orderHtml(o);
      } catch (x) {
        err.textContent = x.message;
      }
    };
    f.onsubmit = (e) => {
      e.preventDefault();
      go();
    };
    const mine = get("myOrders", []);
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
    if (f.phone.value) go();
  }

  function account() {
    const el = $("[data-account]");
    if (!el) return;
    const show = async () => {
      try {
        const u = await api("/me");
        $("[data-auth]").hidden = true;
        el.innerHTML = `<div class="panel"><h2>Hello, ${esc(u.name)}</h2><p>${esc(u.phone)}</p><button class="btn ghost" data-out>Log out</button>
          <details class="change"><summary class="link">Change password</summary><form data-change>
          <label class="field">Current password<input name="old" type="password" required autocomplete="current-password"></label>
          <label class="field">New password (8+ characters)<input name="new" type="password" minlength="8" maxlength="72" required autocomplete="new-password"></label>
          <p class="err"></p><button class="btn small">Save password</button></form></details></div>
          ${u.orders.map(orderHtml).join("") || "<p>No orders yet.</p>"}`;
        $("[data-out]").onclick = async () => {
          await api("/logout", {});
          location.reload();
        };
        $("[data-change]").onsubmit = async (e) => {
          e.preventDefault();
          const er = $(".err", e.target);
          er.textContent = "";
          try {
            await api("/password", Object.fromEntries(new FormData(e.target)));
            e.target.reset();
            toast("Password changed");
          } catch (x) {
            er.textContent = x.message;
          }
        };
      } catch {
        el.innerHTML = "";
        $("[data-auth]").hidden = false;
      }
    };
    $$("[data-form]").forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const er = $(".err", f);
        er.textContent = "";
        try {
          await api("/" + f.dataset.form, Object.fromEntries(new FormData(f)));
          show();
        } catch (x) {
          er.textContent = x.message;
        }
      };
    });
    show();
  }

  // Contact and review forms behave alike: send, thank, clear.
  function simpleForm(f, path, thanks, extra = {}) {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const er = $(".err", f);
      er.textContent = "";
      const data = Object.fromEntries(new FormData(f));
      if (data.rating) data.rating = +data.rating;
      try {
        await api(path, { ...data, ...extra });
        f.reset();
        toast(thanks);
      } catch (x) {
        er.textContent = x.message;
      }
    };
  }

  async function loadStock(reload) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 8000); // a sleeping API must not hold up the page
    try {
      const r = await fetch("/api/stock", { signal: timeout.signal, cache: reload ? "reload" : "default" });
      if (!r.ok) throw new Error();
      const snap = await r.json();
      stock = snap.products || {};
      live = snap.settings || null;
      index = null;
      applyStock();
      applyLive();
      applyDelivery();
      await Promise.all([renderCart(), renderWish(), search(), renderRecent(), repaintCheckout()]);
    } catch {
      // Keep the prices the page was built with. The server still checks every order.
    } finally {
      clearTimeout(timer);
    }
  }

  // Coming back with the browser's Back button restores the old page: bring the counts up to date.
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    cart = get("cart", {});
    wish = get("wish", []);
    badges();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $$("details.mega[open]").forEach((d) => (d.open = false));
  });

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
  Promise.allSettled([renderCart(), renderWish(), search(), renderRecent()]);
  loadStock();
})();
