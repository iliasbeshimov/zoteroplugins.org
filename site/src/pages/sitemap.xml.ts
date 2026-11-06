import type { APIRoute } from "astro";
import { SITE } from "../lib/links.ts";
import { latest, pageEntries, pluginEntries, sitemapIndex } from "../lib/seo.ts";

/** The sitemap index: one sitemap for the site's pages, one for the plugin pages. */
export const GET: APIRoute = () =>
  sitemapIndex([
    { loc: `${SITE}/sitemap-pages.xml`, lastmod: latest(pageEntries().map((e) => e.lastmod)) },
    { loc: `${SITE}/sitemap-plugins.xml`, lastmod: latest(pluginEntries().map((e) => e.lastmod)) },
  ]);
