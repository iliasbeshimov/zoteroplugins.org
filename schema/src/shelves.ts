/**
 * The home page's shelves, shared by the site and the catalogue Zotero Atlas reads, so both show
 * the same picks, the same Rising and the same New and catching on.
 */

/**
 * "Our picks": plugins we chose by hand, each with a screenshot from its own README
 * (site/public/shots/<slug>.jpg, at most 1200px wide). Picked for a grade of A or A+, a release
 * that works with the current Zotero, and a screenshot that shows what it does. Nobody pays to be
 * here. The site shows the first three that still qualify; Zotero Atlas shows the first three the
 * reader hasn't installed, so the list is longer than three. A pick whose plugin stops being
 * listed or stops working drops out until it's replaced.
 */
export interface Pick {
  slug: string;
  /** The screenshot's path under site/public, and its size in px. */
  shot: string;
  w: number;
  h: number;
  /** What the screenshot shows, for its alt text. */
  alt: string;
}

export const PICKS: Pick[] = [
  {
    slug: "zoplicate",
    shot: "/shots/zoplicate.jpg",
    w: 1156,
    h: 768,
    alt: "Zotero's item pane with Zoplicate's Non-duplicates section listing an item marked as not a duplicate",
  },
  {
    slug: "zotero-actions-tags",
    shot: "/shots/zotero-actions-tags.jpg",
    w: 900,
    h: 492,
    alt: "A collection's right-click menu with Actions and Tags' Trigger Action submenu and its shortcut",
  },
  {
    slug: "modern-zotero-themes",
    shot: "/shots/modern-zotero-themes.jpg",
    w: 1200,
    h: 764,
    alt: "The Zotero window split into three of the plugin's colour themes: light, paper and dark",
  },
  {
    slug: "zotero-openalex-pdf",
    shot: "/shots/zotero-openalex-pdf.jpg",
    w: 960,
    h: 338,
    alt: "OpenAlex PDF Finder's progress window: six items with a PDF attached and one not found on OpenAlex",
  },
  {
    slug: "zotero-openalex",
    shot: "/shots/zotero-openalex.jpg",
    w: 960,
    h: 610,
    alt: "A citation graph of a collection beside the item list, with OpenAlex citation counts in a column",
  },
  {
    slug: "zotero-tag-explorer",
    shot: "/shots/zotero-tag-explorer.jpg",
    w: 960,
    h: 640,
    alt: "Tag Explorer's tag list beside every highlight carrying the selected tag, grouped by book",
  },
  {
    slug: "zotero-chatgpt",
    shot: "/shots/zotero-chatgpt.jpg",
    w: 960,
    h: 512,
    alt: "A paper open in the reader with the ChatGPT assistant summarising it in the side pane",
  },
  {
    slug: "zotero-reference-checker",
    shot: "/shots/zotero-reference-checker.jpg",
    w: 960,
    h: 640,
    alt: "A paper's references listed beside the PDF, filtered by section and journal, each marked in your library or not",
  },
  {
    slug: "zotero-time-tracking",
    shot: "/shots/zotero-time-tracking.jpg",
    w: 960,
    h: 533,
    alt: "Reading Time's history: totals for today, the week, the month and all time over a heatmap of reading days",
  },
  {
    slug: "semantic-zotero",
    shot: "/shots/semantic-zotero.jpg",
    w: 960,
    h: 567,
    alt: "A references window from Semantic Scholar listing a paper's cited works, each with an Add button, and an abstract",
  },
];

/** Grades a pick may have. */
export const PICK_GRADES = new Set(["A+", "A"]);

/** Growth over the last days of the census history: new GitHub stars and new downloads. */
export interface Growth {
  stars: number;
  downloads: number;
}

/** What a shelf needs to know about a plugin; the site's plugins and catalogue rows both fit. */
export interface ShelfPlugin {
  slug: string;
  /** owner/repo, as the census history keys it (any case). */
  repo: string;
  grade: string;
  /** Its release works with the current Zotero. */
  currentOk: boolean;
  /** About how many copies of Zotero have it (usage.ts); null without history. */
  inUse: number | null;
  /** When its repository was created. */
  createdAt?: string | null;
}

/** B or better: the grades Rising and New and catching on show. */
const GOOD = new Set(["A+", "A", "B"]);

/**
 * "Rising": the plugins that gained the most GitHub stars in the last six weeks, among those whose
 * downloads grew too. Stars alone can be bought or come from people who never use the plugin, so
 * a plugin also needs:
 * - a grade of B or better, a release that works with the current Zotero, and at least MIN_USE
 *   copies in use;
 * - new downloads in the same weeks;
 * - no more than MAX_PER_THOUSAND new stars per 1,000 copies in use: a burst of stars far ahead of
 *   use is left out until use catches up.
 */
export const RISING_DAYS = 42;
export const MIN_USE = 1000;
export const MAX_PER_THOUSAND = 30;

export function rising<T extends ShelfPlugin>(
  plugins: T[],
  growth: Map<string, Growth>,
  skip: Set<string>,
  n: number,
): { plugin: T; stars: number }[] {
  const out: { plugin: T; stars: number }[] = [];
  for (const p of plugins) {
    if (skip.has(p.slug) || !p.currentOk || !GOOD.has(p.grade)) continue;
    const use = p.inUse ?? 0;
    if (use < MIN_USE) continue;
    const g = growth.get(p.repo.toLowerCase());
    if (!g || g.stars <= 0 || g.downloads <= 0) continue;
    if (g.stars / (use / 1000) > MAX_PER_THOUSAND) continue;
    out.push({ plugin: p, stars: g.stars });
  }
  return out.sort((a, b) => b.stars - a.stars).slice(0, n);
}

/**
 * "New and catching on": repositories created in the last NEW_DAYS before `asOf` (ms), graded B or
 * better and working with the current Zotero, most used first.
 */
export const NEW_DAYS = 90;

export function newest<T extends ShelfPlugin>(plugins: T[], asOf: number, n: number): T[] {
  return plugins
    .filter(
      (p) =>
        p.currentOk &&
        GOOD.has(p.grade) &&
        p.inUse != null &&
        p.createdAt &&
        asOf - Date.parse(p.createdAt) < NEW_DAYS * 86_400_000,
    )
    .sort((a, b) => (b.inUse ?? 0) - (a.inUse ?? 0) || a.slug.localeCompare(b.slug, "en"))
    .slice(0, n);
}
