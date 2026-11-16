import { PACKS, type Pack, type PackPick, packSlugs } from "@atlas/schema";
import { bySlug, type Plugin, RANK } from "./atlas.ts";

// The packs themselves live in the schema package (schema/src/packs.ts): Zotero Atlas reads them
// from the catalogue too.
export { PACKS, type Pack, type PackPick, packSlugs };

/** Fit for a pack: listed, working with the current Zotero, graded B or better, still offered. */
export const packable = (p: Plugin): boolean =>
  !p.hidden && p.currentOk && RANK[p.grade] >= RANK.B && !p.retired && !p.removed;

export interface ResolvedPick {
  task: string;
  why: string;
  ifYou: string | null;
  plugin: Plugin;
  or: { ifYou: string; why: string; plugin: Plugin } | null;
}

/** The first plugin in the list that's fit for a pack, or null. */
function first(slugs: string[], all: Record<string, Plugin>): Plugin | null {
  for (const s of slugs) {
    const p = all[s];
    if (p && packable(p)) return p;
  }
  return null;
}

/** A pack's picks with today's plugins; a task with no fit plugin left is dropped. */
export function resolvePack(pack: Pack): ResolvedPick[] {
  const all = bySlug();
  return pack.picks.flatMap((k) => {
    const plugin = first(k.plugins, all);
    if (!plugin) return [];
    const orPlugin = k.or ? first(k.or.plugins, all) : null;
    return [
      {
        task: k.task,
        why: k.why,
        ifYou: k.ifYou ?? null,
        plugin,
        or: k.or && orPlugin ? { ifYou: k.or.ifYou, why: k.or.why, plugin: orPlugin } : null,
      },
    ];
  });
}

/** "six", for "Six plugins…" when the count is small. */
export const countWord = (n: number): string =>
  ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"][n] ?? String(n);

/** "Zotero plugins for PhD students": the pack's page heading. */
export const packTitle = (pack: Pack) =>
  `Zotero plugins for ${pack.name.toLowerCase().replace(/^phd\b/, "PhD")}`;

/** The pack's page and its PDF. */
export const packPath = (pack: Pack) => `/for/${pack.slug}`;
export const packPdf = (pack: Pack) => `/for/${pack.slug}.pdf`;
/** The file name a downloaded PDF is saved under. */
export const packPdfName = (pack: Pack) => `zotero-plugins-for-${pack.slug}.pdf`;
