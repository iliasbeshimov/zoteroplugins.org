import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, requireGithubToken } from "../config.ts";
import { GitHub } from "../net/github.ts";
import { DiskCache, mapLimit } from "../net/http.ts";
import { paths } from "../paths.ts";
import { submittedRepos } from "../submit/records.ts";
import { detectZoteroVersions } from "../zotero-version.ts";
import { newestRelease, supportedMajors, supportsVersion, type ZoteroVersions } from "./compat.ts";
import { toCsv } from "./csv.ts";
import {
  fetchContributors,
  fetchFull,
  fetchLight,
  isXpi,
  type ReleaseInfo,
  type RepoFull,
} from "./metadata.ts";
import { buildReport } from "./report.ts";
import { type Discovery, discover, loadSeeds, type SourceId } from "./sources.ts";
import { httpRangeReader, readXpiManifests, type XpiManifest } from "./xpi.ts";

export const CURATED_SOURCES: SourceId[] = [
  "addon-market",
  "addon-market-tracked",
  "zotero-chinese",
  "sheet",
  "zotero-wiki-archive",
];

export type Verdict =
  | "zotero-plugin"
  | "zotero-plugin-legacy"
  | "firefox-extension"
  | "xpi-unreadable"
  | "no-xpi-release"
  | "repo-unavailable";

export type Maintenance = "active" | "slowing" | "dormant" | "archived" | "unknown";

export interface CensusRow {
  repo: string;
  url: string;
  name: string;
  verdict: Verdict;
  sources: SourceId[];
  newFind: boolean;
  stars: number | null;
  forks: number | null;
  contributors: number | null;
  commits: number | null;
  totalXpiDownloads: number | null;
  latestXpiDownloads: number | null;
  releaseCount: number | null;
  latestTag: string | null;
  latestReleaseAt: string | null;
  lastCommitAt: string | null;
  lastActivityAt: string | null;
  createdAt: string | null;
  maintenance: Maintenance;
  archived: boolean | null;
  isFork: boolean | null;
  parent: string | null;
  license: string | null;
  addonId: string | null;
  manifestVersion: string | null;
  manifestFormat: string | null;
  minVersion: string | null;
  maxVersion: string | null;
  supports: number[];
  worksWithCurrent: boolean;
  addonMarketTargets: number[];
  sheetToolType: string | null;
  sheetWorkflowPart: string | null;
  description: string | null;
  topics: string[];
  note: string | null;
  /** The latest release's .xpi files; a changed upload time or size under the same tag means replaced. */
  latestAssets: { name: string; size: number; updatedAt: string; downloadCount: number }[];
}

const DAY = 86_400_000;

export function maintenanceOf(lastActivityAt: string | null, archived: boolean, now: number) {
  if (archived) return "archived" as const;
  if (!lastActivityAt) return "unknown" as const;
  const age = now - Date.parse(lastActivityAt);
  return age <= 183 * DAY ? "active" : age <= 548 * DAY ? "slowing" : "dormant";
}

/** Latest non-prerelease release that ships an .xpi, else the latest one that does. */
export function pickRelease(releases: ReleaseInfo[]): ReleaseInfo | null {
  const withXpi = releases.filter((r) => r.assets.some((a) => isXpi(a.name)));
  return withXpi.find((r) => !r.prerelease) ?? withXpi[0] ?? null;
}

function verdictOf(manifests: XpiManifest[]): Verdict {
  if (manifests.some((m) => m.target === "zotero" && m.format === "manifest.json")) {
    return "zotero-plugin";
  }
  if (manifests.some((m) => m.target === "zotero")) return "zotero-plugin-legacy";
  if (manifests.some((m) => m.target === "firefox")) return "firefox-extension";
  return "xpi-unreadable";
}

const maxDate = (...dates: (string | null | undefined)[]) =>
  dates
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1) ?? null;

export type CensusMode = "full" | "refresh";

/**
 * full: discover candidates from every source, then measure them (weekly).
 * refresh: re-measure the repos from the last census without re-running discovery (nightly).
 */
