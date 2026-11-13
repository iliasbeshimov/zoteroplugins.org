import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  installProblem,
  supportedMajors,
  supportsVersion,
  type ZoteroVersions,
} from "../src/census/compat.ts";
import { parseCsv, toCsv } from "../src/census/csv.ts";
import { fetchFull, fetchLight } from "../src/census/metadata.ts";
import { maintenanceOf, newOnLists, pickRelease } from "../src/census/run.ts";
import { curatedLists, repoKeyFromUrl } from "../src/census/sources.ts";
import {
  parseInstallRdf,
  parseManifestJson,
  readXpiManifests,
  type XpiManifest,
} from "../src/census/xpi.ts";
import type { GitHub, GraphqlError } from "../src/net/github.ts";
import { buildZip, memoryReader } from "./helpers/zip.ts";

const zv: ZoteroVersions = {
  release: { mac: "10.0.4", "win-x64": "10.0.3" },
  beta: {},
  dev: { mac: "11.0-dev.5+dac1ad489" },
  currentMajor: 10,
  nextMajor: 11,
  lastTagPerMajor: { 6: "6.0.37", 7: "7.0.32", 8: "8.0.4", 9: "9.0.6", 10: "10.0.4" },
};

const manifest = (over: Partial<XpiManifest>): XpiManifest => ({
  format: "manifest.json",
  target: "zotero",
  addonId: "x@example.org",
  name: "X",
  version: "1.0.0",
  description: null,
  homepageUrl: null,
  updateUrl: "https://example.org/update.json",
  minVersion: null,
  maxVersion: null,
  ...over,
});

describe("compareVersions", () => {
  it.each([
    ["7.0.32", "7.9.9", -1],
    ["7.*", "7.5", 1],
    ["10.0", "10.0.1", -1],
    ["8.0-beta", "8.0", -1],
    ["6.999", "7.0", -1],
    ["10.0.0", "10", 0],
  ])("%s vs %s", (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });
});

describe("supportedMajors", () => {
  it("reads '7.9.9' as 'Zotero 8 and up', like Zotero itself does in practice", () => {
    expect(supportedMajors([manifest({ minVersion: "7.9.9", maxVersion: "10.9.9" })], zv)).toEqual([
      8, 9, 10,
    ]);
  });

  it("handles wildcard maxima", () => {
    expect(supportedMajors([manifest({ minVersion: "6.999", maxVersion: "7.*" })], zv)).toEqual([
      7,
    ]);
    expect(supportedMajors([manifest({ maxVersion: "*" })], zv)).toEqual([7, 8, 9, 10, 11]);
  });

  it("caps legacy install.rdf plugins at Zotero 6", () => {
    const legacy = manifest({ format: "install.rdf", minVersion: "5.0", maxVersion: "*" });
    expect(supportedMajors([legacy], zv)).toEqual([6]);
  });

  it("unions hybrid plugins that ship both manifests", () => {
    const rdf = manifest({ format: "install.rdf", minVersion: "5.0", maxVersion: "6.*" });
    const json = manifest({ minVersion: "6.999", maxVersion: "7.*" });
    expect(supportedMajors([rdf, json], zv)).toEqual([6, 7]);
  });

  it("gives Firefox extensions no Zotero support", () => {
    expect(supportedMajors([manifest({ target: "firefox", maxVersion: "*" })], zv)).toEqual([]);
  });

  it("gives a file Zotero won't install no Zotero 7+ support, keeping install.rdf's Zotero 6", () => {
    const broken = manifest({ minVersion: "6.999", maxVersion: "10.*", updateUrl: null });
    expect(supportedMajors([broken], zv)).toEqual([]);
    const rdf = manifest({ format: "install.rdf", minVersion: "5.0", maxVersion: "6.*" });
    expect(supportedMajors([rdf, broken], zv)).toEqual([6]);
  });
});

