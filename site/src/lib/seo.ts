import { existsSync, readFileSync } from "node:fs";
import { JOBS } from "@atlas/schema";
import { allPlugins, type Plugin, ROOT } from "./atlas.ts";
import { gradeLog } from "./gradeLog.ts";
import { SITE } from "./links.ts";
import { PACKS, packPath } from "./packs.ts";

/**
 * Which plugin pages search engines should index: every listed plugin, plus legacy and retired
 * ones, which people still look up ("ZotFile on Zotero 7"). Forks, cards with nothing to install
 * and cards for deleted repos stay reachable from the site but out of search indexes. The sitemap
 * lists exactly the indexable pages.
 */
export const indexable = (p: Plugin): boolean =>
  !p.hidden || p.hiddenReason === "legacy" || p.hiddenReason === "retired";

/** The guide pages (lib/guides.ts), which answer the questions people search for. */
const GUIDE_PATHS = [
  "/are-zotero-plugins-safe",
  "/best",
  "/for",
  ...PACKS.map(packPath),
  "/librarians",
  "/works-with-zotero",
  "/ai-without-api-key",
  "/zotero-6-plugins",
  "/state-of-zotero-plugins",
];
/** Pages that aren't plugin cards, in the order they appear in the sitemap. */
const PAGES = [
  "/",
  "/browse",
  ...JOBS.map((j) => `/c/${j.slug}`),
  "/how-we-grade",
  ...GUIDE_PATHS,
  "/install",
  "/log",
  "/developers",
  "/submit",
  "/about",
];
/** Pages whose content moves with the data (lists, counts, the log). */
const DATA_PAGES = new Set([
  "/",
  "/browse",
  "/log",
  ...JOBS.map((j) => `/c/${j.slug}`),
  ...GUIDE_PATHS,
]);

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

const day = (iso: string) => iso.slice(0, 10);
export const latest = (dates: (string | null | undefined)[]): string | null =>
  dates
    .filter((d): d is string => !!d)
    .sort()
    .at(-1) ?? null;

/** When the plugin summaries were last written, from data/census/summaries.json. */
function describedAt(): string | null {
  const f = `${ROOT}census/summaries.json`;
  return existsSync(f)
    ? ((JSON.parse(readFileSync(f, "utf8")) as { writtenAt?: string }).writtenAt ?? null)
    : null;
}

/**
 * A plugin page changes when a new release is graded, when its grade moves, or when its summary
 * is written. Build times aren't used: they'd change every page every day, and search engines
 * learn to ignore a lastmod that always says "today".
 */
export function pluginEntries(): SitemapEntry[] {
  const changed = new Map<string, string>();
  for (const c of gradeLog()) if (!changed.has(c.slug)) changed.set(c.slug, c.at);
  const written = describedAt();
  return allPlugins()
    .filter(indexable)
    .map((p) => {
      const last = latest([p.releasedAt, changed.get(p.slug), p.description ? written : null]);
      return { loc: `${SITE}/p/${p.slug}`, lastmod: last ? day(last) : null };
    });
}

export function pageEntries(): SitemapEntry[] {
  const newest = latest([
    ...pluginEntries().map((e) => e.lastmod),
    ...gradeLog()
      .slice(0, 1)
      .map((c) => day(c.at)),
  ]);
  return PAGES.map((path) => ({
    loc: `${SITE}${path === "/" ? "/" : path}`,
    lastmod: DATA_PAGES.has(path) ? newest : null,
  }));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function urlset(entries: SitemapEntry[]): Response {
  const body = entries
    .map(
      (e) =>
        `<url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`,
    )
    .join("\n");
  return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`);
}

export function sitemapIndex(maps: SitemapEntry[]): Response {
  const body = maps
    .map(
      (e) =>
        `<sitemap><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</sitemap>`,
    )
    .join("\n");
  return xml(
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>`,
  );
}

const xml = (s: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${s}\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