export async function runCensus(
  mode: CensusMode = "full",
  log: (msg: string) => void = console.log,
): Promise<void> {
  const config = loadConfig();
  const token = requireGithubToken(config);
  const cache = new DiskCache(join(config.cacheDir, "http"));
  const gh = new GitHub(token, config.userAgent, cache);
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const outDir = join(paths.root, "data", "census");
  const isCurated = (s: Set<SourceId>) => CURATED_SOURCES.some((c) => s.has(c));

  log(`Census (${mode})`);
  log("Detecting Zotero versions");
  const zv = await detectZoteroVersions(gh, config.userAgent);
  log(`  current major ${zv.currentMajor}, next ${zv.nextMajor ?? "none"}`);

  let discovery: Discovery;
  const sourcesOf = new Map<string, Set<SourceId>>();
  let carriedRows: CensusRow[] = [];
  let candidatesCsv: string | null = null;
  let base: { candidates: number; existing: number; unavailable: number; withXpiRelease: number };

  if (mode === "full") {
    log("Discovering candidates");
    discovery = await discover(gh, config.userAgent, log);
    // Repos people submitted (submit/run.ts) stay candidates even if no search finds them.
    for (const key of await submittedRepos()) {
      const set = discovery.candidates.get(key) ?? new Set<SourceId>();
      set.add("submitted");
      discovery.candidates.set(key, set);
    }
    const keys = [...discovery.candidates.keys()].sort();
    log(`  ${keys.length} unique candidate repos`);
    log("Pass A: which candidates release .xpi files");
    const light = await fetchLight(gh, keys, log);
    // Collapse renamed/duplicate keys onto GitHub's canonical name, merging their sources.
    const hasXpi = new Map<string, boolean>();
    const unavailable: string[] = [];
    for (const key of keys) {
      const l = light.get(key);
      const sources = discovery.candidates.get(key) ?? new Set<SourceId>();
      if (!l) {
        unavailable.push(key);
        continue;
      }
      const c = l.nameWithOwner.toLowerCase();
      const merged = sourcesOf.get(c) ?? new Set<SourceId>();
      for (const s of sources) merged.add(s);
      sourcesOf.set(c, merged);
      hasXpi.set(c, (hasXpi.get(c) ?? false) || l.hasXpi);
    }
    for (const [c, merged] of [...sourcesOf]) {
      if (!hasXpi.get(c) && !isCurated(merged)) sourcesOf.delete(c);
    }
    carriedRows = unavailable
      .filter((k) => isCurated(discovery.candidates.get(k) ?? new Set()))
      .map((k) => unavailableRow(k, discovery.candidates.get(k) ?? new Set(), discovery));
    candidatesCsv = toCsv(
      keys.map((k) => ({
        candidate: k,
        canonical: light.get(k)?.nameWithOwner ?? "",
        sources: [...(discovery.candidates.get(k) ?? [])].sort(),
        has_xpi_release: light.get(k)?.hasXpi ?? "",
      })),
      ["candidate", "canonical", "sources", "has_xpi_release"],
    );
    base = {
      candidates: keys.length,
      existing: hasXpi.size,
      unavailable: unavailable.length,
      withXpiRelease: [...hasXpi.values()].filter(Boolean).length,
    };
  } else {
    const prev = JSON.parse(await readFile(join(outDir, "census.json"), "utf8")) as {
      funnel: typeof base;
      queries: Discovery["queries"];
      rows: CensusRow[];
    };
    const seeds = await loadSeeds(config.userAgent);
    discovery = { candidates: new Map(), ...seeds, queries: prev.queries };
    for (const r of prev.rows) {
      if (r.verdict === "repo-unavailable") carriedRows.push(r);
      else sourcesOf.set(r.repo.toLowerCase(), new Set(r.sources));
    }
    base = {
      candidates: prev.funnel.candidates,
      existing: prev.funnel.existing,
      unavailable: prev.funnel.unavailable,
      withXpiRelease: prev.funnel.withXpiRelease,
    };
    log(`  refreshing ${sourcesOf.size} repos from the last census`);
  }
  const selected = [...sourcesOf.keys()].sort();

  const rows = await measureRepos(gh, selected, sourcesOf, discovery, zv, now, log);
  rows.push(...carriedRows);

  rows.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.repo.localeCompare(b.repo, "en"));

  await mkdir(outDir, { recursive: true });
  const funnel = {
    ...base,
    selected: selected.length,
    zoteroPlugins: rows.filter((r) => r.verdict === "zotero-plugin").length,
    legacyPlugins: rows.filter((r) => r.verdict === "zotero-plugin-legacy").length,
  };
  const meta = {
    generatedAt: new Date(now).toISOString(),
    mode,
    zoteroVersions: zv,
    funnel,
    queries: discovery.queries,
  };
  await writeFile(join(outDir, "census.json"), `${JSON.stringify({ ...meta, rows }, null, 1)}\n`);
  await writeFile(join(outDir, "census.csv"), toCsv(rows.map(flatten), CSV_COLUMNS));
  if (candidatesCsv) await writeFile(join(outDir, "candidates.csv"), candidatesCsv);
  await appendHistory(rows, today, funnel);

  const reports = join(paths.root, "docs", "reports");
  await mkdir(reports, { recursive: true });
  const report = buildReport(rows, meta);
  await writeFile(join(reports, "census-latest.md"), report);
  if (mode === "full") await writeFile(join(reports, `census-${today}.md`), report);
  log(
    `Wrote data/census/*, data/census/history/${today.slice(0, 7)}.csv, docs/reports/census-latest.md`,
  );
  log(`Confirmed Zotero plugins: ${funnel.zoteroPlugins} (+${funnel.legacyPlugins} legacy)`);
}

