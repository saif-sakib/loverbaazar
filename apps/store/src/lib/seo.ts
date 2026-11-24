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

const banglaDigits: Record<string, string> = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };
const toAsciiDigits = (text: string) => text.replace(/[০-৯]/g, d => banglaDigits[d] || d);

/** Derive MerchantReturnPolicy JSON-LD truthfully from a public, indexable terms page. */
export function resolveMerchantReturn(page: any, url: string) {
  const seo = page && recordSEO(page, "");
  const text = seo && !seo.noindex && (!seo.canonical || seo.canonical === url) ? plainText(page.html) : "";
  if (!/\b(?:returns|return policy|refunds)\b|ফেরত/iu.test(text)) {
    return { url: undefined, offerPolicy: undefined, orgPolicy: undefined };
  }
  const normalized = toAsciiDigits(text);
  const daysMatch =
    normalized.match(/\b(?:return(?:s)?(?:\s+and\s+refunds?)?|refund(?:s)?(?:\s+and\s+returns?)?)\s+policy\s+lasts\s+(\d{1,3})\s+days?\b/i) ||
    normalized.match(/\b(?:return(?:ed|s)?|refund(?:ed|s)?|exchange(?:d|s)?)\b[^.]{0,40}\b(?:within|up to|for)\s+(\d{1,3})\s+days?\b/i) ||
    normalized.match(/(\d{1,3})\s+দিনের\s+মধ্যে\s*(?:ফেরত|রিটার্ন)/u);
  const days = daysMatch ? Number(daysMatch[1]) : 0;
  if (Number.isInteger(days) && days >= 1 && days <= 365) {
    const returnMethod = /\b(?:send(?:ing)?\s+(?:anything|the item|your item|it)\s+back|mail your product|trackable (?:delivery|shipping) service|courier)\b/i.test(normalized)
      ? "https://schema.org/ReturnByMail"
      : undefined;
    const returnFees = /\bfree return(?:s| shipping)?\b/i.test(normalized)
      ? "https://schema.org/FreeReturn"
      : /\b(?:responsible for paying your own shipping|customer pays(?:\s+for)?\s+return\s+shipping|return shipping costs? (?:are|is) non-refundable|cost of return shipping will be deducted)\b/i.test(normalized)
        ? "https://schema.org/ReturnFeesCustomerResponsibility"
        : undefined;
    const policy = {
      "@type": "MerchantReturnPolicy",
      applicableCountry: "BD",
      returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
      merchantReturnDays: days,
      ...(returnMethod ? { returnMethod } : {}),
      ...(returnFees ? { returnFees } : {}),
      merchantReturnLink: url,
    };
    return { url, offerPolicy: policy, orgPolicy: policy };
  }
  if (/\b(?:no returns|returns? (?:are )?not (?:accepted|permitted)|non-returnable)\b/i.test(normalized)) {
    const policy = {
      "@type": "MerchantReturnPolicy",
      applicableCountry: "BD",
      returnPolicyCategory: "https://schema.org/MerchantReturnNotPermitted",
      merchantReturnLink: url,
    };
    return { url, offerPolicy: policy, orgPolicy: policy };
  }
  return {
    url,
    offerPolicy: undefined,
    orgPolicy: { "@type": "MerchantReturnPolicy", merchantReturnLink: url },
  };
}

const termsPage = pages.find(page => page.slug === "terms-conditions");
const termsURL = siteUrl("/terms-conditions/");
const resolvedReturn = resolveMerchantReturn(termsPage, termsURL);
export const merchantReturnURL = resolvedReturn.url;
export const merchantReturnPolicy = resolvedReturn.offerPolicy;
export const organizationReturnPolicy = resolvedReturn.orgPolicy;

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

/** Split a configured store address into PostalAddress fields without inventing missing data. */
export function postalAddress(address: unknown) {
  const raw = plainText(address);
  if (!raw) return undefined;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const addressLocality = parts.pop()!;
    return {
      "@type": "PostalAddress",
      streetAddress: parts.join(", "),
      addressLocality,
      ...(/\b(?:jashore|jessore)\b/i.test(addressLocality) ? { addressRegion: "Khulna Division" } : {}),
      addressCountry: "BD",
    };
  }
  return {
    "@type": "PostalAddress",
    streetAddress: raw,
    addressCountry: "BD",
  };
}

const nationwideZone = (zone: any) =>
  /^(?:outside (?:of )?(?:jashore|jessore|যশোর)|nationwide(?: delivery)?|(?:(?:all of|across) )?bangladesh|সারা বাংলাদেশ|যশোরের বাইরে)$/i
    .test(String(zone?.label || "").trim().replace(/\s+/g, " "));

export function hasNationwideDelivery(live: any) {
  return Array.isArray(live?.delivery) && live.delivery.some(nationwideZone);
}

/** Find a zero-fee local delivery zone from live store settings. */
export function freeLocalArea(live: any) {
  const list = Array.isArray(live?.delivery) ? live.delivery : [];
  const freeZone = list.find((zone: any) => Number(zone?.fee) === 0 && String(zone?.label || "").trim() && !nationwideZone(zone));
  if (!freeZone) return null;
  const label = String(freeZone.label).trim();
  const area = label.replace(/^inside\s+/i, "").trim();
  if (!area) return null;
  return {
    id: String(freeZone.id || ""),
    label,
    area,
    fee: 0,
    days: String(freeZone.days || "").trim(),
  };
}

/** Describe configured free local delivery and nationwide cash-on-delivery truthfully. */
export function deliveryZonesText(live: any) {
  const free = freeLocalArea(live);
  const payments = Array.isArray(live?.payments) ? live.payments : [];
  const hasCod = payments.some((p: any) => p?.enabled && /cash on delivery|\bcod\b/i.test(`${p.id || ""} ${p.label || ""}`));
  if (hasNationwideDelivery(live)) {
    if (free) return `Free delivery in ${free.area} and ${hasCod ? "cash on delivery" : "delivery"} across Bangladesh`;
    return hasCod ? "Cash on delivery across Bangladesh" : "Delivery across Bangladesh";
  }
  if (free) return `Free delivery in ${free.area}${hasCod ? " and cash on delivery" : ""}`;
  return hasCod ? "Cash on delivery" : "Choose your delivery area at checkout";
}

/** Emit structured areaServed entities for Jashore and Bangladesh when configured. */
export function storeAreaServed(address: unknown, live: any) {
  const rawAddress = plainText(address);
  const list = Array.isArray(live?.delivery) ? live.delivery : [];
  const matchesJashore = /\b(?:jashore|jessore)\b/i.test(rawAddress) ||
    list.some((zone: any) => /\b(?:jashore|jessore)\b/i.test(`${zone?.id || ""} ${zone?.label || ""}`));
  const areas = [];
  if (matchesJashore) {
    areas.push({
      "@type": "AdministrativeArea",
      name: "Jashore",
      alternateName: ["Jessore", "যশোর"],
      containedInPlace: { "@type": "AdministrativeArea", name: "Khulna Division" },
    });
  }
  if (hasNationwideDelivery(live)) areas.push({ "@type": "Country", name: "Bangladesh" });
  return areas.length ? areas : undefined;
}
