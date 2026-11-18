// Share width buckets across cards, mobile galleries and home to bound derived variants.
const widths = new Set([160, 320, 640, 960]);
export function sizedImage(source, width) {
  if (!widths.has(width)) throw new Error("Unapproved image width");
  const safe = source || "/placeholder.svg";
  try {
    const url = new URL(safe);
    if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || url.username || url.password || url.search || url.hash) return safe;
    // Replace only transformation chains owned by this app, never an arbitrary incoming transform.
    const path = /^(\/[^/]+\/image\/upload\/)(?:(?:f_auto(?:,q_auto(?:,w_\d+)?)?|q_auto|c_limit,w_\d+)\/)*(v\d+\/.*|loverbaazar\/.*)$/;
    if (path.test(url.pathname)) url.pathname = url.pathname.replace(path, `$1c_limit,w_${width}/q_auto/f_auto/$2`);
    return url.href;
  } catch {
    return safe;
  }
}

export function responsiveImage(source, fallback, buckets) {
  const original = source || fallback;
  const src = sizedImage(original, buckets[0]);
  if (src === original || !original) return { src: fallback || src };
  const candidates = buckets.map(width => `${sizedImage(original, width)} ${width}w`);
  return { src, srcset: candidates.length > 1 ? candidates.join(", ") : undefined };
}

export const cardSizes = "(min-width: 1200px) 220px, (min-width: 900px) 23vw, (min-width: 600px) 30vw, 46vw";
export const gallerySizes = "(min-width: 1100px) 510px, (min-width: 900px) 48vw, 94vw";
