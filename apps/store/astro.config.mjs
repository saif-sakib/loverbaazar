import { defineConfig } from "astro/config";
import {writeFile,readFile} from "node:fs/promises";
import sitemap from "@astrojs/sitemap";
export default defineConfig({
  site: process.env.SITE_ORIGIN || "https://loverbaazar.com", trailingSlash: "always",
  integrations: [{name:"release-metadata",hooks:{"astro:build:done":async({dir})=>{
 const environment=process.env.BUILD_ENV||"preview";
 if(!["local","preview","production"].includes(environment))throw new Error("Invalid BUILD_ENV");
 await writeFile(new URL("release.json",dir),JSON.stringify({id:process.env.BUILD_ID||"local",commit:process.env.GITHUB_SHA||"local",environment}));
 if(environment!=="production"){
 const path=new URL("_headers",dir);await writeFile(path,(await readFile(path,"utf8"))+"\n/*\n  X-Robots-Tag: noindex, nofollow\n");
 await writeFile(new URL("robots.txt",dir),"User-agent: *\nDisallow: /\n");
 }
}}},sitemap({ filter: (p) => !/\/(admin|cart|checkout|my-account|track|wishlist|search)\//.test(p) })],
  vite: { server: { proxy: { "/api": "http://127.0.0.1:8080" } } },
});
