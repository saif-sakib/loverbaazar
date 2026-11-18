import { defineConfig } from "astro/config";
import { writeFile, readFile } from "node:fs/promises";
import { buildIndex } from "./build-index.mjs";

const site = new URL(process.env.SITE_ORIGIN || "https://loverbaazar.com");
if (site.protocol !== "https:" || site.href !== site.origin + "/") throw new Error("SITE_ORIGIN must be an HTTPS origin");

export default defineConfig({
  site: site.href,
  trailingSlash: "always",
  integrations: [{
    name: "release-metadata",
    hooks: {
      "astro:build:done": async ({ dir, pages }) => {
        const environment = process.env.BUILD_ENV || "preview";
        if (!["local", "preview", "production"].includes(environment)) throw new Error("Invalid BUILD_ENV");
        await buildIndex(dir, pages, site, environment);
        await writeFile(new URL("release.json", dir), JSON.stringify({
          id: process.env.BUILD_ID || "local", commit: process.env.GITHUB_SHA || "local", environment,
          builtAt: new Date().toISOString(),
        }));
        if (environment !== "production") {
          const path = new URL("_headers", dir);
          await writeFile(path, (await readFile(path, "utf8")) + "\n/*\n  X-Robots-Tag: noindex, nofollow\n");
        }
      },
    },
  }],
  vite: { server: { proxy: { "/api": "http://127.0.0.1:8080" } } },
});
