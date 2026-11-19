import { languageOf, pages, siteUrl } from "./shop";

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function plainText(input: unknown) {
  if (typeof input !== "string") return "";
  return input.replace(/<[^>]*>/g, " ").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, key) => {
    if (!key.startsWith("#")) return entities[key.toLowerCase()] ?? full;
    const value = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "";
  }).replace(/\s+/g, " ").trim();
}

export function summary(input: unknown, limit = 160) {
  const text = plainText(input);
  const graphemes = Array.from(new Intl.Segmenter("bn").segment(text), item => item.segment);
  return graphemes.length > limit ? graphemes.slice(0, limit - 1).join("").trimEnd() + "…" : text;
}

const literal = (input: unknown) => /%[a-z][a-z0-9_]*(?:\([^)]*\))?%/i.test(String(input)) ? "" : plainText(input);
export function canonicalUrl(input: unknown) {
  if (typeof input !== "string" || !input || input.startsWith("//")) return undefined;
  try {
    const url = new URL(input, siteUrl("/"));
    const host = new URL(siteUrl("/")).hostname;
    const aliases = host === "loverbaazar.com" ? [host, "www.loverbaazar.com"] : [host];
    if (!["http:", "https:"].includes(url.protocol) || !aliases.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return undefined;
    if (/%(?:2f|5c)/i.test(url.pathname)) return undefined;
    const path = decodeURIComponent(url.pathname);
    if (path.includes("%") || path.includes("\\") || /[?#\s]/u.test(path)) return undefined;
    return siteUrl(path.endsWith("/") ? path : `${path}/`);
  } catch {
    return undefined;
  }
}

export function publicImage(input: unknown) {
  if (typeof input !== "string" || !input || input.startsWith("//")) return undefined;
  try {
    const url = new URL(input, siteUrl("/"));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function recordSEO(record: any, fallback: string) {
  const seo = record.seo ?? {};
  const title = literal(seo.title);
  const description = summary(literal(seo.description) || fallback);
  return {
    seoTitle: title || undefined,
    description,
    canonical: canonicalUrl(seo.canonical_url),
    noindex: !!record.draft || [seo.robots].flat().some(value => typeof value === "string" && /\bnoindex\b/i.test(value)),
    language: languageOf(`${record.name || record.title || ""} ${description} ${record.html || record.desc || ""}`),
    socialTitle: literal(seo.facebook_title) || undefined,
    socialDescription: summary(literal(seo.facebook_description)) || undefined,
    image: publicImage(seo.facebook_image),
  };
}

export function gtinOf(record: any) {
  const id = String(record.gtin ?? "");
  if (!/^(\d{8}|\d{12,14})$/.test(id) || /^0+$/.test(id)) return undefined;
  const sum = [...id].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return sum % 10 === 0 ? id : undefined;
}

export function skuOf(record: { sku?: unknown }) {
  const sku = typeof record.sku === "string" ? record.sku.trim() : "";
  // Google accepts Unicode SKUs but excludes whitespace and non-interchange characters.
  return sku && !/[\p{White_Space}\p{C}]/u.test(sku) ? sku : undefined;
}

const termsPage = pages.find(page => page.slug === "terms-conditions");
const termsURL = siteUrl("/terms-conditions/");
const termsSEO = termsPage && recordSEO(termsPage, "");
export const merchantReturnURL = termsSEO && !termsSEO.noindex &&
  (!termsSEO.canonical || termsSEO.canonical === termsURL) &&
  /\b(?:returns|return policy|refunds)\b|ফেরত/iu.test(plainText(termsPage.html)) ? termsURL : undefined;

export const jsonLd = (object: object) => JSON.stringify(object).replace(/</g, "\\u003c");

export const xmlText = (value: unknown) => String(value ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
  .replace(/[<>&'"]/g, character => `&#${character.charCodeAt(0)};`);

export const isMerchandisingCategory = (slug: string) => slug === "latest-product" || slug === "popular-item";

export const hasPriceIntent = (text: string) => /\b(?:price|bd|bangladesh)\b|দাম|বাংলাদেশ/i.test(text);

export function categoryHeading(name: string, slug: string, count: number) {
  if (count === 0 || isMerchandisingCategory(slug) || hasPriceIntent(name)) return name;
  return languageOf(name) === "bn-BD" ? `${name} এর দাম বাংলাদেশে` : `${name} Price in Bangladesh`;
}

export function productSeoTitle(name: string) {
  if (hasPriceIntent(name)) return name;
  if (languageOf(name) === "bn-BD") return `${name} এর দাম`;
  return name.length > 44 ? `${name} Price in BD` : `${name} Price in Bangladesh`;
}

export function tagSeoTitle(name: string, count: number) {
  if (count < 3 || hasPriceIntent(name)) return name;
  return languageOf(name) === "bn-BD" ? `${name} এর দাম বাংলাদেশে` : `${name} Price in Bangladesh`;
}

export function categoryChain(cat: any, allCats: any[]) {
  if (!cat) return [];
  const parts = String(cat.path || cat.slug || "").split("/").filter(Boolean);
  const byPath = new Map(allCats.map((entry: any) => [entry.path, entry]));
  const chain: any[] = [];
  for (let i = 0; i < parts.length; i++) {
    const found = byPath.get(parts.slice(0, i + 1).join("/"));
    if (found) chain.push(found);
  }
  if (!chain.some((entry: any) => entry.slug === cat.slug)) chain.push(cat);
  return chain;
}

export function primaryCategoryOf(productCats: string[], allCats: any[]) {
  const bySlug = new Map(allCats.map((entry: any) => [entry.slug, entry]));
  const resolved = (productCats || []).map((slug: string) => bySlug.get(slug)).filter(Boolean);
  if (!resolved.length) return undefined;
  const nonMerch = resolved.filter((entry: any) => !isMerchandisingCategory(entry.slug));
  const pool = nonMerch.length ? nonMerch : resolved;
  return pool.reduce((best: any, current: any) => {
    const bestDepth = String(best.path || best.slug).split("/").length;
    const currentDepth = String(current.path || current.slug).split("/").length;
    return currentDepth > bestDepth ? current : best;
  });
}

export function priceBounds(items: any[]) {
  let min = Infinity;
  let max = 0;
  let inStockCount = 0;
  for (const item of items) {
    if (item.inStock) inStockCount++;
    if (Number.isSafeInteger(item.price) && item.price > 0) {
      if (item.price < min) min = item.price;
      if (item.price > max) max = item.price;
    }
  }
  return { min: min === Infinity ? 0 : min, max, inStockCount };
}
