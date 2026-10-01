import { describe, expect, it } from "vitest";
import { shownPlugins } from "../src/lib/atlas.ts";
import { createIndex, search } from "../src/lib/search.ts";

/** The search over the real catalogue: what people type must find something sensible. */
describe("search over the catalogue", () => {
  const plugins = shownPlugins();
  const index = createIndex(plugins.map((p) => p.search));
  const top = (q: string, n = 5) => (search(index, q) ?? []).slice(0, n).map((h) => h.slug);
  const text = (slug: string) => {
    const s = plugins.find((p) => p.slug === slug)?.search;
    return `${s?.name} ${s?.desc} ${s?.does} ${s?.ask}`.toLowerCase();
  };

  it("has phrases for every listed plugin", () => {
    const without = plugins.filter((p) => !p.search.ask);
    expect(without.map((p) => p.slug)).toEqual([]);
  });

  it("finds a plugin from its GitHub link", () => {
    expect(top("https://github.com/MuiseDestiny/zotero-gpt")[0]).toBe("zotero-gpt");
    expect(top("https://github.com/retorquere/zotero-better-bibtex")[0]).toBe(
      "zotero-better-bibtex",
    );
  });

  it("answers natural-language questions with plugins whose text fits", () => {
    const cases: [string, RegExp][] = [
      ["summarise papers", /summar/],
      ["find retracted articles", /retract/],
      ["translate abstracts into chinese", /translat/],
      ["sync highlights to obsidian", /obsidian/],
      ["rename attachments automatically", /renam/],
      ["dark theme", /dark|theme|night/],
      ["word count of my library", /count|statistic|stat/],
      ["get full text pdfs from sci-hub", /sci-?hub|full.?text/],
      ["show journal impact factor", /impact/],
      ["read papers on my kindle", /kindle|e-?reader/],
      ["backup my library to dropbox", /dropbox|backup|webdav|cloud/],
      ["chat with my pdf", /chat|gpt|ai/],
    ];
    for (const [q, fits] of cases) {
      const hits = top(q, 3);
      expect(hits.length, q).toBeGreaterThan(0);
      expect(
        hits.some((s) => fits.test(text(s))),
        `${q} → ${hits.join(", ")}`,
      ).toBe(true);
    }
  });
});
