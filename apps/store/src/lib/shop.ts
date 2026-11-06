import local from "../data/products.json";
import content from "../data/content.json";
const remote = import.meta.env.CATALOG_URL;
export const products: any[] = remote ? await (await fetch(remote)).json() : local;
export const { cats, tags, pages, posts } = content as any;
const BASE = import.meta.env.PUBLIC_IMAGE_BASE;
export const img = (u = "") => (BASE ? u.replace("https://loverbaazar.com/wp-content/uploads", BASE) : u);
export const taka = (n: number) => "৳" + Number(n).toLocaleString("en-IN");
export const off = (p: any) => (p.regular > p.price ? Math.round(((p.regular - p.price) / p.regular) * 100) : 0);
export const inCat = (slug: string) => products.filter((p) => p.cats.includes(slug));
export const SHOP = { phone: "01710-076076", tel: "+8801710076076", email: "loverbaazar@gmail.com",
  facebook: "https://www.facebook.com/profile.php?id=100091885353080", youtube: "https://www.youtube.com/channel/UCZu0It_vU51HDCGxWnGjIQA",
  bkash: "01780-243104", nagad: "01557-123053", rocket: "01780-243104" };
const cat = (s: string) => cats.find((c: any) => c.slug === s);
export const MENU = [
  ["Kitchen", ["rice-cooker","pressure-cooker","anodized","nonstick","induction-infrared","electric-kettle","flask","mixer-grinder","dc","gas-stove"]],
  ["Furniture", ["wardrobe","rfl-wardrobe","almirah","akij-almirah","rfl-almirah","chair","rfl-chair","table","rfl-table","kitchen-rack"]],
].map(([t, l]: any) => ({ title: t, items: l.map(cat).filter(Boolean) }));
export const catUrl = (c: any) => `/product-category/${c.path}/`;
