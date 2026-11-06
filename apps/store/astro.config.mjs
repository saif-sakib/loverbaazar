import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
export default defineConfig({
  site: "https://loverbaazar.com", trailingSlash: "always",
  integrations: [sitemap({ filter: (p) => !/\/(admin|cart|checkout|my-account|track|wishlist|search)\//.test(p) })],
  vite: { server: { proxy: { "/api": "http://127.0.0.1:8080" } } },
});
