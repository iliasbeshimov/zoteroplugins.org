import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://zoteroplugins.org",
  output: "static",
  trailingSlash: "never",
  redirects: {
    "/p/zotero-local-mdx-click": "/p/zotero-lexibridge",
    "/p/zotero-local-dictionary": "/p/zotero-lexibridge",
    "/developers/zotero-local-mdx-click": "/developers/zotero-lexibridge",
    "/developers/zotero-local-dictionary": "/developers/zotero-lexibridge",
  },
  // "file" (browse.html) so Cloudflare Pages serves /browse without redirecting to /browse/.
  build: { format: "file" },
  vite: { plugins: [tailwindcss()] },
});
