import { describe, expect, it } from "vitest";
import { createIndex, type SearchDoc, search, stem, tokenize, unlink } from "../src/lib/search.ts";

const doc = (slug: string, name: string, extra: Partial<SearchDoc> = {}): SearchDoc => ({
  slug,
  name,
  repo: `someone/${slug}`,
  desc: "",
  does: "",
  topics: "",
  jobs: "",
  ask: "",
  dl: 0,
  ...extra,
});

const DOCS: SearchDoc[] = [
  doc("zotero-gpt", "Awesome GPT", {
    repo: "MuiseDestiny/zotero-gpt",
    desc: "GPT Meet Zotero.",
    ask: "chat with a paper; ai assistant for papers",
    dl: 600_000,
  }),
  doc("digest", "Paper Digest", { desc: "Summarizes papers with an LLM", dl: 100 }),
  doc("retraction", "Retraction Watch", { desc: "Flags retracted articles in your library" }),
  doc("owl", "Night Owl", { desc: "A dark theme for the reader", ask: "dark mode" }),
  doc("jasmine", "茉莉花", { desc: "知网元数据抓取和中文文献识别" }),
  doc("attanger", "Attanger", {
    desc: "Renames attachments and moves PDFs into folders",
    dl: 2_000_000,
  }),
  doc("zotfile-lite", "ZotFile Lite", { desc: "Rename attachments", dl: 10 }),
  doc("colour", "Colour Picker", { desc: "Choose the colour of highlights" }),
];
const index = createIndex(DOCS);
const slugs = (q: string) => search(index, q)?.map((h) => h.slug) ?? null;

describe("unlink", () => {
  it("reduces a repository link to owner/name", () => {
    for (const q of [
      "https://github.com/MuiseDestiny/zotero-gpt",
      "https://github.com/MuiseDestiny/zotero-gpt/releases/tag/v1.0.0",
      "https://github.com/MuiseDestiny/zotero-gpt.git",
      "github.com/MuiseDestiny/zotero-gpt?tab=readme-ov-file#install",
      "http://www.github.com/MuiseDestiny/zotero-gpt/",
    ])
      expect(unlink(q)).toBe("MuiseDestiny/zotero-gpt");
    expect(unlink("export notes to markdown")).toBe("export notes to markdown");
    expect(unlink("pdf.js viewer")).toBe("pdf.js viewer");
  });
});

describe("tokenize and stem", () => {
  it("keeps hyphenated words together and splits Chinese into bigrams", () => {
    expect(tokenize("Sci-Hub full-text")).toEqual(["sci-hub", "full-text"]);
    expect(tokenize("知网元数据")).toEqual(["知网", "网元", "元数", "数据"]);
    expect(tokenize("翻译PDF")).toEqual(["翻译", "pdf"]);
  });
  it("gives British and American spellings, and inflections, the same stem", () => {
    expect(stem("summarise")).toBe(stem("summarize"));
    expect(stem("colour")).toBe(stem("color"));
    expect(stem("analyse")).toBe(stem("analyze"));
    expect(stem("retracted")).toBe(stem("retraction"));
    expect(stem("renaming")).toBe(stem("rename"));
    expect(stem("sci-hub")).toBe(stem("scihub"));
  });
  it("drops stop words and one-letter terms", () => {
    for (const w of ["the", "zotero", "plugin", "https", "a", "7"]) expect(stem(w)).toBeNull();
  });
});

describe("search", () => {
  it("finds a plugin from its repository link, name or owner", () => {
    expect(slugs("https://github.com/MuiseDestiny/zotero-gpt")?.[0]).toBe("zotero-gpt");
    expect(slugs("awesome gpt")?.[0]).toBe("zotero-gpt");
    expect(slugs("muisedestiny")?.[0]).toBe("zotero-gpt");
  });
  it("matches the words people use, not just the words in the description", () => {
    expect(slugs("summarise papers")).toContain("digest");
    expect(slugs("find retracted articles")).toContain("retraction");
    expect(slugs("dark mode")?.[0]).toBe("owl");
    expect(slugs("color of highlights")?.[0]).toBe("colour");
    expect(slugs("rename pdf files")?.slice(0, 2)).toEqual(["attanger", "zotfile-lite"]);
    expect(slugs("chat with my pdf")).toContain("zotero-gpt");
  });
  it("searches Chinese by two-character pieces", () => {
    expect(slugs("知网")).toEqual(["jasmine"]);
    expect(slugs("中文文献")).toEqual(["jasmine"]);
  });
  it("prefers the more downloaded plugin when both match equally", () => {
    expect(slugs("rename attachments")?.[0]).toBe("attanger");
  });
  it("needs at least half the words to match", () => {
    expect(slugs("tiny purple elephants in the dark")).toEqual([]);
    expect(slugs("dark theme elephants")).toEqual(["owl"]);
  });
  it("treats a query of only stop words as no query", () => {
    expect(slugs("zotero plugin")).toBeNull();
    expect(slugs("   ")).toBeNull();
  });
});
