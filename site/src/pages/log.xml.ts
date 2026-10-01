import type { APIRoute } from "astro";
import { gradeLog } from "../lib/gradeLog.ts";
import { SITE } from "../lib/links.ts";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The grade log as RSS 2.0. */
export const GET: APIRoute = () => {
  const items = gradeLog()
    .slice(0, 100)
    .map((c) => {
      const title = `${c.name} v${c.version}: ${c.from ? `${c.from} → ` : "new, "}${c.to}`;
      const link = `${SITE}/p/${c.slug}`;
      return `<item><title>${esc(title)}</title><link>${link}</link><guid isPermaLink="false">${esc(`${c.slug}@${c.version}:${c.to}`)}</guid><pubDate>${new Date(c.date).toUTCString()}</pubDate><description>${esc(c.why)}</description></item>`;
    })
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Zotero Plugins Atlas: grade log</title><link>${SITE}/log</link><description>Every change to a Zotero plugin's Atlas grade, up or down.</description>${items}</channel></rss>`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
};