/**
 * Full metadata, download counts, the manifests inside each latest release's .xpi files and the
 * contributor count, as census rows. Shared by the census and by single submissions (submit/run.ts).
 */
export async function measureRepos(
  gh: GitHub,
  keys: string[],
  sourcesOf: Map<string, Set<SourceId>>,
  discovery: Discovery,
  zv: ZoteroVersions,
  now: number,
  log: (msg: string) => void,
): Promise<CensusRow[]> {
  log("Pass B: full metadata and download counts");
  const full = await fetchFull(gh, keys, log);

  log("Reading manifests from release files (HTTP range requests)");
  const manifestCache = new DiskCache(join(loadConfig().cacheDir, "manifests"));
  const manifests = new Map<
    string,
    { release: ReleaseInfo; manifests: XpiManifest[]; error?: string }
  >();
  await mapLimit(keys, 8, async (key) => {
    const repo = full.get(key);
    const release = repo && pickRelease(repo.releases);
    if (!release) return;
    const found: XpiManifest[] = [];
    let error: string | undefined;
    for (const asset of release.assets.filter((a) => isXpi(a.name)).slice(0, 3)) {
      const cacheKey = `v2|${asset.downloadUrl}|${asset.size}|${asset.updatedAt}`;
      let parsed = await manifestCache.get<XpiManifest[]>(cacheKey);
      if (!parsed) {
        try {
          parsed = await readXpiManifests(
            httpRangeReader(asset.downloadUrl, loadConfig().userAgent),
            asset.size,
          );
          await manifestCache.set(cacheKey, parsed);
        } catch (e) {
          error = `${asset.name}: ${(e as Error).message}`;
          continue;
        }
      }
      found.push(...parsed);
    }
    manifests.set(key, { release, manifests: found, ...(error ? { error } : {}) });
  });

  const rows: CensusRow[] = keys.map((key) =>
    buildRow(
      key,
      sourcesOf.get(key) ?? new Set(),
      full.get(key) ?? null,
      manifests.get(key),
      discovery,
      zv,
      now,
    ),
  );

  log("Counting contributors for confirmed plugins");
  const plugins = rows.filter((r) => r.verdict.startsWith("zotero-plugin"));
  await mapLimit(plugins, 8, async (row) => {
    row.contributors = await fetchContributors(gh, row.repo);
  });
  return rows;
}

const HISTORY_COLUMNS = [
  "date",
  "repo",
  "verdict",
  "stars",
  "forks",
  "downloads",
  "latest_downloads",
  "contributors",
  "commits",
  "release_count",
  "latest_tag",
  "latest_release_at",
  "latest_asset_updated_at",
  "latest_asset_size",
  "last_activity_at",
  "maintenance",
  "supports",
];
const SUMMARY_COLUMNS = [
  "date",
  "candidates",
  "plugins",
  "legacy_plugins",
  "works_with_current",
  "active",
  "total_downloads",
  "total_stars",
];

/**
 * Trend data: one row per plugin per day in data/census/history/YYYY-MM.csv, and one summary row
 * per day in history/summary.csv. Re-running on the same day replaces that day's rows.
 */
