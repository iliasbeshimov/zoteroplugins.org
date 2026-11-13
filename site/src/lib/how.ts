import { existsSync, readFileSync } from "node:fs";
import { bySlug, type Plugin, RANK, ROOT } from "./atlas.ts";

/**
 * "How do I … in Zotero" pages: capabilities people asked for on the Zotero forum that a listed
 * plugin provides (data/how.json, chosen by hand from the forum threads). Each page names up to
 * three plugins that work with the current Zotero, graded B or better, best grade first, then
 * downloads. A plugin that drops below B or stops working leaves the page on the next build, and a
 * page with no plugin left isn't built.
 */
export interface HowThread {
  url: string;
  title: string;
  /** When the thread was opened (YYYY-MM-DD). */
  opened: string;
}
export interface HowEntry {
  slug: string;
  /** The capability, as the page title: "Tab groups in Zotero". */
  title: string;
  /** One plain sentence: what people asked for. */
  asked: string;
  /** What the Zotero team said, in our words, and the thread where they said it. */
  zotero?: { text: string; url: string };
  plugins: string[];
  threads: HowThread[];
}
export interface HowPage extends HowEntry {
  path: string;
  picks: Plugin[];
  /** "May 2025": the oldest thread's month. */
  since: string;
}

const MAX = 3;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const month = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

function load(): HowEntry[] {
  const f = `${ROOT}how.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { pages: HowEntry[] }).pages : [];
}

let pages: HowPage[] | undefined;
export function howPages(): HowPage[] {
  if (pages) return pages;
  const all = bySlug();
  pages = load()
    .map((e) => {
      const picks = e.plugins
        .map((s) => all[s])
        .filter(
          (p): p is Plugin =>
            !!p && !p.hidden && !p.retired && p.currentOk && RANK[p.grade] >= RANK.B,
        )
        .sort((a, b) => RANK[b.grade] - RANK[a.grade] || b.downloadsN - a.downloadsN)
        .slice(0, MAX);
      const oldest = e.threads.map((t) => t.opened).sort()[0] ?? "";
      return { ...e, path: `/how/${e.slug}`, picks, since: oldest ? month(oldest) : "" };
    })
    .filter((p) => p.picks.length > 0);
  return pages;
}
