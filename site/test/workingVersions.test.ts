import { describe, expect, it } from "vitest";
import { allPlugins, bySlug, RANK, workingVersions } from "../src/lib/atlas.ts";

/** "Other developers' versions work with Zotero N", over the real catalogue. */
describe("working versions", () => {
  const plugins = allPlugins();
  const by = bySlug();
  const results = plugins.map((p) => ({ p, shown: workingVersions(p) }));

  it("only shows them for plugins people can't use on the current Zotero", () => {
    for (const { p, shown } of results) {
      if (!shown.length) continue;
      expect(!p.currentOk || !!p.removed || !!p.retired, p.slug).toBe(true);
      expect(p.banner, p.slug).toBeNull();
      expect(p.retired?.alternative ?? null, p.slug).toBeNull();
    }
  });

  it("only suggests versions that pass the bar, best first", () => {
    for (const { p, shown } of results) {
      expect(shown.length).toBeLessThanOrEqual(3);
      for (const v of shown) {
        const x = v.p;
        expect(x.slug).not.toBe(p.slug);
        expect(x.currentOk, `${p.slug} → ${x.slug}`).toBe(true);
        expect(x.installUrl, `${p.slug} → ${x.slug}`).toBeTruthy();
        expect(RANK[x.grade], `${p.slug} → ${x.slug}`).toBeGreaterThanOrEqual(RANK.A);
        expect(x.downloadsN).toBeGreaterThanOrEqual(50);
        expect(x.retired).toBeNull();
        expect(x.removed).toBeNull();
        expect(v.sameId).toBe(!!p.addonId && x.addonId === p.addonId);
        if (!v.sameId)
          expect(
            x.jobs.some((j) => p.jobs.includes(j)),
            `${p.slug} → ${x.slug}`,
          ).toBe(true);
      }
      const key = shown.map((v) => [RANK[v.p.grade], Number(v.p.ownUpdates), v.p.downloadsN]);
      const sorted = [...key].sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
      expect(key).toEqual(sorted);
    }
  });

  it("points DOI Manager to the copy that updates itself first", () => {
    const doi = by["zotero-shortdoi--bwiernik"];
    if (!doi || doi.currentOk) return;
    const shown = workingVersions(doi);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((v) => v.sameId)).toBe(true);
    if (by["zotero-doi-manager"]?.currentOk) expect(shown[0].p.slug).toBe("zotero-doi-manager");
  });

  it("leaves out sibling forks, which can be different plugins", () => {
    // Zotero Memento was published from a fork of DOI Manager's repository.
    const memento = by["zotero-shortdoi-8-update"];
    if (!memento) return;
    expect(workingVersions(memento).map((v) => v.p.name)).not.toContain("DOI Manager");
  });
});