export async function appendHistory(
  rows: CensusRow[],
  date: string,
  funnel: { candidates: number },
  dir = join(paths.root, "data", "census", "history"),
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const plugins = rows.filter((r) => r.verdict.startsWith("zotero-plugin"));
  const replaceDay = async (
    file: string,
    columns: string[],
    records: Record<string, unknown>[],
  ) => {
    const existing = await readFile(file, "utf8").catch(() => "");
    const kept = existing
      .split("\n")
      .slice(1)
      .filter((line) => line && !line.startsWith(`${date},`));
    const fresh = toCsv(records, columns).split("\n").slice(1).filter(Boolean);
    const all = [...kept, ...fresh].sort();
    await writeFile(file, `${columns.join(",")}\n${all.join("\n")}\n`);
  };
  await replaceDay(
    join(dir, `${date.slice(0, 7)}.csv`),
    HISTORY_COLUMNS,
    plugins.map((r) => ({
      date,
      repo: r.repo,
      verdict: r.verdict,
      stars: r.stars,
      forks: r.forks,
      downloads: r.totalXpiDownloads,
      latest_downloads: r.latestXpiDownloads,
      contributors: r.contributors,
      commits: r.commits,
      release_count: r.releaseCount,
      latest_tag: r.latestTag,
      latest_release_at: r.latestReleaseAt,
      latest_asset_updated_at: r.latestAssets[0]?.updatedAt,
      latest_asset_size: r.latestAssets[0]?.size,
      last_activity_at: r.lastActivityAt,
      maintenance: r.maintenance,
      supports: r.supports,
    })),
  );
  await replaceDay(join(dir, "summary.csv"), SUMMARY_COLUMNS, [
    {
      date,
      candidates: funnel.candidates,
      plugins: plugins.length,
      legacy_plugins: plugins.filter((r) => r.verdict === "zotero-plugin-legacy").length,
      works_with_current: plugins.filter((r) => r.worksWithCurrent).length,
      active: plugins.filter((r) => r.maintenance === "active").length,
      total_downloads: plugins.reduce((s, r) => s + (r.totalXpiDownloads ?? 0), 0),
      total_stars: plugins.reduce((s, r) => s + (r.stars ?? 0), 0),
    },
  ]);
}

function buildRow(
  key: string,
  sources: Set<SourceId>,
  repo: RepoFull | null,
  m: { release: ReleaseInfo; manifests: XpiManifest[]; error?: string } | undefined,
  discovery: Discovery,
  zv: ZoteroVersions,
  now: number,
): CensusRow {
  const market = discovery.addonMarket.get(key);
  const sheet = discovery.sheet.get(key);
  const zoteroManifests = (m?.manifests ?? []).filter((x) => x.target === "zotero");
  const primary =
    zoteroManifests.find((x) => x.format === "manifest.json") ??
    zoteroManifests[0] ??
    m?.manifests[0];
  const verdict: Verdict = !repo
    ? "repo-unavailable"
    : !m
      ? "no-xpi-release"
      : verdictOf(m.manifests);
  const supports = supportedMajors(zoteroManifests, zv);
  const latestXpi = m?.release.assets.filter((a) => isXpi(a.name)) ?? [];
  const lastActivityAt = maxDate(
    repo?.lastCommitAt,
    m?.release.publishedAt,
    repo?.releases[0]?.publishedAt,
  );
  const sourceList = [...sources].sort();
  return {
    repo: repo?.nameWithOwner ?? key,
    url: repo?.url ?? `https://github.com/${key}`,
    name:
      primary?.name && !primary.name.startsWith("__MSG")
        ? primary.name
        : (market?.name ?? sheet?.name ?? key.split("/")[1] ?? key),
    verdict,
    sources: sourceList,
    newFind: !CURATED_SOURCES.some((c) => sources.has(c)),
    stars: repo?.stars ?? null,
    forks: repo?.forks ?? null,
    contributors: null,
    commits: repo?.commitCount ?? null,
    totalXpiDownloads: repo?.totalXpiDownloads ?? null,
    latestXpiDownloads: latestXpi.length
      ? latestXpi.reduce((s, a) => s + a.downloadCount, 0)
      : null,
    releaseCount: repo?.releaseCount ?? null,
    latestTag: m?.release.tag ?? null,
    latestReleaseAt: m?.release.publishedAt ?? null,
    lastCommitAt: repo?.lastCommitAt ?? null,
    lastActivityAt,
    createdAt: repo?.createdAt ?? null,
    maintenance: maintenanceOf(lastActivityAt, repo?.archived ?? false, now),
    archived: repo?.archived ?? null,
    isFork: repo?.isFork ?? null,
    parent: repo?.parent ?? null,
    license: repo?.license ?? null,
    addonId: primary?.addonId ?? null,
    manifestVersion: primary?.version ?? null,
    manifestFormat: primary?.format ?? null,
    minVersion: primary?.minVersion ?? null,
    maxVersion: primary?.maxVersion ?? null,
    supports,
    // At the current version exactly: a maximum of "10.0.2" supports Zotero 10 but not 10.0.4.
    worksWithCurrent: zoteroManifests.some((x) =>
      supportsVersion(x, newestRelease(zv.currentMajor, zv)),
    ),
    addonMarketTargets: [
      ...new Set((market?.releases ?? []).map((r) => Number(r.targetZoteroVersion))),
    ].sort((a, b) => a - b),
    sheetToolType: sheet?.toolType ?? null,
    sheetWorkflowPart: sheet?.workflowPart ?? null,
    description: repo?.description ?? market?.description ?? null,
    topics: repo?.topics ?? [],
    note: m?.error ?? null,
    latestAssets: latestXpi.map((a) => ({
      name: a.name,
      size: a.size,
      updatedAt: a.updatedAt,
      downloadCount: a.downloadCount,
    })),
  };
}

