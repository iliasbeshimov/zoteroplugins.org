import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shownPlugins } from "../src/lib/atlas.ts";
import { PICK_GRADES, PICKS } from "../src/lib/picks.ts";

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(file: string): [number, number] {
  const b = readFileSync(file);
  let i = 2;
  while (i < b.length) {
    const marker = b[i + 1] ?? 0;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  return [0, 0];
}

describe("our picks", () => {
  const bySlug = new Map(shownPlugins().map((p) => [p.slug, p]));

  it("names listed plugins once each, with a screenshot of the stated size", () => {
    expect(new Set(PICKS.map((k) => k.slug)).size).toBe(PICKS.length);
    for (const k of PICKS) {
      expect(bySlug.has(k.slug), k.slug).toBe(true);
      const file = new URL(`../public${k.shot}`, import.meta.url).pathname;
      expect(existsSync(file), file).toBe(true);
      expect(jpegSize(file), k.slug).toEqual([k.w, k.h]);
      expect(k.alt.length).toBeGreaterThan(20);
    }
  });

  it("has more than three to choose from, and at least three that qualify today", () => {
    expect(PICKS.length).toBeGreaterThan(3);
    const ok = PICKS.filter((k) => {
      const p = bySlug.get(k.slug);
      return p?.currentOk && PICK_GRADES.has(p.grade);
    });
    expect(ok.length).toBeGreaterThanOrEqual(3);
  });
});