describe("supportsVersion: the exact Zotero version, as Zotero compares it", () => {
  it.each([
    [null, "10.*", true],
    [null, "10.0.*", true],
    [null, "10.0", false], // 10.0.0 (zotlite)
    ["10.0.1", "10.0.2", false], // zotero-trackpad-navigation
    [null, "9.999", false],
    ["6.999", "*", true],
    ["6.999", null, false], // no maximum: Zotero won't install it
    ["10.0.4", "10.0.4", true],
    ["10.0.5", "10.*", false],
    ["10.1", "*", false],
  ])("min %s, max %s at Zotero 10.0.4", (min, max, works) => {
    expect(supportsVersion(manifest({ minVersion: min, maxVersion: max }), "10.0.4")).toBe(works);
  });

  it("puts a dev build before its release", () => {
    const dev = "11.0-dev.5+dac1ad489";
    expect(supportsVersion(manifest({ minVersion: "6.999", maxVersion: "11.*" }), dev)).toBe(true);
    expect(supportsVersion(manifest({ minVersion: "6.999", maxVersion: "11.0" }), dev)).toBe(true);
    expect(supportsVersion(manifest({ minVersion: "11.0", maxVersion: "11.*" }), dev)).toBe(false);
    expect(supportsVersion(manifest({ maxVersion: "10.*" }), dev)).toBe(false);
  });

  it("keeps each format to its own Zotero", () => {
    const rdf = manifest({ format: "install.rdf", minVersion: "5.0", maxVersion: "*" });
    expect(supportsVersion(rdf, "6.0.37")).toBe(true);
    expect(supportsVersion(rdf, "10.0.4")).toBe(false);
    expect(supportsVersion(manifest({ maxVersion: "*" }), "6.0.37")).toBe(false);
  });
});

describe("files Zotero won't install", () => {
  const json = (zotero: Record<string, unknown>) =>
    parseManifestJson(
      JSON.stringify({
        manifest_version: 2,
        name: "P",
        version: "1.0.0",
        applications: {
          zotero: { strict_min_version: "6.999", strict_max_version: "10.*", ...zotero },
        },
      }),
    );
  const update = "https://example.org/update.json";

  it("needs an update address (zone, annotation-color-memory's empty one)", () => {
    const none = json({ id: "zone@zotero.local" });
    expect(installProblem(none, zv)).toBe("no-update-url");
    expect(installProblem(json({ id: "a@b.org", update_url: "" }), zv)).toBe("no-update-url");
    expect(supportsVersion(none, "10.0.4")).toBe(false);
    expect(installProblem(json({ id: "a@b.org", update_url: update }), zv)).toBeNull();
  });

  it.each([
    ["zotero-better-popups"],
    ["zotero-skills@leike0813@gmail.com"],
    ["bamboo@@linxzh.com"],
    ["mmmaurer+obsidianzot@protonmail.com"],
    ["paperpilot.zjysnow"],
    [""],
  ])("refuses the add-on ID %j", (id) => {
    expect(installProblem(json({ id, update_url: update }), zv)).toBe("invalid-id");
  });

  it.each([
    ["{ec8030f7-c20a-464f-9b0e-13a3a9e97384}"],
    ["Extra-Columns_2@UserOption3.github.io"],
    ["@short"],
  ])("accepts the add-on ID %j", (id) => {
    expect(installProblem(json({ id, update_url: update }), zv)).toBeNull();
  });

  it("needs a maximum version, after the update address (sovena has neither)", () => {
    const open = json({ id: "a@b.org", update_url: update, strict_max_version: undefined });
    expect(installProblem(open, zv)).toBe("no-max-version");
    expect(supportsVersion(open, "10.0.4")).toBe(false);
    expect(supportedMajors([open], zv)).toEqual([]);
    const sovena = json({ id: "sovena@sovena.local", strict_max_version: undefined });
    expect(installProblem(sovena, zv)).toBe("no-update-url");
  });

  it("doesn't refuse Zotero's old application ID, which Zotero never checks for", () => {
    // zotero-validate uses it, and is refused for its missing update address.
    expect(installProblem(json({ id: "zotero@chnm.gmu.edu" }), zv)).toBe("no-update-url");
    expect(installProblem(json({ id: "zotero@chnm.gmu.edu", update_url: update }), zv)).toBeNull();
  });

  it("leaves install.rdf files and files made for no Zotero version alone", () => {
    const rdf = manifest({ format: "install.rdf", addonId: "legacy", updateUrl: null });
    expect(installProblem({ ...rdf, maxVersion: "6.*" }, zv)).toBeNull();
    expect(installProblem({ ...rdf, minVersion: "5.0" }, zv)).toBeNull();
    // onedict's Firefox build, stored like a manifest.json plugin.
    const firefox = manifest({
      addonId: "onedict@example.com",
      updateUrl: null,
      minVersion: "109.0",
    });
    expect(installProblem(firefox, zv)).toBeNull();
  });
});

