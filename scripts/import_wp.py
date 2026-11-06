#!/usr/bin/env python3
"""Turn the WordPress API dumps in data/raw into the store's catalogue. Re-runnable."""
import json, re, html, pathlib
R = pathlib.Path(__file__).resolve().parent.parent
raw = R / "data/raw"
load = lambda n: json.load(open(raw / n, encoding="utf-8"))
txt = lambda h: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h or ""))).strip()
def clean(h):
    h = re.sub(r"(?is)<(script|style|iframe|form)\b.*?</\1>", "", h or "")
    h = re.sub(r"(?i)\s(on\w+|style|class|id)=(\"[^\"]*\"|'[^']*')", "", h)
    return re.sub(r"(?i)javascript:", "", h).strip()
SKIP = {"sign-up","wishlist","wishlist-2","my-account","checkout","checkout-2","cart","cart-2","shop","shop-2","home","sample-page","best-price-blog","contact-us-2","contact-us","privacy-policy-2"}
cats = [{"id":c["id"],"name":html.unescape(c["name"]),"slug":c["slug"],"parent":c["parent"],"count":c["count"],
         "path":c["link"].split("/product-category/")[1].strip("/")} for c in load("cats.json")]
tags = [{"name":html.unescape(t["name"]),"slug":t["slug"]} for i in (1,2,3) for t in load(f"tags{i}.json") if t["count"]]
products = []
for i in (1,2,3):
    for p in load(f"all{i}.json"):
        pr = p["prices"]
        products.append({"id":p["id"],"slug":p["slug"],"name":html.unescape(p["name"]).strip(),"sku":p.get("sku",""),
          "price":int(pr["price"])//100,"regular":int(pr["regular_price"] or pr["price"])//100,"inStock":bool(p["is_in_stock"]),
          "cats":[c["slug"] for c in p["categories"]],"tags":[t["slug"] for t in p["tags"]],
          "images":[{"src":m["src"],"thumb":m["thumbnail"],"alt":m.get("alt") or ""} for m in p["images"]],
          "short":txt(p.get("short_description"))[:300],"desc":clean(p.get("description")),
          "attrs":[{"name":a["name"],"values":[html.unescape(t["name"]) for t in a["terms"]]} for a in p.get("attributes",[])]})
pg = lambda x,**k: {"slug":x["slug"],"title":txt(x["title"]["rendered"]),"html":clean(x["content"]["rendered"]),**k}
pages = [pg(p) for p in load("pages.json") if p["slug"] not in SKIP and p["content"]["rendered"].strip()]
privacy = next(p for p in load("pages.json") if p["slug"]=="privacy-policy-2")
pages.append({**pg(privacy),"slug":"privacy-policy"})
posts = [pg(p,date=p["date"][:10],excerpt=txt(p["excerpt"]["rendered"])[:180]) for p in load("posts.json")]
(R/"apps/store/src/data").mkdir(parents=True,exist_ok=True); (R/"apps/api/seed").mkdir(parents=True,exist_ok=True)
json.dump({"cats":cats,"tags":tags,"pages":pages,"posts":posts},open(R/"apps/store/src/data/content.json","w",encoding="utf-8"),ensure_ascii=False)
for f in (R/"apps/store/src/data/products.json",R/"apps/api/seed/products.json"):
    json.dump(products,open(f,"w",encoding="utf-8"),ensure_ascii=False)
print(len(products),"products",len(cats),"cats",len(tags),"tags",len(pages),"pages",len(posts),"posts",[p["slug"] for p in pages])
