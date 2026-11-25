import localProducts from "../data/products.json";
import localContent from "../data/content.json";
import { validateBundle } from "./contracts.mjs";
import defaults from "../../../api/defaults.json";

const remote = import.meta.env.CATALOG_URL;

// Render can take a minute to wake, so a build waits for it rather than failing.
async function fetchJson(url: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url,{headers: import.meta.env.BUILD_KEY ? {"X-Build-Key":import.meta.env.BUILD_KEY} : {}, signal:AbortSignal.timeout(20000)});
      if (res.ok) return await res.json();
      throw new Error(`${url} answered ${res.status}`);
    } catch (e) {
      if (attempt === 6) throw e;
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

const buildId=import.meta.env.BUILD_ID;
if(import.meta.env.BUILD_ENV==="production" && (!remote||!buildId||!import.meta.env.BUILD_KEY||!import.meta.env.PUBLIC_TURNSTILE_SITE)) throw new Error("Production needs a frozen build and Turnstile site key");
const bundle=buildId && remote ? await fetchJson(new URL(`/api/build/${buildId}`,remote).href) : null;
const list: any[] = bundle ? bundle.products : remote ? await fetchJson(remote) : localProducts;
const store: any = bundle ? bundle.store : remote ? await fetchJson(remote.replace(/catalog\/?$/, "storefront")) : {};
if(bundle) validateBundle(list,store);
// An empty answer must stop the deploy, never publish an empty shop.
if (!Array.isArray(list) || list.length === 0) throw new Error("The catalogue came back empty. Not publishing.");

export const products: any[] = list.map((p) => ({ cats: [], tags: [], images: [], attrs: [], reviews: [], short: "", desc: "", ...p }));
// An empty list from the database is real: the admin may have deleted the last post.
const pick = (key: "cats" | "tags" | "pages" | "posts"): any[] => store[key] ?? (localContent as any)[key];
export const cats = pick("cats"),
  tags = pick("tags"),
  pages = pick("pages");
export const posts = [...pick("posts")].sort((a, b) => String(b.date).localeCompare(String(a.date)));
const rawSite: any = store.site || {};
export const SITE: any = {
  ...defaults.site,
  ...rawSite,
  hero: { ...defaults.site.hero, ...(rawSite.hero || {}) },
  offers: { ...defaults.site.offers, ...(rawSite.offers || {}) },
};
// Use the readable spacing of the configured wordmark as an alternate name.
export const spacedSiteName = SITE.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
// {phone}, {email} and {name} let the admin write text on Pages that stays right when those details change.
const escapeHTML=(s: string)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
export const fill = (text = "") =>
  text.replaceAll("{phone}", escapeHTML(SITE.phone)).replaceAll("{email}", escapeHTML(SITE.email))
    .replaceAll("{name}", escapeHTML(SITE.name)).replaceAll("{returns}", escapeHTML(SITE.returns));
export const siteUrl = (path: string) => new URL(path, import.meta.env.SITE).href;
export const LIVE: any = { ...defaults.live, ...store.live }; // only a fallback: the browser reads /api/stock

export const img = (u = "") => (u || "/placeholder.svg");
export const taka = (n: number) => "৳" + Number(n).toLocaleString("en-IN");
export const off = (p: any) => (p.regular > p.price ? Math.round(((p.regular - p.price) / p.regular) * 100) : 0);
export const inCat = (slug: string) => products.filter((p) => p.cats.includes(slug));
// Everything priced below its regular price, biggest discount first. Home sections use the name "on-sale".
export const onSale = () => products.filter((p) => off(p) > 0).sort((a, b) => off(b) - off(a));
export const offersEnabled = () => SITE.offers?.enabled !== false;
export const activeOffers = () => (offersEnabled() ? onSale() : []);
export const showOffersNav = () => offersEnabled() && SITE.offers?.showInNav !== false && onSale().length > 0;
export const offersNavLabel = () => String(SITE.offers?.navLabel || "").trim() || "Offers";
export const homeItems = (slug: string) => (slug === "on-sale" ? activeOffers() : inCat(slug));
// WordPress stores Bangla slugs percent-encoded, but a browser's request is decoded before the file
// is looked up. So the build must write the real letters, or those pages answer 404.
export const fileSlug = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
export const catUrl = (c: any) => `/product-category/${c.path}/`;
export const telOf = (phone: string) => "+88" + phone.replace(/\D/g, "").replace(/^88/, "");
export const waOf = (phone: string) => "https://wa.me/88" + phone.replace(/\D/g, "").replace(/^88/, "");
const cat = (s: string) => cats.find((c: any) => c.slug === s);
export const MENU = SITE.menu
  .map((g: any) => ({ title: g.title, items: g.cats.map(cat).filter(Boolean) }))
  .filter((g: any) => g.items.length);
export const rating = (p: any) => (p.reviews.length ? p.reviews.reduce((a: number, r: any) => a + r.rating, 0) / p.reviews.length : 0);

// These are descriptive attributes, never selectable inventory variants.
export const attributeValues = (p: any, key: string): string[] => {
 const pattern=key==="brand" ? /^(brand|manufacturer|ব্র্যান্ড|ব্রান্ড)$/i : /^(color|colour|রং)$/i;
 return [...new Set((p.attrs||[]).filter((a: any)=>pattern.test(a.name.trim())).flatMap((a: any)=>a.values).map((v: any)=>String(v).trim()).filter(Boolean))] as string[];
};

// Use the dominant script for bilingual editorial metadata, without relabeling every page.
export const languageOf = (value: string) => {
  const plain = value.replace(/<[^>]*>/g, " ");
  const bangla = (plain.match(/[\u0980-\u09ff]/g) || []).length;
  const latin = (plain.match(/[A-Za-z]/g) || []).length;
  return bangla > latin ? "bn-BD" : "en-BD";
};
