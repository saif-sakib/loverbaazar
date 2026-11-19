import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidIndexNowKey,
  validateProductionOrigin,
  extractSitemapUrls,
  collectProductionUrls,
  verifyKeyFile,
  submitIndexNow,
} from "./indexnow.mjs";

const key = "0123456789abcdef0123456789abcdef";

test("isValidIndexNowKey validates length, character set, and reserved names", () => {
  assert.equal(isValidIndexNowKey(key), true);
  assert.equal(isValidIndexNowKey("Abcd-1234"), true);
  assert.equal(isValidIndexNowKey("a".repeat(128)), true);
  assert.equal(isValidIndexNowKey("short"), false);
  assert.equal(isValidIndexNowKey("a".repeat(129)), false);
  assert.equal(isValidIndexNowKey("bad key"), false);
  assert.equal(isValidIndexNowKey("bad/key123"), false);
  assert.equal(isValidIndexNowKey("robots"), false);
  assert.equal(isValidIndexNowKey("ROBOTS"), false);
  assert.equal(isValidIndexNowKey(null), false);
});

test("validateProductionOrigin accepts apex HTTPS and rejects non-production hosts", () => {
  const ok = validateProductionOrigin("https://loverbaazar.com");
  assert.equal(ok.origin, "https://loverbaazar.com");
  assert.equal(validateProductionOrigin("https://loverbaazar.com/", "https://loverbaazar.com").host, "loverbaazar.com");

  assert.throws(() => validateProductionOrigin(""), /Missing SITE_ORIGIN/);
  assert.throws(() => validateProductionOrigin("http://loverbaazar.com"), /bare HTTPS origin/);
  assert.throws(() => validateProductionOrigin("https://loverbaazar.com/shop"), /bare HTTPS origin/);
  assert.throws(() => validateProductionOrigin("https://loverbaazar.workers.dev"), /non-production host/);
  assert.throws(() => validateProductionOrigin("https://localhost"), /non-production host/);
  assert.throws(() => validateProductionOrigin("https://127.0.0.1"), /non-production host/);
  assert.throws(() => validateProductionOrigin("https://preview.local"), /non-production host/);
  assert.throws(() => validateProductionOrigin("https://loverbaazar.com", "https://other.example"), /does not match/);
});

test("collectProductionUrls reads sitemap index and child sitemaps cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lb-indexnow-"));
  try {
    await writeFile(
      join(dir, "sitemap-index.xml"),
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://loverbaazar.com/sitemap-0.xml</loc></sitemap><sitemap><loc>https://loverbaazar.com/sitemap-1.xml</loc></sitemap></sitemapindex>`
    );
    const banglaURL = "https://loverbaazar.com/product/%E0%A6%AA%E0%A6%A3%E0%A7%8D%E0%A6%AF/";
    await writeFile(
      join(dir, "sitemap-0.xml"),
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://loverbaazar.com/</loc></url><url><loc>${banglaURL}</loc></url><url><loc>https://loverbaazar.com/shop/?a=1&amp;b=2</loc></url></urlset>`
    );
    await writeFile(
      join(dir, "sitemap-1.xml"),
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://loverbaazar.com/</loc></url><url><loc>https://loverbaazar.com/about-us/</loc></url></urlset>`
    );
    const urls = await collectProductionUrls(dir, "https://loverbaazar.com");
    assert.deepEqual(urls, [
      "https://loverbaazar.com/",
      banglaURL,
      "https://loverbaazar.com/shop/?a=1&b=2",
      "https://loverbaazar.com/about-us/",
    ]);
    assert.throws(
      () => extractSitemapUrls(`<urlset><url><loc>https://evil.example/</loc></url></urlset>`, "https://loverbaazar.com"),
      /origin mismatch/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyKeyFile checks HTTP status and exact content without leaking secrets", async () => {
  await verifyKeyFile({
    siteOrigin: "https://loverbaazar.com",
    key,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, `/${key}.txt`);
      return new Response(`${key}\n`, { status: 200 });
    },
  });

  await assert.rejects(
    verifyKeyFile({
      siteOrigin: "https://loverbaazar.com",
      key,
      fetchImpl: async () => new Response("secret-html-body", { status: 404 }),
    }),
    err => {
      assert.match(err.message, /HTTP 404/);
      assert.doesNotMatch(err.message, new RegExp(key));
      assert.doesNotMatch(err.message, /secret-html-body/);
      return true;
    }
  );

  await assert.rejects(
    verifyKeyFile({
      siteOrigin: "https://loverbaazar.com",
      key,
      fetchImpl: async () => new Response("wrong-key-value", { status: 200 }),
    }),
    err => {
      assert.match(err.message, /does not match/);
      assert.doesNotMatch(err.message, new RegExp(key));
      assert.doesNotMatch(err.message, /wrong-key-value/);
      return true;
    }
  );
});

test("submitIndexNow chunks batches, verifies payload, handles 200/202, and errors safely", async () => {
  const requests = [];
  const logs = [];
  const urls = [
    "https://loverbaazar.com/",
    "https://loverbaazar.com/shop/",
    "https://loverbaazar.com/offers/",
    "https://loverbaazar.com/blog/",
    "https://loverbaazar.com/shop/",
  ];

  const result = await submitIndexNow({
    siteOrigin: "https://loverbaazar.com",
    key,
    urls,
    batchSize: 2,
    report: line => logs.push(line),
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      if (href === `https://loverbaazar.com/${key}.txt`) {
        return new Response(key, { status: 200 });
      }
      requests.push({ href, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(null, { status: requests.length === 1 ? 200 : 202 });
    },
  });

  assert.deepEqual(result, { ok: true, submitted: 4, batches: 2 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].href, "https://api.indexnow.org/indexnow");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(requests[0].body, {
    host: "loverbaazar.com",
    key,
    keyLocation: `https://loverbaazar.com/${key}.txt`,
    urlList: ["https://loverbaazar.com/", "https://loverbaazar.com/shop/"],
  });
  assert.deepEqual(requests[1].body.urlList, ["https://loverbaazar.com/offers/", "https://loverbaazar.com/blog/"]);
  assert.equal(logs.length, 2);

  for (const status of [403, 429]) {
    await assert.rejects(
      submitIndexNow({
        siteOrigin: "https://loverbaazar.com",
        key,
        urls: ["https://loverbaazar.com/"],
        verifyKey: false,
        fetchImpl: async () => new Response("upstream detail leak", { status }),
      }),
      err => {
        assert.match(err.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(err.message, new RegExp(key));
        assert.doesNotMatch(err.message, /upstream detail leak/);
        return true;
      }
    );
  }
});
