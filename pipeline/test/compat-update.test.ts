import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  effectiveRange,
  supportedMajors,
  supportsVersion,
  type ZoteroVersions,
} from "../src/census/compat.ts";
import type { XpiManifest } from "../src/census/xpi.ts";
import { parseUpdateManifest } from "../src/profile/updates.ts";

// Zotero's own compatibility update: an update file can raise a release's maximum Zotero version.
// The update files are the real ones, as fetched on 2026-11-16 (fixtures/update-files).

const zv: ZoteroVersions = {
  release: { mac: "10.0.8" },
  beta: {},
  dev: { mac: "11.0-dev.5+dac1ad489" },
  currentMajor: 10,
  nextMajor: 11,
  lastTagPerMajor: { 6: "6.0.37", 7: "7.0.32", 8: "8.0.4", 9: "9.0.6", 10: "10.0.8" },
};

const manifest = (
  addonId: string,
  version: string,
  minVersion: string,
  maxVersion: string,
): XpiManifest => ({
  format: "manifest.json",
  target: "zotero",
  addonId,
  name: "X",
  version,
  description: null,
  homepageUrl: null,
  updateUrl: "https://example.org/updates.json",
  minVersion,
  maxVersion,
});

const fixture = (slug: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "update-files", `${slug}.json`), "utf8");

/** The release file's manifest and its update file, as the profiler reads them. */
function rangeFor(m: XpiManifest, text: string | null) {
  const entries = text ? parseUpdateManifest(text, m.addonId ?? "") : null;
  return effectiveRange(m, m.version ?? "", entries);
}

const works = (m: XpiManifest, version: string) => supportsVersion(m, version);

