import { existsSync, readFileSync, writeFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Cards for repos that moved on GitHub redirect to the card for the new name, from the list the
// pipeline keeps (data/generated/redirects.json). Cloudflare Pages reads dist/_redirects.
const movedCards = {
  name: "moved-cards",
  hooks: {
    "astro:build:done": ({ dir }) => {
      const src = new URL("../data/generated/redirects.json", import.meta.url);
      const moved = existsSync(src) ? (JSON.parse(readFileSync(src, "utf8")).moved ?? []) : [];
      const lines = moved.flatMap(({ slug, target }) => [
        `/p/${slug} /p/${target} 301`,
        `/p/${slug}.json /p/${target}.json 301`,
        `/badge/${slug}.svg /badge/${target}.svg 301`,
        `/developers/${slug} /developers/${target} 301`,
      ]);
      writeFileSync(new URL("_redirects", dir), lines.length ? `${lines.join("\n")}\n` : "");
    },
  },
};

export default defineConfig({
  site: "https://zoteroplugins.org",
  output: "static",
  trailingSlash: "never",
  // "file" (browse.html) so Cloudflare Pages serves /browse without redirecting to /browse/.
  build: { format: "file" },
  vite: { plugins: [tailwindcss()] },
  integrations: [movedCards],
});
