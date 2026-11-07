import { products, img, fileSlug } from "../lib/shop";
export const GET = () => new Response(JSON.stringify(products.map((p) => ({ id:p.id, slug:p.slug, name:p.name, price:p.price, regular:p.regular, inStock:p.inStock, thumb:img(p.images[0]?.thumb), text:[p.name,p.sku,...p.cats,...p.tags.map(fileSlug),...p.attrs.flatMap((a)=>a.values)].join(" ").toLowerCase() }))));