describe("a release's range as Zotero applies it, with its update file", () => {
  it("scite 2.0.5: the update file's entry has no maximum, so it works with Zotero 10 and 11", () => {
    const m = manifest("scite-zotero-plugin@scite.ai", "2.0.5", "6.999", "8.0.*");
    expect(works(m, "10.0.8")).toBe(false);
    const r = rangeFor(m, fixture("scite-zotero-plugin"));
    expect(r.from).toBe("update-file");
    expect(r.manifest.maxVersion).toBe("*");
    expect(r.manifest.minVersion).toBe("6.999");
    expect(works(r.manifest, "10.0.8")).toBe(true);
    expect(works(r.manifest, "11.0-dev.5+dac1ad489")).toBe(true);
    expect(supportedMajors([r.manifest], zv)).toEqual([7, 8, 9, 10, 11]);
  });

  it("PDF Custom Rename 1.1.0: 7 to 9 in the release, any version in the update file", () => {
    const m = manifest("pdfrename@theigrams.com", "1.1.0", "6.999", "9.*");
    const r = rangeFor(m, fixture("zotero-pdf-custom-rename"));
    expect(r.from).toBe("update-file");
    expect(works(r.manifest, "10.0.8")).toBe(true);
  });

  it("PDF Background 2.3.0: the update file answers 403, so the release's 7 to 9 stands", () => {
    const m = manifest("pdfbackground@example.org", "2.3.0", "6.999", "9.0.*");
    const r = rangeFor(m, null);
    expect(r.from).toBe("release");
    expect(r.manifest).toBe(m);
    expect(supportedMajors([r.manifest], zv)).toEqual([7, 8, 9]);
    // An error page served in place of the file reads as no entries, the same.
    const s3 = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code></Error>';
    expect(rangeFor(m, s3).from).toBe("release");
  });

  it("shortDOI 1.5.0: the update file only has an entry for 1.5.1, so it stays at 7", () => {
    const m = manifest("zoteroshortdoi@wiernik.org", "1.5.0", "6.999", "7.0.*");
    const r = rangeFor(m, fixture("zotero-shortdoi--bwiernik"));
    expect(r.from).toBe("release");
    expect(supportedMajors([r.manifest], zv)).toEqual([7]);
  });

  it("ZotMoov 1.2.34 and Better BibTeX 9.0.77: the same range in both files changes nothing", () => {
    const zotmoov = manifest("zotmoov@wileyy.com", "1.2.34", "6.999", "10.*");
    expect(rangeFor(zotmoov, fixture("zotmoov")).from).toBe("release");
    const bbt = manifest("better-bibtex@iris-advies.com", "9.0.77", "8.0.1", "11.*");
    const r = rangeFor(bbt, fixture("zotero-better-bibtex"));
    expect(r.from).toBe("release");
    expect(r.manifest).toBe(bbt);
  });

  it("never lowers the limit: an entry with a lower max leaves the release's range", () => {
    const m = manifest("x@example.org", "1.0.0", "6.999", "10.*");
    const text = JSON.stringify({
      addons: {
        "x@example.org": {
          updates: [{ version: "1.0.0", applications: { zotero: { strict_max_version: "9.*" } } }],
        },
      },
    });
    const r = rangeFor(m, text);
    expect(r.from).toBe("release");
    expect(works(r.manifest, "10.0.8")).toBe(true);
  });

  it("compares full versions: a max of 10.0.6 doesn't cover Zotero 10.0.8", () => {
    const m = manifest("x@example.org", "1.0.0", "6.999", "9.*");
    const text = JSON.stringify({
      addons: {
        "x@example.org": {
          updates: [
            { version: "1.0.0", applications: { zotero: { strict_max_version: "10.0.6" } } },
          ],
        },
      },
    });
    const r = rangeFor(m, text);
    expect(r.from).toBe("update-file");
    expect(r.manifest.maxVersion).toBe("10.0.6");
    expect(works(r.manifest, "10.0.6")).toBe(true);
    expect(works(r.manifest, "10.0.8")).toBe(false);
  });

  it("reads advisory_max_version when there's no strict one, and only the zotero target", () => {
    const m = manifest("x@example.org", "1.0.0", "6.999", "8.*");
    const entry = (applications: object) =>
      JSON.stringify({
        addons: { "x@example.org": { updates: [{ version: "1.0.0", applications }] } },
      });
    const advisory = rangeFor(m, entry({ zotero: { advisory_max_version: "10.0.*" } }));
    expect(advisory.manifest.maxVersion).toBe("10.0.*");
    expect(works(advisory.manifest, "10.0.8")).toBe(true);
    // A gecko target alone is Firefox's: Zotero skips the entry.
    expect(rangeFor(m, entry({ gecko: { strict_max_version: "*" } })).from).toBe("release");
  });

  it("leaves install.rdf plugins and files Zotero refuses alone", () => {
    const legacy: XpiManifest = {
      ...manifest("x@example.org", "1.0.0", "5.0", "6.*"),
      format: "install.rdf",
    };
    const any = JSON.stringify({
      addons: {
        "x@example.org": { updates: [{ version: "1.0.0", applications: { zotero: {} } }] },
      },
    });
    expect(rangeFor(legacy, any).from).toBe("release");
    // No max at all: Zotero refuses the file before it looks at updates.
    const noMax = { ...manifest("x@example.org", "1.0.0", "6.999", "8.*"), maxVersion: null };
    expect(rangeFor(noMax, any).from).toBe("release");
  });

  it("keeps the release's minimum where the entry starts higher: Zotero only applies an entry on a version it covers", () => {
    const m = manifest("x@example.org", "1.0.0", "6.999", "8.*");
    const text = JSON.stringify({
      addons: {
        "x@example.org": {
          updates: [
            {
              version: "1.0.0",
              applications: { zotero: { strict_min_version: "8.0", strict_max_version: "10.*" } },
            },
          ],
        },
      },
    });
    const r = rangeFor(m, text);
    expect(r.manifest.minVersion).toBe("6.999");
    expect(supportedMajors([r.manifest], zv)).toEqual([7, 8, 9, 10]);
  });
});
