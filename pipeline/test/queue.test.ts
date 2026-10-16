import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQueue, KINDS, type QueueState } from "../src/queue/build.ts";
import { queueMarkdown } from "../src/queue/report.ts";

const NOW = new Date("2026-10-01T00:00:00Z");
const sha = (c: string) => c.repeat(64);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "queue-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, value: unknown) => {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), JSON.stringify(value));
};

interface PluginOpts {
  slug: string;
  sha?: string;
  label?: string;
  value?: string;
  drivers?: string[];
  hosts?: string[];
  downloads?: number;
  hidden?: boolean;
  publishedAt?: string | null;
  sources?: string[];
  analysis?: unknown;
}

async function plugin(o: PluginOpts) {
  const version = "1.0.0";
  await write(`generated/${o.slug}/profile.json`, {
    slug: o.slug,
    name: `Plugin ${o.slug}`,
    listing: { hiddenByDefault: o.hidden ?? false },
    sources: o.sources ?? [],
    popularity: { downloads: o.downloads ?? 0 },
    install: {
      version,
      publishedAt: o.publishedAt ?? null,
      asset: { sha256: o.sha ?? sha("a") },
    },
    trust: {
      overall: { label: o.label ?? "low-concern", reasons: ["a reason"] },
      facets: {
        dataSharing: {
          value: o.value ?? "no-network-found",
          drivers: o.drivers ?? [],
          hosts: o.hosts ? [{ category: "x", hosts: o.hosts }] : [],
        },
      },
    },
  });
  if (o.analysis) await write(`generated/${o.slug}/${version}.json`, { analysis: o.analysis });
}

async function sandbox(slug: string, over: Record<string, unknown> = {}) {
  await write(`sandbox/${slug}.json`, {
    schemaVersion: 1,
    sandboxVersion: "1.1.0",
    slug,
    sha256: sha("a"),
    addonId: null,
    zotero: "9.0.6",
    testedAt: "2026-09-27T10:12:19Z",
    seconds: 100,
    verdict: "as-described",
    loaded: true,
    cutShort: false,
    exercised: {
      itemsSelected: 1,
      readerOpened: false,
      settingsPane: false,
      menuItems: 0,
      dialogs: 0,
    },
    contacted: [],
    hostUsage: {},
    requests: [],
    refused: [],
    programs: [],
    servers: [],
    settings: [],
    files: [],
    databaseStructureChanged: false,
    unexpected: [],
    ...over,
  });
}

const run = async (previous: QueueState | null = null) =>
  buildQueue({ dataDir: dir, previous, now: NOW });

