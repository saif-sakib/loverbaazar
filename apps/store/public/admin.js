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
  // Eight places to go. A place with several parts shows them as tabs at the top of the page.
  const NAV = [
    ["dashboard", "Home"],
    ["orders", "Orders"],
    ["products", "Products", { products: "All products", categories: "Categories", tags: "Tags" }],
    ["coupons", "Coupons"],
    ["customers", "Customers"],
    ["messages", "Inbox", { messages: "Messages", reviews: "Reviews" }],
    ["home", "Website", { home: "Home page", menu: "Menu and footer", pages: "Pages", blog: "Blog", words: "Words" }],
    ["delivery", "Settings", { delivery: "Delivery and payment", shop: "Shop details" }],
  ];
  const LIVE = "Changes here reach customers within about 2 minutes.";
  const PUB = "After saving, press Publish changes so customers can see it.";
  const HEADS = {
    dashboard: ["Welcome", "Your shop today, and shortcuts to what you change most."],
    orders: ["Orders", "Find an order, change its status, or print an invoice."],
    messages: ["Messages", "What customers sent from the contact page."],
    reviews: ["Reviews", `Approve a review to show it on the product page. ${PUB}`],
    products: ["Products", `Type in a price or stock box and it saves by itself. Customers see it within about 2 minutes.`],
    categories: ["Categories", `The groups products are sorted into. ${PUB}`],
    coupons: ["Coupons", `Discount codes for customers. ${LIVE}`],
    customers: ["Customers", "Everyone who has ordered. You can also set a new password for a customer who forgot theirs."],
    tags: ["Tags", `Extra keywords on products, used by Google. ${PUB}`],
    home: ["Home page", `The heading, banners and product sections on your home page. ${PUB}`],
    menu: ["Menu and footer", `The links at the top and bottom of every page. ${PUB}`],
    pages: ["Pages", `About Us, How To Buy, Terms and other pages. ${PUB}`],
    blog: ["Blog", `Articles for your customers and for Google. ${PUB}`],
    words: ["Words on the site", `Headings and small messages used around the shop. ${PUB}`],
    delivery: ["Delivery and payment", `Delivery charges, payment numbers, and opening or closing orders. ${LIVE}`],
    shop: ["Shop details", `Your phone, address, logo and colours. ${PUB}`],
  };
  // The search box and the home screen. The last word list is what people might type.
  const JOBS = [
    ["Change a price or stock", "#products", "price stock quantity sold out discount offer"],
    ["Add a new product", "#new-product", "create product photo image"],
    ["Change delivery charges", "#delivery", "delivery charge free shipping fee courier area jashore dhaka"],
    ["Change payment numbers", "#delivery", "bkash nagad rocket payment cash number"],
    ["Edit the home page", "#home", "hero heading banner picture promises top strip sections"],
    ["Change phone or address", "#shop", "phone whatsapp address email facebook youtube hours contact"],
    ["Change the menu or footer", "#menu", "menu footer links navigation"],
    ["Make a discount coupon", "#coupons", "coupon code discount offer sale"],
    ["Edit About, Terms or Privacy", "#pages", "about terms privacy how to buy policy page"],
    ["Write a blog post", "#new-post", "blog article post"],
    ["Close or reopen online orders", "#delivery", "closed holiday eid stop open"],
    ["Show an announcement bar", "#delivery", "notice announcement sale eid message"],
    ["Change the logo or colours", "#shop", "logo colour color brand"],
    ["Change words on the site", "#words", "text words heading message thank you"],
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

  async function loadCategories() {
    categories = await api("/content/cat");
    return categories;
  }

  // ---- Reusable form parts ----

  const checkList = (
    name,
    chosen,
  ) => `<details class="picker"><summary>${chosen.length} chosen</summary><input type="search" placeholder="Filter" data-pick-filter aria-label="Filter categories"><div>
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
    if (box && e.target.type === "checkbox") $("summary", box).textContent = `${$$("input:checked", box).length} chosen`;
  });

  // Images get readable names. Without a name, the file's own name is used.
  const asciiName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const upload = async (file, folder = "pages", name = "") => {
    const base = name || asciiName(file.name.replace(/\.\w+$/, ""));
    return (await api(`/image?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(base)}`, { body: file })).url;
  };

  // Editable rows: delivery areas, payment methods, homepage sections and so on.
  function rows(host, items, fields, blank) {
    let list = items.map((x) => ({ ...x }));
    const cell = (f, it) => {
      const v = it[f.k] ?? "";
      const label = `<span>${esc(f.label)}</span>`;
      if (f.type === "bool")
        return `<label class="check"><input type="checkbox" data-k="${f.k}" ${v ? "checked" : ""}> ${esc(f.label)}</label>`;
      if (f.type === "select")
        return `<label>${label}<select data-k="${f.k}">${f
          .options()
          .map(([val, text]) => `<option value="${esc(val)}" ${val === v ? "selected" : ""}>${esc(text)}</option>`)
          .join("")}</select></label>`;
      if (f.type === "cats") return `<label class="wide">${label}<div data-k="${f.k}" data-cats>${checkList("c", v || [])}</div></label>`;
      if (f.type === "image")
        return `<label class="wide">${label}<span class="inline"><input data-k="${f.k}" value="${esc(v)}" placeholder="Image address"><input type="file" accept="image/*" data-up aria-label="Upload image"></span></label>`;
      if (f.type === "area") return `<label class="wide">${label}<textarea data-k="${f.k}" rows="4">${esc(v)}</textarea></label>`;
      return `<label>${label}<input data-k="${f.k}" type="${f.type || "text"}" value="${esc(v)}" ${f.list ? 'list="sitelinks"' : ""}></label>`;
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
      host.innerHTML =
        list
          .map(
            (it) => `<div class="rep">${fields.map((f) => cell(f, it)).join("")}
        <span class="repbtn"><button type="button" data-up-row aria-label="Move up">▲</button><button type="button" data-down aria-label="Move down">▼</button><button type="button" data-remove aria-label="Remove">✕</button></span></div>`,
          )
          .join("") + `<button type="button" class="btn ghost small add" data-add-row>Add</button>`;
      $$("[data-up]", host).forEach((inp) => {
        inp.onchange = run(async () => {
          $("input[data-k]", inp.parentElement).value = await upload(inp.files[0], "site");
        });
      });
      $$(".rep", host).forEach((row, i) => {
        const swap = (j) => {
          read();
          if (list[j]) {
            [list[i], list[j]] = [list[j], list[i]];
            draw();
          }
        };
        $("[data-up-row]", row).onclick = () => swap(i - 1);
        $("[data-down]", row).onclick = () => swap(i + 1);
        $("[data-remove]", row).onclick = () => {
          read();
          list.splice(i, 1);
          draw();
        };
      });
      $("[data-add-row]", host).onclick = () => {
        read();
        list.push({ ...blank });
        draw();
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

  const field = (label, name, value, extra = "", type = "text") =>
    `<label class="field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value ?? "")}" ${extra}></label>`;
  const area = (label, name, value, n = 3) =>
    `<label class="field">${esc(label)}<textarea name="${name}" rows="${n}">${esc(value ?? "")}</textarea></label>`;
  const toggle = (label, name, on) =>
    `<label class="check field"><input type="checkbox" name="${name}" ${on ? "checked" : ""}> ${esc(label)}</label>`;

  // ---- Dashboard ----

  const dashboard = run(async () => {
    const d = await api("/dashboard");
    const top = Math.max(...d.series.map((x) => x.sales), 1);
    const tile = (label, value, link) => `<a class="tile" href="${link || "#orders"}"><b>${esc(value)}</b><span>${esc(label)}</span></a>`;
    view().innerHTML = `<div class="tiles">
      ${tile("Sales today", money(d.todaySales))}${tile("Waiting for confirmation", d.pending)}${tile("Ready to ship", d.toShip)}${tile("New messages and reviews", d.unread + d.reviews, "#messages")}${tile("Sales, last 30 days", money(d.monthSales))}
    </div>
    <h3 class="jobhead">What do you want to do?</h3>
    <div class="jobs">${JOBS.slice(0, 10)
      .map(([label, href]) => `<a href="${href}">${esc(label)}</a>`)
      .join("")}</div>
    <div class="panel"><h3>Daily sales, last 14 days</h3><div class="bars" role="img" aria-label="Daily sales for the last 14 days. Best day ${money(top)}.">
      ${d.series.map((x) => `<div class="barcol" title="${esc(x.day)}: ${money(x.sales)}, ${x.orders} orders"><span class="val">${x.sales === top && x.sales ? money(x.sales) : ""}</span><i style="height:${Math.round((x.sales / top) * 100)}%"></i><small>${esc(x.day.slice(8))}</small></div>`).join("")}
    </div></div>
    <div class="split">
      <div class="panel"><h3>Best sellers, last 30 days</h3>${d.top.length ? `<table class="tbl">${d.top.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.qty} sold</td><td>${money(t.sales)}</td></tr>`).join("")}</table>` : "<p>No sales yet.</p>"}</div>
      <div class="panel"><h3>Low stock</h3>${d.low.length ? `<table class="tbl">${d.low.map((p) => `<tr><td><a class="link" href="#product/${p.id}">${esc(p.name)}</a></td><td><b>${p.stock}</b> left</td></tr>`).join("")}</table>` : "<p>Everything is well stocked.</p>"}</div>
    </div>`;
  });

  // ---- Orders ----

  const orderFilter = { q: "", status: "", from: "", to: "", page: 0 };
  const query = () => new URLSearchParams(Object.entries(orderFilter).filter(([, v]) => v !== "" && v !== 0)).toString();

  const orders = run(async () => {
    view().innerHTML = `<div class="toolbar">
      <input id="oq" type="search" placeholder="Search orders" value="${esc(orderFilter.q)}" aria-label="Search orders">
      <select id="ost" aria-label="Status"><option value="">All statuses</option>${statusOptions(orderFilter.status)}</select>
      <label class="check">From <input id="ofrom" type="date" value="${esc(orderFilter.from)}"></label><label class="check">To <input id="oto" type="date" value="${esc(orderFilter.to)}"></label>
      <button class="btn ghost" id="csv">Download as Excel file</button></div><div id="olist"><p>Loading…</p></div>`;
    const reload = () => {
      orderFilter.page = 0;
      drawOrders();
    };
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
    $("#olist").innerHTML = `<p><b>${res.total}</b> orders · <b>${money(res.sales)}</b> sales, not counting cancelled or returned</p>
    <div class="scroll"><table class="tbl"><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th></th></tr>
    ${l
      .map(
        (o) => `<tr>
      <td class="nowrap"><b>${esc(o.number)}</b><br><small>${esc(when(o.created_at))}</small></td>
      <td>${esc(o.name)} ${o.same_phone > 1 ? `<a class="tag" href="#orders" data-phone="${esc(o.phone)}">${o.same_phone} orders</a>` : ""}${o.bad_phone > 0 ? ` <span class="tag warn">${o.bad_phone} cancelled or returned</span>` : ""}<br><a class="link" href="tel:${esc(o.phone)}">${esc(o.phone)}</a>${o.email ? `<br><a class="link" href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : ""}<br>${esc(o.address)} (${esc(o.area)})${o.note ? `<br><i>${esc(o.note)}</i>` : ""}</td>
      <td>${(o.items || []).map((i) => `${esc(i.name)} × ${i.qty}`).join("<br>")}</td>
      <td>${money(o.total)}${o.discount ? `<br><small>${money(o.discount)} off, ${esc(o.coupon)}</small>` : ""}</td>
      <td>${esc(o.payment)}<br><small>${esc(o.txn_id)}</small></td>
      <td><select class="status" data-st="${esc(o.status)}" data-o="${esc(o.number)}" aria-label="Status of ${esc(o.number)}">${statusOptions(o.status)}</select></td>
      <td class="actions"><button class="link" data-more="${esc(o.number)}">Details</button> <button class="link" data-print="${esc(o.number)}">Invoice</button></td>
    </tr>
    <tr id="d-${esc(o.number)}" hidden><td colspan="7"><form class="inlineform" data-n="${esc(o.number)}">
      ${field("Courier", "courier", o.courier)}${field("Tracking number", "tracking", o.tracking)}${field("Private note, customers never see this", "adminNote", o.admin_note)}
      <button class="btn">Save</button></form></td></tr>`,
      )
      .join("")}</table></div>
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
        orderFilter.page = 0;
        orders();
      };
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

  let allProducts = [];
  let allTags = [];
  const productFilter = { q: "", cat: "", show: "", limit: 50 };

  const products = run(async () => {
    [allProducts, allTags] = await Promise.all([api("/products"), api("/content/tag"), loadCategories()]);
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
      <td>${p.images?.[0] ? `<img class="mini" src="${esc(p.images[0].thumb || p.images[0].src)}" alt="" loading="lazy" width="44" height="44">` : ""}</td>
      <td>${esc(p.name)}</td>
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
    view().innerHTML = `<form class="panel editor" id="pf"><h2>${isNew ? "Add product" : "Edit product"}</h2>
      ${field("Name", "name", p.name, "required maxlength=200")}
      <details class="advanced"><summary>Web address: /product/<span id="slugview">${esc(p.slug) || "made-from-the-name"}</span>/</summary>
        ${field("Web address", "slug", p.slug, `required pattern="[^\\s\\/?#.]+"`)}
        <p class="meta">This is filled in for you. ${isNew ? "" : "Changing it breaks old links to this product."}</p></details>
      <div class="fields3">${field("Selling price (৳)", "price", p.price, "required min=0 step=1", "number")}${field("Old price (৳), shown crossed out", "regular", p.regular, "min=0 step=1", "number")}${field("How many in stock", "stock", p.stock, "required min=0 step=1", "number")}</div>
      ${field("Product code (SKU), optional", "sku", p.sku)}${field("Short description, shown beside the photo", "short", p.short, "maxlength=300")}
      <div class="field">Categories ${checkList("cat", p.cats || [])}</div>
      <div class="field">Photos <span class="meta">The first photo is the main one.</span><div id="imgs" class="imgs"></div>
        <label class="btn ghost small upl">Upload photos<input id="up" type="file" accept="image/*" multiple hidden></label>
        <input id="imgurl" placeholder="Or paste an image address and press Enter" aria-label="Image address"></div>
      <div class="field">Specifications<div id="attrs"></div></div>
      <label class="field">Search words, separated by commas<input name="tagnames" value="${esc((p.tags || []).map((t) => allTags.find((x) => x.slug === t)?.name || t).join(", "))}"></label>
      <div class="field">Description<div id="desc"></div></div>
      ${toggle("Visible in shop", "active", p.active)}
      <div class="stick"><button class="btn">Save</button> <button type="button" class="btn ghost" id="back">Back</button>${isNew ? "" : ` <button type="button" class="link danger" id="del">Delete product</button>`}</div></form>`;
    const f = $("#pf");
    if (!isNew)
      $("#del").onclick = run(async () => {
        if (!confirm(`Delete ${p.name}? This can't be undone. If it has been ordered before, it will be hidden instead.`)) return;
        const r = await api("/products/" + p.id, { method: "DELETE" });
        unsaved = false;
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
        };
      });
    };
    drawImages();
    const addImage = (src) => {
      images.push({ src, thumb: src.replace("/upload/f_auto,q_auto/", "/upload/f_auto,q_auto,w_300/"), alt: "" });
      drawImages();
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
        { k: "name", label: "Name, such as Colour" },
        { k: "values", label: "Values, separated by commas" },
      ],
      { name: "", values: "" },
    );
    const desc = rich($("#desc"), p.desc);
    f.name.addEventListener("input", () => {
      if (isNew) {
        f.slug.value = slugify(f.name.value);
        $("#slugview").textContent = f.slug.value;
      }
    });
    f.slug.addEventListener("input", () => {
      $("#slugview").textContent = f.slug.value;
    });
    $("#back").onclick = back(products);
    f.onsubmit = run(async (e) => {
      e.preventDefault();
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
      await products();
      needsPublish("Saved. Price and stock are live.");
    });
  }

  // ---- Categories ----

  const cats = run(async () => {
    await loadCategories();
    view().innerHTML = `<div class="toolbar"><button class="btn" id="newcat">Add category</button></div>
      <p class="meta">To put a category in the menu, use <a class="link" href="#menu">Menu and footer</a>. To show one on the home page, use <a class="link" href="#home">Home page</a>.</p>
      <div class="scroll"><table class="tbl"><tr><th>Name</th><th>Address</th><th></th></tr>
      ${categories.map((c) => `<tr><td>${esc(c.name)}</td><td><small>/product-category/${esc(c.path)}/</small></td><td class="actions"><button class="link" data-e="${esc(c.slug)}">Edit</button> <button class="link" data-x="${esc(c.slug)}">Delete</button></td></tr>`).join("")}</table></div>`;
    $("#newcat").onclick = () => editCat({ name: "", slug: "" }, true);
    $$("[data-e]").forEach((b) => {
      b.onclick = () => editCat(categories.find((c) => c.slug === b.dataset.e));
    });
    $$("[data-x]").forEach((b) => {
      b.onclick = run(async () => {
        if (!confirm("Delete this category? Its web address will stop working after Publish.")) return;
        await api("/content/cat/" + encodeURIComponent(b.dataset.x), { method: "DELETE" });
        await cats();
        needsPublish("Category deleted.");
      });
    });
  });

  function editCat(c, isNew) {
    say("");
    const parentPath = isNew ? "" : (c.path || "").split("/").slice(0, -1).join("/");
    view().innerHTML = `<form class="panel editor" id="cf"><h2>${isNew ? "Add category" : "Edit category"}</h2>
      ${field("Name", "name", c.name, "required")}
      ${isNew ? field("Web address, filled in for you", "slug", "", "required") + `<label class="field">Sits under, optional<select name="parent"><option value="">Nothing, it stands alone</option>${categories.map((x) => `<option value="${esc(x.path)}">${esc(x.path)}</option>`).join("")}</select></label>` : `<p class="meta">/product-category/${esc(c.path)}/</p>`}
      <div class="stick"><button class="btn">Save</button> <button type="button" class="btn ghost" id="back">Back</button></div></form>`;
    const f = $("#cf");
    if (isNew)
      f.name.addEventListener("input", () => {
        f.slug.value = slugify(f.name.value);
      });
    $("#back").onclick = back(cats);
    f.onsubmit = run(async (e) => {
      e.preventDefault();
      const slug = isNew ? f.slug.value.trim() : c.slug;
      const parent = isNew ? f.parent.value : parentPath;
      await api("/content/cat/" + encodeURIComponent(slug), {
        method: "PUT",
        body: { ...c, name: f.name.value.trim(), path: parent ? `${parent}/${slug}` : slug },
      });
      await cats();
      needsPublish("Category saved.");
    });
  }

  // ---- Coupons ----

  const coupons = run(async () => {
    const l = await api("/coupons");
    view().innerHTML = `<form class="panel inlineform" id="cpf">
      ${field("Code", "code", "", "required pattern=[A-Za-z0-9_\\-]{2,40}")}
      <label class="field">Type<select name="kind"><option value="percent">Percent off</option><option value="amount">Taka off</option></select></label>
      ${field("Value", "value", "", "required min=1", "number")}${field("Minimum order (৳)", "minOrder", 0, "min=0", "number")}${field("Use limit, 0 for none", "maxUses", 0, "min=0", "number")}${field("Last day", "expires", "", "", "date")}
      ${toggle("Active", "active", true)}<button class="btn">Save coupon</button></form>
      <div class="scroll"><table class="tbl"><tr><th>Code</th><th>Discount</th><th>Minimum</th><th>Used</th><th>Last day</th><th></th></tr>
      ${
        l
          .map(
            (
              c,
            ) => `<tr class="${c.active ? "" : "off"}"><td><b>${esc(c.code)}</b></td><td>${c.kind === "percent" ? c.value + "%" : money(c.value)}</td><td>${money(c.min_order)}</td><td>${c.used}${c.max_uses ? ` of ${c.max_uses}` : ""}</td><td>${c.expires_at ? esc(c.expires_at.slice(0, 10)) : "None"}</td>
        <td class="actions"><button class="link" data-e="${esc(c.code)}">Edit</button> <button class="link" data-x="${esc(c.code)}">Delete</button></td></tr>`,
          )
          .join("") || `<tr><td colspan="6">No coupons yet.</td></tr>`
      }</table></div>`;
    const f = $("#cpf");
    f.onsubmit = run(async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      await api("/coupons/" + encodeURIComponent(d.code.trim()), {
        method: "PUT",
        body: { kind: d.kind, value: +d.value, minOrder: +d.minOrder, maxUses: +d.maxUses, expires: d.expires, active: !!d.active },
      });
      await coupons();
      say("Coupon saved. It works straight away.");
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
    view().innerHTML = `<div class="toolbar"><input id="cq" type="search" placeholder="Name or phone" aria-label="Search customers"></div>
      <form class="panel inlineform" id="reset">${field("Customer forgot their password? Enter their mobile number", "phone", "", "required inputmode=tel")}<button class="btn ghost">Set a new password</button></form>
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
      ${r.approved ? "" : `<button class="btn" data-a="${r.id}">Approve</button> `}<button class="btn ghost" data-x="${r.id}">Delete</button></div>`,
        )
        .join("") || "<p>No reviews yet.</p>";
    $$("[data-a]").forEach((b) => {
      b.onclick = run(async () => {
        await api("/reviews/" + b.dataset.a, { method: "PUT", body: {} });
        await reviews();
        counts();
        needsPublish("Review approved.");
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
      view().innerHTML = `<div class="toolbar"><button class="btn" id="newdoc">Add ${word}</button></div><div class="scroll"><table class="tbl"><tr><th>Title</th><th>Address</th><th></th></tr>
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
      view().innerHTML = `<form class="panel editor" id="df"><h2>${isNew ? "Add" : "Edit"} ${word}</h2>
        ${field("Title", "title", d.title, "required")}
        ${isNew ? field("Web address, filled in for you", "slug", "", "required") : `<p class="meta">Web address: /${esc(d.slug)}/</p>`}
        ${kind === "post" ? field("Date", "date", d.date, "", "date") + field("Short summary, shown on the blog page", "excerpt", d.excerpt, "maxlength=180") : ""}
        <div class="field">Text<div id="body"></div></div>
        ${toggle("Draft: keep this hidden for now", "draft", d.draft)}
        <div class="stick"><button class="btn">Save</button> <button type="button" class="btn ghost" id="back">Back</button></div></form>`;
      const f = $("#df");
      const body = rich($("#body"), d.html);
      if (isNew)
        f.title.addEventListener("input", () => {
          f.slug.value = slugify(f.title.value);
        });
      $("#back").onclick = back(list);
      f.onsubmit = run(async (e) => {
        e.preventDefault();
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
    view().innerHTML = `<div class="toolbar"><input id="tq" type="search" placeholder="Find a tag" aria-label="Find a tag"><button class="btn ghost" id="newtag">Add tag</button></div><div class="scroll"><table class="tbl" id="tt"></table></div>`;
    $("#newtag").onclick = run(async () => {
      const name = prompt("Name of the new tag")?.trim();
      if (!name) return;
      await api("/content/tag/" + encodeURIComponent(slugify(name)), { method: "PUT", body: { name } });
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
          needsPublish("Saved.");
        });
      });
      $$("[data-x]").forEach((b) => {
        b.onclick = run(async () => {
          if (!confirm("Delete this tag? Its web address will stop working after Publish.")) return;
          await api("/content/tag/" + encodeURIComponent(b.dataset.x), { method: "DELETE" });
          await tags();
          needsPublish("Deleted.");
        });
      });
    };
    $("#tq").oninput = draw;
    draw();
  });

  // ---- Settings ----

  const WORDS = [
    ["searchPlaceholder", "Search box hint"],
    ["shopAll", "Shop all link"],
    ["callLine", "Call line in the top strip"],
    ["categoriesHeading", "Home: categories heading"],
    ["viewAll", "Home: view all link"],
    ["seeAll", "Home: see all link"],
    ["recentlyViewed", "Recently viewed heading"],
    ["allProducts", "Shop page heading"],
    ["blogHeading", "Blog page heading"],
    ["contactHeading", "Contact page heading"],
    ["contactIntro", "Contact page intro"],
    ["cartHeading", "Cart page heading"],
    ["cartNote", "Cart: note under the subtotal"],
    ["checkoutHeading", "Checkout page heading"],
    ["checkoutHelp", "Checkout: help line"],
    ["trackHeading", "Track page heading"],
    ["wishlistHeading", "Wishlist page heading"],
    ["accountHeading", "Account page heading"],
    ["productPromise", "Product: line under delivery charges"],
    ["orderByPhone", "Product: order by phone words"],
    ["descriptionHeading", "Product: description heading"],
    ["reviewsHeading", "Product: reviews heading"],
    ["noReviews", "Product: no reviews yet"],
    ["alsoLike", "Product: related products heading"],
    ["emptyCategory", "Empty category message"],
    ["notFoundHeading", "Page not found: heading"],
    ["notFoundText", "Page not found: text"],
    ["paymentHeading", "Footer: payment heading"],
    ["orderPlaced", "Thank you after an order"],
    ["reviewThanks", "Thank you after a review"],
    ["messageThanks", "Thank you after a message"],
  ];

  const settings = run(async (only) => {
    const [s, pageList] = await Promise.all([api("/settings"), api("/content/page"), loadCategories()]);
    const L = s.live,
      W = s.site;
    site = W;
    const catOptions = () => [["on-sale", "★ Products on offer (any with a discount)"], ...categories.map((c) => [c.slug, c.name])];
    const places = [
      ["/shop/", "All products"],
      ["/offers/", "Offers: every discounted product"],
      ["/blog/", "Blog"],
      ["/contact-us/", "Contact us"],
      ["/track/", "Track your order"],
      ...pageList.map((p) => [`/${p.slug}/`, p.title]),
      ...categories.map((c) => [`/product-category/${c.path}/`, c.name]),
    ];
    view().innerHTML = `<datalist id="sitelinks">${places.map(([u, n]) => `<option value="${esc(u)}" label="${esc(n)}"></option>`).join("")}</datalist>
      <form id="sf" class="settings">
      <section class="panel" data-s="delivery"><h2>Delivery areas</h2><p class="meta">The charge is per piece: 5 pieces at ৳100 each pay ৳500. Set it to 0 to make delivery free in that area. Customers must choose their area at checkout.</p><div id="zones"></div>
        ${field("Free delivery everywhere on orders over (৳), 0 to switch off", "freeOver", L.freeOver, "min=0", "number")}
      </section>
      <section class="panel" data-s="delivery"><h2>Payment methods</h2><p class="meta">Add a number for mobile payments, and customers will be asked for a transaction ID. Leave the number empty for cash on delivery.</p><div id="pays"></div></section>
      <section class="panel" data-s="delivery"><h2>Taking orders</h2>
        ${toggle("We are taking online orders", "ordersOpen", L.ordersOpen)}
        ${field("Message to show when orders are closed", "closedNote", L.closedNote)}
        ${field("Announcement bar on every page, leave empty to hide it", "notice", L.notice, "placeholder='Eid sale: 10% off with code EID10'")}
        <details class="advanced"><summary>More options</summary>
        <div class="fields3">${field("Smallest order allowed (৳), 0 for none", "minOrder", L.minOrder, "min=0", "number")}${field("Warn me when stock falls to", "lowStock", L.lowStock, "min=0", "number")}${field("Unconfirmed orders allowed per phone, 0 for no limit", "maxPending", L.maxPending, "min=0", "number")}</div>
        ${toggle("Show “Only 3 left” on products when stock is low", "showLeft", L.showLeft)}</details>
      </section>
      <section class="panel" data-s="shop"><h2>Contact details</h2>
        <div class="fields2">${field("Shop name", "name", W.name, "required")}${field("Tagline", "tagline", W.tagline)}${field("Phone", "phone", W.phone, "required")}${field("WhatsApp number, leave empty to hide", "whatsapp", W.whatsapp)}${field("Email", "email", W.email, "", "email")}${field("Opening hours", "hours", W.hours)}${field("Facebook link", "facebook", W.facebook, "", "url")}${field("YouTube link", "youtube", W.youtube, "", "url")}</div>
        ${field("Shop address", "address", W.address)}${area("Return and warranty policy, shown on products, leave empty to hide", "returns", W.returns, 2)}${area("A sentence about the shop, shown in the footer", "about", W.about, 2)}${area("Description of the shop for Google", "description", W.description, 2)}
      </section>
      <section class="panel" data-s="shop"><h2>Logo and colours</h2>
        <label class="field">Logo, shown instead of the shop name<span class="inline"><input name="logo" value="${esc(W.logo)}" placeholder="Upload a picture, or paste its address"><input type="file" accept="image/*" id="logoup" aria-label="Upload logo"></span></label>
        <div class="fields2">${field("Main colour", "brandColor", W.brandColor, "", "color")}${field("Dark colour", "brandDark", W.brandDark, "", "color")}</div>
      </section>
      <section class="panel" data-s="home"><h2>Main heading</h2>
        ${field("Heading", "heroTitle", W.hero.title, "required")}${area("Text under the heading", "heroText", W.hero.text, 2)}
        <div class="fields2">${field("Button words", "heroButton", W.hero.button)}${field("Button goes to", "heroLink", W.hero.link, 'list="sitelinks"')}</div>
      </section>
      <section class="panel" data-s="home"><h2>Pictures beside the heading</h2><p class="meta">Add up to 3. Leave this empty and the shop picks products for you.</p><div id="heroimgs"></div></section>
      <section class="panel" data-s="home"><h2>Text strip at the very top</h2>${area("One line for each message", "ticker", (W.ticker || []).join("\n"), 3)}</section>
      <section class="panel" data-s="home"><h2>Banner pictures</h2><p class="meta">Shown under the main heading. Leave this empty for no banners.</p><div id="banners"></div></section>
      <section class="panel" data-s="home"><h2>Promises</h2><p class="meta">The four short promises under the main heading.</p><div id="perks"></div></section>
      <section class="panel" data-s="home"><h2>Category pictures</h2>
        ${toggle("Show the Shop by category section", "showCats", W.showCats !== false)}
        <div class="field">Which categories to show, leave empty to use the menu ${checkList("tiles", W.catTiles || [])}</div></section>
      <section class="panel" data-s="home"><h2>Product sections</h2><p class="meta">Each section shows products from one category. Choose “Products on offer” to show every product whose price is below its regular price, biggest discount first. Use the arrows to change the order.</p><div id="home"></div></section>
      <section class="panel" data-s="menu"><h2>Drop-down menus</h2><div id="menu"></div></section>
      <section class="panel" data-s="menu"><h2>Other menu links</h2><div id="links"></div></section>
      <section class="panel" data-s="menu"><h2>Footer links</h2><p class="meta">Links with the same column name appear together.</p><div id="footlinks"></div></section>
      <section class="panel" data-s="words"><h2>Words</h2><p class="meta">Tip: writing {phone}, {email} or {name} fills in your shop details, here and on Pages, so they stay correct if they change.</p>
        <div class="fields2">${WORDS.map(([k, label]) => field(label, "copy_" + k, W.copy?.[k])).join("")}</div></section>
      <div class="stick"><button class="btn">Save changes</button></div></form>`;
    $$("#sf > section").forEach((p) => {
      p.hidden = p.dataset.s !== only;
    });
    const f = $("#sf");
    const zones = rows(
      $("#zones"),
      L.delivery,
      [
        { k: "label", label: "Area" },
        { k: "fee", label: "Charge per piece (৳), 0 for free", type: "number" },
        { k: "days", label: "Delivery time, such as 2 to 3 days" },
      ],
      { label: "", fee: 0 },
    );
    const pays = rows(
      $("#pays"),
      L.payments,
      [
        { k: "label", label: "Name" },
        { k: "number", label: "Number" },
        { k: "enabled", label: "On", type: "bool" },
      ],
      { label: "", number: "", enabled: true },
    );
    const banners = rows(
      $("#banners"),
      W.banners || [],
      [
        { k: "title", label: "What the picture shows" },
        { k: "link", label: "Goes to", list: true },
        { k: "image", label: "Picture", type: "image" },
      ],
      { title: "", link: "/shop/", image: "" },
    );
    const perks = rows(
      $("#perks"),
      W.perks || [],
      [
        { k: "title", label: "Title" },
        { k: "text", label: "Text" },
      ],
      { title: "", text: "" },
    );
    const home = rows(
      $("#home"),
      W.home || [],
      [
        { k: "title", label: "Heading" },
        { k: "cat", label: "Category", type: "select", options: catOptions },
        { k: "count", label: "How many products", type: "number" },
      ],
      { title: "", cat: categories[0]?.slug || "", count: 8 },
    );
    const heroimgs = rows(
      $("#heroimgs"),
      W.heroImages || [],
      [
        { k: "title", label: "What the picture shows" },
        { k: "link", label: "Goes to", list: true },
        { k: "image", label: "Picture", type: "image" },
      ],
      { title: "", link: "/shop/", image: "" },
    );
    const menu = rows(
      $("#menu"),
      W.menu || [],
      [
        { k: "title", label: "Title" },
        { k: "cats", label: "Categories", type: "cats" },
      ],
      { title: "", cats: [] },
    );
    const links = rows(
      $("#links"),
      W.links || [],
      [
        { k: "label", label: "Words" },
        { k: "url", label: "Goes to", list: true },
      ],
      { label: "", url: "/" },
    );
    const footlinks = rows(
      $("#footlinks"),
      (W.footer || []).flatMap((c) => c.links.map((l) => ({ col: c.title, label: l.label, url: l.url }))),
      [
        { k: "col", label: "Column" },
        { k: "label", label: "Words" },
        { k: "url", label: "Goes to", list: true },
      ],
      { col: W.footer?.[0]?.title || "Company", label: "", url: "/" },
    );
    $("#logoup").onchange = run(async (e) => {
      f.logo.value = await upload(e.target.files[0], "site", "logo");
    });
    f.onsubmit = run(async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      const live = {
        ...L,
        ordersOpen: f.ordersOpen.checked,
        closedNote: d.closedNote,
        notice: d.notice.trim(),
        freeOver: +d.freeOver,
        minOrder: +d.minOrder,
        lowStock: +d.lowStock,
        showLeft: f.showLeft.checked,
        maxPending: +d.maxPending,
        delivery: zones().map((z) => ({ ...z, id: z.id || asciiId(z.label) })),
        payments: pays().map((p) => ({ ...p, id: p.id || asciiId(p.label) })),
      };
      const shop = {
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
        brandColor: d.brandColor,
        brandDark: d.brandDark,
        logo: d.logo.trim(),
        hero: { title: d.heroTitle, text: d.heroText, button: d.heroButton, link: d.heroLink },
        ticker: d.ticker
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean),
        banners: banners().filter((b) => b.image),
        perks: perks().filter((p) => p.title),
        home: home().filter((h) => h.title),
        heroImages: heroimgs().filter((h) => h.image),
        showCats: f.showCats.checked,
        catTiles: new FormData(f).getAll("tiles"),
        menu: menu().filter((m) => m.title),
        links: links().filter((l) => l.label),
        footer: [...new Set(footlinks().map((l) => l.col.trim()))]
          .filter(Boolean)
          .map((title) => ({
            title,
            links: footlinks()
              .filter((l) => l.col.trim() === title && l.label && l.url)
              .map(({ label, url }) => ({ label, url })),
          })),
        copy: Object.fromEntries(WORDS.map(([k]) => [k, d["copy_" + k] ?? ""])),
      };
      await api("/settings", { method: "PUT", body: { live, site: shop } });
      if (only === "delivery") say("Saved. Customers will see this within about 2 minutes.");
      else needsPublish("Saved.");
    });
  });

  // ---- Start ----

  const blog = writing("post", "post");
  const publish = run(async () => {
    $("#pub").disabled = true;
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
    }
  });
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
    words: () => settings("words"),
    settings: () => settings("delivery"), // old bookmarks
    product: async (id) => {
      await products();
      const p = allProducts.find((x) => x.id === +id);
      if (p) editProduct(p);
    },
    "new-product": async () => {
      await products();
      $("#new").click();
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
    const [title, help] = HEADS[nav] || ["", ""];
    const place = NAV.find(([k, , parts]) => k === nav || parts?.[nav]);
    const parts = place?.[2];
    $$("#tabs a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + place?.[0]));
    $("#head").innerHTML =
      (parts
        ? `<div class="subtabs">${Object.entries(parts)
            .map(([k, v]) => `<a href="#${k}" class="${k === nav ? "on" : ""}">${esc(v)}</a>`)
            .join("")}</div>`
        : "") + `<h1>${esc(title)}</h1><p class="meta">${esc(help)}</p>`;
    view().innerHTML = "<p>Loading…</p>";
    routes[tab](arg);
    scrollTo(0, 0);
  }

  // The search box finds tasks by their everyday words, and products by name.
  let findList = null;
  function finder() {
    const box = $("#find"),
      res = $("#findres");
    const close = () => {
      res.hidden = true;
    };
    box.oninput = run(async () => {
      findList ??= await api("/products");
      const q = box.value.trim().toLowerCase();
      if (!q) return close();
      const jobs = JOBS.filter(([label, , words]) => (label + " " + words).toLowerCase().includes(q)).slice(0, 5);
      const items = (findList || []).filter((p) => (p.name + " " + (p.sku || "")).toLowerCase().includes(q)).slice(0, 6);
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
      e.textContent = n;
      e.hidden = !n;
    };
    show("orders", d.pending);
    show("messages", d.unread + d.reviews);
  };

  async function enter() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#tabs").innerHTML = NAV.map(([k, v]) => `<a href="#${k}">${v}<i data-count="${k}" hidden></i></a>`).join("");
    try {
      $("#dirtybar").hidden = !localStorage.getItem("dirty");
    } catch {}
    finder();
    go();
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