describe("xpi manifests over range requests", () => {
  const zoteroManifest = JSON.stringify({
    manifest_version: 2,
    name: "Demo",
    version: "1.2.3",
    applications: {
      zotero: {
        id: "demo@example.org",
        update_url: "https://example.org/update.json",
        strict_min_version: "6.999",
        strict_max_version: "10.*",
      },
    },
  });

  it("reads a deflated manifest.json", async () => {
    const zip = buildZip({ "bootstrap.js": "void 0;", "manifest.json": zoteroManifest });
    const [m] = await readXpiManifests(memoryReader(zip), zip.length);
    expect(m).toMatchObject({
      format: "manifest.json",
      target: "zotero",
      addonId: "demo@example.org",
      version: "1.2.3",
      maxVersion: "10.*",
    });
  });

  it("fetches the central directory separately when it isn't in the tail", async () => {
    const big = new Uint8Array(200_000).map((_, i) => (i * 7919) % 251);
    const zip = buildZip({ "manifest.json": zoteroManifest, "content/big.bin": big }, false);
    const reader = memoryReader(zip);
    const [m] = await readXpiManifests(reader, zip.length);
    expect(m?.addonId).toBe("demo@example.org");
    const bytesRead = reader.requests.reduce((s, [a, b]) => s + (b - a + 1), 0);
    expect(bytesRead).toBeLessThan(zip.length / 2);
  });

  it("parses install.rdf in element and attribute forms", () => {
    const rdf = `<?xml version="1.0"?>
      <RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:em="http://www.mozilla.org/2004/em-rdf#">
        <Description about="urn:mozilla:install-manifest">
          <em:id>legacy@example.org</em:id>
          <em:name>Legacy</em:name>
          <em:version>0.9</em:version>
          <em:targetApplication>
            <Description em:id="zotero@chnm.gmu.edu" em:minVersion="5.0" em:maxVersion="6.*"/>
          </em:targetApplication>
          <em:targetApplication>
            <Description><em:id>juris-m@juris-m.github.io</em:id><em:minVersion>4.999</em:minVersion><em:maxVersion>6.*</em:maxVersion></Description>
          </em:targetApplication>
        </Description>
      </RDF>`;
    expect(parseInstallRdf(rdf)).toMatchObject({
      format: "install.rdf",
      target: "zotero",
      addonId: "legacy@example.org",
      version: "0.9",
      minVersion: "5.0",
      maxVersion: "6.*",
    });
  });

  it("recognises Firefox extensions", () => {
    const m = parseManifestJson(
      JSON.stringify({
        name: "F",
        version: "1",
        browser_specific_settings: { gecko: { id: "f@x" } },
      }),
    );
    expect(m.target).toBe("firefox");
  });
});

