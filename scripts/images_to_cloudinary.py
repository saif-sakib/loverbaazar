#!/usr/bin/env python3
"""Copy every product image from the old site into static files, keeping the same URLs. Safe to re-run."""
import json, pathlib, urllib.request, concurrent.futures as cf
R = pathlib.Path(__file__).resolve().parent.parent
urls = {u for p in json.load(open(R/"apps/store/src/data/products.json")) for i in p["images"] for u in (i["src"], i["thumb"])}
def get(u):
    out = R/"apps/store/public"/u.split("loverbaazar.com/")[1].split("?")[0]
    if out.exists() and out.stat().st_size: return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(u, headers={"User-Agent": "LoverBaazar-migration"})
        out.write_bytes(urllib.request.urlopen(req, timeout=120).read()); return 0
    except Exception as e:
        print("failed", u, e); return 1
with cf.ThreadPoolExecutor(6) as x:
    print("failures:", sum(x.map(get, urls)), "of", len(urls))
