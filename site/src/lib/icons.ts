import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./atlas.ts";

/**
 * Plugin icons: site/public/icons/<slug>.png, written by `atlas icons` from the icon each plugin
 * declares in its graded release file. Plugins without one (none declared, the template's stock
 * icon, too small, blank) have no file and get a letter tile.
 */
let have: Set<string> | null = null;

export function iconOf(slug: string): string | null {
  if (!have) {
    const dir = join(ROOT, "..", "site", "public", "icons");
    have = new Set(
      existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".png"))
            .map((f) => f.slice(0, -".png".length))
        : [],
    );
  }
  return have.has(slug) ? `/icons/${slug}.png` : null;
}

/** The letter for a plugin without an icon: its name's first letter after a leading "Zotero". */
export const iconLetter = (name: string): string =>
  (name.replace(/^zotero[\s-]*/i, "").match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
