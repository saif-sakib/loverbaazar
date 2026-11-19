import { defineConfig } from "astro/config";
import { copyFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { buildIndex } from "./build-index.mjs";

const site = new URL(process.env.SITE_ORIGIN || "https://loverbaazar.com");
const require = createRequire(import.meta.url);
const invoiceAssets = {
  "pdfmake-0.3.14.js": "pdfmake/build/pdfmake.min.js",
  "pdfmake-license.txt": "pdfmake/LICENSE",
  "latin.woff": "@fontsource/noto-sans-bengali/files/noto-sans-bengali-latin-400-normal.woff",
  "bold.woff": "@fontsource/noto-sans-bengali/files/noto-sans-bengali-latin-700-normal.woff",
  "bengali.woff": "@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff",
  "noto-sans-bengali-license.txt": "@fontsource/noto-sans-bengali/LICENSE",
};
if (site.protocol !== "https:" || site.href !== site.origin + "/") throw new Error("SITE_ORIGIN must be an HTTPS origin");

export default defineConfig({
  site: site.href,
  publicDir: process.env.BUILD_PUBLIC_DIR || "./public",
  trailingSlash: "always",
  compressHTML: true,
  integrations: [{
    name: "release-metadata",
    hooks: {
      "astro:build:done": async ({ dir, pages }) => {
        const environment = process.env.BUILD_ENV || "preview";
        if (!["local", "preview", "production"].includes(environment)) throw new Error("Invalid BUILD_ENV");
        const output = new URL("invoice-assets/", dir);
        await mkdir(output, { recursive: true });
        await Promise.all(Object.entries(invoiceAssets).map(([file, source]) =>
          copyFile(require.resolve(source), new URL(file, output))));
        await buildIndex(dir, pages, site, environment, { indexNowKey: process.env.INDEXNOW_KEY });
        await writeFile(new URL("release.json", dir), JSON.stringify({
          id: process.env.BUILD_ID || "local", commit: process.env.GITHUB_SHA || "local", environment,
          builtAt: new Date().toISOString(),
          revision: process.env.BUILD_REVISION ? Number(process.env.BUILD_REVISION) : null,
        }));
        const previewPattern = environment === "production" ? "https://:worker.:account.workers.dev/*" : "/*";
        const headers = new URL("_headers", dir);
        await writeFile(headers, (await readFile(headers, "utf8")) + `\n${previewPattern}\n  X-Robots-Tag: noindex, nofollow\n`);
      },
    },
  }],
  vite: { server: { proxy: { "/api": "http://127.0.0.1:8080" } } },
});
