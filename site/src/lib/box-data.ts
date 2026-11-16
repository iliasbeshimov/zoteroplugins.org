import { CURRENT_ZOTERO_MAJOR } from "./atlas.ts";
import { SITE } from "./links.ts";
import { PACKS, packPath, packTitle, resolvePack } from "./packs.ts";

/**
 * What the self-updating box for library guides shows (/embed/box.js and /embed/box): each plugin
 * pack's current picks, rebuilt with the site every night, so a pick that stops working or drops
 * below B is replaced the next day without the librarian doing anything.
 */
export interface BoxPick {
  task: string;
  name: string;
  url: string;
  grade: string;
  works: string;
}
export interface BoxPack {
  slug: string;
  title: string;
  url: string;
  picks: BoxPick[];
}
export interface BoxData {
  updated: string;
  currentMajor: number;
  site: string;
  packs: BoxPack[];
}

export function boxData(): BoxData {
  return {
    updated: new Date().toISOString().slice(0, 10),
    currentMajor: CURRENT_ZOTERO_MAJOR(),
    site: SITE,
    packs: PACKS.map((k) => ({
      slug: k.slug,
      title: packTitle(k).replace(/^Zotero plugins/, "Plugins"),
      url: `${SITE}${packPath(k)}`,
      picks: resolvePack(k).map((r) => ({
        task: r.task,
        name: r.plugin.name,
        url: `${SITE}/p/${r.plugin.slug}`,
        grade: r.plugin.grade,
        works: r.plugin.worksRange,
      })),
    })),
  };
}
