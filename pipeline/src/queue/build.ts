import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Analysis, CapabilityId, type PluginProfile, type SandboxRecord } from "@atlas/schema";
import { readFindingReview, readFindingReviews, reviewedFiles } from "../profile/reviews.ts";
import { readSandboxRecord } from "../profile/sandbox.ts";

/**
 * The investigation queue: where the scanner and the sandbox disagree, or where the scanner says
 * it couldn't tell. Everything here is derived from data/ on each run, so a case drops out once
 * its cause is fixed, catalogued or reviewed. The only memory is the snapshot of labels, which
 * is how a grade change shows up.
 */

export const KINDS = [
  "modified-library",
  "review-lapsed",
  "possible-miss",
  "sandbox-unexpected",
  "checking",
  "untraced-but-quiet",
  "new-release-concern",
  "grade-change",
  "unknown-host",
  "uncatalogued-library",
] as const;
export type Kind = (typeof KINDS)[number];

export type Priority = "high" | "medium" | "low";

export interface QueueItem {
  key: string;
  kind: Kind;
  priority: Priority;
  slug?: string;
  name?: string;
  version?: string;
  sha256?: string;
  label?: string;
  downloads?: number;
  summary: string;
  details: Record<string, unknown>;
}

export interface AgreementRow {
  value: string;
  tested: number;
  contactedNothing: number;
  contactedUnlisted: number;
}

export interface RuleAccuracyRow {
  rule: string;
  reviewed: number;
  overturned: number;
  changedLevel: number;
  examples: string[];
}

export interface Queue {
  generatedAt: string;
  counts: Record<Kind, number>;
  items: QueueItem[];
  agreement: AgreementRow[];
  ruleAccuracy: RuleAccuracyRow[];
}

export interface QueueState {
  labels: Record<string, { label: string; sha256: string }>;
}

const PRIORITY_ORDER: Priority[] = ["high", "medium", "low"];
const NEW_RELEASE_DAYS = 14;
const MAX_EXAMPLES = 5;

/** GitHub serves release downloads and source archives from these hosts: they're github.com. */
const SAME_AS: Record<string, string> = {
  "release-assets.githubusercontent.com": "github.com",
  "objects.githubusercontent.com": "github.com",
  "codeload.github.com": "github.com",
};

/** A host name as the two sides can be compared: www.x and x are one host. */
export function normaliseHost(raw: string): string {
  const name = raw.toLowerCase().replace(/\.$/, "");
  return (SAME_AS[name] ?? name).replace(/^www\./, "");
}

/** The fields of a vendored library entry that other tasks add; read loosely. */
interface LooseLibrary {
  name: string;
  match?: string;
  unmatched?: unknown[];
}

