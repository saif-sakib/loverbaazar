import { cats, products, SITE, siteUrl, attributeValues } from "../lib/shop";
import { categoryChain, gtinOf, plainText, primaryCategoryOf, recordSEO, publicImage, summary, xmlText as xml } from "../lib/seo";

const ALLOWED_CONDITIONS = new Set(["new", "used", "refurbished"]);

const items = products.flatMap(p => {
  const url = siteUrl(`/product/${p.slug}/`);
  const seo = recordSEO(p, p.name);
  const image = publicImage(p.images[0]?.src);
  if (seo.noindex || (seo.canonical && seo.canonical !== url) || !image || !Number.isSafeInteger(p.price) || p.price <= 0) return [];
  const price = p.regular > p.price ? p.regular : p.price;
  const title = summary(p.name, 150) || plainText(p.name) || p.name;
  const description = summary(p.short || p.desc, 5000) || title;
  const extraImages = [...new Set((p.images || []).slice(1).map((img: any) => publicImage(img?.src)).filter((u): u is string => Boolean(u) && u !== image))].slice(0, 10);
  const brand = attributeValues(p, "brand")[0];
  const gtin = gtinOf(p);
  const mpn = typeof p.mpn === "string" ? p.mpn.trim() : "";
  const condition = typeof p.condition === "string" ? p.condition.trim().toLowerCase() : "";
  const primary = primaryCategoryOf(p.cats, cats);
  const productType = primary ? categoryChain(primary, cats).map(c => c.name).join(" > ") : "";
  return [`<item><g:id>${p.id}</g:id><guid>${xml(url)}</guid><title>${xml(title)}</title>
    <description>${xml(description)}</description><link>${xml(url)}</link><g:image_link>${xml(image)}</g:image_link>
    ${extraImages.map(u => `<g:additional_image_link>${xml(u)}</g:additional_image_link>`).join("")}
    <g:price>${price} BDT</g:price>${price > p.price ? `<g:sale_price>${p.price} BDT</g:sale_price>` : ""}
    <g:availability>${p.inStock ? "in_stock" : "out_of_stock"}</g:availability>
    ${ALLOWED_CONDITIONS.has(condition) ? `<g:condition>${condition}</g:condition>` : ""}
    ${productType ? `<g:product_type>${xml(productType)}</g:product_type>` : ""}
    ${brand ? `<g:brand>${xml(brand)}</g:brand>` : ""}${gtin ? `<g:gtin>${gtin}</g:gtin>` : ""}${mpn ? `<g:mpn>${xml(mpn)}</g:mpn>` : ""}${!brand && !gtin && !mpn ? "<g:identifier_exists>no</g:identifier_exists>" : ""}</item>`];
});

export const GET = () => new Response(
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
    <title>${xml(SITE.name)}</title><link>${xml(siteUrl("/"))}</link><description>${xml(SITE.description)}</description>
    ${items.join("")}</channel></rss>`, { headers: { "Content-Type": "application/xml; charset=utf-8" } },
);
