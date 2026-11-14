// Admin panel. Everything customers typed goes through esc() before it reaches the page.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => "৳" + Number(n || 0).toLocaleString("en-IN");
  const when = (s) =>
    new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const slugify = (s) =>
    String(s)
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-") // Bangla vowel signs are marks, not letters
      .replace(/^-+|-+$/g, "");
  const asciiId = (s) => slugify(s).replace(/[^a-z0-9-]/g, "") || "opt-" + Date.now().toString(36);
  const view = () => $("#view");

  const STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled", "returned"];
  const statusOptions = (current) =>
    STATUSES.map((v) => `<option value="${v}" ${v === current ? "selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`).join("");

  // Direct 1-click grouped navigation; related sections also share top subtabs.
  const NAV_GROUPS = [
    [
      "Daily Work",
      [
        ["dashboard", "Overview"],
        ["orders", "Orders"],
        ["messages", "Inbox"],
        ["reviews", "Reviews"],
      ],
    ],
    [
      "Catalog",
      [
        ["products", "Products"],
        ["categories", "Categories"],
        ["coupons", "Coupons"],
        ["customers", "Customers"],
        ["tags", "Search tags"],
      ],
    ],
    [
      "Website",
      [
        ["home", "Home page"],
        ["menu", "Navigation menu"],
        ["pages", "Pages"],
        ["blog", "Blog"],
      ],
    ],
    [
      "Settings",
      [
        ["delivery", "Delivery and payment"],
        ["shop", "Shop details"],
      ],
    ],
  ];
  const SUBGROUPS = [
    { messages: "Messages", reviews: "Reviews" },
    { products: "All products", categories: "Categories", tags: "Search tags" },
    { home: "Home page", menu: "Navigation menu", pages: "Pages", blog: "Blog" },
    { delivery: "Delivery and payment", shop: "Shop details" },
  ];

  const LIVE_BADGE = `<span class="effect live">● Live — updates in ~2 min</span>`;
  const PUB_BADGE = `<span class="effect pub">◆ Needs Publish</span>`;
  const effectBadges = (mode) =>
    mode === "live"
      ? LIVE_BADGE
      : mode === "pub"
        ? PUB_BADGE
        : mode === "both"
          ? `${LIVE_BADGE} ${PUB_BADGE}`
          : "";

  const HEADS = {
    dashboard: ["Welcome", "Your shop today, and quick links to the tasks you do most.", ""],
    orders: ["Orders", "Find orders, update shipping status, save courier tracking, or print invoices. Status updates appear on order tracking immediately.", ""],
    messages: ["Messages", "Questions sent by customers from the Contact Us page (/contact-us/).", ""],
    reviews: ["Reviews", "Customer product reviews waiting for moderation. Approved reviews appear on product pages after you click Publish.", "pub"],
    products: ["Products", "Edit prices, old prices, stock, and visibility inline — they save automatically and go live in ~2 minutes. Click Edit for names, photos, categories, and descriptions.", "both"],
    categories: ["Categories", "Product groups served at /product-category/<path>/. Add categories to your top menu or home grid under Website → Navigation menu.", "pub"],
    coupons: ["Coupons", "Discount codes customers apply on the Checkout page. Active coupons start working immediately.", "live"],
    customers: ["Customers", "Everyone who has ordered. Click an order count to view their orders, or reset a forgotten customer account password.", ""],
    tags: ["Tags", "Search keywords on products, used on /product-tag/ pages and by Google.", "pub"],
    home: ["Home page", "Edit the main hero headline, promotional banners, and featured product rows on your storefront home page (/).", "pub"],
    menu: ["Navigation menu", "Choose which category groups appear in the top header dropdowns and the home page 'Shop by category' grid.", "pub"],
    pages: ["Pages", "Edit About Us, How To Buy, Terms, Privacy Policy, and other pages. Any extra published pages are added to the Company footer column.", "pub"],
    blog: ["Blog", "Articles shown on /blog/ and at /<slug>/ for customers and Google search.", "pub"],
    delivery: ["Delivery and payment", "Configure delivery fees, free shipping threshold, payment numbers, announcement bar, and whether checkout is open.", "live"],
    shop: ["Shop details", "Manage your shop name, logo, phone numbers, address, opening hours, return policy, and social links used across the store and invoices.", "pub"],
  };

  // The search box and the home screen. The last word list is what people might type.
  const JOBS = [
    ["Change a price or stock", "#products", "price stock quantity sold out discount offer"],
    ["Add a new product", "#new-product", "create product photo image"],
    ["Change delivery charges", "#delivery", "delivery charge free shipping fee courier area jashore dhaka"],
    ["Change payment numbers", "#delivery", "bkash nagad rocket payment cash number"],
    ["Edit the home page", "#home", "hero heading banner picture sections"],
    ["Change phone or address", "#shop", "phone whatsapp address email facebook youtube hours contact returns"],
    ["Change the navigation menu", "#menu", "menu categories dropdown navigation"],
    ["Make a discount coupon", "#coupons", "coupon code discount offer sale"],
    ["Edit About, Terms or Privacy", "#pages", "about terms privacy how to buy policy page"],
    ["Write a blog post", "#new-post", "blog article post"],
    ["Close or reopen online orders", "#delivery", "closed holiday eid stop open"],
    ["Show an announcement bar", "#delivery", "notice announcement sale eid message"],
    ["Change the shop logo", "#shop", "logo image brand"],
    ["Publish the website now", "#publish", "publish rebuild update"],
  ];

  const remembered = () => {
    try {
      return localStorage.getItem("keep") || "";
    } catch {
      return "";
    }
  };
  let token = sessionStorage.getItem("t") || remembered();
  let unsaved = false;
  const LEAVE = "You have changes you haven't saved. Leave without saving?";
  const back = (to) => () => {
    if (unsaved && !confirm(LEAVE)) return;
    unsaved = false;
    to();
  };
  let site = null; // shop details, for invoices
  let categories = [];
  let allProducts = [];
  let allTags = [];
  let productsLoaded = false;
  let catalogPromise = null;
  let catsPromise = null;
  let lowStock = 5;

  async function api(path, opts = {}) {
    const headers = { "X-Admin-Token": token, ...(opts.headers || {}) };
    let body = opts.body;
    if (body && !(body instanceof Blob)) {
      body = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const r = await fetch("/api/admin" + path, { method: opts.method || (body ? "POST" : "GET"), headers, body });
    if (opts.raw && r.ok) return r;
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error("That password is not right. Please try again."), { auth: true });
    if (!r.ok) throw new Error(j.error || "Request failed");
    return j;
  }

  const say = (m) => {
    $("#ok").textContent = m;
    $("#ok").hidden = !m;
  };
  const logout = (msg) => {
    sessionStorage.removeItem("t");
    try {
      localStorage.removeItem("keep");
    } catch {}
    token = "";
    categories = [];
    allProducts = [];
    allTags = [];
    productsLoaded = false;
    catalogPromise = null;
    catsPromise = null;
    $("#loginErr").textContent = msg || "";
    $("#login").hidden = false;
    $("#app").hidden = true;
  };
  // Runs an action and shows any failure at the top of the page.
  const run =
    (f) =>
    async (...a) => {
      $("#err").textContent = "";
      try {
        return await f(...a);
      } catch (e) {
        if (e.auth) logout(e.message);
        else {
          say("");
          $("#err").textContent = e.message;
          unsaved = !!$("#view form");
          scrollTo(0, 0);
        }
      }
    };
  // Saved, but customers only see it after Publish.
  const needsPublish = (m) => {
    say(m);
    try {
      localStorage.setItem("dirty", "1");
    } catch {}
    $("#dirtybar").hidden = false;
  };

  const publish = run(async () => {
    $("#pub").disabled = true;
    $("#pub2").disabled = true;
    say("Publishing…");
    try {
      const r = await api("/publish", { method: "POST" });
      say(r.message);
      try {
        localStorage.removeItem("dirty");
      } catch {}
      $("#dirtybar").hidden = true;
    } finally {
      $("#pub").disabled = false;
      $("#pub2").disabled = false;
    }
  });

  // Binds Save and an optional Save & Publish now button so a failed save never publishes.
  const bindSavePublish = (f, saveFn) => {
    let publishAfter = false;
    f.onsubmit = run(async (e) => {
      e.preventDefault();
      unsaved = false;
      const andPub = publishAfter;
      publishAfter = false;
      await saveFn(e);
      if (andPub) await publish();
    });
    const btn = $("#savepub", f);
    if (btn)
      btn.onclick = () => {
        if (f.reportValidity && !f.reportValidity()) return;
        publishAfter = true;
        if (f.requestSubmit) f.requestSubmit();
        else f.onsubmit({ preventDefault: () => {} });
      };
  };

  async function loadCategories(force = false) {
    if (categories.length && !force) return categories;
    if (catsPromise && !force) return catsPromise;
    catsPromise = api("/content/cat")
      .then((c) => {
        categories = c;
        return categories;
      })
      .finally(() => {
        catsPromise = null;
      });
    return catsPromise;
  }

  async function ensureCatalog(force = false) {
    if (productsLoaded && !force) return;
    if (catalogPromise && !force) return catalogPromise;
    catalogPromise = Promise.all([api("/products"), api("/content/tag"), loadCategories(force)])
      .then(([p, t]) => {
        allProducts = p;
        allTags = t;
        productsLoaded = true;
      })
      .finally(() => {
        catalogPromise = null;
      });
    return catalogPromise;
  }

  // ---- Reusable form parts ----

  const pickSummary = (chosen) => {
    if (!chosen.length) return "0 chosen — click to select";
    const names = chosen.map((s) => categories.find((c) => c.slug === s)?.name || s);
    const shown = names.slice(0, 3).join(", ");
    return `${shown}${names.length > 3 ? ` +${names.length - 3} more` : ""} (${chosen.length} chosen)`;
  };

  const checkList = (name, chosen, openDefault = false) =>
    `<details class="picker"${openDefault ? " open" : ""}><summary>${esc(pickSummary(chosen))}</summary><input type="search" placeholder="Filter categories…" data-pick-filter aria-label="Filter categories"><div>
    ${categories.map((c) => `<label class="check" data-pick="${esc(c.name.toLowerCase())}"><input type="checkbox" name="${esc(name)}" value="${esc(c.slug)}" ${chosen.includes(c.slug) ? "checked" : ""}> ${esc(c.name)}</label>`).join("")}
  </div></details>`;

  document.addEventListener("input", (e) => {
    if (e.target.matches("[data-pick-filter]")) {
      const q = e.target.value.toLowerCase();
      $$("[data-pick]", e.target.parentElement).forEach((l) => {
        l.hidden = !l.dataset.pick.includes(q);
      });
    }
  });
  document.addEventListener("change", (e) => {
    const box = e.target.closest(".picker");
    if (box && e.target.type === "checkbox") {
      $("summary", box).textContent = pickSummary($$("input:checked", box).map((x) => x.value));
    }
  });

  // Images get readable names. Without a name, the file's own name is used.
  const asciiName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const upload = async (file, folder = "pages", name = "") => {
    const base = name || asciiName(file.name.replace(/\.\w+$/, ""));
    return (await api(`/image?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(base)}`, { body: file })).url;
  };

  const field = (label, name, value, extra = "", type = "text", help = "") =>
    `<label class="field"><span class="flabel">${esc(label)}</span>${help ? `<small class="fhelp">${esc(help)}</small>` : ""}<input name="${name}" type="${type}" value="${esc(value ?? "")}" ${extra}></label>`;
  const area = (label, name, value, n = 3, help = "") =>
    `<label class="field"><span class="flabel">${esc(label)}</span>${help ? `<small class="fhelp">${esc(help)}</small>` : ""}<textarea name="${name}" rows="${n}">${esc(value ?? "")}</textarea></label>`;
  const toggle = (label, name, on, help = "") =>
    `<label class="check field"><input type="checkbox" name="${name}" ${on ? "checked" : ""}><span><span class="flabel">${esc(label)}</span>${help ? `<small class="fhelp">${esc(help)}</small>` : ""}</span></label>`;
  const secHead = (title, desc, where = "", mode = "") => {
    const badge = effectBadges(mode);
    return `<div class="sec-head"><div><h2>${esc(title)}</h2>${desc ? `<p class="sec-desc">${esc(desc)}</p>` : ""}</div>${where || badge ? `<div class="sec-tags">${where ? `<span class="where-badge">Where: ${esc(where)}</span>` : ""}${badge}</div>` : ""}</div>`;
  };

  // Editable rows: delivery areas, payment methods, homepage sections and so on.
  function rows(host, items, fields, blank, opts = {}) {
    let list = items.map((x) => ({ ...x }));
    const cell = (f, it) => {
      const v = it[f.k] ?? "";
      const label = `<span class="flabel">${esc(f.label)}</span>${f.help ? `<small class="fhelp">${esc(f.help)}</small>` : ""}`;
      if (f.type === "bool")
        return `<label class="check"><input type="checkbox" data-k="${f.k}" ${v ? "checked" : ""}> <span>${esc(f.label)}</span></label>`;
      if (f.type === "select")
        return `<label>${label}<select data-k="${f.k}">${f
          .options()
          .map(([val, text]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(text)}</option>`)
          .join("")}</select></label>`;
      if (f.type === "cats") return `<label class="wide">${label}<div data-k="${f.k}" data-cats>${checkList("c", v || [])}</div></label>`;
      if (f.type === "image")
        return `<div class="wide"><span class="flabel">${esc(f.label)}</span>${f.help ? `<small class="fhelp">${esc(f.help)}</small>` : ""}<div class="img-row"><img class="img-prev" src="${esc(v)}" alt="" ${v ? "" : "hidden"}><div class="inline"><input data-k="${f.k}" value="${esc(v)}" placeholder="${esc(f.placeholder || "Upload or paste image URL")}"><label class="btn ghost small upl-inline">Upload<input type="file" accept="image/*" data-up hidden></label></div></div></div>`;
      if (f.type === "area")
        return `<label class="wide">${label}<textarea data-k="${f.k}" rows="4" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea></label>`;
      return `<label>${label}<input data-k="${f.k}" type="${f.type || "text"}" value="${esc(v)}" ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""} placeholder="${esc(f.placeholder || "")}" ${f.list ? 'list="sitelinks"' : ""}></label>`;
    };
    const read = () => {
      list = $$(".rep", host).map((row, i) => {
        const it = { ...list[i] };
        fields.forEach((f) => {
          const e = $(`[data-k="${f.k}"]`, row);
          if (f.type === "bool") it[f.k] = e.checked;
          else if (f.type === "cats") it[f.k] = $$("input[name=c]:checked", e).map((x) => x.value);
          else if (f.type === "number") it[f.k] = +e.value || 0;
          else it[f.k] = e.value;
        });
        return it;
      });
      return list;
    };
    const draw = () => {
      const body = list.length
        ? list
            .map(
              (it) => `<div class="rep">${fields.map((f) => cell(f, it)).join("")}
        <span class="repbtn"><button type="button" data-up-row aria-label="Move up" title="Move up">▲</button><button type="button" data-down aria-label="Move down" title="Move down">▼</button><button type="button" data-remove aria-label="Remove" title="Remove">✕</button></span></div>`,
            )
            .join("")
        : opts.empty
          ? `<p class="rep-empty">${esc(opts.empty)}</p>`
          : "";
      host.innerHTML = body + `<button type="button" class="btn ghost small add" data-add-row>${esc(opts.addLabel || "Add")}</button>`;
      $$("[data-up]", host).forEach((inp) => {
        inp.onchange = run(async () => {
          if (!inp.files[0]) return;
          const row = inp.closest(".img-row");
          const url = await upload(inp.files[0], "site");
          $("input[data-k]", row).value = url;
          const prev = $(".img-prev", row);
          if (prev) {
            prev.src = url;
            prev.hidden = false;
          }
          unsaved = true;
        });
      });
      $$(".img-row input[data-k]", host).forEach((textInp) => {
        textInp.addEventListener("input", () => {
          const prev = $(".img-prev", textInp.closest(".img-row"));
          if (!prev) return;
          const val = textInp.value.trim();
          prev.src = val;
          prev.hidden = !val;
        });
      });
      $$(".rep", host).forEach((row, i) => {
        const swap = (j) => {
          read();
          if (list[j]) {
            [list[i], list[j]] = [list[j], list[i]];
            draw();
            unsaved = true;
          }
        };
        $("[data-up-row]", row).onclick = () => swap(i - 1);
        $("[data-down]", row).onclick = () => swap(i + 1);
        $("[data-remove]", row).onclick = () => {
          read();
          list.splice(i, 1);
          draw();
          unsaved = true;
        };
      });
      $("[data-add-row]", host).onclick = () => {
        read();
        list.push({ ...blank });
        draw();
        unsaved = true;
      };
    };
    draw();
    return read;
  }

  // A small word-processor box, with a switch to plain HTML.
  function rich(host, html) {
    host.innerHTML = `<div class="rich"><div class="richbar">
      <button type="button" data-cmd="bold"><b>B</b></button><button type="button" data-cmd="italic"><i>I</i></button>
      <button type="button" data-block="h2">Heading</button><button type="button" data-block="p">Text</button>
      <button type="button" data-cmd="insertUnorderedList">List</button><button type="button" data-link>Link</button>
      <label class="richup">Image<input type="file" accept="image/*" hidden></label>
      <button type="button" data-html>Code view</button></div>
      <div class="richbox" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Text"></div>
      <textarea class="richsrc" rows="12" hidden aria-label="HTML"></textarea></div>`;
    const box = $(".richbox", host),
      src = $(".richsrc", host);
    box.innerHTML = html || "";
    const cmd = (c, v) => {
      box.focus();
      document.execCommand(c, false, v);
    };
    $$("[data-cmd]", host).forEach((b) => {
      b.onclick = () => cmd(b.dataset.cmd);
    });
    $$("[data-block]", host).forEach((b) => {
      b.onclick = () => cmd("formatBlock", b.dataset.block);
    });
    $("[data-link]", host).onclick = () => {
      const u = prompt("Paste the link, such as /shop/ or https://...");
      if (u) cmd("createLink", u);
    };
    $("input[type=file]", host).onchange = run(async (e) => {
      const url = await upload(e.target.files[0]);
      if (src.hidden) cmd("insertImage", url);
      else src.value += `<img src="${esc(url)}" alt="">`;
    });
    $("[data-html]", host).onclick = () => {
      if (src.hidden) src.value = box.innerHTML;
      else box.innerHTML = src.value;
      src.hidden = !src.hidden;
      box.hidden = !box.hidden;
    };
    return () => (src.hidden ? box.innerHTML : src.value);
  }

  // ---- Dashboard ----

  const dashboard = run(async () => {
    const d = await api("/dashboard");
    const top = Math.max(...d.series.map((x) => x.sales), 1);
    const tile = (label, value, link) => `<a class="tile" href="${link || "#orders"}"><b>${esc(value)}</b><span>${esc(label)}</span></a>`;
    view().innerHTML = `<div class="tiles">
      ${tile("Sales today", money(d.todaySales), "#orders/all")}${tile("Waiting for confirmation", d.pending, "#orders/pending")}${tile("Ready to ship", d.toShip, "#orders/confirmed")}${tile("New messages", d.unread, "#messages")}${tile("Pending reviews", d.reviews, "#reviews")}${tile("Sales, last 30 days", money(d.monthSales), "#orders/all")}
    </div>
    <h3 class="jobhead">Quick actions</h3>
    <div class="jobs">${JOBS.slice(0, 10)
      .map(([label, href]) => `<a href="${href}">${esc(label)}</a>`)
      .join("")}</div>
    <div class="panel"><h3>Daily sales, last 14 days</h3><div class="bars" role="img" aria-label="Daily sales for the last 14 days. Best day ${money(top)}.">
      ${d.series.map((x) => `<div class="barcol" title="${esc(x.day)}: ${money(x.sales)}, ${x.orders} orders"><span class="val">${x.sales === top && x.sales ? money(x.sales) : ""}</span><i style="height:${Math.round((x.sales / top) * 100)}%"></i><small>${esc(x.day.slice(8))}</small></div>`).join("")}
    </div></div>
    <div class="split">
      <div class="panel"><h3>Best sellers, last 30 days</h3>${d.top.length ? `<table class="tbl">${d.top.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.qty} sold</td><td>${money(t.sales)}</td></tr>`).join("")}</table>` : "<p>No sales yet.</p>"}</div>
      <div class="panel"><h3>Low stock (≤ ${lowStock} left)</h3>${d.low.length ? `<table class="tbl">${d.low.map((p) => `<tr><td><a class="link" href="#product/${p.id}">${esc(p.name)}</a></td><td><b>${p.stock}</b> left</td></tr>`).join("")}</table>` : "<p>Everything is well stocked.</p>"}</div>
    </div>`;
  });

  // ---- Orders ----

  const orderFilter = { q: "", status: "", from: "", to: "", page: 0 };
  const query = () => new URLSearchParams(Object.entries(orderFilter).filter(([, v]) => v !== "" && v !== 0)).toString();

  const orders = run(async (statusArg) => {
    if (statusArg === "all") {
      orderFilter.status = "";
      orderFilter.q = "";
      orderFilter.page = 0;
    } else if (statusArg && STATUSES.includes(statusArg)) {
      orderFilter.status = statusArg;
      orderFilter.q = "";
      orderFilter.page = 0;
    }
    const pills = [["", "All"], ...STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)])];
    view().innerHTML = `<div class="qfilters">${pills.map(([v, lbl]) => `<button type="button" class="qpill ${orderFilter.status === v ? "on" : ""}" data-fst="${v}">${lbl}</button>`).join("")}</div>
      <div class="toolbar">
      <input id="oq" type="search" placeholder="Search order #, phone, name or address" value="${esc(orderFilter.q)}" aria-label="Search orders">
      <select id="ost" aria-label="Status"><option value="">All statuses</option>${statusOptions(orderFilter.status)}</select>
      <label class="check">From <input id="ofrom" type="date" value="${esc(orderFilter.from)}"></label><label class="check">To <input id="oto" type="date" value="${esc(orderFilter.to)}"></label>
      <button class="btn ghost" id="csv">Download Excel CSV</button></div><div id="olist"><p>Loading…</p></div>`;
    const reload = () => {
      orderFilter.page = 0;
      drawOrders();
    };
    const syncPills = () => {
      $$("[data-fst]").forEach((b) => b.classList.toggle("on", b.dataset.fst === orderFilter.status));
    };
    $$("[data-fst]").forEach((b) => {
      b.onclick = () => {
        orderFilter.status = b.dataset.fst;
        $("#ost").value = orderFilter.status;
        syncPills();
        reload();
      };
    });
    let t;
    $("#oq").oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => {
        orderFilter.q = e.target.value;
        reload();
      }, 300);
    };
    $("#ost").onchange = (e) => {
      orderFilter.status = e.target.value;
      syncPills();
      reload();
    };
    $("#ofrom").onchange = (e) => {
      orderFilter.from = e.target.value;
      reload();
    };
    $("#oto").onchange = (e) => {
      orderFilter.to = e.target.value;
      reload();
    };
    $("#csv").onclick = run(async () => {
      const r = await api("/orders.csv?" + query(), { raw: true });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await r.blob());
      a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    await drawOrders();
  });

  const drawOrders = run(async () => {
    const res = await api("/orders?" + query());
    const l = res.orders;
    const pages = Math.ceil(res.total / res.size);
    const quickBtn = (o) => {
      if (o.status === "pending") return `<button type="button" class="link primary-act" data-step="confirmed" data-num="${esc(o.number)}">✓ Confirm</button> `;
      if (o.status === "shipped") return `<button type="button" class="link primary-act" data-step="delivered" data-num="${esc(o.number)}">✓ Delivered</button> `;
      return "";
    };
    $("#olist").innerHTML = `<p><b>${res.total}</b> orders · <b>${money(res.sales)}</b> sales, excluding cancelled and returned</p>
    <div class="scroll"><table class="tbl"><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th></th></tr>
    ${
      l
        .map(
          (o) => `<tr>
      <td class="nowrap"><b>${esc(o.number)}</b><br><small>${esc(when(o.created_at))}</small></td>
      <td>${esc(o.name)} ${o.same_phone > 1 ? `<a class="tag" href="#orders" data-phone="${esc(o.phone)}">${o.same_phone} orders</a>` : ""}${o.bad_phone > 0 ? ` <span class="tag warn">${o.bad_phone} cancelled or returned</span>` : ""}<br><a class="link" href="tel:${esc(o.phone)}">${esc(o.phone)}</a>${o.email ? `<br><a class="link" href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : ""}<br>${esc(o.address)} (${esc(o.area)})${o.note ? `<br><i>${esc(o.note)}</i>` : ""}</td>
      <td>${(o.items || []).map((i) => `${esc(i.name)} × ${i.qty}`).join("<br>")}</td>
      <td>${money(o.total)}${o.discount ? `<br><small>${money(o.discount)} off, ${esc(o.coupon)}</small>` : ""}</td>
      <td>${esc(o.payment)}<br><small>${esc(o.txn_id)}</small></td>
      <td><select class="status" data-st="${esc(o.status)}" data-o="${esc(o.number)}" aria-label="Status of ${esc(o.number)}">${statusOptions(o.status)}</select></td>
      <td class="actions">${quickBtn(o)}${o.status === "confirmed" ? `<button type="button" class="link primary-act" data-more="${esc(o.number)}" data-ship-focus>📦 Ship / Track</button>` : `<button type="button" class="link" data-more="${esc(o.number)}">Details</button>`} <button type="button" class="link" data-print="${esc(o.number)}">Invoice</button></td>
    </tr>
    <tr id="d-${esc(o.number)}" hidden><td colspan="7"><form class="inlineform" data-n="${esc(o.number)}">
      ${field("Courier", "courier", o.courier, "", "text", "Shown on /track/.")}
      ${field("Tracking number", "tracking", o.tracking, "", "text", "Shown on /track/.")}
      ${field("Private note", "adminNote", o.admin_note, "", "text", "Staff only.")}
      <button class="btn">Save details</button>${o.status === "cancelled" || o.status === "returned" ? "" : ` <button type="button" class="btn pub-now" data-ship="${esc(o.number)}">Save & Mark Shipped</button>`} <button type="button" class="btn ghost small" data-copy="${esc(o.number)}">Copy address</button></form></td></tr>`,
        )
        .join("") || `<tr><td colspan="7">No orders match.</td></tr>`
    }</table></div>
    ${pages > 1 ? `<div class="pager"><button class="btn ghost" id="prev" ${orderFilter.page ? "" : "disabled"}>Previous</button> Page ${orderFilter.page + 1} of ${pages} <button class="btn ghost" id="next" ${orderFilter.page + 1 < pages ? "" : "disabled"}>Next</button></div>` : ""}`;
    if ($("#prev")) {
      $("#prev").onclick = () => {
        orderFilter.page--;
        drawOrders();
      };
      $("#next").onclick = () => {
        orderFilter.page++;
        drawOrders();
      };
    }
    $$("[data-phone]").forEach((a) => {
      a.onclick = () => {
        orderFilter.q = a.dataset.phone;
        orderFilter.status = "";
        orderFilter.page = 0;
        orders();
      };
    });
    $$("[data-step]").forEach((b) => {
      b.onclick = run(async () => {
        await api("/orders/" + encodeURIComponent(b.dataset.num), { method: "PUT", body: { status: b.dataset.step } });
        say(`${b.dataset.num} is now ${b.dataset.step}.`);
        counts();
        await drawOrders();
      });
    });
    $$("[data-o]").forEach((s) => {
      s.onchange = run(async () => {
        const previous = l.find((o) => o.number === s.dataset.o).status;
        if (
          (s.value === "cancelled" || s.value === "returned") &&
          !confirm(`Mark ${s.dataset.o} as ${s.value}? The stock goes back on sale.`)
        ) {
          s.value = previous;
          return;
        }
        try {
          await api("/orders/" + encodeURIComponent(s.dataset.o), { method: "PUT", body: { status: s.value } });
          say(`${s.dataset.o} is now ${s.value}.`);
          counts();
        } finally {
          await drawOrders();
        }
      });
    });
    $$("[data-more]").forEach((b) => {
      b.onclick = () => {
        const r = $(`[id="d-${b.dataset.more}"]`);
        r.hidden = !r.hidden;
        if (!r.hidden && b.hasAttribute("data-ship-focus")) $('[name="courier"]', r)?.focus();
      };
    });
    $$("form[data-n]").forEach((f) => {
      f.onsubmit = run(async (e) => {
        e.preventDefault();
        await api("/orders/" + encodeURIComponent(f.dataset.n), { method: "PUT", body: Object.fromEntries(new FormData(f)) });
        say("Order updated.");
        await drawOrders();
      });
    });
    $$("[data-ship]").forEach((b) => {
      b.onclick = run(async () => {
        const f = b.closest("form");
        await api("/orders/" + encodeURIComponent(f.dataset.n), {
          method: "PUT",
          body: { ...Object.fromEntries(new FormData(f)), status: "shipped" },
        });
        say(`${f.dataset.n} marked shipped.`);
        counts();
        await drawOrders();
      });
    });
    $$("[data-copy]").forEach((b) => {
      b.onclick = async () => {
        const o = l.find((x) => x.number === b.dataset.copy);
        if (!o) return;
        const text = `${o.name}\n${o.phone}\n${o.address} (${o.area})`;
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
          say(`Address copied for ${o.number}.`);
        } catch {
          prompt("Copy customer address:", text);
        }
      };
    });
    $$("[data-print]").forEach((b) => {
      b.onclick = () => invoice(l.find((x) => x.number === b.dataset.print));
    });
  });

  function invoice(o) {
    const s = site || {},
      w = window.open("");
    if (!w) return say("Your browser blocked the invoice window. Please allow pop-ups for this page.");
    w.document
      .write(`<!doctype html><title>Invoice ${esc(o.number)}</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:640px;margin:32px auto;color:#111}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border:1px solid #bbb;padding:8px;text-align:left}td:last-child,th:last-child{text-align:right}</style>
      <h2>${esc(s.name || "Invoice")}</h2><p>${esc(s.phone)}${s.address ? `<br>${esc(s.address)}` : ""}</p>
      <p><b>Invoice ${esc(o.number)}</b><br>${esc(when(o.created_at))}</p>
      <p><b>${esc(o.name)}</b>, ${esc(o.phone)}${o.email ? `, ${esc(o.email)}` : ""}<br>${esc(o.address)} (${esc(o.area)})</p>
      <table><tr><th>Item</th><th>Qty</th><th>Amount</th></tr>${(o.items || []).map((i) => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${money(i.price * i.qty)}</td></tr>`).join("")}
      ${o.discount ? `<tr><td colspan=2>Discount (${esc(o.coupon)})</td><td>−${money(o.discount)}</td></tr>` : ""}
      <tr><td colspan=2>Delivery charge</td><td>${o.shipping ? money(o.shipping) : "Free"}</td></tr><tr><td colspan=2><b>Total</b></td><td><b>${money(o.total)}</b></td></tr></table>
      <p>Payment: ${esc(o.payment)} ${esc(o.txn_id)}</p>
      <p style="text-align:center;margin-top:32px"><b>Thanks for shopping from ${esc(s.name || "LoverBaazar")}!</b><br>We hope to see you again soon.${s.phone ? ` Questions? Call ${esc(s.phone)}.` : ""}</p>`);
    w.document.close();
    w.print();
  }

  // ---- Products ----

  const productFilter = { q: "", cat: "", show: "", limit: 50 };

  const products = run(async () => {
    await ensureCatalog();
    view().innerHTML = `<div class="toolbar"><button class="btn" id="new">Add product</button>
      <input id="pq" type="search" placeholder="Search name or SKU" value="${esc(productFilter.q)}" aria-label="Search products">
      <select id="pcat" aria-label="Category"><option value="">All categories</option>${categories.map((c) => `<option value="${esc(c.slug)}" ${c.slug === productFilter.cat ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <select id="pshow" aria-label="Show"><option value="">All products</option><option value="low">Low stock</option><option value="out">Sold out</option><option value="hidden">Hidden</option></select></div>
      <div class="scroll"><table class="tbl"><tr><th></th><th>Product</th><th>Price</th><th>Old price</th><th>Stock</th><th>Visible</th><th></th></tr><tbody id="rows"></tbody></table></div><button class="btn ghost more" id="pmore" hidden>Show more</button>`;
    $("#pshow").value = productFilter.show;
    $("#new").onclick = () =>
      editProduct({ cats: [], images: [], attrs: [], active: true, price: 0, regular: 0, stock: 0, name: "", slug: "" }, true);
    const on = (id, key) => {
      $(id).oninput = (e) => {
        productFilter[key] = e.target.value;
        productFilter.limit = 50;
        drawProducts();
      };
    };
    on("#pq", "q");
    on("#pcat", "cat");
    on("#pshow", "show");
    $("#pmore").onclick = () => {
      productFilter.limit += 50;
      drawProducts();
    };
    drawProducts();
  });

  function drawProducts() {
    const { q, cat, show, limit } = productFilter;
    const text = q.toLowerCase();
    const low = lowStock;
    const l = allProducts.filter(
      (p) =>
        (p.name + " " + (p.sku || "")).toLowerCase().includes(text) &&
        (!cat || (p.cats || []).includes(cat)) &&
        (!show ||
          (show === "low" && p.stock > 0 && p.stock <= low) ||
          (show === "out" && p.stock === 0) ||
          (show === "hidden" && !p.active)),
    );
    $("#rows").innerHTML =
      l
        .slice(0, limit)
        .map(
          (p) => `<tr data-id="${p.id}" class="${p.active ? "" : "off"}">
      <td>${p.images?.[0] ? `<img class="mini" src="${esc(p.images[0].thumb || p.images[0].src)}" alt="" loading="lazy" decoding="async" width="44" height="44">` : ""}</td>
      <td><button type="button" class="link prod-title" data-e="${p.id}">${esc(p.name)}</button></td>
      <td data-l="Price"><input class="num" type="number" min="0" data-q="price" value="${p.price}" aria-label="Price of ${esc(p.name)}"></td>
      <td data-l="Old price"><input class="num" type="number" min="0" data-q="regular" value="${p.regular}" aria-label="Old price of ${esc(p.name)}"></td>
      <td data-l="Stock"><input class="num" type="number" min="0" data-q="stock" value="${p.stock}" aria-label="Stock of ${esc(p.name)}"></td>
      <td data-l="Visible"><input type="checkbox" data-q="active" ${p.active ? "checked" : ""} aria-label="${esc(p.name)} visible in shop"></td>
      <td class="actions"><button class="link" data-e="${p.id}">Edit</button> <button class="link" data-dup="${p.id}">Copy</button> <a class="link" href="/product/${esc(p.slug)}/" target="_blank" rel="noopener">View</a></td></tr>`,
        )
        .join("") || `<tr><td colspan="7">No products match.</td></tr>`;
    $("#pmore").hidden = l.length <= limit;
    const find = (id) => allProducts.find((p) => p.id === +id);
    $$("[data-e]").forEach((b) => {
      b.onclick = () => editProduct(find(b.dataset.e));
    });
    $$("[data-dup]").forEach((b) => {
      b.onclick = () => {
        const p = find(b.dataset.dup);
        editProduct({ ...p, id: undefined, stock: 0, name: p.name + " copy", slug: p.slug + "-copy", sku: "" }, true);
      };
    });
    $$("[data-q]").forEach((i) => {
      i.onchange = run(async () => {
        const row = i.closest("tr"),
          p = find(row.dataset.id),
          key = i.dataset.q,
          body = {};
        if (key === "stock")
          body.stockDelta = (+i.value || 0) - p.stock; // never an absolute number: orders may have come in
        else if (key === "active") body.active = i.checked;
        else body[key] = Math.max(0, Math.floor(+i.value) || 0);
        const r = await api("/products/" + p.id, { method: "PATCH", body });
        if (key === "stock") {
          p.stock = r.stock;
          i.value = r.stock;
        } else if (key === "active") {
          p.active = i.checked;
          row.classList.toggle("off", !p.active);
        } else p[key] = body[key];
        i.classList.add("saved");
        setTimeout(() => i.classList.remove("saved"), 1500);
        say(key === "active" ? `${p.name} is ${p.active ? "visible" : "hidden"}.` : `${p.name} saved. Live within about 2 minutes.`);
      });
    });
  }

  function editProduct(p, isNew) {
    say("");
    let images = (p.images || []).map((i) => ({ ...i }));
    view().innerHTML = `<form class="panel editor" id="pf">
      ${secHead(isNew ? "Add product" : "Edit product", "Fill in product details below. Price, stock and visibility update live; name, photos, categories and text require Publish.", isNew ? "Shop & new /product/<slug>/ page" : `/product/${p.slug}/`, "both")}
      ${field("Product name", "name", p.name, "required maxlength=200", "text", "Shown on product cards, search results, cart, and customer invoices. (Needs Publish)")}
      <details class="advanced"><summary>Web address: /product/<span id="slugview">${esc(p.slug) || "made-from-the-name"}</span>/</summary>
        ${field("Web address (URL slug)", "slug", p.slug, `required pattern="[^\\s\\/?#.]+"`, "text", isNew ? "Automatically filled from the product name." : "Changing an existing web address breaks old links to this product.")}
      </details>
      <div class="fields3">
        ${field("Selling price (৳)", "price", p.price, "required min=0 step=1", "number", "Actual checkout price. Live in ~2 min.")}
        ${field("Old price (৳)", "regular", p.regular, "min=0 step=1", "number", "Crossed out to show % off & list on /offers/. 0 for none.")}
        ${field("Stock quantity", "stock", p.stock, "required min=0 step=1", "number", "0 marks the item as Sold out. Live in ~2 min.")}
      </div>
      ${field("Product code (SKU)", "sku", p.sku, "", "text", "Optional product code shown on the product page and searchable.")}
      ${field("Short description", "short", p.short, "maxlength=300", "text", "Shown right beside the main photo and used as the Google search snippet.")}
      <div class="field"><span class="flabel">Categories</span><small class="fhelp">Choose which category pages and home page rows include this product. (Needs Publish)</small><div id="pcatpick">${checkList("cat", p.cats || [], true)}</div><div class="inline-cats"><input id="quickcat" placeholder="Need a new category? Type name…" aria-label="New category name"><button type="button" class="btn ghost small" id="addquickcat">+ Add category</button></div></div>
      <div class="field"><span class="flabel">Product photos</span><small class="fhelp">The first photo is the main thumbnail on product cards. Use ◀ / ▶ to reorder. (Needs Publish)</small><div id="imgs" class="imgs"></div>
        <label class="btn ghost small upl">Upload photos<input id="up" type="file" accept="image/*" multiple hidden></label>
        <input id="imgurl" placeholder="Or paste an image address and press Enter" aria-label="Image address"></div>
      <div class="field"><span class="flabel">Specifications</span><small class="fhelp">Optional key details shown under Buy buttons, such as Colour, Capacity, or Warranty.</small><div id="attrs"></div></div>
      <label class="field"><span class="flabel">Search tags (comma-separated)</span><small class="fhelp">Extra keywords for search engines and /product-tag/ pages.</small><input name="tagnames" value="${esc((p.tags || []).map((t) => allTags.find((x) => x.slug === t)?.name || t).join(", "))}"></label>
      <div class="field"><span class="flabel">Full description</span><small class="fhelp">Detailed features and product info shown below the main section. (Needs Publish)</small><div id="desc"></div></div>
      ${toggle("Visible in shop", "active", p.active, "Turn off to hide this product from customers without deleting it. (Live in ~2 min)")}
      <div class="stick"><button class="btn">Save product</button> <button type="button" class="btn pub-now" id="savepub">Save &amp; Publish now</button> <button type="button" class="btn ghost" id="back">Back</button>${isNew ? "" : ` <button type="button" class="link danger" id="del">Delete product</button>`}<span class="stick-hint">Price, stock & visibility go live in ~2 min. Other edits need Publish.</span></div></form>`;
    const f = $("#pf");
    const addQuickCat = run(async () => {
      const inp = $("#quickcat");
      const name = inp.value.trim();
      if (!name) return inp.focus();
      const slug = slugify(name);
      if (!slug) throw new Error("Please enter a valid category name.");
      const cur = $$('input[name="cat"]:checked', $("#pcatpick")).map((x) => x.value);
      if (!categories.some((c) => c.slug === slug)) {
        await api("/content/cat/" + encodeURIComponent(slug), { method: "PUT", body: { name, path: slug } });
        await loadCategories(true);
      }
      if (!cur.includes(slug)) cur.push(slug);
      $("#pcatpick").innerHTML = checkList("cat", cur, true);
      inp.value = "";
      unsaved = true;
      needsPublish(`Category "${name}" added and selected.`);
    });
    $("#addquickcat").onclick = addQuickCat;
    $("#quickcat").onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      addQuickCat();
    };
    if (!isNew)
      $("#del").onclick = run(async () => {
        if (!confirm(`Delete ${p.name}? This can't be undone. If it has been ordered before, it will be hidden instead.`)) return;
        const r = await api("/products/" + p.id, { method: "DELETE" });
        unsaved = false;
        await ensureCatalog(true);
        await products();
        needsPublish(r.deleted ? "Product deleted." : "This product has old orders, so it was hidden instead of deleted.");
      });
    const drawImages = () => {
      $("#imgs").innerHTML = images
        .map(
          (
            im,
            i,
          ) => `<figure><img src="${esc(im.thumb || im.src)}" alt="" width="96" height="96"><input value="${esc(im.alt || "")}" placeholder="Describe photo" data-alt="${i}" aria-label="Photo description">
        <figcaption><button type="button" data-l="${i}" aria-label="Move left">◀</button><button type="button" data-r="${i}" aria-label="Move right">▶</button><button type="button" data-x="${i}" aria-label="Remove photo">✕</button></figcaption></figure>`,
        )
        .join("");
      const swap = (a, b) => {
        if (images[b]) {
          [images[a], images[b]] = [images[b], images[a]];
          drawImages();
          unsaved = true;
        }
      };
      $$("[data-alt]").forEach((b) => {
        b.oninput = () => {
          images[+b.dataset.alt].alt = b.value;
        };
      });
      $$("[data-l]").forEach((b) => {
        b.onclick = () => swap(+b.dataset.l, +b.dataset.l - 1);
      });
      $$("[data-r]").forEach((b) => {
        b.onclick = () => swap(+b.dataset.r, +b.dataset.r + 1);
      });
      $$("[data-x]").forEach((b) => {
        b.onclick = () => {
          images.splice(+b.dataset.x, 1);
          drawImages();
          unsaved = true;
        };
      });
    };
    drawImages();
    const addImage = (src) => {
      images.push({ src, thumb: src.replace("/upload/f_auto,q_auto/", "/upload/f_auto,q_auto,w_300/"), alt: "" });
      drawImages();
      unsaved = true;
    };
    $("#up").onchange = run(async (e) => {
      say("Uploading…");
      const cat = (new FormData(f).getAll("cat").find((c) => !["latest-product", "popular-item"].includes(c)) || "other").replace(/[^a-z0-9-]/g, "");
      const stem = asciiName(f.slug.value) || "product";
      // Numbers carry on from existing photos: reusing one would overwrite that photo on Cloudinary.
      const taken = images.map((i) => +(i.src.match(new RegExp(`${stem}-(\\d+)(?:\\.|$)`))?.[1] || 0));
      let n = Math.max(0, ...taken);
      for (const file of e.target.files) addImage(await upload(file, `products/${cat}`, `${stem}-${++n}`));
      say("");
      e.target.value = "";
    });
    $("#imgurl").onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (e.target.value.trim()) addImage(e.target.value.trim());
      e.target.value = "";
    };
    const attrs = rows(
      $("#attrs"),
      (p.attrs || []).map((a) => ({ name: a.name, values: (a.values || []).join(", ") })),
      [
        { k: "name", label: "Specification name", placeholder: "e.g. Colour or Capacity" },
        { k: "values", label: "Values (comma-separated)", placeholder: "e.g. Red, Silver" },
      ],
      { name: "", values: "" },
      { addLabel: "+ Add specification", empty: "No specifications added yet (optional)." },
    );
    const desc = rich($("#desc"), p.desc);
    const nameEl = $('[name="name"]', f);
    nameEl.addEventListener("input", () => {
      if (isNew) {
        f.slug.value = slugify(nameEl.value);
        $("#slugview").textContent = f.slug.value;
      }
    });
    f.slug.addEventListener("input", () => {
      $("#slugview").textContent = f.slug.value;
    });
    $("#back").onclick = back(products);
    bindSavePublish(f, async () => {
      const d = new FormData(f);
      const tagNames = d
        .get("tagnames")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const tagSlugs = [];
      for (const name of tagNames) {
        const known = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
        if (!known) await api("/content/tag/" + encodeURIComponent(slugify(name)), { method: "PUT", body: { name } });
        tagSlugs.push(known?.slug || slugify(name));
      }
      const out = {
        ...p,
        tags: tagSlugs,
        name: d.get("name").trim(),
        slug: d.get("slug").trim(),
        price: +d.get("price"),
        regular: +d.get("regular"),
        sku: d.get("sku").trim(),
        short: d.get("short").trim(),
        desc: desc(),
        active: !!d.get("active"),
        cats: d.getAll("cat"),
        images,
        attrs: attrs()
          .filter((a) => a.name.trim())
          .map((a) => ({
            name: a.name.trim(),
            values: a.values
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          })),
      };
      if (isNew) {
        out.stock = +d.get("stock");
        await api("/products", { body: out });
      } else {
        delete out.stock;
        out.stockDelta = +d.get("stock") - p.stock; // never an absolute number: orders may have come in since this form opened
        await api("/products/" + p.id, { method: "PUT", body: out });
      }
      await ensureCatalog(true);
      await products();
      needsPublish("Product saved. Price, stock and visibility are live; click Publish changes for name, photo or text edits.");
    });
  }

  // ---- Categories ----

  const cats = run(async () => {
    await loadCategories();
    view().innerHTML = `<form class="panel inline-form" id="quickcatform">
        ${secHead("Quick add category", "Add a category in one step. Need a custom URL? Use Full category form.", "Category pages & Navigation menu", "pub")}
        <div class="fields2">
          ${field("Category name", "name", "", `required placeholder="e.g. Air Fryers"`, "text", "Creates /product-category/<slug>/ automatically.")}
          <label class="field"><span class="flabel">Parent category (optional)</span><small class="fhelp">Nest under an existing category, or leave top-level.</small><select name="parent"><option value="">Top-level (no parent)</option>${categories.map((x) => `<option value="${esc(x.path)}">${esc(x.path)}</option>`).join("")}</select></label>
        </div>
        <div class="inline-actions">
          <button class="btn">Add category</button>
          <button type="button" class="btn pub-now" id="savepub">Add &amp; Publish now</button>
          <button type="button" class="btn ghost" id="newcat">Full category form…</button>
        </div>
      </form>
      <p class="meta">Categories appear at /product-category/&lt;address&gt;/. To show categories in the top menu and home page grid, open <a class="link" href="#menu">Website → Navigation menu</a>. To add a product row on the home page, open <a class="link" href="#home">Website → Home page</a>.</p>
      <div class="scroll"><table class="tbl"><tr><th>Name</th><th>Address</th><th></th></tr>
      ${categories.map((c) => `<tr><td>${esc(c.name)}</td><td><small>/product-category/${esc(c.path)}/</small></td><td class="actions"><button class="link" data-e="${esc(c.slug)}">Edit</button> <button class="link" data-x="${esc(c.slug)}">Delete</button></td></tr>`).join("")}</table></div>`;
    const qf = $("#quickcatform");
    bindSavePublish(qf, async () => {
      const name = $('[name="name"]', qf).value.trim();
      const slug = slugify(name);
      if (!slug) throw Error("Enter a valid category name.");
      const parent = qf.parent.value;
      await api("/content/cat/" + encodeURIComponent(slug), {
        method: "PUT",
        body: { name, slug, path: parent ? `${parent}/${slug}` : slug },
      });
      await loadCategories(true);
      await cats();
      needsPublish(`Category "${name}" saved.`);
    });
    $("#newcat").onclick = () => editCat({ name: "", slug: "" }, true);
    $$("[data-e]").forEach((b) => {
      b.onclick = () => editCat(categories.find((c) => c.slug === b.dataset.e));
    });
    $$("[data-x]").forEach((b) => {
      b.onclick = run(async () => {
        if (!confirm("Delete this category? Its web address will stop working after Publish.")) return;
        await api("/content/cat/" + encodeURIComponent(b.dataset.x), { method: "DELETE" });
        await loadCategories(true);
        await cats();
        needsPublish("Category deleted.");
      });
    });
  });

  function editCat(c, isNew) {
    say("");
    const parentPath = isNew ? "" : (c.path || "").split("/").slice(0, -1).join("/");
    view().innerHTML = `<form class="panel editor" id="cf">
      ${secHead(isNew ? "Add category" : "Edit category", "Categories organize products on your storefront and in Google search.", "Category pages & Navigation menu", "pub")}
      ${field("Category name", "name", c.name, "required", "text", "Display name shown in menus, breadcrumbs, and category headings.")}
      ${
        isNew
          ? field("Web address (URL slug)", "slug", "", "required", "text", "Filled automatically from the name. Cannot be changed later.") +
            `<label class="field"><span class="flabel">Parent category (optional)</span><small class="fhelp">Nests this category's URL under an existing category.</small><select name="parent"><option value="">None (top-level category)</option>${categories.map((x) => `<option value="${esc(x.path)}">${esc(x.path)}</option>`).join("")}</select></label>`
          : `<p class="meta"><b>Web address:</b> /product-category/${esc(c.path)}/</p>`
      }
      <div class="stick"><button class="btn">Save category</button> <button type="button" class="btn pub-now" id="savepub">Save &amp; Publish now</button> <button type="button" class="btn ghost" id="back">Back</button></div></form>`;
    const f = $("#cf");
    const nameEl = $('[name="name"]', f);
    if (isNew)
      nameEl.addEventListener("input", () => {
        f.slug.value = slugify(nameEl.value);
      });
    $("#back").onclick = back(cats);
    bindSavePublish(f, async () => {
      const slug = isNew ? f.slug.value.trim() : c.slug;
      const parent = isNew ? f.parent.value : parentPath;
      await api("/content/cat/" + encodeURIComponent(slug), {
        method: "PUT",
        body: { ...c, name: nameEl.value.trim(), path: parent ? `${parent}/${slug}` : slug },
      });
      await loadCategories(true);
      await cats();
      needsPublish("Category saved.");
    });
  }

  // ---- Coupons ----

  const coupons = run(async () => {
    const l = await api("/coupons");
    view().innerHTML = `<form class="panel coupon-form" id="cpf">
      ${secHead("Create or edit a coupon", "Enter an existing code to update it, or type a new code. Customers apply coupons on the Checkout page.", "Checkout page", "live")}
      <div class="fields3">
        ${field("Coupon code", "code", "", "required pattern=[A-Za-z0-9_\\-]{2,40} placeholder='EID10'", "text", "2–40 letters, numbers, - or _. Saved in uppercase.")}
        <label class="field"><span class="flabel">Discount type</span><small class="fhelp">Percentage or fixed Taka amount off.</small><select name="kind"><option value="percent">Percent off (%)</option><option value="amount">Flat Taka off (৳)</option></select></label>
        ${field("Discount value", "value", "", "required min=1 placeholder='10'", "number", "Enter 1–100 for %, or Taka amount.")}
      </div>
      <div class="fields3">
        ${field("Minimum order (৳)", "minOrder", 0, "min=0", "number", "Minimum cart subtotal required. 0 for none.")}
        ${field("Total use limit", "maxUses", 0, "min=0", "number", "Max total redemptions allowed. 0 for unlimited.")}
        ${field("Expiry date (optional)", "expires", "", "", "date", "Ends at 11:59 PM on this day (BD time).")}
      </div>
      ${toggle("Active", "active", true, "Uncheck to pause this coupon without deleting it.")}
      <div class="inline-actions"><button class="btn">Save coupon</button> <button type="button" class="btn ghost" id="cpclear" hidden>Cancel edit</button></div></form>
      <div class="scroll"><table class="tbl"><tr><th>Code</th><th>Discount</th><th>Minimum order</th><th>Used</th><th>Expires</th><th>Active</th><th></th></tr>
      ${
        l
          .map(
            (
              c,
            ) => `<tr class="${c.active ? "" : "off"}"><td><b>${esc(c.code)}</b>${c.active ? "" : ` <span class="tag">Paused</span>`}</td><td>${c.kind === "percent" ? c.value + "%" : money(c.value)}</td><td>${money(c.min_order)}</td><td>${c.used}${c.max_uses ? ` of ${c.max_uses}` : ""}</td><td>${c.expires_at ? esc(c.expires_at.slice(0, 10)) : "No expiry"}</td>
        <td><input type="checkbox" data-toggle-cp="${esc(c.code)}" ${c.active ? "checked" : ""} aria-label="Active ${esc(c.code)}"></td>
        <td class="actions"><button class="link" data-e="${esc(c.code)}">Edit</button> <button class="link" data-x="${esc(c.code)}">Delete</button></td></tr>`,
          )
          .join("") || `<tr><td colspan="7">No coupons yet.</td></tr>`
      }</table></div>`;
    const f = $("#cpf");
    $("#cpclear").onclick = () => {
      f.reset();
      f.active.checked = true;
      $("#cpclear").hidden = true;
      unsaved = false;
    };
    f.onsubmit = run(async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      await api("/coupons/" + encodeURIComponent(d.code.trim()), {
        method: "PUT",
        body: { kind: d.kind, value: +d.value, minOrder: +d.minOrder, maxUses: +d.maxUses, expires: d.expires, active: !!d.active },
      });
      await coupons();
      say("Coupon saved. It works straight away at checkout.");
    });
    $$("[data-toggle-cp]").forEach((box) => {
      box.onchange = run(async () => {
        const c = l.find((x) => x.code === box.dataset.toggleCp);
        if (!c) return;
        await api("/coupons/" + encodeURIComponent(c.code), {
          method: "PUT",
          body: {
            kind: c.kind,
            value: c.value,
            minOrder: c.min_order,
            maxUses: c.max_uses,
            expires: c.expires_at ? c.expires_at.slice(0, 10) : "",
            active: box.checked,
          },
        });
        await coupons();
        say(`Coupon ${c.code} ${box.checked ? "activated" : "paused"}.`);
      });
    });
    $$("[data-e]").forEach((b) => {
      b.onclick = () => {
        const c = l.find((x) => x.code === b.dataset.e);
        f.code.value = c.code;
        f.kind.value = c.kind;
        f.value.value = c.value;
        f.minOrder.value = c.min_order;
        f.maxUses.value = c.max_uses;
        f.expires.value = c.expires_at ? c.expires_at.slice(0, 10) : "";
        f.active.checked = c.active;
        $("#cpclear").hidden = false;
        scrollTo(0, 0);
      };
    });
    $$("[data-x]").forEach((b) => {
      b.onclick = run(async () => {
        if (!confirm(`Delete coupon ${b.dataset.x}?`)) return;
        await api("/coupons/" + encodeURIComponent(b.dataset.x), { method: "DELETE" });
        await coupons();
      });
    });
  });

  // ---- Customers ----

  const customers = run(async () => {
    view().innerHTML = `<div class="toolbar"><input id="cq" type="search" placeholder="Search by name or phone number" aria-label="Search customers"></div>
      <form class="panel inlineform" id="reset">${field("Customer forgot their password? Enter their mobile number", "phone", "", "required inputmode=tel placeholder='01XXXXXXXXX'")}<button class="btn ghost">Set a new password</button></form>
      <p class="note" id="newpass" hidden></p><div id="clist"><p>Loading…</p></div>`;
    const draw = run(async () => {
      const l = await api("/customers?q=" + encodeURIComponent($("#cq").value));
      $("#clist").innerHTML =
        `<div class="scroll"><table class="tbl"><tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Cancelled or returned</th><th>Spent</th><th>Last order</th></tr>
        ${l.map((c) => `<tr><td>${esc(c.name)}</td><td><a class="link" href="tel:${esc(c.phone)}">${esc(c.phone)}</a></td><td><a class="link" href="#orders" data-phone="${esc(c.phone)}">${c.orders}</a></td><td>${c.cancelled}</td><td>${money(c.spent)}</td><td>${esc(when(c.last))}</td></tr>`).join("") || `<tr><td colspan="6">No customers yet.</td></tr>`}</table></div>`;
      $$("[data-phone]", $("#clist")).forEach((a) => {
        a.onclick = () => {
          orderFilter.q = a.dataset.phone;
          orderFilter.status = "";
        };
      });
    });
    let t;
    $("#cq").oninput = () => {
      clearTimeout(t);
      t = setTimeout(draw, 300);
    };
    $("#reset").onsubmit = run(async (e) => {
      e.preventDefault();
      if (!confirm("Set a new password? Their current password and logins stop working.")) return;
      const r = await api("/customers/password", { body: { phone: e.target.phone.value } });
      $("#newpass").textContent = `New password: ${r.password}. Read it to the customer, and ask them to change it from My account.`;
      $("#newpass").hidden = false;
      e.target.reset();
    });
    await draw();
  });

  // ---- Reviews and messages ----

  const reviews = run(async () => {
    const l = await api("/reviews");
    view().innerHTML =
      l
        .map(
          (
            r,
          ) => `<div class="panel item"><b>${esc(r.name)}</b> ${"★".repeat(r.rating)} on <a class="link" href="/product/${esc(r.slug)}/" target="_blank" rel="noopener">${esc(r.product)}</a> ${r.approved ? "" : `<span class="tag">Waiting</span>`}<p>${esc(r.body)}</p>
      ${r.approved ? "" : `<button class="btn" data-a="${r.id}">Approve</button> <button type="button" class="btn pub-now" data-ap="${r.id}">Approve &amp; Publish</button> `}<button class="btn ghost" data-x="${r.id}">Delete</button></div>`,
        )
        .join("") || "<p>No reviews yet.</p>";
    $$("[data-a]").forEach((b) => {
      b.onclick = run(async () => {
        await api("/reviews/" + b.dataset.a, { method: "PUT", body: {} });
        await reviews();
        counts();
        needsPublish("Review approved. Click Publish changes to show it on the product page.");
      });
    });
    $$("[data-ap]").forEach((b) => {
      b.onclick = run(async () => {
        await api("/reviews/" + b.dataset.ap, { method: "PUT", body: {} });
        await reviews();
        counts();
        await publish();
      });
    });
    $$("[data-x]").forEach((b) => {
      b.onclick = run(async () => {
        if (confirm("Delete this review?")) {
          await api("/reviews/" + b.dataset.x, { method: "DELETE" });
          await reviews();
        }
      });
    });
  });

  const messages = run(async () => {
    const l = await api("/messages");
    view().innerHTML =
      l
        .map(
          (
            m,
          ) => `<div class="panel item ${m.read ? "off" : ""}"><b>${esc(m.name)}</b> ${esc(m.contact)} <small>${esc(when(m.created_at))}</small><p>${esc(m.body)}</p>
      ${m.read ? "" : `<button class="btn" data-r="${m.id}">Mark as read</button> `}<button class="btn ghost" data-x="${m.id}">Delete</button></div>`,
        )
        .join("") || "<p>No messages.</p>";
    $$("[data-r]").forEach((b) => {
      b.onclick = run(async () => {
        await api("/messages/" + b.dataset.r, { method: "PUT", body: {} });
        await messages();
        counts();
      });
    });
    $$("[data-x]").forEach((b) => {
      b.onclick = run(async () => {
        if (confirm("Delete this message?")) {
          await api("/messages/" + b.dataset.x, { method: "DELETE" });
          await messages();
        }
      });
    });
  });

  // ---- Pages and blog ----

  const writing = (kind, word) => {
    const list = run(async () => {
      const l = await api("/content/" + kind);
      const hint =
        kind === "page"
          ? "Pages live at /<address>/ (such as /about-us/). Writing {phone}, {email} or {name} automatically inserts your Shop details."
          : "Posts appear on /blog/ (newest first) and at /<address>/.";
      view().innerHTML = `<div class="toolbar"><button class="btn" id="newdoc">Add ${word}</button></div>
        <p class="meta">${esc(hint)}</p>
        <div class="scroll"><table class="tbl"><tr><th>Title</th><th>Address</th><th></th></tr>
        ${l.map((d) => `<tr class="${d.draft ? "off" : ""}"><td>${esc(d.title)}${d.draft ? ` <span class="tag">Draft</span>` : ""}</td><td><small>/${esc(d.slug)}/</small></td><td class="actions"><button class="link" data-e="${esc(d.slug)}">Edit</button> <a class="link" href="/${esc(d.slug)}/" target="_blank" rel="noopener">View</a> <button class="link" data-x="${esc(d.slug)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="3">Nothing here yet.</td></tr>`}</table></div>`;
      $("#newdoc").onclick = () => edit({ title: "", slug: "", html: "" }, true);
      $$("[data-e]").forEach((b) => {
        b.onclick = () => edit(l.find((d) => d.slug === b.dataset.e));
      });
      $$("[data-x]").forEach((b) => {
        b.onclick = run(async () => {
          if (!confirm(`Delete this ${word}? Its web address will stop working after Publish.`)) return;
          await api(`/content/${kind}/${encodeURIComponent(b.dataset.x)}`, { method: "DELETE" });
          await list();
          needsPublish("Deleted.");
        });
      });
    });
    const edit = (d, isNew) => {
      say("");
      const where = kind === "page" ? (isNew ? "Website page & Company footer" : `/${d.slug}/`) : isNew ? "Blog (/blog/)" : `/${d.slug}/ & /blog/`;
      const desc =
        kind === "page"
          ? "Tip: write {phone}, {email}, or {name} inside the page text so your shop details stay updated automatically."
          : "Articles appear on your Blog page and are indexed by search engines.";
      view().innerHTML = `<form class="panel editor" id="df">
        ${secHead(`${isNew ? "Add" : "Edit"} ${word}`, desc, where, "pub")}
        ${field("Title", "title", d.title, "required", "text", kind === "page" ? "Page heading and footer link label." : "Article headline.")}
        ${isNew ? field("Web address (URL slug)", "slug", "", "required", "text", "Filled automatically from the title. Cannot be changed later.") : `<p class="meta"><b>Web address:</b> /${esc(d.slug)}/</p>`}
        ${kind === "post" ? field("Publish date", "date", d.date, "", "date", "Posts are ordered newest first.") + field("Short summary", "excerpt", d.excerpt, "maxlength=180", "text", "Shown below the title on /blog/ and in Google search results.") : ""}
        <div class="field"><span class="flabel">Content</span><div id="body"></div></div>
        ${toggle("Draft (keep hidden)", "draft", d.draft, "Hidden from customers even after Publish until unchecked.")}
        <div class="stick"><button class="btn">Save ${word}</button> <button type="button" class="btn pub-now" id="savepub">Save &amp; Publish now</button> <button type="button" class="btn ghost" id="back">Back</button><span class="stick-hint">◆ Save stores a draft here; <b>Save &amp; Publish now</b> updates the live site too.</span></div></form>`;
      const f = $("#df");
      const body = rich($("#body"), d.html);
      if (isNew)
        f.title.addEventListener("input", () => {
          f.slug.value = slugify(f.title.value);
        });
      $("#back").onclick = back(list);
      bindSavePublish(f, async () => {
        const slug = isNew ? f.slug.value.trim() : d.slug;
        const out = { ...d, title: f.title.value.trim(), html: body(), draft: f.draft.checked };
        if (kind === "post") {
          out.date = f.date.value;
          out.excerpt = f.excerpt.value.trim();
        }
        await api(`/content/${kind}/${encodeURIComponent(slug)}`, { method: "PUT", body: out });
        await list();
        needsPublish("Saved.");
      });
    };
    list.add = async () => {
      await list();
      $("#newdoc").click();
    };
    return list;
  };

  // ---- Tags ----

  const tags = run(async () => {
    const l = await api("/content/tag");
    view().innerHTML = `<div class="toolbar"><input id="tq" type="search" placeholder="Find a tag" aria-label="Find a tag"><button class="btn ghost" id="newtag">Add tag</button></div>
      <p class="meta">Tags create /product-tag/&lt;slug&gt;/ pages for Google and can also be edited directly on each product. Changes go live after Publish.</p>
      <div class="scroll"><table class="tbl" id="tt"></table></div>`;
    $("#newtag").onclick = run(async () => {
      const name = prompt("Name of the new tag")?.trim();
      if (!name) return;
      await api("/content/tag/" + encodeURIComponent(slugify(name)), { method: "PUT", body: { name } });
      productsLoaded = false;
      await tags();
      needsPublish("Tag added.");
    });
    const draw = () => {
      const q = $("#tq").value.toLowerCase();
      const hits = l.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 100);
      $("#tt").innerHTML =
        `<tr><th>Name</th><th>Address</th><th></th></tr>` +
        hits
          .map(
            (t) =>
              `<tr><td><input value="${esc(t.name)}" data-n="${esc(t.slug)}" aria-label="Tag name"></td><td><small>/product-tag/${esc(t.slug)}/</small></td><td class="actions"><button class="link" data-s="${esc(t.slug)}">Save</button> <button class="link" data-x="${esc(t.slug)}">Delete</button></td></tr>`,
          )
          .join("");
      $$("[data-s]").forEach((b) => {
        b.onclick = run(async () => {
          const t = l.find((x) => x.slug === b.dataset.s);
          t.name = $(`[data-n="${CSS.escape(t.slug)}"]`).value.trim();
          await api("/content/tag/" + encodeURIComponent(t.slug), { method: "PUT", body: t });
          allTags = l;
          needsPublish("Saved.");
        });
      });
      $$("[data-x]").forEach((b) => {
        b.onclick = run(async () => {
          if (!confirm("Delete this tag? Its web address will stop working after Publish.")) return;
          await api("/content/tag/" + encodeURIComponent(b.dataset.x), { method: "DELETE" });
          productsLoaded = false;
          await tags();
          needsPublish("Deleted.");
        });
      });
    };
    $("#tq").oninput = draw;
    draw();
  });

  // ---- Settings ----

  const settings = run(async (only) => {
    const [s, pageList] = await Promise.all([api("/settings"), api("/content/page"), loadCategories()]);
    let L = s.live,
      W = s.site;
    site = W;
    const catOptions = () => [["on-sale", "★ Products on offer (any discounted product)"], ...categories.map((c) => [c.slug, c.name])];
    const places = [
      ["/shop/", "All products"],
      ["/offers/", "Offers: every discounted product"],
      ["/blog/", "Blog"],
      ["/contact-us/", "Contact us"],
      ["/track/", "Track your order"],
      ...pageList.map((p) => [`/${p.slug}/`, p.title]),
      ...categories.map((c) => [`/product-category/${c.path}/`, c.name]),
    ];
    const datalist = `<datalist id="sitelinks">${places.map(([u, n]) => `<option value="${esc(u)}" label="${esc(n)}"></option>`).join("")}</datalist>`;

    let html = "";
    let stickBtn = "Save changes";
    let stickHint = "◆ Save stores a draft; <b>Save &amp; Publish now</b> updates the live storefront immediately.";

    if (only === "delivery") {
      stickBtn = "Save delivery & payment";
      stickHint = "● Takes effect live within ~2 minutes (no Publish needed).";
      html = `
        <section class="panel">
          ${secHead("Online orders & announcement bar", "Pause online checkout anytime (such as during Eid holidays) or show an announcement banner across the storefront.", "Top of every page & Checkout", "live")}
          ${toggle("Accepting online orders", "ordersOpen", L.ordersOpen, "When turned off, customers can still browse products, but placing orders at checkout is paused.")}
          ${field("Closed message", "closedNote", L.closedNote, "", "text", "Shown in a notice box at the top of the Checkout page when online orders are paused.")}
          ${field("Top announcement bar", "notice", L.notice, "placeholder='Eid Sale: 10% off with code EID10'", "text", "Shown as a bar at the very top of every page. Leave empty to hide.")}
        </section>
        <section class="panel">
          ${secHead("Delivery areas & order rules", "Configure delivery areas and fees shown on product pages and checkout. Fees are charged per piece because appliances are heavy.", "Product pages, Cart & Checkout", "live")}
          <div id="zones"></div>
          <div class="fields2">
            ${field("Free delivery threshold (৳)", "freeOver", L.freeOver, "min=0 step=1", "number", "Orders at or above this subtotal (after coupon discount) get free delivery everywhere. Set 0 to disable.")}
            ${field("Minimum order amount (৳)", "minOrder", L.minOrder, "min=0 step=1", "number", "Smallest cart subtotal allowed to place an online order. Set 0 for no minimum.")}
          </div>
        </section>
        <section class="panel">
          ${secHead("Payment methods", "Enable or disable payment options at checkout. Active methods are also listed in the website footer.", "Checkout & Website footer", "live")}
          <p class="hint-box"><strong>How mobile payments work:</strong> Add a mobile/account number (such as bKash, Nagad, or Rocket) and checkout instructs the customer to send money there and asks for their Transaction ID. Leave the number empty for Cash on delivery.</p>
          <div id="pays"></div>
        </section>`;
    } else if (only === "shop") {
      stickBtn = "Save shop details";
      html = `
        <section class="panel">
          ${secHead("Shop identity & logo", "Your business name, tagline, header logo, and descriptions shown in the footer and search engines.", "Header, Browser tab, Footer & Google search", "pub")}
          <div class="fields2">
            ${field("Shop name", "name", W.name, "required", "text", "Shown in the header, footer, emails, and printed customer invoices.")}
            ${field("Tagline", "tagline", W.tagline, "", "text", "Shown above the hero headline on the home page and in browser tab titles.")}
          </div>
          <div class="field">
            <span class="flabel">Logo image</span>
            <small class="fhelp">Shown in the top header instead of the text logo. Leave empty to display your styled shop name.</small>
            <div class="img-row">
              <img class="img-prev" id="logoprev" src="${esc(W.logo)}" alt="Shop logo preview" ${W.logo ? "" : "hidden"}>
              <div class="inline">
                <input name="logo" value="${esc(W.logo)}" placeholder="Upload an image or paste a URL">
                <label class="btn ghost small upl-inline">Upload<input type="file" accept="image/*" id="logoup" hidden></label>
              </div>
            </div>
          </div>
          ${area("Footer summary", "about", W.about, 2, "Short sentence shown under your shop name in the website footer.")}
          ${area("Google search description (SEO)", "description", W.description, 2, "Summary shown under your website link in Google search results and social link previews.")}
        </section>
        <section class="panel">
          ${secHead("Phone, WhatsApp & location", "Support numbers and address shown in the header, Contact Us page, product pages, floating buttons, and invoices.", "Header strip, Product pages, Contact page, Floating buttons & Invoices", "pub")}
          <div class="fields2">
            ${field("Main phone number", "phone", W.phone, "required", "text", "Used in the top call line, product pages ('Order by phone'), Contact page, invoices, and floating call button.")}
            ${field("WhatsApp number", "whatsapp", W.whatsapp, "", "text", "Enables the floating WhatsApp chat button and 'WhatsApp' order link on products. Leave empty to hide.")}
            ${field("Email address", "email", W.email, "", "email", "Shown on Contact Us and receives new order/message notifications.")}
            ${field("Opening hours", "hours", W.hours, "placeholder='Sat–Thu, 9:00 AM – 9:00 PM'", "text", "Shown on the Contact Us page. Leave empty to hide.")}
          </div>
          ${field("Shop address", "address", W.address, "", "text", "Shown in the footer, Contact Us page, and printed on customer invoices.")}
        </section>
        <section class="panel">
          ${secHead("Return policy & social links", "Warranty/return details shown on product pages and social media links in the footer.", "Product pages & Website footer", "pub")}
          ${area("Return and warranty policy", "returns", W.returns, 2, "Shown on every product page below the delivery charges. Leave empty to hide.")}
          <div class="fields2">
            ${field("Facebook page URL", "facebook", W.facebook, "", "url", "Shows the Facebook icon in the website footer. Leave empty to hide.")}
            ${field("YouTube channel URL", "youtube", W.youtube, "", "url", "Shows the YouTube icon in the website footer. Leave empty to hide.")}
          </div>
        </section>`;
    } else if (only === "home") {
      stickBtn = "Save home page";
      html = `
        <section class="panel">
          ${secHead("Hero introduction", "The welcome block at the top of your home page. The 3 product photos beside it are picked automatically from your featured product sections below.", "Top of Home page (/)", "pub")}
          ${field("Main headline", "heroTitle", W.hero.title, "required", "text", "The last word is automatically highlighted in your brand red colour.")}
          ${area("Introductory text", "heroText", W.hero.text, 2, "Short paragraph displayed directly underneath the main headline.")}
          <div class="fields2">
            ${field("Button label", "heroButton", W.hero.button, "", "text", "Text inside the main action button (e.g. 'Shop all products').")}
            ${field("Button link", "heroLink", W.hero.link, 'list="sitelinks"', "text", "Page or category opened when customers click the button.")}
          </div>
        </section>
        <section class="panel">
          ${secHead("Promotional banners", "Optional sale or campaign images shown directly below the hero. Leave empty for no banners.", "Below Hero on Home page (/)", "pub")}
          <div id="banners"></div>
        </section>
        <section class="panel">
          ${secHead("Featured product sections", "Rows of products on the home page. Choose any category or '★ Products on offer' (all discounted items, biggest savings first). Use ▲ / ▼ to reorder.", "Main rows on Home page (/)", "pub")}
          <div id="home"></div>
        </section>`;
    } else if (only === "menu") {
      stickBtn = "Save navigation menu";
      html = `
        <section class="panel">
          ${secHead("Header category menus & home category grid", "Each group appears as a dropdown in the top navigation bar. The categories chosen here also power the 'Shop by category' grid on the home page.", "Top navigation bar & Home page category grid", "pub")}
          <p class="hint-box"><strong>Note:</strong> Standard store links (Shop all, Offers, New, Popular, Blog, Track order, Contact) and footer Company/Policies columns are managed automatically.</p>
          <div id="menu"></div>
        </section>`;
    }

    view().innerHTML = `${only === "home" ? datalist : ""}<form id="sf" class="settings">${html}
      <div class="stick"><button class="btn">${esc(stickBtn)}</button>${only === "delivery" ? "" : ` <button type="button" class="btn pub-now" id="savepub">Save &amp; Publish now</button>`}<span class="stick-hint">${stickHint}</span></div></form>`;

    const f = $("#sf");
    let zones, pays, banners, home, menu;

    if (only === "delivery") {
      zones = rows(
        $("#zones"),
        L.delivery,
        [
          { k: "label", label: "Area name", placeholder: "e.g. Inside Jashore" },
          { k: "fee", label: "Charge per piece (৳)", type: "number", min: 0, help: "0 for free delivery" },
          { k: "days", label: "Delivery time (optional)", placeholder: "e.g. 2 to 3 days" },
        ],
        { label: "", fee: 0, days: "" },
        { addLabel: "+ Add delivery area", empty: "No delivery areas configured. Add at least one area so customers can check out." },
      );
      pays = rows(
        $("#pays"),
        L.payments,
        [
          { k: "label", label: "Method name", placeholder: "e.g. bKash" },
          { k: "number", label: "Account / mobile number", placeholder: "Leave empty for Cash on delivery" },
          { k: "enabled", label: "Enabled", type: "bool" },
        ],
        { label: "", number: "", enabled: true },
        { addLabel: "+ Add payment method", empty: "No payment methods added yet." },
      );
    }

    if (only === "shop") {
      $("#logoup").onchange = run(async (e) => {
        if (!e.target.files[0]) return;
        const url = await upload(e.target.files[0], "site", "logo");
        f.logo.value = url;
        $("#logoprev").src = url;
        $("#logoprev").hidden = false;
        unsaved = true;
      });
      f.logo.addEventListener("input", () => {
        const val = f.logo.value.trim();
        $("#logoprev").src = val;
        $("#logoprev").hidden = !val;
      });
    }

    if (only === "home") {
      banners = rows(
        $("#banners"),
        W.banners || [],
        [
          { k: "title", label: "Banner description (alt text)", placeholder: "e.g. Eid Appliance Sale" },
          { k: "link", label: "Goes to (URL)", list: true, placeholder: "/offers/" },
          { k: "image", label: "Banner image", type: "image" },
        ],
        { title: "", link: "/shop/", image: "" },
        { addLabel: "+ Add promotional banner", empty: "No promotional banners yet. Leave empty if you don't want banners on the home page." },
      );
      home = rows(
        $("#home"),
        W.home || [],
        [
          { k: "title", label: "Section heading", placeholder: "e.g. Rice cookers" },
          { k: "cat", label: "Category or Offers", type: "select", options: catOptions },
          { k: "count", label: "Products to show", type: "number", min: 1 },
        ],
        { title: "", cat: categories[0]?.slug || "", count: 8 },
        { addLabel: "+ Add product section", empty: "No product sections added yet." },
      );
    }

    if (only === "menu") {
      menu = rows(
        $("#menu"),
        W.menu || [],
        [
          { k: "title", label: "Menu title", placeholder: "e.g. Kitchen or Furniture" },
          { k: "cats", label: "Categories in this dropdown", type: "cats" },
        ],
        { title: "", cats: [] },
        { addLabel: "+ Add menu group", empty: "No category dropdown menus yet." },
      );
    }

    bindSavePublish(f, async () => {
      const d = Object.fromEntries(new FormData(f));
      let live = { ...L };
      let shop = { ...W };

      if (only === "delivery") {
        live = {
          ...L,
          ordersOpen: f.ordersOpen.checked,
          closedNote: d.closedNote,
          notice: d.notice.trim(),
          freeOver: +d.freeOver,
          minOrder: +d.minOrder,
          delivery: zones().map((z) => ({ ...z, id: z.id || asciiId(z.label) })),
          payments: pays().map((p) => ({ ...p, id: p.id || asciiId(p.label) })),
        };
      } else if (only === "shop") {
        shop = {
          ...W,
          name: d.name.trim(),
          tagline: d.tagline,
          phone: d.phone.trim(),
          whatsapp: d.whatsapp.trim(),
          email: d.email.trim(),
          hours: d.hours,
          facebook: d.facebook.trim(),
          youtube: d.youtube.trim(),
          address: d.address,
          returns: d.returns,
          about: d.about,
          description: d.description,
          logo: d.logo.trim(),
        };
      } else if (only === "home") {
        shop = {
          ...W,
          hero: { title: d.heroTitle, text: d.heroText, button: d.heroButton, link: d.heroLink },
          banners: banners().filter((b) => b.image),
          home: home().filter((h) => h.title),
        };
      } else if (only === "menu") {
        shop = {
          ...W,
          menu: menu().filter((m) => m.title),
        };
      }

      await api("/settings", { method: "PUT", body: { live, site: shop } });
      L = live;
      W = shop;
      site = shop;
      lowStock = live.lowStock ?? lowStock;
      if (only === "delivery") say("Saved. Customers will see delivery & payment changes within about 2 minutes.");
      else needsPublish("Saved.");
    });
  });

  // ---- Start ----

  const blog = writing("post", "post");
  const routes = {
    dashboard,
    orders,
    products,
    categories: cats,
    coupons,
    customers,
    reviews,
    messages,
    tags,
    pages: writing("page", "page"),
    blog,
    delivery: () => settings("delivery"),
    shop: () => settings("shop"),
    home: () => settings("home"),
    menu: () => settings("menu"),
    settings: () => settings("delivery"), // old bookmarks
    product: async (id) => {
      await ensureCatalog();
      const p = allProducts.find((x) => x.id === +id);
      if (p) editProduct(p);
      else await products();
    },
    "new-product": async () => {
      await ensureCatalog();
      editProduct({ cats: [], images: [], attrs: [], active: true, price: 0, regular: 0, stock: 0, name: "", slug: "" }, true);
    },
    "new-post": () => blog.add(),
    publish: async () => {
      await dashboard();
      await publish();
    },
  };
  const NAVTAB = { product: "products", "new-product": "products", "new-post": "blog", settings: "delivery", publish: "dashboard" };

  let here = "";
  function go() {
    if (unsaved && !confirm(LEAVE)) {
      history.replaceState(null, "", "#" + here);
      return;
    }
    unsaved = false;
    const [first, arg] = location.hash.slice(1).split("/");
    const tab = routes[first] ? first : "dashboard";
    here = location.hash.slice(1);
    const nav = NAVTAB[tab] || tab;
    say("");
    $("#err").textContent = "";
    const [title, help, mode] = HEADS[nav] || ["", "", ""];
    const parts = SUBGROUPS.find((g) => g[nav]);
    $$("#tabs a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + nav));
    const badges = effectBadges(mode);
    $("#head").innerHTML =
      (parts
        ? `<div class="subtabs">${Object.entries(parts)
            .map(([k, v]) => `<a href="#${k}" class="${k === nav ? "on" : ""}">${esc(v)}</a>`)
            .join("")}</div>`
        : "") + `<div class="headrow"><h1>${esc(title)}</h1>${badges ? `<div class="headbadges">${badges}</div>` : ""}</div><p class="meta">${esc(help)}</p>`;
    view().innerHTML = "<p>Loading…</p>";
    routes[tab](arg);
    scrollTo(0, 0);
  }

  // The search box finds tasks by their everyday words, and products by name.
  function finder() {
    const box = $("#find"),
      res = $("#findres");
    const close = () => {
      res.hidden = true;
    };
    box.oninput = run(async () => {
      if (!productsLoaded) await ensureCatalog();
      const q = box.value.trim().toLowerCase();
      if (!q) return close();
      const jobs = JOBS.filter(([label, , words]) => (label + " " + words).toLowerCase().includes(q)).slice(0, 5);
      const items = allProducts.filter((p) => (p.name + " " + (p.sku || "")).toLowerCase().includes(q)).slice(0, 6);
      res.innerHTML =
        jobs.map(([label, href]) => `<a href="${href}">${esc(label)}</a>`).join("") +
        items.map((p) => `<a href="#product/${p.id}"><small>Product</small> ${esc(p.name)}</a>`).join("") ||
        "<p>Nothing found. Try another word.</p>";
      res.hidden = false;
    });
    res.onclick = () => {
      box.value = "";
      close();
    };
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".adminfind")) close();
    });
  }

  // Small numbers on the menu, so waiting work is seen from any page.
  const counts = async () => {
    const d = await api("/dashboard").catch(() => null);
    if (!d) return;
    const show = (k, n) => {
      const e = $(`[data-count="${k}"]`);
      if (!e) return;
      e.textContent = n;
      e.hidden = !n;
    };
    show("orders", d.pending);
    show("messages", d.unread);
    show("reviews", d.reviews);
  };

  async function enter() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#tabs").innerHTML = NAV_GROUPS.map(
      ([group, items]) =>
        `<div class="nav-group">${esc(group)}</div>` +
        items.map(([k, v]) => `<a href="#${k}">${esc(v)}<i data-count="${k}" hidden></i></a>`).join(""),
    ).join("");
    try {
      $("#dirtybar").hidden = !localStorage.getItem("dirty");
    } catch {}
    finder();
    go();
    ensureCatalog().catch(() => {});
    const s = await api("/settings").catch(() => ({}));
    site = s.site || null;
    lowStock = s.live?.lowStock ?? lowStock;
    counts();
  }

  addEventListener("hashchange", go);
  $("#pub").onclick = publish;
  $("#pub2").onclick = publish;
  document.addEventListener("input", (e) => {
    if (e.target.closest("#view form")) unsaved = true;
  });
  document.addEventListener("submit", () => {
    unsaved = false;
  });
  addEventListener("beforeunload", (e) => {
    if (unsaved) e.preventDefault();
  });
  $("#out").onclick = () => logout();
  $("#login").onsubmit = (e) => {
    e.preventDefault();
    token = $("#tok").value.trim();
    sessionStorage.setItem("t", token);
    if ($("#keep").checked)
      try {
        localStorage.setItem("keep", token);
      } catch {}
    $("#tok").value = "";
    enter();
  };
  if (token) enter();
})();