interface Plugin {
  profile: PluginProfile;
  slug: string;
  sha256: string;
  version: string;
  label: string;
  downloads: number;
  analysis: Analysis | null;
  record: SandboxRecord | null;
  drivers: string[];
  dataSharing: string;
  cardHosts: Set<string>;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function loadPlugins(dataDir: string): Promise<Plugin[]> {
  const generated = join(dataDir, "generated");
  let slugs: string[];
  try {
    slugs = (await readdir(generated)).sort();
  } catch {
    return [];
  }
  const plugins: Plugin[] = [];
  for (const slug of slugs) {
    const profile = (await readJson(join(generated, slug, "profile.json"))) as PluginProfile | null;
    if (!profile || profile.listing.hiddenByDefault || !profile.trust || !profile.install) continue;
    const sha256 = profile.install.asset.sha256;
    if (!sha256) continue;
    const version = profile.install.version;
    // The per-version file wraps the analysis next to the provenance and the card.
    const doc = (await readJson(join(generated, slug, `${version}.json`))) as {
      analysis?: Analysis;
    } | null;
    const record = await readSandboxRecord(slug, join(dataDir, "sandbox"));
    const dataSharing = profile.trust.facets.dataSharing;
    plugins.push({
      profile,
      slug,
      sha256,
      version,
      label: profile.trust.overall.label,
      downloads: profile.popularity.downloads ?? 0,
      analysis: doc?.analysis ?? null,
      record: record && record.sha256 === sha256 ? record : null,
      drivers: dataSharing.drivers ?? [],
      dataSharing: dataSharing.value,
      cardHosts: new Set(dataSharing.hosts.flatMap((g) => g.hosts).map(normaliseHost)),
    });
  }
  return plugins;
}

const librariesOf = (p: Plugin): LooseLibrary[] =>
  (p.analysis?.transparency?.vendoredLibraries ?? []) as unknown as LooseLibrary[];

/** The hosts a test contacted that the card doesn't list, by the name the record uses. */
const unlistedHosts = (p: Plugin): string[] =>
  (p.record?.contacted ?? []).filter((h) => !p.cardHosts.has(normaliseHost(h)));

const sha12 = (p: Plugin) => p.sha256.slice(0, 12);

const base = (p: Plugin) => ({
  slug: p.slug,
  name: p.profile.name,
  version: p.version,
  sha256: p.sha256,
  label: p.label,
  downloads: p.downloads,
});

export async function buildQueue(opts: {
  dataDir: string;
  previous: QueueState | null;
  now: Date;
}): Promise<{ queue: Queue; state: QueueState }> {
  const { dataDir, previous, now } = opts;
  const plugins = await loadPlugins(dataDir);
  const items: QueueItem[] = [];

  const state: QueueState = { labels: {} };
  for (const p of plugins) state.labels[p.slug] = { label: p.label, sha256: p.sha256 };

  for (const p of plugins) {
    for (const lib of librariesOf(p)) {
      if (lib.match !== "partial") continue;
      items.push({
        ...base(p),
        key: `modified-library:${p.slug}:${sha12(p)}:${lib.name}`,
        kind: "modified-library",
        priority: "high",
        summary: `Bundled ${lib.name} differs from its official release in places; those parts were scanned as the plugin's own code`,
        details: { library: lib.name, ...(lib.unmatched ? { unmatched: lib.unmatched } : {}) },
      });
    }

    // A hand review covers one release file and, when it has one, the code behind its finding. A
    // release that still has the finding but neither the file nor the code needs a new look.
    for (const review of await readFindingReviews(p.slug, join(dataDir, "reviews"))) {
      const now = p.analysis?.capabilities.find((c) => c.id === review.capability);
      if (!now) continue;
      if (reviewedFiles(review).includes(p.sha256)) continue;
      if (review.codeKey && review.codeKey === now.codeKey) continue;
      items.push({
        ...base(p),
        key: `review-lapsed:${p.slug}:${sha12(p)}:${review.capability}`,
        kind: "review-lapsed",
        priority: "high",
        summary: `Our review of '${review.capability}' covered ${review.version}; the code behind it changed by ${p.version}: review it again`,
        details: {
          capability: review.capability,
          reviewedVersion: review.version,
          currentVersion: p.version,
          hadCodeKey: Boolean(review.codeKey),
        },
      });
    }

    const record = p.record;
    const unlisted = unlistedHosts(p);
    if (record && unlisted.length > 0) {
      const hosts = unlisted.map((host) => ({
        host,
        usage: record.hostUsage?.[host]?.usage ?? null,
      }));
      const fetchesOnly = hosts.every((h) => h.usage === "fetches");
      items.push({
        ...base(p),
        key: `possible-miss:${p.slug}:${sha12(p)}`,
        kind: "possible-miss",
        priority: fetchesOnly ? "low" : "high",
        summary: `When we ran it, it contacted ${unlisted.join(", ")}, which its card doesn't list`,
        details: { hosts },
      });
    }

    if (record?.verdict === "unexpected") {
      items.push({
        ...base(p),
        key: `sandbox-unexpected:${p.slug}:${sha12(p)}`,
        kind: "sandbox-unexpected",
        priority: "high",
        summary: `When we ran it, it did things its card doesn't say: ${record.unexpected.join("; ")}`,
        details: { unexpected: record.unexpected },
      });
    }

    const unknownDestination = p.drivers.includes("DS-UNKNOWN-DESTINATION");
    if (p.label === "checking" || (unknownDestination && !record)) {
      items.push({
        ...base(p),
        key: `checking:${p.slug}:${sha12(p)}`,
        kind: "checking",
        priority: "medium",
        summary:
          "Has network code we couldn't trace and no sandbox run of this file: run it in the sandbox, or review the code",
        details: { drivers: p.drivers },
      });
    }

    const untraced = unknownDestination || p.drivers.includes("DS-UNTRACED-QUIET");
    if (untraced && record?.loaded && !record.cutShort && record.contacted.length === 0) {
      items.push({
        ...base(p),
        key: `untraced-but-quiet:${p.slug}:${sha12(p)}`,
        kind: "untraced-but-quiet",
        priority: "medium",
        summary:
          "Couldn't trace where its network code sends data, and it contacted nothing when we ran it. A run without an API key may never reach the feature: check the code for a default address",
        details: { drivers: p.drivers },
      });
    }

    if (p.label === "high-concern" || p.label === "review-details") {
      const published = p.profile.install?.publishedAt ?? null;
      const recent =
        published !== null &&
        now.getTime() - new Date(published).getTime() <= NEW_RELEASE_DAYS * 86_400_000;
      if (recent || p.profile.sources.includes("submitted")) {
        items.push({
          ...base(p),
          key: `new-release-concern:${p.slug}:${sha12(p)}`,
          kind: "new-release-concern",
          priority: "medium",
          summary: `New release graded ${p.label === "high-concern" ? "C" : "B"}: check its findings before people install it`,
          details: { reasons: p.profile.trust?.overall.reasons ?? [] },
        });
      }
    }

    const before = previous?.labels[p.slug];
    if (before && before.sha256 !== p.sha256 && before.label !== p.label) {
      items.push({
        ...base(p),
        key: `grade-change:${p.slug}:${sha12(p)}`,
        kind: "grade-change",
        priority: "high",
        summary: `Grade changed from ${before.label} to ${p.label} with a new release`,
        details: { from: before.label, to: p.label, fromSha256: before.sha256 },
      });
    }
  }

  // Aggregated kinds: one item per host or library, across plugins.
  const unknownHosts = new Map<string, Set<string>>();
  const uncatalogued = new Map<string, Set<string>>();
  for (const p of plugins) {
    for (const h of p.analysis?.network?.hosts ?? []) {
      if (h.category !== "unknown" || h.usage !== "request" || h.inVendoredCode) continue;
      const host = h.host.toLowerCase();
      unknownHosts.set(host, (unknownHosts.get(host) ?? new Set()).add(p.slug));
    }
    for (const lib of librariesOf(p)) {
      if (lib.match !== "not-in-catalogue") continue;
      uncatalogued.set(lib.name, (uncatalogued.get(lib.name) ?? new Set()).add(p.slug));
    }
  }
  for (const [host, set] of unknownHosts) {
    const slugs = [...set].sort();
    items.push({
      key: `unknown-host:${host}`,
      kind: "unknown-host",
      priority: "low",
      summary: `${host} isn't in our host table; ${slugs.length} plugin(s) send requests to it`,
      details: { plugins: slugs },
    });
  }
  for (const [name, set] of uncatalogued) {
    const slugs = [...set].sort();
    items.push({
      key: `uncatalogued-library:${name}`,
      kind: "uncatalogued-library",
      priority: "low",
      summary: `${name} is bundled in ${slugs.length} plugin(s) but has no fingerprints yet, so its code is trusted by name`,
      details: { plugins: slugs },
    });
  }

  items.sort(
    (a, b) =>
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
      (b.downloads ?? 0) - (a.downloads ?? 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
  for (const item of items) counts[item.kind]++;

  const queue: Queue = {
    generatedAt: now.toISOString(),
    counts,
    items,
    agreement: agreementTable(plugins),
    ruleAccuracy: await ruleAccuracy(dataDir, plugins),
  };
  return { queue, state };
}

function agreementTable(plugins: Plugin[]): AgreementRow[] {
  const rows = new Map<string, AgreementRow>();
  for (const p of plugins) {
    if (!p.record) continue;
    const row = rows.get(p.dataSharing) ?? {
      value: p.dataSharing,
      tested: 0,
      contactedNothing: 0,
      contactedUnlisted: 0,
    };
    row.tested++;
    if (p.record.contacted.length === 0) row.contactedNothing++;
    if (unlistedHosts(p).length > 0) row.contactedUnlisted++;
    rows.set(p.dataSharing, row);
  }
  return [...rows.values()].sort((a, b) => (a.value < b.value ? -1 : 1));
}

async function ruleAccuracy(dataDir: string, plugins: Plugin[]): Promise<RuleAccuracyRow[]> {
  const rows: RuleAccuracyRow[] = [];

  // One row per capability with reviews; download-exec keeps its rule name and comes first.
  const reviewsDir = join(dataDir, "reviews");
  const byCapability = new Map<string, RuleAccuracyRow>();
  const capabilityDirs = (await readdir(reviewsDir).catch(() => [] as string[]))
    .filter((d) => CapabilityId.safeParse(d).success)
    .sort((x, y) => (x === "download-exec" ? -1 : y === "download-exec" ? 1 : x < y ? -1 : 1));
  for (const dir of capabilityDirs) {
    const capability = CapabilityId.parse(dir);
    const row: RuleAccuracyRow = {
      rule: capability === "download-exec" ? "CAP-DOWNLOAD-EXEC" : `CAP-${dir.toUpperCase()}`,
      reviewed: 0,
      overturned: 0,
      changedLevel: 0,
      examples: [],
    };
    for (const file of await listJson(join(reviewsDir, dir))) {
      const slug = file.replace(/\.json$/, "");
      const review = await readFindingReview(capability, slug, reviewsDir);
      if (!review) continue;
      row.reviewed++;
      const overturned = !review.real;
      const changed = review.real && review.concern === "low";
      if (overturned) row.overturned++;
      if (changed) row.changedLevel++;
      if ((overturned || changed) && row.examples.length < MAX_EXAMPLES) row.examples.push(slug);
    }
    byCapability.set(capability, row);
  }
  // The download row is always there, as before.
  rows.push(
    byCapability.get("download-exec") ?? {
      rule: "CAP-DOWNLOAD-EXEC",
      reviewed: 0,
      overturned: 0,
      changedLevel: 0,
      examples: [],
    },
  );
  byCapability.delete("download-exec");
  rows.push(...byCapability.values());

  // Network reviews come from another task; anything that doesn't parse is skipped.
  const networkDir = join(dataDir, "reviews", "network");
  const network = new Map<string, RuleAccuracyRow>();
  for (const file of await listJson(networkDir)) {
    const review = (await readJson(join(networkDir, file))) as {
      slug?: unknown;
      rule?: unknown;
      outcome?: unknown;
    } | null;
    if (
      !review ||
      typeof review.slug !== "string" ||
      typeof review.rule !== "string" ||
      (review.outcome !== "no-requests" && review.outcome !== "hosts")
    )
      continue;
    const row = network.get(review.rule) ?? {
      rule: review.rule,
      reviewed: 0,
      overturned: 0,
      changedLevel: 0,
      examples: [],
    };
    row.reviewed++;
    if (review.outcome === "no-requests") row.overturned++;
    else row.changedLevel++;
    if (row.examples.length < MAX_EXAMPLES) row.examples.push(review.slug);
    network.set(review.rule, row);
  }
  rows.push(...[...network.values()].sort((a, b) => (a.rule < b.rule ? -1 : 1)));

  const sandbox: RuleAccuracyRow = {
    rule: "DS-UNKNOWN-DESTINATION (sandbox)",
    reviewed: 0,
    overturned: 0,
    changedLevel: 0,
    examples: [],
  };
  for (const p of plugins) {
    if (!p.record) continue;
    if (!p.drivers.includes("DS-UNKNOWN-DESTINATION") && !p.drivers.includes("DS-UNTRACED-QUIET"))
      continue;
    sandbox.reviewed++;
    const nothing = p.record.contacted.length === 0;
    const unlisted = unlistedHosts(p).length > 0;
    if (nothing) sandbox.overturned++;
    if (unlisted) sandbox.changedLevel++;
    if ((nothing || unlisted) && sandbox.examples.length < MAX_EXAMPLES)
      sandbox.examples.push(p.slug);
  }
  rows.push(sandbox);

  return rows;
}
