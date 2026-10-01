import { describe, expect, it } from "vitest";
import {
  compareVersions,
  installProblem,
  supportedMajors,
  supportsVersion,
  type ZoteroVersions,
} from "../src/census/compat.ts";
import { parseCsv, toCsv } from "../src/census/csv.ts";
import { maintenanceOf, pickRelease } from "../src/census/run.ts";
import { repoKeyFromUrl } from "../src/census/sources.ts";
import {
  parseInstallRdf,
  parseManifestJson,
  readXpiManifests,
  type XpiManifest,
} from "../src/census/xpi.ts";
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
