import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Analysis } from "@atlas/schema";
import type { CensusRow } from "../census/run.ts";
import { listZipEntries, readZipEntry, type XpiManifest } from "../census/xpi.ts";
import { loadConfig, requireGithubToken } from "../config.ts";
import { GitHub } from "../net/github.ts";
import { DiskCache, fetchWithRetry, mapLimit } from "../net/http.ts";
import { paths } from "../paths.ts";
import { ANALYZER_VERSION, analyzeXpi, developerHints, type XpiEntry } from "./analyze.ts";
import { loadHostTable } from "./hosts.ts";
import { type Preview, preview } from "./preview.ts";
import { buildScanReport } from "./report.ts";

/** Plugins checked in every scan regardless of rank: the brief's regression targets. */
const ALWAYS = [
  "MuiseDestiny/zotero-gpt",
  "MuiseDestiny/zotero-style",
  "MuiseDestiny/zotero-reference",
  "windingwind/zotero-pdf-translate",
  "retorquere/zotero-better-bibtex",
];
const MAX_XPI_BYTES = 60 * 1024 * 1024;

export type Group = "top" | "sample-2026" | "regression";

export interface ScanArtifact {
  asset: { name: string; url: string; size: number; uploadedAt: string; sha256: string };
  manifest: XpiManifest | null;
  analysis: Analysis;
  preview: Preview;
}

export interface ScanResult {
  repo: string;
  slug: string;
  group: Group;
  rank: number;
  name: string;
  stars: number | null;
  downloads: number | null;
  createdAt: string | null;
  tag: string | null;
  artifacts: ScanArtifact[];
  error: string | null;
}

export interface ScanOptions {
  top: number;
  sample: number;
}

export function selectTargets(
  rows: CensusRow[],
  opts: ScanOptions,
): { row: CensusRow; group: Group; rank: number }[] {
  const plugins = rows.filter(
    (r) => r.verdict === "zotero-plugin" || r.verdict === "zotero-plugin-legacy",
  );
  const byDownloads = [...plugins].sort(
    (a, b) =>
      (b.totalXpiDownloads ?? 0) - (a.totalXpiDownloads ?? 0) || a.repo.localeCompare(b.repo, "en"),
  );
  const top = byDownloads.slice(0, opts.top);
  const chosen = new Set(top.map((r) => r.repo.toLowerCase()));
  const regression = ALWAYS.map((repo) =>
    plugins.find((r) => r.repo.toLowerCase() === repo.toLowerCase()),
  ).filter((r): r is CensusRow => r !== undefined && !chosen.has(r.repo.toLowerCase()));
  for (const r of regression) chosen.add(r.repo.toLowerCase());
  // A fixed pseudo-random sample: order by a hash of the repo name, so reruns pick the same set.
  const hash = (s: string) =>
    createHash("sha256").update(`atlas-scan-sample-2026|${s.toLowerCase()}`).digest("hex");
  const sample = plugins
    .filter(
      (r) => r.createdAt?.startsWith("2026") && !r.isFork && !chosen.has(r.repo.toLowerCase()),
    )
    .sort((a, b) => hash(a.repo).localeCompare(hash(b.repo), "en"))
    .slice(0, opts.sample);
  return [
    ...top.map((row, i) => ({ row, group: "top" as const, rank: i + 1 })),
    ...regression.map((row) => ({
      row,
      group: "regression" as const,
      rank: byDownloads.indexOf(row) + 1,
    })),
    ...sample.map((row) => ({
      row,
      group: "sample-2026" as const,
      rank: byDownloads.indexOf(row) + 1,
    })),
  ];
}

