#!/usr/bin/env python3
"""Move the shop's images from the old WordPress site to tidy, readable places on Cloudinary.

    loverbaazar/products/rice-cooker/kiam-rice-cooker-1.jpg
    loverbaazar/pages/about-us/about-us-1.jpg
    loverbaazar/blog/eid-offers/eid-offers-1.jpg

Only images a visible product, page or post really uses are copied. WordPress's extra sizes are
dropped, because Cloudinary resizes on delivery. After copying, it updates the addresses through
the admin API. Run it while the old site is online. It's safe to re-run until "failed: 0".

    export SHOP=https://your-shop ADMIN_TOKEN=... CLOUDINARY_CLOUD=... CLOUDINARY_KEY=... CLOUDINARY_SECRET=...
    python3 scripts/images_to_cloudinary.py            # copy, then update the shop
    python3 scripts/images_to_cloudinary.py --dry-run  # only count
"""
import base64, concurrent.futures as cf, hashlib, json, os, re, sys, time
import urllib.error, urllib.parse, urllib.request

ROOT = "loverbaazar"
OLD = re.compile(r"""https?://(?:www\.)?loverbaazar\.com/wp-content/uploads/[^\s"'<>),?\\]+""")
SIZE = re.compile(r"-\d+x\d+(?=\.\w+$)")  # WordPress's resized copies: rice-300x300.jpg
LISTS = {"latest-product", "popular-item", "uncategorized"}  # groupings, not real categories
AGENT = {"User-Agent": "LoverBaazar-migration"}


def fetch(req, timeout=60):
    return urllib.request.urlopen(req, timeout=timeout)


def admin(path, body=None):
    req = urllib.request.Request(os.environ["SHOP"] + "/api/admin" + path, headers={"X-Admin-Token": os.environ["ADMIN_TOKEN"], "X-Origin-Secret": os.environ.get("ORIGIN_SECRET", ""), "Content-Type": "application/json", **AGENT})
    if body is not None:
        req.data, req.method = json.dumps(body).encode(), "PUT"
    with fetch(req, 90) as res:
        return json.load(res)


def tidy(text, fallback):
    """A readable ASCII name: Bangla letters can't be typed into a URL by hand."""
    return re.sub(r"[^a-z0-9]+", "-", urllib.parse.unquote(text).lower()).strip("-") or fallback


def original(url):
    return SIZE.sub("", url.replace("http://", "https://").replace("//www.", "//"))


def plan(products, docs):
    """Decide a home for each image. Returns {original url: public id} and the url variants of each."""
    places, used = {}, set()

    def place(url, folder, name):
        key = original(url)
        if key in places:
            return
        n = 1
        while f"{folder}/{name}-{n}" in used:
            n += 1
        places[key] = f"{folder}/{name}-{n}"
        used.add(places[key])

    for p in products:
        cat = next((c for c in p.get("cats", []) if c not in LISTS), "other")
        folder, name = f"{ROOT}/products/{tidy(cat, 'other')}", tidy(p["slug"], f"product-{p['id']}")
        for i in p.get("images", []):
            if OLD.fullmatch(i.get("src", "")):
                place(i["src"], folder, name)
        for u in OLD.findall(p.get("desc", "")):
            place(u, folder, name)
    for kind, d in docs:
        name = tidy(d["slug"], "untitled")
        for u in OLD.findall(d.get("html", "")):
            place(u, f"{ROOT}/{'blog' if kind == 'post' else 'pages'}/{name}", name)
    return places


def sign(params, secret):
    text = "&".join(f"{k}={params[k]}" for k in sorted(params))
    return hashlib.sha1((text + secret).encode()).hexdigest()


def address(pid, url, size=""):
    ext = url.rsplit(".", 1)[-1].lower()
    return f"https://res.cloudinary.com/{os.environ['CLOUDINARY_CLOUD']}/image/upload/f_auto,q_auto{size}/{pid}.{ext}"


def there(pid, url):
    plain = f"https://res.cloudinary.com/{os.environ['CLOUDINARY_CLOUD']}/image/upload/{pid}.{url.rsplit('.', 1)[-1].lower()}"
    try:
        fetch(urllib.request.Request(plain, method="HEAD"), 30)
        return True
    except urllib.error.URLError:
        return False


def send(pid, file):
    params = {"asset_folder": pid.rsplit("/", 1)[0], "overwrite": "false", "public_id": pid, "timestamp": str(int(time.time()))}
    body = {**params, "api_key": os.environ["CLOUDINARY_KEY"], "signature": sign(params, os.environ["CLOUDINARY_SECRET"]), "file": file}
    req = urllib.request.Request(f"https://api.cloudinary.com/v1_1/{os.environ['CLOUDINARY_CLOUD']}/image/upload", urllib.parse.urlencode(body).encode())
    with fetch(req, 180) as res:
        if not json.load(res).get("secure_url"):
            raise ValueError("no address returned")


def copy(item):
    url, pid = item
    if there(pid, url):
        return url, True
    for attempt in range(2):
        try:
            send(pid, url)  # Cloudinary fetches it from the old site itself
            return url, True
        except (urllib.error.URLError, ValueError, OSError):
            time.sleep(2)
    try:  # some hosts block Cloudinary, so fetch it here and hand it over
        with fetch(urllib.request.Request(url, headers=AGENT), 120) as res:
            kind, data = res.headers.get_content_type(), base64.b64encode(res.read()).decode()
        send(pid, f"data:{kind};base64,{data}")
        return url, True
    except (urllib.error.URLError, ValueError, OSError) as e:
        print("failed", url, e, flush=True)
        return url, False


def rewrite(text, places, done):
    def swap(m):
        key = original(m[0])
        return address(places[key], key) if key in done else m[0]

    return OLD.sub(swap, text or "")


def main():
    products = [p for p in admin("/products") if p.get("active")]
    docs = [(k, d) for k in ("page", "post") for d in admin("/content/" + k)]
    places = plan(products, docs)
    print(len(places), "images for", len(products), "products and", len(docs), "pages and posts", flush=True)
    if "--dry-run" in sys.argv:
        print({f.split("/")[1]: sum(v.split("/")[1] == f.split("/")[1] for v in places.values()) for f in places.values()})
        return
    with cf.ThreadPoolExecutor(6) as pool:
        results = list(pool.map(copy, places.items()))
    done = {u for u, good in results if good}
    print("copied:", len(done), " failed:", len(results) - len(done), flush=True)

    def update_product(p):
        images = []
        for i in p.get("images", []):
            key = original(i.get("src", ""))
            images.append({**i, "src": address(places[key], key), "thumb": address(places[key], key, ",w_300")} if key in done else i)
        body = {**p, "images": images, "desc": rewrite(p.get("desc"), places, done), "stockDelta": 0}
        if images != p.get("images") or body["desc"] != (p.get("desc") or ""):
            admin(f"/products/{p['id']}", body)
            return 1
        return 0

    with cf.ThreadPoolExecutor(3) as pool:
        print("products updated:", sum(pool.map(update_product, products)), flush=True)
    for kind, d in docs:
        html = rewrite(d.get("html"), places, done)
        if html != d.get("html"):
            admin(f"/content/{kind}/{urllib.parse.quote(d['slug'])}", {**d, "html": html})
    print("finished", flush=True)


if __name__ == "__main__":
    main()
