import { languageOf, siteUrl } from "./shop";

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

export const jsonLd = (object: object) => JSON.stringify(object).replace(/</g, "\\u003c");

export const xmlText = (value: unknown) => String(value ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
  .replace(/[<>&'"]/g, character => `&#${character.charCodeAt(0)};`);
