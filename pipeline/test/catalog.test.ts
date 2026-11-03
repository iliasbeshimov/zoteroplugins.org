import { Catalog, type PluginProfile, type Release } from "@atlas/schema";
import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  type CatalogSources,
  catalogEntry,
  serializeCatalog,
} from "../src/profile/catalog.ts";

/** A listed plugin with one release, as the catalogue reads it. */
function profile(o: {
  slug?: string;
  hidden?: boolean;
  kind?: "plugin" | "legacy" | "no-release";
  install?: boolean;
  label?: string;
  reasons?: string[];
  tested?: boolean;
  check?: { result: string; version: string | null; label: string | null };
  builds?: { asset: string; supports: number[]; releaseFile: string }[];
  blocked?: string;
  description?: string | null;
}): PluginProfile {
  const slug = o.slug ?? "demo";
  const label = o.label ?? "low-concern";
  return {
    slug,
    repo: `dev/${slug}`,
    repoName: `Dev/${slug}`,
    name: "Demo",
    listing: { kind: o.kind ?? "plugin", hiddenByDefault: o.hidden ?? false, hiddenReason: null },
    links: {
      repo: `https://github.com/dev/${slug}`,
      homepage: null,
      issues: `https://github.com/dev/${slug}/issues`,
      releases: `https://github.com/dev/${slug}/releases`,
    },
    about: {
      githubDescription: o.description === undefined ? "Cites things in Word" : o.description,
      manifestDescription: null,
      topics: [],
      categoryHint: null,
    },
    languages: {
      docs: ["en"],
      docsAlternates: [],
      ui: [],
      chineseOnlyDocs: false,
      chineseOnlyUi: false,
    },
    popularity: { stars: 10, forks: 0, contributors: 1, downloads: 500, latestDownloads: 5 },
    maintenance: { status: "active", lastReleaseAt: "2026-10-01T00:00:00Z" },
    compatibility: {
      supports: [9, 10],
      minVersion: "9.0",
      maxVersion: "10.*",
      current: { major: 10, zoteroVersion: "10.0.7", status: "compatible" },
      previous: null,
      next: null,
      blockedByZotero: o.blocked ? { reason: o.blocked, source: "https://example.org" } : null,
    },
    install:
      o.install === false
        ? null
        : {
            version: "1.2.0",
            tag: "v1.2.0",
            publishedAt: "2026-10-01T00:00:00Z",
            prerelease: false,
            asset: {
              name: "demo.xpi",
              url: `https://github.com/dev/${slug}/releases/download/v1.2.0/demo.xpi`,
              size: 100,
              sha256: "a".repeat(64),
            },
            otherAssets: [],
            autoUpdates: true,
            ...(o.builds ? { builds: o.builds } : {}),
            ...(o.check ? { updates: { kind: "this-project", check: o.check } } : {}),
            releaseFile: `${slug}/1.2.0.json`,
          },
    addonId: "demo@example.org",
    scan: { status: "analyzed", reason: null },
    requirementsHints: {
      aiServices: ["OpenAI"],
      otherServices: [],
      storesCredentials: true,
      localModels: true,
      launchesPrograms: false,
    },
    trust: {
      overall: { label, reasons: o.reasons ?? [] },
      inputs: { currentZotero: "10.0.7", analyzerVersion: "0.13.1" },
      tested: o.tested ? { verdict: "as-described", zotero: "10.0.7" } : null,
      appliesTo: { version: "1.2.0" },
      rulesVersion: "0.9.0-preview",
    },
    requirements: null,
    categories: null,
  } as unknown as PluginProfile;
}

const release = (asset: string, sha: string): Release =>
  ({
    asset: {
      name: asset,
      url: `https://github.com/dev/demo/releases/download/v1.2.0/${asset}`,
      sha256: sha,
    },
    manifest: { strictMinVersion: "7.0", strictMaxVersion: "8.*" },
  }) as unknown as Release;

const sources = (overrides: Partial<CatalogSources> = {}): CatalogSources => ({
  summaries: {},
  requirements: {},
  release: () => null,
  ...overrides,
});

