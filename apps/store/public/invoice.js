// Loaded on demand by Admin. Order data stays in the browser.
const ink = "#172438";
const muted = "#48586b";
const rule = "#cad3df";
const accent = "#92243d";
const contentWidth = 505;
const totalsWidth = 205;
const money = (amount) => "৳" + Number(amount || 0).toLocaleString("en-IN");
const bangla = /[\u0964-\u0965\u0980-\u09ff\u200c\u200d]/;
const absoluteURL = (path) => new URL(path, location.href).href;

function text(value, options) {
  return {
    text: String(value ?? "").split(/([\u0964-\u0965\u0980-\u09ff\u200c\u200d]+)/).filter(Boolean)
      .map((part) => bangla.test(part) ? { text: part, font: "Bengali" } : { text: part }),
    ...options,
  };
}

async function invoiceLogo(configured) {
  for (const src of new Set([configured, "/logo/primary-logo-80.webp"].filter(Boolean))) {
    let timer;
    try {
      const url = new URL(src, location.href);
      if (url.origin !== location.origin && url.protocol !== "https:") continue;
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = url.href;
      await Promise.race([
        image.decode(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Logo unavailable")), 2500); }),
      ]);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 88;
      const scale = 88 / Math.max(image.naturalWidth, image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      canvas.getContext("2d").drawImage(image, (88 - w) / 2, (88 - h) / 2, w, h);
      return canvas.toDataURL("image/png");
    } catch {
      // Try the bundled logo. Seller details can also stand alone.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// Fixed widths let pdfmake wrap even a long code without widening the table.
const widths = [contentWidth - 220, 40, 90, 90];
const itemLayout = {
  hLineWidth: () => 0.6,
  hLineColor: () => rule,
  vLineWidth: () => 0,
  paddingLeft: () => 0,
  paddingRight: () => 0,
  paddingTop: () => 0,
  paddingBottom: () => 0,
};

function itemRow(values, header = false) {
  return values.map((value, column) => text(value, {
    alignment: column === 0 ? "left" : "right",
    margin: [7, 6, 7, 6],
    bold: header,
    ...(header ? { fillColor: "#f2f4f7" } : {}),
  }));
}

function fact(label, value) {
  return {
    columns: [
      text(label, { width: 112, color: muted }),
      text(value, { width: 102 }),
    ],
    columnGap: 6,
    margin: [0, 0, 0, 3],
  };
}

function totalsLine(label, amount, total = false) {
  return {
    columns: [
      text(label, { width: 107, bold: total }),
      text(amount, { width: 88, alignment: "right", bold: total }),
    ],
    fontSize: total ? 12 : 10,
    margin: [5, 5, 5, 5],
  };
}

function divider(color = rule, width = contentWidth, weight = 0.6) {
  return { canvas: [{ type: "line", x1: 0, x2: width, y1: 0, y2: 0, lineWidth: weight, lineColor: color }] };
}

function invoiceDocument(order, shop, logo) {
  const name = shop.name || "LoverBaazar";
  const date = new Date(order.created_at).toLocaleDateString("en-GB", {
    timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric",
  });
  const status = String(order.status || "");
  const contact = [shop.phone, shop.email].filter(Boolean).join(" · ");
  const sellerWidth = contentWidth - 155 - 12;
  const rows = (order.items || []).map(item => itemRow([
    item.name, item.qty, money(item.price), money(item.price * item.qty),
  ]));
  const lastItem = rows.pop();
  // A single final table row keeps the last item, summary and contact together
  // while the main table still repeats column labels on each page.
  const settlement = {
    margin: [0, 12, 0, 0],
    stack: [
      {
        margin: [contentWidth - totalsWidth, 0, 0, 0],
        stack: [
          totalsLine("Subtotal", money(order.subtotal)),
          ...(order.discount ? [totalsLine(order.coupon ? `Discount (${order.coupon})` : "Discount", "−" + money(order.discount))] : []),
          totalsLine("Delivery charge", order.shipping ? money(order.shipping) : "Free"),
          divider(accent, totalsWidth, 1),
          totalsLine("Order total", money(order.total), true),
        ],
      },
      { ...divider(), margin: [0, 13, 0, 8] },
      text(`Thank you for shopping with ${name}.`, { bold: true }),
      ...(contact ? [text(`Questions about your order? ${contact}`, { color: muted })] : []),
    ],
  };
  return {
    pageSize: "A4",
    pageMargins: [45, 40, 45, 45],
    info: { title: `Invoice ${order.number}`, author: name },
    defaultStyle: { font: "Invoice", fontSize: 10, color: ink, lineHeight: 1.12 },
    footer: (page, total) => total > 1
      ? { text: `${order.number}  ·  ${page} / ${total}`, alignment: "right", margin: [45, 10, 45, 0], color: muted, fontSize: 8 }
      : null,
    content: [
      { ...divider(accent, contentWidth, 3), margin: [0, 0, 0, 13] },
      {
        columns: [{
          width: sellerWidth,
          columns: [
            ...(logo ? [{ image: logo, width: 34, height: 34 }] : []),
            { width: sellerWidth - (logo ? 42 : 0), stack: [text(name, { fontSize: 13, bold: true }), text(shop.address, { color: muted })] },
          ],
          columnGap: 8,
        }, {
          width: 155,
          alignment: "right",
          stack: [
            text("Invoice", { fontSize: 24, bold: true }),
            text(order.number, { bold: true }),
            text(date, { color: muted }),
          ],
        }],
        columnGap: 12,
        margin: [0, 0, 0, 12],
      },
      { ...divider(), margin: [0, 0, 0, 9] },
      {
        columns: [
          {
            width: contentWidth - 220 - 19,
            stack: [
              text("Deliver to", { color: muted, bold: true, margin: [0, 0, 0, 4] }),
              text(order.name, { bold: true }),
              text([order.address, order.area && `(${order.area})`].filter(Boolean).join(" ")),
              text(order.phone),
            ],
          },
          {
            width: 220,
            stack: [
              text("Order details", { color: muted, bold: true, margin: [0, 0, 0, 4] }),
              fact("Order status", status.charAt(0).toUpperCase() + status.slice(1)),
              fact("Payment method", order.payment),
              ...(order.txn_id ? [fact("Transaction reference", order.txn_id)] : []),
            ],
          },
        ],
        columnGap: 19,
        margin: [0, 0, 0, 12],
      },
      {
        table: {
          headerRows: 1,
          keepWithHeaderRows: 1,
          dontBreakRows: true,
          widths,
          body: [
            itemRow(["Item", "Qty", "Unit price", "Amount"], true),
            ...rows,
            [{
              colSpan: 4,
              stack: [
                ...(lastItem ? [{ table: { widths, body: [lastItem] }, layout: itemLayout }] : []),
                settlement,
              ],
            }, {}, {}, {}],
          ],
        },
        layout: {
          ...itemLayout,
          hLineWidth: (index, node) => index >= node.table.body.length - 1 ? 0 : 0.6,
        },
      },
    ],
  };
}

export async function downloadInvoice(order, shop) {
  await import("/invoice-assets/pdfmake-0.3.14.js");
  const pdfMake = globalThis.pdfMake;
  const regular = absoluteURL("/invoice-assets/latin.woff");
  const bold = absoluteURL("/invoice-assets/bold.woff");
  const bengali = absoluteURL("/invoice-assets/bengali.woff");
  pdfMake.addFonts({
    Invoice: { normal: regular, bold, italics: regular, bolditalics: bold },
    Bengali: { normal: bengali, bold: bengali, italics: bengali, bolditalics: bengali },
  });
  const logo = await invoiceLogo(shop?.logo);
  const filename = String(order.number || "invoice").replace(/[^a-z0-9_-]+/gi, "-");
  await pdfMake.createPdf(invoiceDocument(order, shop || {}, logo)).download(filename + ".pdf");
}
