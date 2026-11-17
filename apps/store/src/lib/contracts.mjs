export function validateBundle(products, store) {
  if (!Array.isArray(products) || !products.length || !store || typeof store.site !== 'object') throw new Error('Invalid or empty build snapshot');
  const ids=new Set(), slugs=new Set();
  const slug=s=>{try{return typeof s==='string' && /^[\p{L}\p{M}\p{N}_-]+$/u.test(decodeURIComponent(s));}catch{return false;}};
  for (const p of products) {
    if (!Number.isSafeInteger(p.id)||p.id<1||ids.has(p.id)||!slug(p.slug)||slugs.has(decodeURIComponent(p.slug))||typeof p.name!=='string'||!p.name.trim()) throw new Error('Invalid/duplicate product identity');
    ids.add(p.id);slugs.add(decodeURIComponent(p.slug));
    for(const k of ['price','regular']) if(!Number.isSafeInteger(p[k])||p[k]<0||p[k]>1e9) throw new Error('Invalid whole-taka price');
    for(const k of ['cats','tags','images','attrs']) if(!Array.isArray(p[k])) throw new Error('Invalid product '+k);
  }
  for(const k of ['cats','tags','pages','posts']) if(!Array.isArray(store[k])) throw new Error('Missing content collection '+k);
  const cats=new Set(store.cats.map(c=>c.slug)),tags=new Set(store.tags.map(t=>t.slug));
  for(const p of products) if(p.cats.some(c=>!cats.has(c))||p.tags.some(t=>!tags.has(t))) throw new Error('Unknown product category/tag');
}
