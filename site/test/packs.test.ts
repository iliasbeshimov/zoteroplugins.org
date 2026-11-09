import { describe, expect, it } from "vitest";
import { allPlugins } from "../src/lib/atlas.ts";
import { countWord, PACKS, packSlugs, packTitle } from "../src/lib/packs.ts";

describe("plugin packs", () => {
  it("name only plugins the catalogue has, so a renamed repo doesn't silently drop a pick", () => {
    const known = new Set(allPlugins().map((p) => p.slug));
    expect(packSlugs().filter((s) => !known.has(s))).toEqual([]);
  });

  it("hold five or six tasks each, with no plugin picked twice in a pack", () => {
    for (const pack of PACKS) {
      expect(pack.picks.length, pack.slug).toBeGreaterThanOrEqual(5);
      expect(pack.picks.length, pack.slug).toBeLessThanOrEqual(6);
      const first = pack.picks.map((k) => k.plugins[0]);
      expect(new Set(first).size, pack.slug).toBe(first.length);
    }
  });

  it("have unique slugs and readable titles", () => {
    expect(new Set(PACKS.map((k) => k.slug)).size).toBe(PACKS.length);
    const phd = PACKS.find((k) => k.slug === "phd-students");
    expect(phd && packTitle(phd)).toBe("Zotero plugins for PhD students");
    expect(countWord(6)).toBe("six");
  });
});
