export const DEFAULT_ADSENSE_CLIENT = "ca-pub-2212378495306002";
export const ADSENSE_CERT_AUTHORITY_ID = "f08c47fec0942fa0";

export function resolveAdsenseClient(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return DEFAULT_ADSENSE_CLIENT;
  if (/^(off|false|none|0)$/i.test(value)) return "";
  if (!/^ca-pub-\d{16}$/.test(value)) {
    throw new Error("Invalid ADSENSE_CLIENT (expected ca-pub-XXXXXXXXXXXXXXXX or off)");
  }
  return value;
}

export function resolveAdSlot(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (!/^\d{8,16}$/.test(value)) {
    throw new Error("Invalid AdSense slot ID (expected 8–16 digits)");
  }
  return value;
}

export function adsTxtContent(client) {
  if (!client) return "";
  return `google.com, ${client.replace(/^ca-/, "")}, DIRECT, ${ADSENSE_CERT_AUTHORITY_ID}\n`;
}
