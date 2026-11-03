import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/paths.ts";
import { RULES_VERSION } from "../src/profile/score.ts";
import { ANALYZER_VERSION } from "../src/scan/analyze.ts";

/**
 * "Changes to the checks" in docs/methodology.md is the public record of what each analyzer and
 * rules version changed; How we grade shows it and the grade log links to it. Bumping a version
 * means adding its row, newest first.
 */
describe("methodology changelog", () => {
  const md = readFileSync(join(repoRoot, "docs", "methodology.md"), "utf8");
  const section = md.slice(md.indexOf("## Changes to the checks"));
  const rows = [
    ...section.matchAll(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm),
  ];

  it("has a row for the current analyzer and rules versions, at the top", () => {
    const top = rows[0];
    expect(top).toBeDefined();
    expect({ analyzer: top?.[2], rules: top?.[3] }).toEqual({
      analyzer: ANALYZER_VERSION,
      rules: RULES_VERSION,
    });
  });

  it("lists changes newest first", () => {
    const dates = rows.map((r) => r[1]);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});
