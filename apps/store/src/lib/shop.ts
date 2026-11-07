import localProducts from "../data/products.json";
import localContent from "../data/content.json";
import defaults from "../../../api/defaults.json";

const remote = import.meta.env.CATALOG_URL;

// Render can take a minute to wake, so a build waits for it rather than failing.
async function fetchJson(url: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      throw new Error(`${url} answered ${res.status}`);
    } catch (e) {
      if (attempt === 6) throw e;
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

const list: any[] = remote ? await fetchJson(remote) : localProducts;
const store: any = remote ? await fetchJson(remote.replace(/catalog\/?$/, "storefront")) : {};
// An empty answer must stop the deploy, never publish an empty shop.
if (!Array.isArray(list) || list.length === 0) throw new Error("The catalogue came back empty. Not publishing.");

export const products: any[] = list.map((p) => ({ cats: [], tags: [], images: [], attrs: [], reviews: [], short: "", desc: "", ...p }));
// An empty list from the database is real: the admin may have deleted the last post.
const pick = (key: "cats" | "tags" | "pages" | "posts"): any[] => store[key] ?? (localContent as any)[key];
export const cats = pick("cats"),
  tags = pick("tags"),
  pages = pick("pages");
export const posts = [...pick("posts")].sort((a, b) => String(b.date).localeCompare(String(a.date)));
export const SITE: any = { ...defaults.site, ...store.site };
SITE.copy = { ...defaults.site.copy, ...store.site?.copy };
// {phone}, {email} and {name} let the admin write text that stays right when those details change.
export const fill = (text = "") =>
  text.replaceAll("{phone}", SITE.phone).replaceAll("{email}", SITE.email).replaceAll("{name}", SITE.name);
export const say = (key: string) => fill(SITE.copy[key] ?? "");
export const siteUrl = (path: string) => new URL(path, import.meta.env.SITE).href;
export const LIVE: any = { ...defaults.live, ...store.live }; // only a fallback: the browser reads /api/stock

export const img = (u = "") => (u || "/placeholder.svg");
export const taka = (n: number) => "৳" + Number(n).toLocaleString("en-IN");
export const off = (p: any) => (p.regular > p.price ? Math.round(((p.regular - p.price) / p.regular) * 100) : 0);
export const inCat = (slug: string) => products.filter((p) => p.cats.includes(slug));
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