describe("helpers", () => {
  it("extracts canonical repo keys from GitHub URLs", () => {
    expect(repoKeyFromUrl("https://github.com/Windingwind/Zotero-PDF-Translate/releases")).toBe(
      "windingwind/zotero-pdf-translate",
    );
    expect(repoKeyFromUrl("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(repoKeyFromUrl("https://github.com/topics/zotero")).toBeNull();
    expect(repoKeyFromUrl("https://gitee.com/a/b")).toBeNull();
  });

  it("round-trips CSV with quotes, commas and newlines", () => {
    const rows = [{ a: 'say "hi"', b: "x,y", c: "line1\nline2" }];
    const parsed = parseCsv(toCsv(rows, ["a", "b", "c"]));
    expect(parsed).toEqual([
      ["a", "b", "c"],
      ['say "hi"', "x,y", "line1\nline2"],
    ]);
  });

  it("picks the latest stable release that ships an .xpi", () => {
    const asset = (name: string) => ({
      name,
      size: 1,
      downloadCount: 0,
      updatedAt: "",
      downloadUrl: "",
    });
    const releases = [
      { tag: "v3-beta", publishedAt: "2026-09-01", prerelease: true, assets: [asset("p.xpi")] },
      {
        tag: "update",
        publishedAt: "2026-08-30",
        prerelease: false,
        assets: [asset("update.json")],
      },
      { tag: "v2", publishedAt: "2026-08-01", prerelease: false, assets: [asset("p.xpi")] },
    ];
    expect(pickRelease(releases)?.tag).toBe("v2");
  });

  it("classifies maintenance by last activity", () => {
    const now = Date.parse("2026-09-24T00:00:00Z");
    expect(maintenanceOf("2026-06-01T00:00:00Z", false, now)).toBe("active");
    expect(maintenanceOf("2025-06-01T00:00:00Z", false, now)).toBe("slowing");
    expect(maintenanceOf("2024-01-01T00:00:00Z", false, now)).toBe("dormant");
    expect(maintenanceOf("2026-09-01T00:00:00Z", true, now)).toBe("archived");
  });
});

describe("install.rdf add-on IDs", () => {
  it("never reports an application's ID as the add-on's own", () => {
    const rdf = `<RDF xmlns:em="http://www.mozilla.org/2004/em-rdf#">
      <Description about="urn:mozilla:install-manifest">
        <em:targetApplication RDF:resource="rdf:#$ff"/>
        <em:targetApplication RDF:resource="rdf:#$zotero"/>
        <em:id>scholar@example.org</em:id>
        <em:version>1.0</em:version>
      </Description>
      <Description about="rdf:#$ff" em:id="{ec8030f7-c20a-464f-9b0e-13a3a9e97384}" em:minVersion="3.0" em:maxVersion="60.*"/>
    </RDF>`;
    expect(parseInstallRdf(rdf).addonId).toBe("scholar@example.org");
  });

  it("skips a Description referenced as a target application (zotupdate)", () => {
    const rdf = `<RDF:RDF xmlns:em="http://www.mozilla.org/2004/em-rdf#" xmlns:RDF="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <RDF:Description RDF:about="rdf:#$x61SL3" em:id="{3A807F45-47B3-4705-9AE6-BADEB861E297}" em:minVersion="2.0" em:maxVersion="20.*"/>
      <RDF:Description RDF:about="urn:mozilla:install-manifest" em:id="zoterozotupdate@018.ai" em:version="1.1.1"
        em:updateURL="https://raw.githubusercontent.com/018/zotupdate/main/update.rdf">
        <em:targetApplication RDF:resource="rdf:#$x61SL3"/>
        <em:targetApplication><Description><em:id>zotero@chnm.gmu.edu</em:id><em:minVersion>5.0.66</em:minVersion><em:maxVersion>5.0.*</em:maxVersion></Description></em:targetApplication>
      </RDF:Description>
    </RDF:RDF>`;
    expect(parseInstallRdf(rdf)).toMatchObject({
      addonId: "zoterozotupdate@018.ai",
      version: "1.1.1",
      minVersion: "5.0.66",
      maxVersion: "5.0.*",
    });
  });
});

describe("history", () => {
  it("appends one row per plugin per day and replaces a re-run day", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { appendHistory } = await import("../src/census/run.ts");
    const dir = await mkdtemp(join(tmpdir(), "atlas-history-"));
    const row = (stars: number) =>
      ({
        repo: "a/b",
        verdict: "zotero-plugin",
        stars,
        supports: [9, 10],
        worksWithCurrent: true,
        maintenance: "active",
        totalXpiDownloads: 100,
        latestAssets: [
          { name: "b.xpi", size: 10, updatedAt: "2026-09-01T00:00:00Z", downloadCount: 5 },
        ],
      }) as unknown as import("../src/census/run.ts").CensusRow;
    await appendHistory([row(1)], "2026-09-24", { candidates: 5 }, dir);
    await appendHistory([row(2)], "2026-09-25", { candidates: 5 }, dir);
    await appendHistory([row(3)], "2026-09-25", { candidates: 6 }, dir);
    const month = parseCsv(await readFile(join(dir, "2026-09.csv"), "utf8"));
    expect(month.slice(1).map((r) => [r[0], r[3]])).toEqual([
      ["2026-09-24", "1"],
      ["2026-09-25", "3"],
    ]);
    expect(month[1]?.[16]).toBe("9;10");
    const summary = parseCsv(await readFile(join(dir, "summary.csv"), "utf8"));
    expect(summary.slice(1).map((r) => [r[0], r[1], r[2]])).toEqual([
      ["2026-09-24", "5", "1"],
      ["2026-09-25", "6", "1"],
    ]);
  });
});

describe("known plugins stay candidates", () => {
  it("lists the last census's plugin rows and every plugin card the census lost", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { knownRepos } = await import("../src/census/run.ts");
    const dir = await mkdtemp(join(tmpdir(), "atlas-known-"));
    const census = join(dir, "census");
    const generated = join(dir, "generated");
    await mkdir(census);
    await mkdir(join(generated, "zotvim"), { recursive: true });
    await writeFile(
      join(census, "census.json"),
      JSON.stringify({
        rows: [
          { repo: "a/Plugin", verdict: "zotero-plugin", sources: ["topic"] },
          { repo: "a/old", verdict: "zotero-plugin-legacy", sources: ["sheet"] },
          { repo: "a/docs", verdict: "no-xpi-release", sources: ["topic"] },
        ],
      }),
    );
    await writeFile(
      join(generated, "index.json"),
      JSON.stringify([
        { slug: "plugin", repo: "a/plugin", kind: "plugin" },
        { slug: "zotvim", repo: "jan-grp/zotvim", kind: "plugin" },
        { slug: "wiki", repo: "z/wiki", kind: "resource" },
      ]),
    );
    await writeFile(
      join(generated, "zotvim", "profile.json"),
      JSON.stringify({ sources: ["code-search", "not-a-source"] }),
    );
    const known = await knownRepos(census, generated);
    expect(Object.fromEntries([...known].map(([k, v]) => [k, [...v]]))).toEqual({
      "a/plugin": ["topic"],
      "a/old": ["sheet"],
      "jan-grp/zotvim": ["code-search"],
    });
  });
});