function unavailableRow(key: string, sources: Set<SourceId>, discovery: Discovery): CensusRow {
  const sheet = discovery.sheet.get(key);
  const market = discovery.addonMarket.get(key);
  return {
    repo: key,
    url: `https://github.com/${key}`,
    name: market?.name ?? sheet?.name ?? key,
    verdict: "repo-unavailable",
    sources: [...sources].sort(),
    newFind: false,
    stars: null,
    forks: null,
    contributors: null,
    commits: null,
    totalXpiDownloads: null,
    latestXpiDownloads: null,
    releaseCount: null,
    latestTag: null,
    latestReleaseAt: null,
    lastCommitAt: null,
    lastActivityAt: null,
    createdAt: null,
    maintenance: "unknown",
    archived: null,
    isFork: null,
    parent: null,
    license: null,
    addonId: null,
    manifestVersion: null,
    manifestFormat: null,
    minVersion: null,
    maxVersion: null,
    supports: [],
    worksWithCurrent: false,
    addonMarketTargets: [],
    sheetToolType: sheet?.toolType ?? null,
    sheetWorkflowPart: sheet?.workflowPart ?? null,
    description: market?.description ?? null,
    topics: [],
    note: "repository not found (deleted, private or renamed away)",
    latestAssets: [],
  };
}

const CSV_COLUMNS = [
  "repo",
  "name",
  "verdict",
  "stars",
  "total_xpi_downloads",
  "latest_xpi_downloads",
  "contributors",
  "commits",
  "release_count",
  "latest_tag",
  "latest_release_at",
  "last_commit_at",
  "maintenance",
  "works_with_current",
  "supports",
  "z6",
  "z7",
  "z8",
  "z9",
  "z10",
  "z11",
  "min_version",
  "max_version",
  "manifest_format",
  "addon_id",
  "addon_market_targets",
  "archived",
  "is_fork",
  "parent",
  "license",
  "forks",
  "created_at",
  "sources",
  "new_find",
  "sheet_tool_type",
  "sheet_workflow_part",
  "description",
  "topics",
  "url",
  "note",
];

function flatten(r: CensusRow): Record<string, unknown> {
  const z = Object.fromEntries([6, 7, 8, 9, 10, 11].map((n) => [`z${n}`, r.supports.includes(n)]));
  return {
    repo: r.repo,
    name: r.name,
    verdict: r.verdict,
    stars: r.stars,
    total_xpi_downloads: r.totalXpiDownloads,
    latest_xpi_downloads: r.latestXpiDownloads,
    contributors: r.contributors,
    commits: r.commits,
    release_count: r.releaseCount,
    latest_tag: r.latestTag,
    latest_release_at: r.latestReleaseAt?.slice(0, 10),
    last_commit_at: r.lastCommitAt?.slice(0, 10),
    maintenance: r.maintenance,
    works_with_current: r.worksWithCurrent,
    supports: r.supports,
    ...z,
    min_version: r.minVersion,
    max_version: r.maxVersion,
    manifest_format: r.manifestFormat,
    addon_id: r.addonId,
    addon_market_targets: r.addonMarketTargets,
    archived: r.archived,
    is_fork: r.isFork,
    parent: r.parent,
    license: r.license,
    forks: r.forks,
    created_at: r.createdAt?.slice(0, 10),
    sources: r.sources,
    new_find: r.newFind,
    sheet_tool_type: r.sheetToolType,
    sheet_workflow_part: r.sheetWorkflowPart,
    description: r.description,
    topics: r.topics,
    url: r.url,
    note: r.note,
  };
}
