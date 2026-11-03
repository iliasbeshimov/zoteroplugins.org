import { describe, expect, it } from "vitest";
import { allPlugins, shownPlugins } from "../src/lib/atlas.ts";
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

  // Phrases are written in working sessions, so plugins the census or the submit form adds arrive
  // without them until the next top-up (`pnpm -C site phrases:missing` lists them). This guards the
  // wiring, not that backlog: most plugins have phrases, and the best-known ones always do.
  it("loads the phrases for the catalogue", () => {
    const without = plugins.filter((p) => !p.search.ask);
    expect(without.length / plugins.length).toBeLessThan(0.5);
    for (const slug of ["zotero-better-bibtex", "zotero-gpt", "zotero-pdf-translate"])
      expect(plugins.find((p) => p.slug === slug)?.search.ask, slug).toBeTruthy();
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

/** Plugins whose developer retired them (data/plugins/<slug>.yaml): a page, but no list or install. */
describe("retired plugins", () => {
  const retired = allPlugins().filter((p) => p.retired);

  it("stay out of the lists and offer no install", () => {
    expect(retired.length).toBeGreaterThan(0);
    for (const p of retired) {
      expect(p.hidden, p.slug).toBe(true);
      expect(p.hiddenReason, p.slug).toBe("retired");
      expect(p.installUrl, p.slug).toBeNull();
      expect(
        shownPlugins().some((x) => x.slug === p.slug),
        p.slug,
      ).toBe(false);
    }
  });
});
