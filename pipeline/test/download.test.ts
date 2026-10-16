import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paths } from "../src/paths.ts";
import {
  classifyDownload,
  DownloadFacts,
  downloadLabelEnd,
  downloadWhy,
} from "../src/profile/download.ts";
import { readFindingReview } from "../src/profile/reviews.ts";

const facts = (over: Partial<DownloadFacts> = {}): DownloadFacts => ({
  source: "third-party",
  publisher: "Someone Else",
  transport: "https",
  integrity: "none",
  trigger: "automatic",
  toldInReadme: "yes",
  ...over,
});

describe("classifyDownload", () => {
  const kind = (f: DownloadFacts, checked = false) => classifyDownload(f, checked);

  it("rates each case", () => {
    expect(kind(facts({ transport: "http" }))).toEqual({
      kind: "http",
      concern: "high",
      rule: "CAP-DOWNLOAD-EXEC-HTTP",
    });
    expect(kind(facts({ integrity: "pinned" }))).toEqual({
      kind: "fixed",
      concern: "medium",
      rule: "CAP-DOWNLOAD-EXEC-FIXED",
    });
    expect(kind(facts({ integrity: "pinned", source: "official" })).concern).toBe("low");
    expect(kind(facts({ source: "official" }))).toEqual({
      kind: "maker",
      concern: "low",
      rule: "CAP-DOWNLOAD-EXEC-MAKER",
    });
    expect(kind(facts({ source: "official", toldInReadme: "no" }))).toEqual({
      kind: "maker-untold",
      concern: "medium",
      rule: "CAP-DOWNLOAD-EXEC-UNTOLD",
    });
    expect(kind(facts({ source: "developer-own", publisher: undefined }))).toEqual({
      kind: "developer",
      concern: "medium",
      rule: "CAP-DOWNLOAD-EXEC-DEVELOPER",
    });
    expect(kind(facts())).toEqual({
      kind: "other",
      concern: "medium",
      rule: "CAP-DOWNLOAD-EXEC-OTHER",
    });
  });

  it("lets a pinned file override http, and a button tell you when the README doesn't", () => {
    expect(kind(facts({ transport: "http", integrity: "pinned" })).kind).toBe("fixed");
    const quiet = facts({ source: "official", toldInReadme: "no" });
    expect(kind({ ...quiet, trigger: "automatic" }).kind).toBe("maker-untold");
    expect(kind({ ...quiet, trigger: "user-clicks-install" }).kind).toBe("maker");
    expect(kind({ ...quiet, trigger: "asks-first" }).kind).toBe("maker");
  });

  it("rates a pinned file low only when we checked what's inside it or the maker made it", () => {
    const own = facts({ source: "developer-own", publisher: undefined, integrity: "pinned" });
    expect(kind(own).concern).toBe("medium");
    expect(kind(own, true).concern).toBe("low");
  });
});

describe("downloadWhy", () => {
  const own = facts({ source: "developer-own", publisher: undefined });
  it("says who can change it and what checks it", () => {
    expect(downloadWhy("developer", own, false)).toBe(
      "Its developer can replace the file at any time without releasing a new version, and nothing checks it before it runs, so our check of the plugin doesn't cover what runs.",
    );
    expect(downloadWhy("developer", { ...own, integrity: "same-source-checksum" }, false)).toBe(
      "Its developer can replace the file at any time without releasing a new version, and the only check is a checksum from the same place, which a replaced file passes too, so our check of the plugin doesn't cover what runs.",
    );
    expect(downloadWhy("other", facts({ publisher: "Zotero Chinese community" }), false)).toBe(
      "The file belongs to Zotero Chinese community, not this plugin's developer: they can replace it at any time, and nothing checks it before it runs, and what they put there runs on your computer.",
    );
    expect(downloadWhy("maker", facts({ publisher: "Astral, who make uv" }), false)).toBe(
      "It comes straight from Astral, who make uv, over an encrypted connection, as it would if you installed it yourself.",
    );
  });

  it("explains a fixed fingerprint", () => {
    const base =
      "It checks the download against a fingerprint written into the plugin, so only a new version of the plugin can change what runs.";
    const pinned = facts({ integrity: "pinned" });
    expect(
      downloadWhy("fixed", { ...pinned, source: "official", publisher: "Astral" }, false),
    ).toBe(`${base} The download comes from Astral.`);
    expect(downloadWhy("fixed", pinned, false)).toBe(
      `${base} We haven't checked what's inside it.`,
    );
    expect(downloadWhy("fixed", pinned, true)).toBe(base);
  });

  it("ends a label by kind", () => {
    expect(downloadLabelEnd("developer", "medium")).toBe(
      "; its developer can change what runs at any time",
    );
    expect(downloadLabelEnd("fixed", "medium")).toBe("; we haven't checked what's inside it");
    expect(downloadLabelEnd("fixed", "low")).toBe("");
    expect(downloadLabelEnd("maker", "low")).toBe("");
  });
});

describe("DownloadFacts", () => {
  it("needs a publisher unless it's the developer's own", () => {
    expect(DownloadFacts.safeParse(facts({ publisher: undefined })).success).toBe(false);
    expect(
      DownloadFacts.safeParse(facts({ source: "developer-own", publisher: undefined })).success,
    ).toBe(true);
  });
});

describe("the real download reviews", () => {
  const dir = join(paths.root, "data", "reviews", "download-exec");
  it("all read, with the level and rule their facts compute", async () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const slug = f.replace(/\.json$/, "");
      expect(await readFindingReview("download-exec", slug), slug).not.toBeNull();
    }
  });
});
