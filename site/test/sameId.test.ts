import { describe, expect, it } from "vitest";
import {
  listedForks,
  sameIdGroups,
  sameIdNote,
  sameIdOthers,
  sameIdText,
} from "../src/lib/atlas.ts";

/** A plugin page's "N other plugins use the same ID" box, over the real catalogue. */
describe("shared IDs", () => {
  const groups = [...sameIdGroups().values()];

  it("lists every plugin the box counts, up to three, the most used first", () => {
    for (const g of groups)
      for (const p of g.plugins) {
        const others = g.plugins.length - 1;
        const rows = sameIdOthers(g, p);
        expect(rows.length, p.slug).toBe(Math.min(3, others));
        expect(sameIdText(g, p).heading, p.slug).toMatch(
          new RegExp(`^${others} other plugins? uses? `),
        );
        expect(
          rows.map((r) => r.p.slug),
          p.slug,
        ).not.toContain(p.slug);
        expect(new Set(rows.map((r) => r.p.slug)).size, p.slug).toBe(rows.length);
        if (p !== g.plugins[0]) expect(rows[0].p, p.slug).toBe(g.plugins[0]);
      }
  });

  it("puts plugins in the directory before hidden ones, and says which are hidden", () => {
    for (const g of groups)
      for (const p of g.plugins) {
        const rest = sameIdOthers(g, p).filter((r) => r.p !== g.plugins[0]);
        const firstHidden = rest.findIndex((r) => r.p.hidden);
        if (firstHidden >= 0)
          expect(
            rest.slice(firstHidden).every((r) => r.p.hidden),
            p.slug,
          ).toBe(true);
        for (const r of sameIdOthers(g, p))
          expect(r.note.includes("hidden by default"), `${p.slug} → ${r.p.slug}`).toBe(r.p.hidden);
      }
  });

  it("says why a plugin you can't install is hidden", () => {
    for (const g of groups)
      for (const p of g.plugins) {
        if (p.hiddenReason === "removed")
          expect(sameIdNote(g, p), p.slug).toMatch(/removed from GitHub/i);
        if (p.hiddenReason === "no-release")
          expect(sameIdNote(g, p), p.slug).toMatch(/no release to install/i);
        if (p.hiddenReason === "legacy") expect(sameIdNote(g, p), p.slug).toMatch(/older Zotero/i);
      }
  });

  it("finds the Zotadata fork the box once counted without showing", () => {
    const g = groups.find((x) => x.id === "zotadata@zotero.org");
    if (!g) return; // the catalogue moved on
    const top = g.plugins[0];
    const rows = sameIdOthers(g, top);
    expect(rows.length).toBe(g.plugins.length - 1);
    for (const f of listedForks(top).filter((x) => x.addonId === top.addonId))
      expect(rows.map((r) => r.p)).toContain(f);
  });
});
