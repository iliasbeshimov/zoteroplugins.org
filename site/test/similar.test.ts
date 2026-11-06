import { describe, expect, it } from "vitest";
import { allPlugins, bySlug, RANK } from "../src/lib/atlas.ts";
import { similarFloor, similarPlugins } from "../src/lib/similar.ts";

/** "Other plugins that do this", over the real catalogue. */
describe("similar plugins", () => {
  const plugins = allPlugins();
  const by = bySlug();
  const results = plugins.map((p) => ({ p, ...similarPlugins(p) }));

  it("only suggests plugins that pass the bar, at most three, closest first", () => {
    for (const { p, shown, total } of results) {
      expect(shown.length).toBeLessThanOrEqual(3);
      expect(total).toBeGreaterThanOrEqual(shown.length);
      for (const s of shown) {
        expect(s.p.slug).not.toBe(p.slug);
        expect(s.p.currentOk, `${p.slug} → ${s.p.slug}`).toBe(true);
        expect(RANK[s.p.grade], `${p.slug} → ${s.p.slug}`).toBeGreaterThanOrEqual(
          RANK[similarFloor(p)],
        );
        expect(s.p.retired).toBeNull();
        expect(s.p.downloadsN).toBeGreaterThanOrEqual(50);
        if (p.addonId) expect(s.p.addonId).not.toBe(p.addonId);
        expect(s.p.jobs.some((j) => p.jobs.includes(j))).toBe(true);
        expect(s.labels.length).toBeLessThanOrEqual(2);
      }
      const scores = shown.map((s) => s.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    }
  });

  it("shows nothing rather than a weak match for most plugins", () => {
    const none = results.filter((r) => r.shown.length === 0).length;
    expect(none / results.length).toBeGreaterThan(0.3);
  });

  it("finds the usual replacements for ZotFile, which doesn't work with Zotero 10", () => {
    const zotfile = by.zotfile;
    if (!zotfile) return;
    const shown = similarPlugins(zotfile).shown;
    const slugs = shown.map((s) => s.p.slug);
    expect(slugs.some((s) => s === "zotmoov" || s === "zotero-attanger")).toBe(true);
    expect(shown[0].labels).toContain(`Works with Zotero ${zotfile.currentMajor}`);
  });

  it("matches plugins on the job, not just the category", () => {
    const list = by["zotero-reading-list"];
    if (!list) return;
    const shown = similarPlugins(list).shown;
    expect(shown.length).toBeGreaterThan(0);
    for (const s of shown)
      expect(`${s.p.search.desc} ${s.p.search.ask}`.toLowerCase()).toMatch(/read/);
  });
});