function slugs(repos: string[]): Map<string, string> {
  const base = (r: string) =>
    (r.split("/")[1] ?? r)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "plugin";
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(base(r), (counts.get(base(r)) ?? 0) + 1);
  return new Map(
    repos.map((r) => {
      const b = base(r);
      const owner = (r.split("/")[0] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return [r, (counts.get(b) ?? 0) > 1 ? `${b}--${owner}` : b];
    }),
  );
}

export interface ReleaseAsset {
  name: string;
  size: number;
  updated_at: string;
  browser_download_url: string;
}

export async function runScan(
  opts: ScanOptions,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const config = loadConfig();
  const gh = new GitHub(
    requireGithubToken(config),
    config.userAgent,
    new DiskCache(join(config.cacheDir, "http")),
  );
  const blobIndex = new DiskCache(join(config.cacheDir, "blob-index"));
  const table = await loadHostTable();
  const census = JSON.parse(
    await readFile(join(paths.root, "data", "census", "census.json"), "utf8"),
  ) as {
    generatedAt: string;
    rows: CensusRow[];
  };
  const targets = selectTargets(census.rows, opts);
  const slugOf = slugs(targets.map((t) => t.row.repo));
  const analyzedAt = new Date().toISOString();
  log(
    `Scanning ${targets.length} plugins (analyzer ${ANALYZER_VERSION}, hosts table ${table.version})`,
  );

  const results = await mapLimit(
    targets,
    4,
    async ({ row, group, rank }, i): Promise<ScanResult> => {
      const result: ScanResult = {
        repo: row.repo,
        slug: slugOf.get(row.repo) ?? row.repo,
        group,
        rank,
        name: row.name,
        stars: row.stars,
        downloads: row.totalXpiDownloads,
        createdAt: row.createdAt,
        tag: row.latestTag,
        artifacts: [],
        error: null,
      };
      try {
        if (!row.latestTag) throw new Error("no release with an .xpi");
        const rel = await gh.rest<{ assets: ReleaseAsset[] }>(
          `/repos/${row.repo}/releases/tags/${encodeURIComponent(row.latestTag)}`,
        );
        const assets = (rel.data?.assets ?? [])
          .filter((a) => a.name.toLowerCase().endsWith(".xpi"))
          .slice(0, 2);
        if (!assets.length)
          throw new Error(`release ${row.latestTag} has no .xpi asset (HTTP ${rel.status})`);
        for (const asset of assets) {
          if (asset.size > MAX_XPI_BYTES)
            throw new Error(`${asset.name} is larger than ${MAX_XPI_BYTES} bytes`);
          const { bytes, sha256 } = await download(
            asset,
            blobIndex,
            config.cacheDir,
            config.userAgent,
          );
          const entries = await unzip(bytes);
          const { analysis, manifests, updateHost } = analyzeXpi({
            slug: result.slug,
            sha256,
            entries,
            table,
            analyzedAt,
            developer: developerHints(row.repo, row.addonId, null),
          });
          result.artifacts.push({
            asset: {
              name: asset.name,
              url: asset.browser_download_url,
              size: asset.size,
              uploadedAt: asset.updated_at,
              sha256,
            },
            manifest: manifests.find((m) => m.target === "zotero") ?? manifests[0] ?? null,
            analysis,
            preview: preview(analysis, updateHost),
          });
        }
      } catch (error) {
        result.error = (error as Error).message.slice(0, 300);
      }
      if ((i + 1) % 20 === 0) log(`  ${i + 1}/${targets.length}`);
      return result;
    },
  );

  const outDir = join(paths.root, "data", "scan");
  await mkdir(join(outDir, "plugins"), { recursive: true });
  for (const r of results) {
    await writeFile(join(outDir, "plugins", `${r.slug}.json`), `${JSON.stringify(r, null, 1)}\n`);
  }
  const meta = {
    generatedAt: analyzedAt,
    analyzerVersion: ANALYZER_VERSION,
    hostsTableVersion: table.version,
    censusGeneratedAt: census.generatedAt,
    options: opts,
  };
  await writeFile(
    join(outDir, "summary.json"),
    `${JSON.stringify({ ...meta, results: results.map(summarize) }, null, 1)}\n`,
  );
  const day = analyzedAt.slice(0, 10);
  await mkdir(join(paths.root, "docs", "reports"), { recursive: true });
  await writeFile(
    join(paths.root, "docs", "reports", `scan-${day}.md`),
    buildScanReport(results, meta),
  );
  const failed = results.filter((r) => r.error).length;
  log(`Wrote data/scan/plugins/*.json, data/scan/summary.json, docs/reports/scan-${day}.md`);
  log(`Scanned ${results.length - failed} plugins; ${failed} could not be scanned`);
}

export async function download(
  asset: ReleaseAsset,
  index: DiskCache,
  cacheDir: string,
  userAgent: string,
) {
  const key = `${asset.browser_download_url}|${asset.size}|${asset.updated_at}`;
  const known = await index.get<string>(key);
  if (known) {
    try {
      const bytes = new Uint8Array(
        await readFile(join(cacheDir, "blobs", "sha256", known.slice(0, 2), `${known}.xpi`)),
      );
      return { bytes, sha256: known };
    } catch {
      // fall through and re-download
    }
  }
  const res = await fetchWithRetry(asset.browser_download_url, {
    headers: { "user-agent": userAgent },
  });
  if (!res.ok) throw new Error(`download ${asset.name}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = join(cacheDir, "blobs", "sha256", sha256.slice(0, 2), `${sha256}.xpi`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  await index.set(key, sha256);
  return { bytes, sha256 };
}

export async function unzip(bytes: Uint8Array): Promise<XpiEntry[]> {
  const read = async (start: number, end: number) =>
    bytes.subarray(start, Math.min(end + 1, bytes.length));
  const entries = await listZipEntries(read, bytes.length);
  const out: XpiEntry[] = [];
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    try {
      out.push({ path: e.name, data: await readZipEntry(read, e) });
    } catch {
      out.push({ path: e.name, data: new Uint8Array() });
    }
  }
  return out;
}

export function summarize(r: ScanResult) {
  const a = r.artifacts;
  const worst = a.map((x) => x.preview).sort((p, q) => labelRank(q.label) - labelRank(p.label))[0];
  const hosts = (pred: (h: Analysis["network"]["hosts"][number]) => boolean) =>
    [...new Set(a.flatMap((x) => x.analysis.network.hosts.filter(pred).map((h) => h.host)))].sort();
  return {
    repo: r.repo,
    slug: r.slug,
    group: r.group,
    rank: r.rank,
    name: r.name,
    stars: r.stars,
    downloads: r.downloads,
    createdAt: r.createdAt,
    version: a[0]?.analysis.input.version ?? null,
    sha256: a.map((x) => x.asset.sha256),
    error: r.error,
    label: worst?.label ?? null,
    drivers: [...new Set(a.flatMap((x) => x.preview.drivers))],
    dataSharing: worst?.dataSharing ?? null,
    obfuscated: a.some((x) => x.preview.obfuscated),
    obfuscationSignals: [
      ...new Set(a.flatMap((x) => x.analysis.transparency.obfuscation.signals.map((s) => s.kind))),
    ].sort(),
    verdict: a[0]?.analysis.transparency.verdict ?? null,
    suspiciousUnicode: a.some((x) => x.preview.suspiciousUnicode),
    requestHosts: hosts((h) => h.usage === "request"),
    countedHosts: [
      ...new Set(a.flatMap((x) => Object.values(x.preview.hostsByCategory).flat())),
    ].sort(),
    unknownHosts: [...new Set(a.flatMap((x) => x.preview.hostsByCategory.unknown ?? []))].sort(),
    ipHosts: hosts((h) => h.flags.includes("ip-literal") && h.category === "unknown"),
    telemetryHosts: hosts((h) => h.category === "telemetry"),
    legalRiskHosts: hosts((h) => h.flags.includes("legal-risk")),
    developerHosts: hosts(
      (h) => h.category === "developer-server" || h.category === "cloud-function",
    ),
    capabilities: [...new Set(a.flatMap((x) => x.preview.capabilities.map((c) => c.id)))].sort(),
    dbTables: [
      ...new Set(
        a.flatMap((x) => x.analysis.capabilities.flatMap((c) => c.details?.sqlTables ?? [])),
      ),
    ].sort(),
    serverEndpoints: [
      ...new Set(
        a.flatMap((x) => x.analysis.capabilities.flatMap((c) => c.details?.endpoints ?? [])),
      ),
    ].sort(),
    parseFailures: a.reduce((s, x) => s + x.analysis.coverage.parseFailures.length, 0),
    filesAnalyzed: a.reduce((s, x) => s + x.analysis.coverage.filesAnalyzed, 0),
    vendored: [
      ...new Set(a.flatMap((x) => x.analysis.transparency.vendoredLibraries.map((v) => v.name))),
    ].sort(),
  };
}

export type ScanSummary = ReturnType<typeof summarize>;

export function labelRank(l: string | undefined): number {
  return (
    { "high-concern": 3, "review-details": 2, "insufficient-data": 1, "low-concern": 0 }[l ?? ""] ??
    -1
  );
}
