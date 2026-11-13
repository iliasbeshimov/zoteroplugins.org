import type { Plugin } from "./atlas.ts";
import type { Growth } from "./usage.ts";

/**
 * "Rising" on the home page: the plugins that gained the most GitHub stars in the last six weeks,
 * among those whose downloads grew too. Stars alone can be bought or come from people who never
 * use the plugin, so a plugin also needs:
 * - a grade of B or better, a release that works with the current Zotero, and at least MIN_USE
 *   copies in use (lib/usage.ts);
 * - new downloads in the same weeks;
 * - no more than MAX_PER_THOUSAND new stars per 1,000 copies in use: a burst of stars far ahead of
 *   use is left out until use catches up.
 */
export const RISING_DAYS = 42;
export const MIN_USE = 1000;
export const MAX_PER_THOUSAND = 30;
const GOOD = new Set(["A+", "A", "B"]);

export interface Riser {
  plugin: Plugin;
  /** Stars gained in the last RISING_DAYS. */
  stars: number;
}

export function rising(
  plugins: Plugin[],
  growth: Map<string, Growth>,
  skip: Set<string>,
  n: number,
): Riser[] {
  const out: Riser[] = [];
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
