import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fmtUse, loadUsage } from "../src/lib/usage.ts";

const HEAD = "date,repo,verdict,stars,forks,downloads,latest_downloads,latest_tag";
const row = (date: string, repo: string, tag: string, latest: number, total = latest * 10) =>
  `${date},${repo},zotero-plugin,1,0,${total},${latest},${tag}`;

function history(files: Record<string, string[]>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "usage-")), "history");
  mkdirSync(dir);
  for (const [name, rows] of Object.entries(files))
    writeFileSync(join(dir, name), `${[HEAD, ...rows].join("\n")}\n`);
  return dir;
}

describe("in-use estimate", () => {
  it("takes the most-downloaded recent release, not the newest or the all-time total", () => {
    const dir = history({
      "2026-10.csv": [
        row("2026-10-20", "a/plugin", "v1", 900),
        row("2026-10-21", "a/plugin", "v1", 1000),
      ],
      "2026-11.csv": [
        // v2 came out yesterday: its count is still small, so v1's stands.
        row("2026-11-05", "a/plugin", "v2", 40),
        row("2026-11-05", "B/Other", "v3", 7),
      ],
    });
    const use = loadUsage(dir);
    expect(use.get("a/plugin")).toBe(1000);
    // Keys are lower case: GitHub names ignore case.
    expect(use.get("b/other")).toBe(7);
  });

  it("ignores releases last seen before the window", () => {
    const dir = history({
      "2026-08.csv": [row("2026-08-01", "a/plugin", "v1", 5000)],
      "2026-11.csv": [row("2026-11-05", "a/plugin", "v2", 300)],
    });
    expect(loadUsage(dir).get("a/plugin")).toBe(300);
  });

  it("reads columns by name and quoted fields", () => {
    const dir = history({});
    writeFileSync(
      join(dir, "2026-11.csv"),
      'repo,latest_tag,date,latest_downloads\na/plugin,"v1,beta",2026-11-05,12\n',
    );
    expect(loadUsage(dir).get("a/plugin")).toBe(12);
  });

  it("is empty without history", () => {
    expect(loadUsage(join(tmpdir(), "no-such-history-dir")).size).toBe(0);
  });

  it("rounds to two significant figures", () => {
    expect(fmtUse(572_471)).toBe("570k");
    expect(fmtUse(946_438)).toBe("950k");
    expect(fmtUse(999_999)).toBe("1M");
    expect(fmtUse(1_234_567)).toBe("1.2M");
    expect(fmtUse(9_876)).toBe("9.9k");
    expect(fmtUse(1_000)).toBe("1k");
    expect(fmtUse(840)).toBe("840");
    expect(fmtUse(87)).toBe("87");
  });
});
