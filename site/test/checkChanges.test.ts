import { describe, expect, it } from "vitest";
import { checkChanges, parseCheckChanges } from "../src/lib/checkChanges.ts";

describe("changes to the checks", () => {
  it("reads every row of the methodology table, newest first", () => {
    const rows = checkChanges();
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(rows[0].date >= rows[rows.length - 1].date).toBe(true);
    for (const r of rows) expect(r.what).not.toMatch(/\]\(|`/);
  });

  it("turns links and code marks into plain text and stops at the next section", () => {
    const md = [
      "## Changes to the checks",
      "| Date | Analyzer | Rules | What changed |",
      "|---|---|---|---|",
      "| 2026-10-16 | 0.13.0 | 0.9.0-preview | See [Programs](#programs); `_0x` names. |",
      "## Next",
      "| 2026-01-01 | 0.1.0 | 0.1.0 | Not part of it. |",
    ].join("\n");
    expect(parseCheckChanges(md)).toEqual([
      {
        date: "2026-10-16",
        analyzer: "0.13.0",
        rules: "0.9.0-preview",
        what: "See Programs; _0x names.",
      },
    ]);
  });
});