describe("batched GitHub queries", () => {
  /**
   * Answers like GitHub: a batch that includes `heavy/repo` with anything else exceeds the
   * resource limits, so every release asset in it comes back null with RESOURCE_LIMITS_EXCEEDED
   * (jorgepb96/nodus did this to 19 neighbours, 2026-11). `gone/repo` doesn't exist.
   */
  const fakeGitHub = () => {
    const batches: string[][] = [];
    const gh = {
      graphql: async (query: string) => {
        const repos = [
          ...query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g),
        ];
        const keys = repos.map((m) => `${m[2]}/${m[3]}`);
        batches.push(keys);
        const tooBig = keys.includes("heavy/repo") && keys.length > 1;
        const data: Record<string, unknown> = {};
        const errors: GraphqlError[] = [];
        for (const [i, m] of repos.entries()) {
          const key = keys[i] as string;
          if (key === "gone/repo") {
            data[m[1] as string] = null;
            errors.push({
              type: "NOT_FOUND",
              message: "Could not resolve",
              path: [m[1] as string],
            });
            continue;
          }
          data[m[1] as string] = {
            nameWithOwner: key,
            stargazerCount: 1,
            isFork: false,
            releases: {
              nodes: [{ releaseAssets: { nodes: [tooBig ? null : { name: "plugin.xpi" }] } }],
            },
          };
          if (tooBig) {
            errors.push({ type: "RESOURCE_LIMITS_EXCEEDED", message: "Resource limits exceeded" });
          }
        }
        return { data, errors };
      },
    };
    return { gh: gh as unknown as GitHub, batches };
  };

  it("splits a batch GitHub only partly answered instead of reading it as 'no .xpi'", async () => {
    const { gh, batches } = fakeGitHub();
    const keys = ["a/one", "b/two", "heavy/repo", "c/three"];
    const light = await fetchLight(gh, keys, () => {});
    for (const key of keys) expect(light.get(key)?.hasXpi, key).toBe(true);
    expect(batches.length).toBeGreaterThan(1);
  });

  it("leaves out a repository GitHub keeps failing on, so the census keeps its last row", async () => {
    const { gh } = fakeGitHub();
    const light = await fetchLight(
      {
        graphql: async () => ({
          data: {
            r0: { nameWithOwner: "heavy/repo", stargazerCount: 1, isFork: false, releases: null },
          },
          errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "Resource limits exceeded" }],
        }),
      } as unknown as typeof gh,
      ["heavy/repo"],
      () => {},
    );
    expect(light.has("heavy/repo")).toBe(false);
  });

  it("treats a missing repository as missing, without splitting the batch", async () => {
    const { gh, batches } = fakeGitHub();
    const light = await fetchLight(gh, ["a/one", "gone/repo"], () => {});
    expect(light.get("gone/repo")).toBeNull();
    expect(light.get("a/one")?.hasXpi).toBe(true);
    expect(batches).toHaveLength(1);
  });

  it("asks a repo too big on its own for fewer releases instead of giving up on it", async () => {
    const asked: string[] = [];
    const gh = {
      graphql: async (query: string) => {
        const releases = Number(query.match(/releases\(first: (\d+)/)?.[1]);
        asked.push(`${releases}`);
        // bydb/mindgraph-notes: 270 releases of 20 files; 50 of them exceed the limits.
        if (releases > 20) {
          return {
            data: { r0: null },
            errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "Resource limits exceeded" }],
          };
        }
        const asset = { name: "p.xpi", size: 1, downloadCount: 5, updatedAt: "", downloadUrl: "" };
        return {
          data: {
            r0: {
              nameWithOwner: "huge/repo",
              url: "https://github.com/huge/repo",
              stargazerCount: 1,
              forkCount: 0,
              isFork: false,
              isArchived: false,
              pushedAt: null,
              createdAt: "2026-01-01T00:00:00Z",
              description: null,
              homepageUrl: null,
              parent: null,
              licenseInfo: null,
              repositoryTopics: { nodes: [] },
              defaultBranchRef: null,
              listed: { totalCount: 270 },
              hasIssuesEnabled: true,
              openIssues: { totalCount: 3 },
              closedIssues: { totalCount: 41 },
              releases: {
                totalCount: 270,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    tagName: "v2",
                    publishedAt: "2026-11-01T00:00:00Z",
                    isPrerelease: false,
                    isDraft: false,
                    releaseAssets: { nodes: [asset] },
                  },
                ],
              },
            },
          },
          errors: [],
        };
      },
    } as unknown as GitHub;
    const full = await fetchFull(gh, ["huge/repo"], () => {});
    expect(asked).toEqual(["50", "10"]);
    expect(full.get("huge/repo")?.releases[0]?.assets[0]?.name).toBe("p.xpi");
    expect(full.get("huge/repo")?.releaseCount).toBe(270);
    expect(full.get("huge/repo")?.issues).toEqual({ enabled: true, open: 3, closed: 41 });
  });
});

