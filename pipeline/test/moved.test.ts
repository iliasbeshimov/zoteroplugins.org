import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMoved, followLostCards, markRemoved, readRedirects } from "../src/profile/moved.ts";

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

  it("moves a card when its repo's new name has a card; marks one whose repo is gone", async () => {
    const asked: string[] = [];
    const { moves, removed } = await followLostCards(
      cards,
      inCensus,
      async (repo) => {
        asked.push(repo);
        const name = github[repo];
        return name === undefined
          ? { status: 502, name: null }
          : name === null
            ? { status: 404, name: null }
            : { status: 200, name };
      },
      "2026-11-06",
    );
    expect(moves.map((m) => [m.slug, m.target])).toEqual([
      ["zotero-local-dictionary", "zotero-lexibridge"],
      ["zotero-local-mdx-click", "zotero-lexibridge"],
    ]);
    // Repos the census lists aren't asked about; unchanged and unlisted renames stay.
    expect(removed).toEqual(["paper-pilot"]);
    expect(asked).not.toContain("windingwind/zotero-pdf-translate");
  });

  it("marks a removed card hidden once, keeping the day it was first found gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-removed-"));
    await mkdir(join(dir, "paper-pilot"));
    const file = join(dir, "paper-pilot", "profile.json");
    await writeFile(
      file,
      JSON.stringify({
        slug: "paper-pilot",
        listing: { kind: "plugin", hiddenByDefault: false, hiddenReason: null },
      }),
    );
    expect(await markRemoved(dir, ["paper-pilot", "not-there"], "2026-11-06")).toEqual([
      "paper-pilot",
    ]);
    expect(await markRemoved(dir, ["paper-pilot"], "2026-11-07")).toEqual([]);
    const p = JSON.parse(await readFile(file, "utf8"));
    expect(p.removed).toEqual({ since: "2026-11-06" });
    expect(p.listing).toEqual({ kind: "plugin", hiddenByDefault: true, hiddenReason: "removed" });
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