describe("investigation queue", () => {
  it("raises nothing for a no-network plugin that contacted nothing, and counts it", async () => {
    await plugin({ slug: "quiet" });
    await sandbox("quiet");
    const { queue } = await run();
    expect(queue.items).toEqual([]);
    expect(queue.agreement).toEqual([
      { value: "no-network-found", tested: 1, contactedNothing: 1, contactedUnlisted: 0 },
    ]);
  });

  it("ignores a sandbox record for a different file", async () => {
    await plugin({ slug: "old", sha: sha("b") });
    await sandbox("old", { contacted: ["evil.example"] });
    const { queue } = await run();
    expect(queue.items).toEqual([]);
    expect(queue.agreement).toEqual([]);
  });

  it("rates a possible miss by what the requests carried, and aliases GitHub's hosts", async () => {
    await plugin({ slug: "fetcher" });
    await sandbox("fetcher", {
      contacted: ["example.org"],
      hostUsage: { "example.org": { usage: "fetches", sent: [] } },
    });
    await plugin({ slug: "sender" });
    await sandbox("sender", {
      contacted: ["api.example.com"],
      hostUsage: { "api.example.com": { usage: "sends-data", sent: [] } },
    });
    await plugin({ slug: "github", hosts: ["github.com"] });
    await sandbox("github", { contacted: ["release-assets.githubusercontent.com"] });
    const { queue } = await run();
    const misses = queue.items.filter((i) => i.kind === "possible-miss");
    expect(misses.map((i) => [i.slug, i.priority])).toEqual([
      ["sender", "high"],
      ["fetcher", "low"],
    ]);
    expect(misses[0]?.details).toEqual({
      hosts: [{ host: "api.example.com", usage: "sends-data" }],
    });
    expect(misses[0]?.key).toBe(`possible-miss:sender:${sha("a").slice(0, 12)}`);
  });

  it("separates an untested unknown destination from a tested one that contacted nothing", async () => {
    await plugin({ slug: "untested", drivers: ["DS-UNKNOWN-DESTINATION"] });
    await plugin({ slug: "tested", drivers: ["DS-UNKNOWN-DESTINATION"] });
    await sandbox("tested");
    await plugin({ slug: "quietly", drivers: ["DS-UNTRACED-QUIET"] });
    await sandbox("quietly");
    const { queue } = await run();
    const kinds = queue.items.map((i) => [i.kind, i.slug]).sort();
    expect(kinds).toEqual([
      ["checking", "untested"],
      ["untraced-but-quiet", "quietly"],
      ["untraced-but-quiet", "tested"],
    ]);
  });

  it("flags grade changes only for a new file with another label", async () => {
    await plugin({ slug: "p", label: "high-concern" });
    const first = await run();
    expect(first.queue.items.filter((i) => i.kind === "grade-change")).toEqual([]);
    expect(first.state.labels.p).toEqual({ label: "high-concern", sha256: sha("a") });

    const changed = await run({ labels: { p: { label: "low-concern", sha256: sha("b") } } });
    const item = changed.queue.items.find((i) => i.kind === "grade-change");
    expect(item?.details).toEqual({
      from: "low-concern",
      to: "high-concern",
      fromSha256: sha("b"),
    });
    expect(item?.priority).toBe("high");

    const sameLabel = await run({ labels: { p: { label: "high-concern", sha256: sha("b") } } });
    expect(sameLabel.queue.items.filter((i) => i.kind === "grade-change")).toEqual([]);
    const sameFile = await run({ labels: { p: { label: "low-concern", sha256: sha("a") } } });
    expect(sameFile.queue.items.filter((i) => i.kind === "grade-change")).toEqual([]);
  });

  it("flags a recent or submitted release graded B or C", async () => {
    await plugin({ slug: "fresh", label: "review-details", publishedAt: "2026-09-25T00:00:00Z" });
    await plugin({ slug: "stale", label: "review-details", publishedAt: "2026-06-01T00:00:00Z" });
    await plugin({ slug: "sub", label: "high-concern", sources: ["submitted"] });
    const { queue } = await run();
    const items = queue.items.filter((i) => i.kind === "new-release-concern");
    expect(items.map((i) => i.slug).sort()).toEqual(["fresh", "sub"]);
    expect(items.find((i) => i.slug === "sub")?.summary).toMatch(/graded C/);
  });

  it("groups unknown hosts across plugins and reads the library match loosely", async () => {
    const analysis = (extra: unknown[] = []) => ({
      transparency: { vendoredLibraries: extra },
      network: {
        hosts: [
          { host: "Odd.example", category: "unknown", usage: "request", inVendoredCode: false },
          { host: "linked.example", category: "unknown", usage: "link", inVendoredCode: false },
          { host: "lib.example", category: "unknown", usage: "request", inVendoredCode: true },
        ],
      },
    });
    await plugin({
      slug: "one",
      analysis: analysis([
        { name: "jszip", match: "partial", unmatched: ["a.js:3"] },
        { name: "foo", match: "not-in-catalogue" },
      ]),
    });
    await plugin({ slug: "two", analysis: analysis([{ name: "foo", match: "not-in-catalogue" }]) });
    const { queue } = await run();
    const hosts = queue.items.filter((i) => i.kind === "unknown-host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      key: "unknown-host:odd.example",
      details: { plugins: ["one", "two"] },
    });
    expect(queue.items.find((i) => i.kind === "modified-library")).toMatchObject({
      priority: "high",
      details: { library: "jszip", unmatched: ["a.js:3"] },
    });
    expect(queue.items.find((i) => i.kind === "uncatalogued-library")?.details).toEqual({
      plugins: ["one", "two"],
    });
    expect(queueMarkdown(queue)).toContain("a.js:3");
  });

  it("counts a download review that overturned the rule", async () => {
    await write("reviews/download-exec/p.json", {
      schemaVersion: 1,
      slug: "p",
      version: "1.0.0",
      sha256: sha("a"),
      reviewedAt: "2026-09-01",
      method: "read the code",
      real: false,
      concern: "low",
      rule: "CAP-DOWNLOAD-EXEC",
      summary: "s",
      facts: {},
    });
    await write("reviews/network/n.json", {
      slug: "n",
      rule: "DS-UNKNOWN-DESTINATION",
      outcome: "no-requests",
      sha256: sha("a"),
    });
    await write("reviews/network/bad.json", { nonsense: true });
    const { queue } = await run();
    expect(queue.ruleAccuracy[0]).toEqual({
      rule: "CAP-DOWNLOAD-EXEC",
      reviewed: 1,
      overturned: 1,
      changedLevel: 0,
      examples: ["p"],
    });
    expect(queue.ruleAccuracy[1]).toMatchObject({ rule: "DS-UNKNOWN-DESTINATION", overturned: 1 });
    expect(queue.ruleAccuracy.at(-1)?.rule).toBe("DS-UNKNOWN-DESTINATION (sandbox)");
  });

  describe("review-lapsed", () => {
    const review = (over: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      slug: "p",
      version: "1.0.0",
      sha256: sha("c"),
      reviewedAt: "2026-09-01",
      method: "read the code",
      real: true,
      concern: "medium",
      rule: "CAP-DOWNLOAD-EXEC-REVIEWED",
      summary: "s",
      facts: {},
      ...over,
    });
    const analysis = (codeKey?: string) => ({
      capabilities: [{ id: "download-exec", ...(codeKey ? { codeKey } : {}) }],
      network: { hosts: [] },
      transparency: { vendoredLibraries: [] },
    });
    const lapsed = async () => (await run()).queue.items.filter((i) => i.kind === "review-lapsed");

    it("fires when the file and the code behind the finding both changed", async () => {
      await plugin({ slug: "p", analysis: analysis("new-key") });
      await write("reviews/download-exec/p.json", review({ codeKey: "old-key", version: "0.9.0" }));
      const items = await lapsed();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        priority: "high",
        summary:
          "Our review of 'download-exec' covered 0.9.0; the code behind it changed by 1.0.0: review it again",
        details: {
          capability: "download-exec",
          reviewedVersion: "0.9.0",
          currentVersion: "1.0.0",
          hadCodeKey: true,
        },
      });
    });

    it("fires for a review with no codeKey on a new file, and says so", async () => {
      await plugin({ slug: "p", analysis: analysis("k") });
      await write("reviews/download-exec/p.json", review());
      expect((await lapsed())[0]?.details).toMatchObject({ hadCodeKey: false });
    });

    it("doesn't fire when the file or the codeKey still matches, or the finding is gone", async () => {
      await plugin({ slug: "p", sha: sha("c"), analysis: analysis("k") });
      await write("reviews/download-exec/p.json", review());
      expect(await lapsed()).toEqual([]);
      await plugin({ slug: "p", analysis: analysis("same") });
      await write("reviews/download-exec/p.json", review({ codeKey: "same" }));
      expect(await lapsed()).toEqual([]);
      await write("reviews/download-exec/p.json", review({ codeKey: "other" }));
      await plugin({
        slug: "p",
        analysis: {
          capabilities: [],
          network: { hosts: [] },
          transparency: { vendoredLibraries: [] },
        },
      });
      expect(await lapsed()).toEqual([]);
    });

    it("sits right after modified-library in the kind order", () => {
      expect(KINDS.indexOf("review-lapsed")).toBe(KINDS.indexOf("modified-library") + 1);
    });

    it("counts reviews of other capabilities in their own rule rows", async () => {
      await write("reviews/download-exec/p.json", review());
      await write(
        "reviews/runs-sent-code/q.json",
        review({ slug: "q", real: false, rule: "CAP-SENT-CODE-REVIEWED" }),
      );
      await write("reviews/not-a-capability/z.json", review({ slug: "z" }));
      const { queue } = await run();
      expect(queue.ruleAccuracy.map((r) => r.rule)).toEqual([
        "CAP-DOWNLOAD-EXEC",
        "CAP-RUNS-SENT-CODE",
        "DS-UNKNOWN-DESTINATION (sandbox)",
      ]);
      expect(queue.ruleAccuracy[1]).toEqual({
        rule: "CAP-RUNS-SENT-CODE",
        reviewed: 1,
        overturned: 1,
        changedLevel: 0,
        examples: ["q"],
      });
    });
  });

  it("skips hidden plugins", async () => {
    await plugin({ slug: "hidden", hidden: true, drivers: ["DS-UNKNOWN-DESTINATION"] });
    const { queue, state } = await run();
    expect(queue.items).toEqual([]);
    expect(state.labels).toEqual({});
  });

  it("sorts by priority, then kind, then downloads, then key", async () => {
    await plugin({ slug: "low-dl", drivers: ["DS-UNKNOWN-DESTINATION"], downloads: 5 });
    await plugin({ slug: "high-dl", drivers: ["DS-UNKNOWN-DESTINATION"], downloads: 50 });
    await plugin({ slug: "miss", downloads: 1 });
    await sandbox("miss", { contacted: ["api.example.com"] });
    await plugin({ slug: "unexpected", downloads: 1 });
    await sandbox("unexpected", { verdict: "unexpected", unexpected: ["it did a thing"] });
    const { queue } = await run();
    expect(queue.items.map((i) => `${i.kind}:${i.slug}`)).toEqual([
      "possible-miss:miss",
      "sandbox-unexpected:unexpected",
      "checking:high-dl",
      "checking:low-dl",
    ]);
  });
});
