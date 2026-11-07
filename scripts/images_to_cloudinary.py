#!/usr/bin/env python3
"""Copy every old WordPress image to Cloudinary, keeping its path, so one prefix change moves them all.

  https://loverbaazar.com/wp-content/uploads/2023/01/rice.jpg
  https://res.cloudinary.com/CLOUD/image/upload/f_auto,q_auto/loverbaazar/2023/01/rice.jpg

Run it while the old site is still online. It skips images already copied, so it is safe to re-run
until it says "failed: 0".

    export CLOUDINARY_CLOUD=... CLOUDINARY_KEY=... CLOUDINARY_SECRET=...
    python3 scripts/images_to_cloudinary.py            # copy
    python3 scripts/images_to_cloudinary.py --dry-run  # only count
"""
import base64, concurrent.futures as cf, hashlib, json, os, pathlib, re, sys, time
import urllib.error, urllib.parse, urllib.request

R = pathlib.Path(__file__).resolve().parent.parent
FOLDER = "loverbaazar"  # the API uses the same folder for new uploads (uploadFolder in admin.go)
OLD = re.compile(r"""https?://(?:www\.)?loverbaazar\.com/wp-content/uploads/[^\s"'<>),?\\]+""")
PREFIX = re.compile(r"^https?://(?:www\.)?loverbaazar\.com/wp-content/uploads/")
IMAGE = (".jpg", ".jpeg", ".png", ".webp", ".gif")
AGENT = {"User-Agent": "LoverBaazar-migration"}


def find_images():
    """Every image the shop mentions, including those inside descriptions, pages and blog posts."""
    found = set()
    for name in ("products.json", "content.json"):
        text = json.dumps(json.load(open(R / "apps/store/src/data" / name, encoding="utf-8")), ensure_ascii=False)
        found.update(OLD.findall(text))
    return sorted(u for u in found if u.lower().endswith(IMAGE))


def public_id(url):
    path = urllib.parse.unquote(PREFIX.sub("", url))
    return FOLDER + "/" + path.rsplit(".", 1)[0]


def sign(params, secret):
    """Cloudinary's rule: sorted name=value pairs, then the secret, hashed with SHA-1."""
    text = "&".join(f"{k}={params[k]}" for k in sorted(params))
    return hashlib.sha1((text + secret).encode()).hexdigest()


def fetch(req, timeout):
    return urllib.request.urlopen(req, timeout=timeout)


def already_there(cloud, url):
    path = urllib.parse.quote(FOLDER + "/" + urllib.parse.unquote(PREFIX.sub("", url)))
    try:
        fetch(urllib.request.Request(f"https://res.cloudinary.com/{cloud}/image/upload/{path}", method="HEAD"), 30)
        return True
    except urllib.error.URLError:
        return False


def send(cloud, key, secret, url, file):
    params = {"asset_folder": FOLDER, "overwrite": "false", "public_id": public_id(url), "timestamp": str(int(time.time()))}
    body = {**params, "api_key": key, "signature": sign(params, secret), "file": file}
    req = urllib.request.Request(f"https://api.cloudinary.com/v1_1/{cloud}/image/upload", urllib.parse.urlencode(body).encode())
    with fetch(req, 180) as res:
        if not json.load(res).get("secure_url"):
            raise ValueError("no address in Cloudinary's answer")


def copy(cloud, key, secret, url):
    """Returns "skipped", "copied" or "failed"."""
    if already_there(cloud, url):
        return "skipped"
    for attempt in range(3):
        try:
            send(cloud, key, secret, url, url)  # Cloudinary fetches it from the old site itself
            return "copied"
        except (urllib.error.URLError, ValueError, TimeoutError, OSError):
            time.sleep(2 * (attempt + 1))
    try:  # some hosts block Cloudinary, so fetch it here and hand it over
        with fetch(urllib.request.Request(url, headers=AGENT), 120) as res:
            kind = res.headers.get_content_type()
            data = base64.b64encode(res.read()).decode()
        send(cloud, key, secret, url, f"data:{kind};base64,{data}")
        return "copied"
    except (urllib.error.URLError, ValueError, TimeoutError, OSError) as e:
        print("failed", url, e)
        return "failed"


def main():
    images = find_images()
    print(len(images), "images to check")
    if "--dry-run" in sys.argv:
        return
    try:
        cloud, key, secret = (os.environ[k] for k in ("CLOUDINARY_CLOUD", "CLOUDINARY_KEY", "CLOUDINARY_SECRET"))
    except KeyError as e:
        sys.exit(f"Set {e.args[0]} first. See the top of this file.")
    with cf.ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda u: copy(cloud, key, secret, u), images))
    print("copied:", results.count("copied"), " already there:", results.count("skipped"), " failed:", results.count("failed"))


if __name__ == "__main__":
    main()