describe("Zotero add-ons released far behind a repo's newest release", () => {
  type Node = { tag: string; prerelease?: boolean; files: string[] };
  const nodesOf = (nodes: Node[]) =>
    nodes.map((n) => ({
      tagName: n.tag,
      publishedAt: "2026-09-03T00:00:00Z",
      isPrerelease: n.prerelease ?? false,
      isDraft: false,
      releaseAssets: {
        nodes: n.files.map((name) => ({
          name,
          size: 1,
          downloadCount: 2,
          updatedAt: "",
          downloadUrl: `https://example.org/${n.tag}/${name}`,
        })),
      },
    }));
  const obsidian = (from: number, to: number): Node[] =>
    Array.from({ length: to - from }, (_, i) => ({
      tag: `1.17.${to - i}`,
      files: ["main.js", "manifest.json", "styles.css"],
    }));

  it("pass A looks further back when the newest 10 releases ship no .xpi", async () => {
    // Pages per repo, after each cursor: Heptazero/obsidian-lexis's Zotero add-on is its 37th
    // newest release. none/here has 210 releases without one; small/repo has only 10.
    const pages: Record<string, Record<string, { nodes: Node[]; next: string | null }>> = {
      "heptazero/obsidian-lexis": {
        "": { nodes: obsidian(68, 78), next: "c10" },
        c10: {
          nodes: [...obsidian(42, 68), { tag: "zotero-v0.2.2", files: ["lexis-zotero-0.2.2.xpi"] }],
          next: "c110",
        },
      },
      "none/here": {
        "": { nodes: obsidian(200, 210), next: "n10" },
        n10: { nodes: obsidian(100, 200), next: "n110" },
        n110: { nodes: obsidian(0, 100), next: null },
      },
      "small/repo": { "": { nodes: obsidian(0, 10), next: null } },
    };
    const asked: string[] = [];
    const page = (key: string, after: string) => {
      const p = pages[key]?.[after];
      if (!p) throw new Error(`unexpected page ${key} after ${after}`);
      asked.push(`${key}@${after}`);
      return {
        pageInfo: { hasNextPage: p.next !== null, endCursor: p.next },
        nodes: nodesOf(p.nodes),
      };
    };
    const gh = {
      graphql: async (query: string) => {
        const data: Record<string, unknown> = {};
        const after = query.match(/after: "([^"]+)"/)?.[1];
        for (const m of query.matchAll(
          /(r\d+: )?repository\(owner: "([^"]+)", name: "([^"]+)"\)/g,
        )) {
          const key = `${m[2]}/${m[3]}`.toLowerCase();
          const releases = page(key, after ?? "");
          if (after) return { data: { repository: { releases } }, errors: [] };
          data[(m[1] ?? "").replace(": ", "")] = {
            nameWithOwner: key,
            stargazerCount: 0,
            isFork: false,
            releases,
          };
        }
        return { data, errors: [] };
      },
    } as unknown as GitHub;
    const light = await fetchLight(gh, Object.keys(pages), () => {});
    expect(light.get("heptazero/obsidian-lexis")?.hasXpi).toBe(true);
    expect(light.get("none/here")?.hasXpi).toBe(false);
    expect(light.get("small/repo")?.hasXpi).toBe(false);
    expect(asked.filter((a) => !a.endsWith("@"))).toEqual([
      "heptazero/obsidian-lexis@c10",
      "none/here@n10",
      "none/here@n110",
    ]);
  });

  const full = (name: string, nodes: Node[], next: string | null) => ({
    nameWithOwner: name,
    url: `https://github.com/${name}`,
    stargazerCount: 1,
    forkCount: 0,
    isFork: false,
    isArchived: false,
    pushedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    description: null,
    homepageUrl: null,
    parent: null,
    licenseInfo: null,
    repositoryTopics: { nodes: [] },
    defaultBranchRef: null,
    listed: { totalCount: 95 },
    releases: {
      totalCount: 95,
      pageInfo: { hasNextPage: next !== null, endCursor: next },
      nodes: nodesOf(nodes),
    },
  });
  // Further back, for both repos: a prerelease and two stable releases with an .xpi.
  const older: Node[] = [
    { tag: "0.9.0", files: ["main.js"] },
    { tag: "v0.7.0-beta", prerelease: true, files: ["companion.xpi"] },
    { tag: "v0.6.1", files: ["companion.xpi", "main.js"] },
    { tag: "v0.5.0", files: ["companion.xpi"] },
  ];
  const fullGitHub = (first: Record<string, Node[]>) =>
    ({
      graphql: async (query: string) => {
        if (query.includes("after:"))
          return {
            data: {
              repository: {
                releases: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: nodesOf(older),
                },
              },
            },
            errors: [],
          };
        const data: Record<string, unknown> = {};
        for (const m of query.matchAll(
          /(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g,
        )) {
          const key = `${m[2]}/${m[3]}`;
          data[m[1] as string] = full(key, first[key] ?? [], "p50");
        }
        return { data, errors: [] };
      },
    }) as unknown as GitHub;

  it("pass B keeps the older releases with an .xpi when none of the newest 50 has one", async () => {
    const gh = fullGitHub({ "jmiba/zotero-redisearch-rag": obsidian(45, 50) });
    const repo = (await fetchFull(gh, ["jmiba/zotero-redisearch-rag"], () => {})).get(
      "jmiba/zotero-redisearch-rag",
    );
    // The newest releases first, then the older ones with an .xpi down to the first stable one.
    expect(repo?.releases.map((r) => r.tag)).toEqual([
      ...obsidian(45, 50).map((n) => n.tag),
      "v0.7.0-beta",
      "v0.6.1",
    ]);
    expect(pickRelease(repo?.releases ?? [])?.tag).toBe("v0.6.1");
    // Downloads still count every release's .xpi files.
    expect(repo?.totalXpiDownloads).toBe(6);
  });

  it("pass B leaves a repo whose newest releases ship an .xpi as it was", async () => {
    const newest: Node[] = [{ tag: "v2.0.0", files: ["plugin.xpi"] }, ...obsidian(46, 50)];
    const gh = fullGitHub({ "a/plugin": newest });
    const repo = (await fetchFull(gh, ["a/plugin"], () => {})).get("a/plugin");
    expect(repo?.releases.map((r) => r.tag)).toEqual(newest.map((n) => n.tag));
    expect(repo?.totalXpiDownloads).toBe(8);
  });
});

