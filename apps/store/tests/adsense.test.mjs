import test from "node:test";
import assert from "node:assert/strict";
import {
  ADSENSE_CERT_AUTHORITY_ID,
  DEFAULT_ADSENSE_CLIENT,
  adsTxtContent,
  resolveAdSlot,
  resolveAdsenseClient,
} from "../src/lib/adsense.mjs";

test("resolveAdsenseClient uses store default when unset and supports explicit override or kill switch", () => {
  assert.equal(resolveAdsenseClient(undefined), DEFAULT_ADSENSE_CLIENT);
  assert.equal(resolveAdsenseClient(""), DEFAULT_ADSENSE_CLIENT);
  assert.equal(resolveAdsenseClient("  "), DEFAULT_ADSENSE_CLIENT);
  assert.equal(resolveAdsenseClient("ca-pub-1234567890123456"), "ca-pub-1234567890123456");
  for (const off of ["off", "OFF", "false", "none", "0"]) {
    assert.equal(resolveAdsenseClient(off), "");
  }
  for (const bad of ["pub-2212378495306002", "ca-pub-123", "ca-pub-2212378495306002;evil"]) {
    assert.throws(() => resolveAdsenseClient(bad), /Invalid ADSENSE_CLIENT/);
  }
});

test("resolveAdSlot accepts empty or 8-16 digit IDs and rejects invalid values", () => {
  assert.equal(resolveAdSlot(undefined), "");
  assert.equal(resolveAdSlot(" "), "");
  assert.equal(resolveAdSlot("1234567890"), "1234567890");
  assert.throws(() => resolveAdSlot("1234"), /Invalid AdSense slot/);
  assert.throws(() => resolveAdSlot("12345abc"), /Invalid AdSense slot/);
});

test("adsTxtContent formats authorized seller line accurately", () => {
  assert.equal(adsTxtContent(""), "");
  assert.equal(
    adsTxtContent(DEFAULT_ADSENSE_CLIENT),
    `google.com, pub-2212378495306002, DIRECT, ${ADSENSE_CERT_AUTHORITY_ID}\n`,
  );
});
