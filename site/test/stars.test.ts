import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../src/lib/atlas.ts";
import { historyOf, readStarRows, sparkPath } from "../src/lib/stars.ts";

const HEAD = "date,repo,verdict,stars,forks,downloads";
const row = (date: string, repo: string, stars: number | "") =>
  `${date},${repo},zotero-plugin,${stars},0,10`;

function history(files: Record<string, string[]>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "stars-")), "history");
  mkdirSync(dir);
  for (const [name, rows] of Object.entries(files))
    writeFileSync(join(dir, name), `${[HEAD, ...rows].join("\n")}\n`);
  return dir;
}

describe("star history", () => {
  const dir = history({
    "2026-09.csv": [row("2026-09-25", "Owner/Plugin", 100)],
    "2026-10.csv": [
      row("2026-10-07", "Owner/Plugin", 120),
      row("2026-10-20", "Owner/Plugin", 130),
      row("2026-10-20", "gone/old", 5),
    ],
    "2026-11.csv": [
      row("2026-11-18", "Owner/Plugin", 150),
      row("2026-11-18", "a/falls", 9),
      row("2026-10-01", "a/falls", 12),
      row("2026-11-18", "new/one", 3),
      row("2026-11-18", "x/blank", ""),
    ],
  });
  const rows = readStarRows(dir);

  it("counts the gain since the last row at least six weeks old, matching the repo in any case", () => {
    const h = historyOf(rows, "owner/plugin");
    expect(h?.now).toBe(150);
    // 18 Nov − 42 days = 7 Oct: the 7 Oct row is the start.
    expect(h?.gain).toBe(30);
    expect(h?.points.map((p) => p[0])).toEqual(["2026-10-07", "2026-10-20", "2026-11-18"]);
  });

  it("shows a loss as a negative gain: people can take their star back", () => {
    expect(historyOf(rows, "a/falls")?.gain).toBe(-3);
  });

  it("has no gain for a repo newer than the window, and nothing for one gone from the newest census", () => {
    expect(historyOf(rows, "new/one")).toMatchObject({ now: 3, gain: null });
    expect(historyOf(rows, "gone/old")).toBeNull();
    expect(historyOf(rows, "x/blank")).toBeNull();
  });

  it("draws a path across the box, and a flat line through the middle", () => {
    const pts: [string, number][] = [
      ["2026-10-07", 10],
      ["2026-11-18", 20],
    ];
    expect(sparkPath(pts, 300, 48)).toBe("M0.0,44.0 L300.0,4.0");
    expect(sparkPath([pts[0], ["2026-11-18", 10]], 300, 48)).toBe("M0.0,24.0 L300.0,24.0");
    expect(sparkPath([pts[0]], 300, 48)).toBe("");
  });
});

describe("gallery file", () => {
  const f = `${ROOT}census/gallery.json`;
  const pub = join(ROOT, "../site/public/gallery");
  it.runIf(existsSync(f))(
    "names only pictures that exist, with captions short enough to read",
    () => {
      const g = JSON.parse(readFileSync(f, "utf8")) as {
        plugins: Record<
          string,
          {
            readmeImages: number;
            shots: { file: string; w: number; h: number; caption: string; anim: string | null }[];
          }
        >;
      };
      for (const [repo, { readmeImages, shots }] of Object.entries(g.plugins)) {
        expect(repo).toBe(repo.toLowerCase());
        expect(shots.length).toBeGreaterThan(0);
        expect(shots.length).toBeLessThanOrEqual(Math.min(6, readmeImages));
        for (const s of shots) {
          expect(existsSync(join(pub, s.file)), s.file).toBe(true);
          if (s.anim) expect(existsSync(join(pub, s.anim)), s.anim).toBe(true);
          expect(s.w).toBeGreaterThan(0);
          expect(s.h).toBeGreaterThan(0);
          expect(s.caption.split(/\s+/).length).toBeLessThanOrEqual(16);
        }
      }
    },
  );
});