describe("ZotDex, a curated list", () => {
  afterEach(() => vi.unstubAllGlobals());
  const gh = { rest: async () => ({ status: 200, data: { tree: [] } }) } as unknown as GitHub;
  const answer = (zotdex: Response) =>
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("zotdex.jmgirard.com") ? zotdex : new Response('repo: "a/b"'),
    );

  it("names each repository its plugins come from, once", async () => {
    answer(
      Response.json({
        plugins: [
          { repoUrl: "https://github.com/Heptazero/obsidian-lexis" },
          { repoUrl: "https://github.com/heptazero/obsidian-lexis/" },
          { repoUrl: "https://gitlab.com/someone/plugin" },
          { id: "no-repo@example.org" },
        ],
      }),
    );
    const lists = await curatedLists(gh, "test", new Map());
    expect(lists.find((l) => l.source === "zotdex")?.repos).toEqual(["heptazero/obsidian-lexis"]);
    expect(lists.find((l) => l.source === "zotero-chinese")?.repos).toEqual(["a/b"]);
  });

  it("leaves the list empty, not the census stopped, when ZotDex can't be read", async () => {
    answer(new Response("gone", { status: 404 }));
    const lists = await curatedLists(gh, "test", new Map());
    const zotdex = lists.find((l) => l.source === "zotdex");
    expect(zotdex?.repos).toEqual([]);
    expect(zotdex?.query).toMatch(/unavailable: .*HTTP 404/);
    expect(lists.find((l) => l.source === "zotero-chinese")?.repos).toEqual(["a/b"]);
  });
});