describe("catalogEntry", () => {
  it("carries the grade, the because line, the file and what it needs", () => {
    const e = catalogEntry(profile({ tested: true }), sources());
    expect(e).toMatchObject({
      slug: "demo",
      id: "demo@example.org",
      page: "https://zoteroplugins.org/p/demo",
      grade: "A+",
      because:
        "every code check came out low, and our live test in Zotero found nothing unexpected",
      version: "1.2.0",
      supports: [9, 10],
      current: { zotero: "10.0.7", status: "compatible" },
      file: { name: "demo.xpi", sha256: "a".repeat(64), min: "9.0", max: "10.*" },
      builds: [],
      update: null,
      blocked: null,
      tested: { zotero: "10.0.7", verdict: "as-described" },
      needs: { apiKey: "unknown", services: ["OpenAI"], localModel: true, launchesPrograms: false },
      jobs: ["citing", "ai"],
      summary: "Cites things in Word",
    });
  });

  it("prefers the site's summary and the reviewed requirements", () => {
    const e = catalogEntry(
      profile({}),
      sources({
        summaries: { "Dev/demo": { does: "Reviewed one-liner." } },
        requirements: {
          demo: { apiKey: { need: "required", services: ["Anthropic"] }, localModel: "no" },
        },
      }),
    );
    expect(e?.summary).toBe("Reviewed one-liner.");
    expect(e?.needs).toEqual({
      apiKey: "required",
      services: ["Anthropic"],
      localModel: true, // the code talks to a local model even if the review didn't confirm it
      launchesPrograms: false,
    });
  });

  it("leaves out hidden plugins, Zotero 6 plugins and plugins with nothing to install", () => {
    expect(catalogEntry(profile({ hidden: true }), sources())).toBeNull();
    expect(catalogEntry(profile({ kind: "legacy" }), sources())).toBeNull();
    expect(catalogEntry(profile({ install: false }), sources())).toBeNull();
  });

  it("says what the update address offers when it's a different file, by grade", () => {
    const worse = catalogEntry(
      profile({ check: { result: "different-file", version: "1.3.0", label: "high-concern" } }),
      sources(),
    );
    expect(worse?.update).toEqual({ version: "1.3.0", grade: "C" });
    const unknown = catalogEntry(
      profile({ check: { result: "different-file", version: "1.3.0", label: null } }),
      sources(),
    );
    expect(unknown?.update).toEqual({ version: "1.3.0", grade: "–" });
    const same = catalogEntry(
      profile({ check: { result: "same-file", version: "1.2.0", label: null } }),
      sources(),
    );
    expect(same?.update).toBeNull();
  });

  it("lists the other builds with their own hash and range, from their release documents", () => {
    const e = catalogEntry(
      profile({
        builds: [
          { asset: "demo.xpi", supports: [9, 10], releaseFile: "demo/1.2.0.json" },
          { asset: "demo-zotero7.xpi", supports: [7, 8], releaseFile: "demo/1.2.0+z7.json" },
        ],
      }),
      sources({
        release: (f) =>
          f === "demo/1.2.0+z7.json" ? release("demo-zotero7.xpi", "b".repeat(64)) : null,
      }),
    );
    expect(e?.builds).toEqual([
      {
        name: "demo-zotero7.xpi",
        url: "https://github.com/dev/demo/releases/download/v1.2.0/demo-zotero7.xpi",
        sha256: "b".repeat(64),
        supports: [7, 8],
        min: "7.0",
        max: "8.*",
      },
    ]);
  });

  it("grades B and C from the label, and the blocklist reason comes through", () => {
    const b = catalogEntry(
      profile({ label: "review-details", reasons: ["Launches programs on your computer"] }),
      sources(),
    );
    expect(b?.grade).toBe("B");
    expect(b?.because).toBe("it launches programs on your computer");
    const c = catalogEntry(
      profile({
        label: "high-concern",
        reasons: ["Obfuscated code"],
        blocked: "Crashes Zotero 10",
      }),
      sources(),
    );
    expect(c?.grade).toBe("C");
    expect(c?.blocked).toBe("Crashes Zotero 10");
  });
});

describe("buildCatalog", () => {
  it("writes one plugin per line, most downloaded first, and validates against the schema", () => {
    const profiles = [
      profile({ slug: "b-plugin" }),
      profile({ slug: "a-plugin" }),
      profile({ hidden: true, slug: "hidden" }),
    ];
    const catalog = buildCatalog(profiles, sources(), "2026-11-03T00:00:00.000Z");
    expect(catalog.currentZotero).toBe("10.0.7");
    expect(catalog.plugins.map((p) => p.slug)).toEqual(["a-plugin", "b-plugin"]);
    const text = serializeCatalog(catalog);
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\{"schemaVersion":1,.*"plugins":\[$/);
    expect(lines.length).toBe(4); // header, two plugins, closing
    expect(Catalog.parse(JSON.parse(text))).toEqual(catalog);
  });
});
