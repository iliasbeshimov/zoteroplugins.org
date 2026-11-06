import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMoved, findMoved, readRedirects } from "../src/profile/moved.ts";

describe("cards for repos that moved on GitHub", () => {
  const cards = [
    { slug: "zotero-local-dictionary", repo: "noahxie83/zotero-local-dictionary" },
    { slug: "zotero-local-mdx-click", repo: "noahxie83/zotero-local-mdx-click" },
    { slug: "zotero-lexibridge", repo: "Noahxie83/zotero-lexibridge" },
    { slug: "paper-pilot", repo: "yebuqiu/paper-pilot" },
    { slug: "zotvim", repo: "jan-grp/zotvim" },
    { slug: "renamed-unlisted", repo: "a/old" },
    { slug: "zotero-pdf-translate", repo: "windingwind/zotero-pdf-translate" },
  ];
  const github: Record<string, string | null> = {
    "noahxie83/zotero-local-dictionary": "Noahxie83/zotero-lexibridge",
    "noahxie83/zotero-local-mdx-click": "Noahxie83/zotero-lexibridge",
    "yebuqiu/paper-pilot": null,
    "jan-grp/zotvim": "jan-grp/zotvim",
    "a/old": "a/new",
  };
  const inCensus = new Set(["noahxie83/zotero-lexibridge", "windingwind/zotero-pdf-translate"]);

  it("moves a card only when its repo's new name has a card", async () => {
    const asked: string[] = [];
    const moves = await findMoved(
      cards,
      inCensus,
      async (repo) => {
        asked.push(repo);
        return github[repo] ?? null;
      },
      "2026-11-06",
    );
    expect(moves.map((m) => [m.slug, m.target])).toEqual([
      ["zotero-local-dictionary", "zotero-lexibridge"],
      ["zotero-local-mdx-click", "zotero-lexibridge"],
    ]);
    // Repos the census lists aren't asked about; deleted, unchanged and unlisted ones stay.
    expect(asked).not.toContain("windingwind/zotero-pdf-translate");
    expect(asked).toContain("yebuqiu/paper-pilot");
  });

  it("removes the old cards and keeps one redirect per slug, chained to the newest card", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-moved-"));
    for (const s of ["b", "c"]) {
      await mkdir(join(dir, s));
      await writeFile(join(dir, s, "profile.json"), "{}");
    }
    await writeFile(
      join(dir, "redirects.json"),
      JSON.stringify({
        schemaVersion: 1,
        moved: [{ from: "x/a", to: "x/b", slug: "a", target: "b", date: "2026-11-01" }],
      }),
    );
    await applyMoved(dir, [{ from: "x/b", to: "x/c", slug: "b", target: "c", date: "2026-11-06" }]);
    expect(existsSync(join(dir, "b"))).toBe(false);
    expect(existsSync(join(dir, "c"))).toBe(true);
    expect((await readRedirects(dir)).moved.map((m) => [m.slug, m.target])).toEqual([
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(JSON.parse(await readFile(join(dir, "redirects.json"), "utf8")).schemaVersion).toBe(1);
  });
});
