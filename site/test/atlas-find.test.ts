import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type CatalogEntry, JOB_ART, JOBS } from "@atlas/schema";
import { describe, expect, it } from "vitest";

/** Zotero Atlas's findlib.js, run as the Atlas window runs it: a script that sets window.ZoteroAtlasLib. */
interface AtlasLib {
  JOBS: [string, string][];
  JOB_ART: unknown;
  words: (q: string) => string[];
  haystack: (e: CatalogEntry) => string;
  score: (e: CatalogEntry, ws: string[]) => number;
}
const lib = (() => {
  const box: { window: { ZoteroAtlasLib?: AtlasLib } } = { window: {} };
  const file = new URL("../../zotero-atlas/src/content/findlib.js", import.meta.url);
  runInNewContext(readFileSync(file, "utf8"), box);
  if (!box.window.ZoteroAtlasLib) throw new Error("findlib.js didn't set window.ZoteroAtlasLib");
  return box.window.ZoteroAtlasLib;
})();
// Values made in the vm context have its prototypes; compare them as plain data.
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("Zotero Atlas and the site agree", () => {
  it("on the jobs and their titles", () => {
    expect(plain(lib.JOBS)).toEqual(JOBS.map((j) => [j.slug, j.title]));
  });

  it("on the tile a plugin without an icon gets", () => {
    expect(plain(lib.JOB_ART)).toEqual(JOB_ART);
  });
});

describe("Zotero Atlas's Best match on the real catalogue", () => {
  const { plugins } = JSON.parse(
    readFileSync(new URL("../../data/generated/catalog.json", import.meta.url), "utf8"),
  ) as { plugins: CatalogEntry[] };
  // Roughly "works with Zotero 10", which Atlas checks exactly against the user's version.
  const fitting = plugins.filter((e) => e.file && e.supports.includes(10));
  const top = (q: string, n = 5) => {
    const ws = lib.words(q);
    return fitting
      .filter((e) => ws.every((w) => lib.haystack(e).includes(w)))
      .map((e) => ({ slug: e.slug, s: lib.score(e, ws) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
      .map((r) => r.slug);
  };

  // Loose on purpose: the catalogue changes every night.
  it("finds the plugin people mean", () => {
    expect(top("better notes")[0]).toBe("zotero-better-notes");
    expect(top("find duplicates")).toContain("zoplicate");
    expect(top("cite in word", 3)).toContain("zotero-citation");
  });

  it("uses how people ask: a search no name or tagline holds still finds plugins", () => {
    expect(top("retracted papers").length).toBeGreaterThan(0);
    // A metadata plugin whose summary mentions papers isn't a way to summarise one.
    expect(top("summarise a paper", 3)).not.toContain("jasminum");
  });
});
