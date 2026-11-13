import { describe, expect, it } from "vitest";
import type { Plugin } from "../src/lib/atlas.ts";
import { rising } from "../src/lib/rising.ts";
import type { Growth } from "../src/lib/usage.ts";

const plugin = (slug: string, o: Partial<Plugin> = {}): Plugin =>
  ({ slug, repo: `o/${slug}`, grade: "A", currentOk: true, inUse: 10_000, ...o }) as Plugin;
const growth = (m: Record<string, Growth>) =>
  new Map(Object.entries(m).map(([k, v]) => [`o/${k}`, v]));

describe("rising", () => {
  it("ranks by new stars among plugins whose downloads grew too", () => {
    const ps = [plugin("a"), plugin("b"), plugin("c")];
    const g = growth({
      a: { stars: 50, downloads: 100 },
      b: { stars: 90, downloads: 100 },
      c: { stars: 200, downloads: 0 },
    });
    expect(rising(ps, g, new Set(), 6).map((r) => r.plugin.slug)).toEqual(["b", "a"]);
  });

  it("leaves out stars far ahead of use, poor grades, small or unlisted-for-now plugins and skipped ones", () => {
    const ps = [
      plugin("burst", { inUse: 2000 }), // 61 stars per 1,000 in use
      plugin("c-grade", { grade: "C" }),
      plugin("small", { inUse: 900 }),
      plugin("old-zotero", { currentOk: false }),
      plugin("skipped"),
      plugin("ok"),
    ];
    const g = growth({
      burst: { stars: 122, downloads: 10 },
      "c-grade": { stars: 80, downloads: 10 },
      small: { stars: 20, downloads: 10 },
      "old-zotero": { stars: 80, downloads: 10 },
      skipped: { stars: 80, downloads: 10 },
      ok: { stars: 5, downloads: 10 },
    });
    expect(rising(ps, g, new Set(["skipped"]), 6).map((r) => r.plugin.slug)).toEqual(["ok"]);
  });
});
