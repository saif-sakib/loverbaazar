import { products, SITE, siteUrl, attributeValues } from "../lib/shop";
import { gtinOf, plainText, recordSEO, publicImage, xmlText as xml } from "../lib/seo";

const items = products.flatMap(p => {
  const url = siteUrl(`/product/${p.slug}/`);
  const seo = recordSEO(p, p.name);
  const image = publicImage(p.images[0]?.src);
  if (seo.noindex || (seo.canonical && seo.canonical !== url) || !image || !Number.isSafeInteger(p.price) || p.price <= 0) return [];
  const price = p.regular > p.price ? p.regular : p.price;
  const brand = attributeValues(p, "brand")[0];
  const gtin = gtinOf(p);
  return [`<item><g:id>${p.id}</g:id><guid>${xml(url)}</guid><title>${xml(p.name)}</title>
    <description>${xml(plainText(p.short || p.desc) || p.name)}</description><link>${xml(url)}</link><g:image_link>${xml(image)}</g:image_link>
    <g:price>${price} BDT</g:price>${price > p.price ? `<g:sale_price>${p.price} BDT</g:sale_price>` : ""}
    <g:availability>${p.inStock ? "in_stock" : "out_of_stock"}</g:availability>
    ${p.condition === "new" ? "<g:condition>new</g:condition>" : ""}
    ${brand ? `<g:brand>${xml(brand)}</g:brand>` : ""}${gtin ? `<g:gtin>${gtin}</g:gtin>` : ""}${p.mpn ? `<g:mpn>${xml(p.mpn)}</g:mpn>` : ""}</item>`];
});

export const GET = () => new Response(
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
    <title>${xml(SITE.name)}</title><link>${xml(siteUrl("/"))}</link><description>${xml(SITE.description)}</description>
    ${items.join("")}</channel></rss>`, { headers: { "Content-Type": "application/xml; charset=utf-8" } },
);
