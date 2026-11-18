import { posts, SITE, siteUrl } from "../../lib/shop";
import { recordSEO, summary, xmlText as xml } from "../../lib/seo";

const items = posts.filter(p => !recordSEO(p, p.title).noindex).slice(0, 30).map(p => {
  const canonical = recordSEO(p, p.title).canonical || siteUrl(`/${p.slug}/`);
  const date = new Date(p.date);
  return `<item><title>${xml(p.title)}</title><link>${xml(canonical)}</link><guid>${xml(canonical)}</guid>
    <description>${xml(summary(p.excerpt || p.html) || p.title)}</description>
    ${Number.isNaN(date.getTime()) ? "" : `<pubDate>${date.toUTCString()}</pubDate>`}</item>`;
});
export const GET = () => new Response(
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>${xml(SITE.name)} Blog</title><link>${xml(siteUrl("/blog/"))}</link>
    <description>${xml(SITE.description)}</description>${items.join("")}</channel></rss>`,
  { headers: { "Content-Type": "application/xml; charset=utf-8" } },
);
