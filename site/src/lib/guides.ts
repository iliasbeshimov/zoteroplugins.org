import { JOBS } from "@atlas/schema";
import { CURRENT_ZOTERO_MAJOR, type Grade, type Plugin, RANK, shownPlugins } from "./atlas.ts";
import { SITE } from "./links.ts";
import { pageEntries } from "./seo.ts";

/**
 * The guide pages: short answers to the questions people search for and ask chatbots ("are
 * Zotero plugins safe?", "ZotFile on Zotero 7"), each built from the same data as the cards.
 * Every number on them is computed here or on the page at build time.
 */
export const GUIDES = [
  { path: "/are-zotero-plugins-safe", name: "Are Zotero plugins safe?" },
  { path: "/best", name: "Best-graded plugins by job" },
  { path: "/for", name: "Plugin packs for students and researchers" },
  { path: "/librarians", name: "For librarians: a box for your guide" },
  { path: "/works-with-zotero", name: "Plugins for the current Zotero" },
  { path: "/ai-without-api-key", name: "AI plugins without an API key" },
  { path: "/zotero-6-plugins", name: "Zotero 6 plugin replacements" },
  { path: "/state-of-zotero-plugins", name: "The state of Zotero plugins" },
] as const;

export const PUBLISHER = { "@type": "Organization", name: "Zotero Plugins Atlas", url: `${SITE}/` };

/** When a guide's data last changed: the sitemap's lastmod for its path. */
export const modifiedAt = (path: string): string | undefined =>
  pageEntries().find((e) => e.loc === `${SITE}${path}`)?.lastmod ?? undefined;

/** Home › name, or Home › parent › name for a page under a list page. */
export function breadcrumb(name: string, path: string, parent?: { name: string; path: string }) {
  const steps = [{ name: "Home", path: "/" }, ...(parent ? [parent] : []), { name, path }];
  return {
    "@type": "BreadcrumbList",
    itemListElement: steps.map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: s.name,
      item: `${SITE}${s.path === "/" ? "/" : s.path}`,
    })),
  };
}

/** An ItemList of plugin pages: the first `max` in order, with the full count. */
export function itemList(plugins: Plugin[], max = 50) {
  return {
    "@type": "ItemList",
    numberOfItems: plugins.length,
    itemListElement: plugins.slice(0, max).map((p, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE}/p/${p.slug}`,
      name: p.name,
    })),
  };
}

/** A list page: the page, what it lists, and its breadcrumb. */
export function collectionPage(o: {
  path: string;
  name: string;
  description: string;
  plugins: Plugin[];
}) {
  return [
    {
      "@type": "CollectionPage",
      "@id": `${SITE}${o.path}`,
      url: `${SITE}${o.path}`,
      name: o.name,
      description: o.description,
      dateModified: modifiedAt(o.path),
      isPartOf: { "@type": "WebSite", name: "Zotero Plugins Atlas", url: `${SITE}/` },
      publisher: PUBLISHER,
      mainEntity: itemList(o.plugins),
    },
    breadcrumb(o.name, o.path),
  ];
}

/** Graded A+, A, B or C, best first. */
const GRADED: Grade[] = ["A+", "A", "B", "C"];

/** How many listed plugins got each grade, for the answers' opening lines. */
export function gradeCounts() {
  const plugins = shownPlugins();
  const n = (g: Grade) => plugins.filter((p) => p.grade === g).length;
  return {
    total: plugins.length,
    graded: plugins.filter((p) => GRADED.includes(p.grade)).length,
    a: n("A+") + n("A"),
    aPlus: n("A+"),
    b: n("B"),
    c: n("C"),
    none: n("–"),
  };
}

/** Plugins below this many downloads are mostly days-old experiments (as for "Other plugins that do this"). */
export const MIN_DOWNLOADS = 50;

/**
 * The best-graded plugins for a job (their main job only): listed, working with the current Zotero, graded B or better,
 * with some users. Better grade first, then more downloads.
 */
export function bestFor(job: string, n = 5): Plugin[] {
  return shownPlugins()
    .filter(
      (p) =>
        p.mainJob === job &&
        p.currentOk &&
        RANK[p.grade] >= RANK.B &&
        p.downloadsN >= MIN_DOWNLOADS &&
        !p.retired,
    )
    .sort((a, b) => RANK[b.grade] - RANK[a.grade] || b.downloadsN - a.downloadsN)
    .slice(0, n);
}

export const jobsWithBest = () => JOBS.map((j) => ({ job: j, plugins: bestFor(j.slug) }));

export const currentMajor = () => CURRENT_ZOTERO_MAJOR();

/** "1,547" in the site's number style. */
export const num = (n: number) => n.toLocaleString("en-GB");
