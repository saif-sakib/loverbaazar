import { products, img, SITE, siteUrl } from "../lib/shop";
const x = (s: string) => String(s ?? "").replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
const absImg = (u = "") => {
  const s = img(u);
  return s.startsWith("http") ? s : siteUrl(s);
};
// Product feed for Facebook catalogue and Google Merchant Center.
export const GET = () => new Response(`<?xml version="1.0"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${x(SITE.name)}</title><link>${siteUrl("/")}</link>${products.map((p) => `<item><g:id>${p.id}</g:id><title>${x(p.name)}</title><description>${x(p.short || p.name)}</description><link>${x(siteUrl(`/product/${p.slug}/`))}</link><g:image_link>${x(absImg(p.images[0]?.src))}</g:image_link><g:price>${p.price} BDT</g:price><g:availability>${p.inStock ? "in_stock" : "out_of_stock"}</g:availability><g:condition>new</g:condition></item>`).join("")}</channel></rss>`, { headers: { "Content-Type": "application/xml" } });