describe("new plugins on the curated lists (nightly)", () => {
  // GitHub's answer per name the lists use: renamed repos answer with their current name.
  const current: Record<string, string | null> = {
    "muisedestiny/zoterostyle": "MuiseDestiny/zotero-style",
    "huaisure/zotero-quick-copy-pdf": "Huaisure/zotero-quick-copy-pdf",
    "xiuxiuki/zotero-pdf2zh-batch": "xiuxiuki/zotero-pdf2zh-batch",
    "old/name": "someone/new-name",
    "gone/repo": null,
  };
  const asked: string[] = [];
  const gh = {
    graphql: async (query: string) => {
      const data: Record<string, unknown> = {};
      for (const m of query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
        const key = `${m[2]}/${m[3]}`;
        asked.push(key);
        const name = current[key];
        data[m[1] as string] = name
          ? {
              nameWithOwner: name,
              stargazerCount: 0,
              isFork: false,
              releases: { nodes: [{ releaseAssets: { nodes: [{ name: "p.xpi" }] } }] },
            }
          : null;
      }
      return { data, errors: [] };
    },
  } as unknown as GitHub;

  it("adds only repos the last census didn't measure, under their current name", async () => {
    asked.length = 0;
    const found = await newOnLists(
      gh,
      [
        {
          source: "addon-market",
          query: "addon_infos.json",
          repos: ["muisedestiny/zoterostyle", "huaisure/zotero-quick-copy-pdf", "gone/repo"],
        },
        {
          source: "addon-market-tracked",
          query: "addons/",
          repos: ["huaisure/zotero-quick-copy-pdf", "xiuxiuki/zotero-pdf2zh-batch", "old/name"],
        },
        { source: "zotero-chinese", query: "plugins.ts", repos: ["muisedestiny/zotero-style"] },
      ],
      new Set(["muisedestiny/zotero-style"]),
      () => {},
    );
    // Known by its current name: not asked about. Listed by its old name: asked, then left out.
    expect(asked).not.toContain("muisedestiny/zotero-style");
    expect(asked).toContain("muisedestiny/zoterostyle");
    expect([...found.keys()].sort()).toEqual([
      "huaisure/zotero-quick-copy-pdf",
      "someone/new-name",
      "xiuxiuki/zotero-pdf2zh-batch",
    ]);
    expect([...(found.get("huaisure/zotero-quick-copy-pdf")?.sources ?? [])].sort()).toEqual([
      "addon-market",
      "addon-market-tracked",
    ]);
    expect(found.get("someone/new-name")?.hasXpi).toBe(true);
  });

  it("asks GitHub nothing when every listed repo is known", async () => {
    asked.length = 0;
    const found = await newOnLists(
      gh,
      [{ source: "addon-market", query: "addon_infos.json", repos: ["a/b"] }],
      new Set(["a/b"]),
      () => {},
    );
    expect(found.size).toBe(0);
    expect(asked).toEqual([]);
  });
});
