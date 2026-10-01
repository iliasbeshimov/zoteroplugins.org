import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://zoteroplugins.org",
  output: "static",
  trailingSlash: "never",
  // "file" (browse.html) so Cloudflare Pages serves /browse without redirecting to /browse/.
  build: { format: "file" },
  vite: { plugins: [tailwindcss()] },
});
