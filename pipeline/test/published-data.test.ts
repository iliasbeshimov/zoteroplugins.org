import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/paths.ts";
import { SECRET_PATTERNS } from "../src/scan/text.ts";

// Everything under data/ is published (public repo, site, /api). Plugins sometimes hard-code
// their own keys; every field we copy from their code must redact them. This catches a field
// that doesn't, whatever produced it.
const ANY_KEY = new RegExp(SECRET_PATTERNS.map((re) => re.source).join("|"), "g");

describe("published data", () => {
  it("contains no credential-shaped string", async () => {
    const root = join(repoRoot, "data");
    const files = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    expect(files.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      // Only a prefix goes in the failure message: test logs are public too.
      for (const m of text.matchAll(ANY_KEY))
        found.push(`${file.slice(root.length + 1)}: ${m[0].slice(0, 8)}…`);
    }
    expect(found).toEqual([]);
  }, 120_000);
});
