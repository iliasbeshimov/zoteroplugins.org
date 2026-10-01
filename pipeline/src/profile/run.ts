import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Analysis,
  Manifest,
  PluginCurated,
  PluginProfile,
  type ProfileIndexEntry,
  type Provenance,
  Release,
  type SandboxRecord,
} from "@atlas/schema";
import { parse as parseYaml } from "yaml";
import {
  compareVersions,
  installProblem,
  newestRelease,
  supportedMajors,
  supportsMajor,
  supportsVersion,
  type ZoteroVersions,
} from "../census/compat.ts";
import type { CensusRow } from "../census/run.ts";
import type { XpiManifest } from "../census/xpi.ts";
import { loadConfig, requireGithubToken } from "../config.ts";
import { cachedRest, GitHub } from "../net/github.ts";
import { DiskCache, fetchWithRetry, mapLimit } from "../net/http.ts";
import { paths } from "../paths.ts";
import {
  ANALYZER_VERSION,
  analyzeXpi,
  type DeveloperHints,
  developerHints,
  pickManifest,
} from "../scan/analyze.ts";
import { type HostTable, loadHostTable } from "../scan/hosts.ts";
import { download, type ReleaseAsset, unzip } from "../scan/run.ts";
import {
  ACTIONS_BOT,
  type Blocklist,
  blockedBy,
  CODE_HOSTS as CODE_HOST_NAMES,
  classifyUpdateSource,
  codeHostRepo,
  fetchAttestation,
  fetchBlocklist,
  provenanceLite,
  reclassifyHosts,
  unclaimedLabel,
  updateHostOf,
} from "./checks.ts";
import { detectDocLanguages, linkedReadmeLanguages, uiLocales } from "./languages.ts";
import { assignSlugs, listingKind, resolveListing } from "./listing.ts";
import { buildProfileReport } from "./report.ts";
import { type DownloadReview, readDownloadReview, reviewedFiles } from "./reviews.ts";
import { observedHosts, readSandboxRecord } from "./sandbox.ts";
import { RULES_VERSION, score } from "./score.ts";
import {
  cachedUpdateText,
  fetchUpdateText,
  type HashAlgorithm,
  isoTime,
  matchesStatedHash,
  parseUpdateManifest,
  pickUpdate,
  statedHash,
  statedSha256,
} from "./updates.ts";

export const PROFILER_VERSION = "0.1.2";
const MB = 1024 * 1024;
const MAX_XPI_BYTES = 60 * MB;
/** Builds analysed per release; one release ships 11 (zoterocitationcountsagent). */
const MAX_BUILDS = 12;
const SLUGS_FILE = join(paths.root, "data", "slugs.json");

type Profile = PluginProfile;
type ReleaseDoc = Release;

interface RestAsset extends ReleaseAsset {
  id: number;
  digest?: string | null;
  uploader?: { login: string } | null;
}
interface RestRelease {
  tag_name: string;
  /** Who created the release; undefined when a stored release didn't record it. */
  author?: { login: string } | null;
  published_at: string | null;
  created_at: string;
  prerelease: boolean;
  assets: RestAsset[];
}

export interface ProfileOptions {
  plugin?: string;
  force?: boolean;
  limit?: number;
}

export interface Context {
  gh: GitHub;
  table: HostTable;
  blocklist: Blocklist;
  zv: ZoteroVersions;
  blobIndex: DiskCache;
  cacheDir: string;
  userAgent: string;
  now: string;
  force: boolean;
  /** Rebuild from stored release files and cached .xpi blobs only: no GitHub calls (regress). */
  offline: boolean;
  /** Every listed project by lower-case repo, to recognise updates that come from another one. */
  projects: Map<string, { slug: string; name: string }>;
  /** Update manifests and update files, revalidated with ETag / Last-Modified. */
  updateCache: DiskCache;
  /** GitHub's answers as the client cached them, read without a request. */
  httpCache: DiskCache;
}

export interface Candidate {
  row: CensusRow;
  kind: NonNullable<ReturnType<typeof listingKind>>;
  slug: string;
}

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
};

export interface Prepared {
  census: { generatedAt: string; zoteroVersions: ZoteroVersions; rows: CensusRow[] };
  candidates: Candidate[];
  registry: Record<string, string>;
  listing: ReturnType<typeof resolveListing>;
  table: HostTable;
}

/** Census rows, slugs, listing and the hosts table: everything a run needs before any plugin. */
export async function prepare(): Promise<Prepared> {
  const census = (await readJson<Prepared["census"]>(
    join(paths.root, "data", "census", "census.json"),
  )) ?? {
    generatedAt: "",
    zoteroVersions: null as never,
    rows: [],
  };
  if (!census.rows.length)
    throw new Error("data/census/census.json is missing; run `atlas census`");

  const listed = census.rows
    .map((row) => ({ row, kind: listingKind(row) }))
    .filter((c): c is Omit<Candidate, "slug"> => c.kind !== null)
    .sort(
      (a, b) =>
        (b.row.totalXpiDownloads ?? 0) - (a.row.totalXpiDownloads ?? 0) ||
        (b.row.stars ?? 0) - (a.row.stars ?? 0) ||
        a.row.repo.localeCompare(b.row.repo, "en"),
    );
  const registry = assignSlugs(
    (await readJson<Record<string, string>>(SLUGS_FILE)) ?? {},
    listed.map((c) => c.row.repo),
  );
  const candidates: Candidate[] = listed.map((c) => ({
    ...c,
    slug: registry[c.row.repo.toLowerCase()] as string,
  }));
  // The census reads each add-on ID once; the release records re-read it from the build with the
  // current parser (zotupdate and zotflomo were misread as sharing an ID), so prefer theirs.
  await mapLimit(candidates, 16, async (c) => {
    const profile = await readJson<Profile>(join(paths.generated, c.slug, "profile.json"));
    const file = profile?.install?.releaseFile;
    if (!file) return;
    const doc = await readJson<ReleaseDoc>(join(paths.generated, `${file}`));
    const id = doc?.manifest?.addonId;
    if (id && id !== "(none)" && id !== c.row.addonId) c.row = { ...c.row, addonId: id };
  });
  const listing = resolveListing(
    candidates.map((c) => ({
      repo: c.row.repo,
      slug: c.slug,
      kind: c.kind,
      isFork: Boolean(c.row.isFork),
      parent: c.row.parent,
      downloads: c.row.totalXpiDownloads ?? 0,
      maintenance: c.row.maintenance,
      addonId: c.row.addonId,
    })),
  );
  return { census, candidates, registry, listing, table: await loadHostTable() };
}

export function selectCandidates(
  candidates: Candidate[],
  opts: { plugin?: string; limit?: number },
): Candidate[] {
  const wanted = opts.plugin?.toLowerCase();
  const selected = candidates
    .filter((c) => !wanted || c.slug === wanted || c.row.repo.toLowerCase() === wanted)
    .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
  if (wanted && !selected.length) throw new Error(`${opts.plugin} is not in the census`);
  return selected;
}

const BLOCKLIST_CACHE = "blocklist.json";

/** Zotero's blocklist from GitHub, kept in the cache so offline runs can use the same list. */
async function loadBlocklist(gh: GitHub | null, cacheDir: string): Promise<Blocklist> {
  const file = join(cacheDir, BLOCKLIST_CACHE);
  if (gh) {
    const list = await fetchBlocklist(gh);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, JSON.stringify(list));
    return list;
  }
  return (await readJson<Blocklist>(file)) ?? { version: 0, blockedPlugins: [] };
}

export async function makeContext(
  prep: Prepared,
  opts: { force?: boolean; offline?: boolean },
): Promise<Context> {
  const config = loadConfig();
  const httpCache = new DiskCache(join(config.cacheDir, "http"));
  const gh =
    opts.offline && !config.githubToken
      ? null
      : new GitHub(
          opts.offline ? (config.githubToken as string) : requireGithubToken(config),
          config.userAgent,
          httpCache,
        );
  const blocklist = await loadBlocklist(opts.offline ? null : gh, config.cacheDir);
  return {
    gh: gh as GitHub,
    table: prep.table,
    blocklist,
    zv: prep.census.zoteroVersions,
    blobIndex: new DiskCache(join(config.cacheDir, "blob-index")),
    updateCache: new DiskCache(join(config.cacheDir, "updates")),
    httpCache,
    cacheDir: config.cacheDir,
    userAgent: config.userAgent,
    now: new Date().toISOString(),
    force: Boolean(opts.force),
    offline: Boolean(opts.offline),
    projects: new Map(
      prep.candidates.map((c) => [
        c.row.repo.toLowerCase(),
        { slug: c.slug, name: c.row.name || c.row.repo.split("/")[1] || c.row.repo },
      ]),
    ),
  };
}

export async function runProfile(
  opts: ProfileOptions = {},
  log: (msg: string) => void = console.log,
): Promise<void> {
  const prep = await prepare();
  const { census, candidates, registry, listing, table } = prep;
  const selected = selectCandidates(candidates, opts);
  const ctx = await makeContext(prep, { force: Boolean(opts.force) });
  log(
    `Profiling ${selected.length} of ${candidates.length} listed plugins (analyzer ${ANALYZER_VERSION}, hosts ${table.version}, rules ${RULES_VERSION})`,
  );

  let done = 0;
  let written = 0;
  const failures: string[] = [];
  await mapLimit(selected, 6, async (c) => {
    try {
      const changed = await profileOne(c, ctx, listing.get(c.row.repo.toLowerCase()));
      if (changed) written++;
    } catch (error) {
      failures.push(`${c.row.repo}: ${(error as Error).message.slice(0, 200)}`);
    }
    if (++done % 50 === 0) log(`  ${done}/${selected.length}`);
  });

  await writeFile(SLUGS_FILE, `${JSON.stringify(registry, null, 1)}\n`);
  const profiles = await loadAllProfiles();
  await writeFile(
    join(paths.generated, "index.json"),
    `${JSON.stringify(profiles.map(indexEntry), null, 1)}\n`,
  );
  await mkdir(join(paths.root, "docs", "reports"), { recursive: true });
  await writeFile(
    join(paths.root, "docs", "reports", "profiles-latest.md"),
    buildProfileReport(profiles, {
      generatedAt: ctx.now,
      censusGeneratedAt: census.generatedAt,
      analyzerVersion: ANALYZER_VERSION,
      hostsTableVersion: table.version,
      currentMajor: ctx.zv.currentMajor,
      nextMajor: ctx.zv.nextMajor,
    }),
  );
  log(
    `Wrote ${written} changed profiles; ${profiles.length} profiles in data/generated/index.json`,
  );
  if (failures.length) {
    log(`${failures.length} plugins failed:`);
    for (const f of failures.slice(0, 20)) log(`  ${f}`);
  }
}

// ----------------------------------------------------------------------------------------------

interface Artifact {
  asset: RestAsset;
  doc: ReleaseDoc;
  file: string;
  isNew: boolean;
  /** An older name of the same file's record, removed once the new one is written. */
  replaces?: string;
}

async function profileOne(
  c: Candidate,
  ctx: Context,
  listing: ReturnType<ReturnType<typeof resolveListing>["get"]>,
): Promise<boolean> {
  const dir = join(paths.generated, c.slug);
  const existing = await readJson<Profile>(join(dir, "profile.json"));
  const known = await loadReleaseDocs(dir);
  const gathered = await gather(c, ctx, existing, known);
  const built = assemble(c, ctx, listing, existing, gathered);
  for (const r of built.releases) {
    const file = join(dir, r.file);
    const old = await readJson<ReleaseDoc>(file);
    if (!old || stable(old) !== stable(r.doc)) {
      await mkdir(dir, { recursive: true });
      await writeFile(file, `${JSON.stringify(r.doc, null, 1)}\n`);
    }
    if (r.replaces && r.replaces !== r.file) await rm(join(dir, r.replaces), { force: true });
  }
  if (existing && stable(existing) === stable(built.profile)) return false;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "profile.json"), `${JSON.stringify(built.profile, null, 1)}\n`);
  return true;
}

export type UpdateCheck = NonNullable<
  NonNullable<NonNullable<Profile["install"]>["updates"]>["check"]
>;

export interface Gathered {
  release: RestRelease | null;
  artifacts: Artifact[];
  scanError: string | null;
  docs: Profile["languages"]["docs"];
  alternates: string[];
  /** What the update address offers today; `target` is the file when it isn't this release's. */
  update?: { check: UpdateCheck; target: Artifact | null } | null;
  /** Developer responses and notices from data/plugins/<slug>.yaml. */
  curated?: Pick<PluginCurated, "responses" | "notices"> | null;
  /** The plugin sandbox's record (data/sandbox/<slug>.json), for the one file it ran. */
  sandbox?: SandboxRecord | null;
  /** A reviewed download-and-run finding (data/reviews/download-exec/<slug>.json). */
  downloadReview?: DownloadReview | null;
}

/** data/plugins/<slug>.yaml, when someone wrote one. A malformed file stops the run. */
async function readCurated(slug: string): Promise<Gathered["curated"]> {
  let text: string;
  try {
    text = await readFile(join(paths.root, "data", "plugins", `${slug}.yaml`), "utf8");
  } catch {
    return null;
  }
  const parsed = PluginCurated.safeParse(parseYaml(text));
  if (!parsed.success)
    throw new Error(`data/plugins/${slug}.yaml: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return { responses: parsed.data.responses, notices: parsed.data.notices };
}

/** Everything that needs GitHub or the .xpi files: the release, its analysed files, the README. */
export async function gather(
  c: Candidate,
  ctx: Context,
  existing: Profile | null,
  known: Map<string, { file: string; doc: ReleaseDoc }>,
): Promise<Gathered> {
  const { row, slug, kind } = c;
  const developer = developerHints(row.repo, row.addonId, null);
  const artifacts: Artifact[] = [];
  let release: RestRelease | null = null;
  let scanError: string | null = null;
  if (kind === "no-release" || !row.latestTag) {
    scanError = "No .xpi release on GitHub";
  } else {
    try {
      release = ctx.offline
        ? storedRelease(existing, known)
        : ctx.force
          ? null
          : unchangedRelease(row, existing, known);
      if (!release && ctx.offline) throw new Error("no stored release");
      if (!release) {
        const rel = await ctx.gh.rest<RestRelease>(
          `/repos/${row.repo}/releases/tags/${encodeURIComponent(row.latestTag)}`,
        );
        if (rel.status !== 200 || !rel.data)
          throw new Error(`release ${row.latestTag}: HTTP ${rel.status}`);
        release = rel.data;
      }
      // Who created the release: stored with its files, else GitHub's answer we cached earlier.
      if (release.author === undefined) {
        const cached = await cachedRest<RestRelease>(
          ctx.httpCache,
          `/repos/${row.repo}/releases/tags/${encodeURIComponent(row.latestTag)}`,
        );
        release.author = cached?.tag_name === release.tag_name ? (cached.author ?? null) : null;
      }
      // Every build in the release (per Zotero major, per OS, per language), within reason.
      // Offline, only builds we have stored.
      const xpis = release.assets
        .filter((a) => a.name.toLowerCase().endsWith(".xpi"))
        .filter(
          (a) =>
            !ctx.offline ||
            [...known.values()].some(
              (k) =>
                k.doc.asset.name === a.name ||
                k.doc.asset.url === a.browser_download_url ||
                a.digest === `sha256:${k.doc.asset.sha256}`,
            ),
        )
        .slice(0, MAX_BUILDS);
      if (!xpis.length) throw new Error(`release ${release.tag_name} has no .xpi file`);
      for (const asset of xpis) {
        try {
          artifacts.push(await artifactFor(asset, release, row, slug, known, developer, ctx));
        } catch (error) {
          scanError = (error as Error).message.slice(0, 200);
        }
      }
    } catch (error) {
      scanError = (error as Error).message.slice(0, 200);
    }
  }

  // Where Zotero's automatic updates lead today: the update address fetched, and the file it
  // offers analysed when it isn't one of this release's.
  let update: Gathered["update"] = null;
  const lead = orderBuilds(artifacts, ctx.zv)[0];
  if (release && lead) {
    try {
      update = await checkUpdates(lead, artifacts, row, slug, known, developer, ctx, existing);
    } catch {
      update = null;
    }
  }

  // README languages. A README only changes with a commit, so reuse them until the next one.
  let docs: Profile["languages"]["docs"];
  let alternates: string[];
  if (
    existing &&
    (ctx.offline ||
      (!ctx.force &&
        existing.profilerVersion === PROFILER_VERSION &&
        existing.maintenance.lastCommitAt === row.lastCommitAt))
  ) {
    docs = existing.languages.docs;
    alternates = existing.languages.docsAlternates;
  } else {
    const readme = await ctx.gh.rest<{ content?: string }>(`/repos/${row.repo}/readme`);
    const text =
      readme.status === 200 && readme.data?.content
        ? Buffer.from(readme.data.content, "base64").toString("utf8")
        : "";
    docs = text ? detectDocLanguages(text) : [];
    alternates = text
      ? linkedReadmeLanguages(text).filter((l) => !(docs as string[]).includes(l))
      : [];
  }
  return {
    release,
    artifacts,
    scanError,
    docs,
    alternates,
    update,
    curated: await readCurated(slug),
    sandbox: await readSandboxRecord(slug),
    downloadReview: await readDownloadReview(slug),
  };
}

/** A template's default name ("Zotero Plugin Template") says nothing: use the repository's. */
const TEMPLATE_NAME = /^(zotero )?(plugin|addon|add-on) template$|^make it red$/i;
function displayName(row: CensusRow): string {
  const repoName = row.repo.split("/")[1] || row.repo;
  if (row.name && TEMPLATE_NAME.test(row.name.trim()) && !/template/i.test(repoName))
    return repoName;
  return row.name || repoName;
}

const LABEL_TEXT: Record<string, string> = {
  "low-concern": "Few concerns found",
  "review-details": "Review the details",
  "high-concern": "Serious concerns found",
  "insufficient-data": "Not enough data",
};

/** The update check's label, record path and the line the card shows. */
export function finishCheck(
  c: UpdateCheck,
  offered: Artifact | null,
  slug: string,
  currentMajor: number,
): UpdateCheck {
  const label =
    c.result === "different-file" ? (offered?.doc.trustCard?.overall.label ?? null) : null;
  // Where the file comes from, by repository when it's on a code host ("ZenanH/zotero-babeldoc
  // on GitHub"), else by host name.
  let from = "";
  try {
    if (c.link) {
      const u = new URL(c.link);
      const code = codeHostRepo(u);
      from = code ? `${code.repo} on ${CODE_HOST_NAMES[code.host] ?? code.host}` : u.hostname;
    }
  } catch {}
  const major = Number.parseInt(c.zoteroVersion ?? "", 10) || currentMajor;
  const forZotero = major === currentMajor ? "" : ` on Zotero ${major}`;
  const rated = label ? ` (rated: ${LABEL_TEXT[label]})` : "";
  // Zotero hashes the download and refuses it when the entry states another hash.
  const refused = "the file doesn't match the fingerprint the update address gives";
  const note =
    c.hashMatches === false && c.result === "same-file"
      ? `The update address offers this version, but Zotero won't install it as an update: ${refused}`
      : c.hashMatches === false
        ? `The update address offers version ${c.version}${forZotero ? ` for Zotero ${major}` : ""} from ${from}${rated}, but Zotero won't install it: ${refused}`
        : c.result === "same-file"
          ? "The update address offers this version"
          : c.result === "different-file"
            ? `Zotero will update it${forZotero} to version ${c.version} from ${from}${rated}`
            : c.result === "not-analysed" && /\b(404|410)\b/.test(c.error ?? "")
              ? `The update address lists version ${c.version}, but its download link is broken, so Zotero can't update it`
              : c.result === "not-analysed"
                ? `Zotero will update it${forZotero} to version ${c.version} from ${from}; we couldn't download that version to check it`
                : c.result === "not-newer"
                  ? `The update address offers version ${c.version}, which isn't newer than this one, so Zotero won't update it for now`
                  : c.result === "no-update-for-current"
                    ? `The update address has no version for Zotero ${major}`
                    : c.result === "not-listed"
                      ? "The update address doesn't list this add-on, so Zotero won't update it"
                      : c.status === 404 || c.status === 410
                        ? "The update address is broken (nothing is there), so Zotero can't update it"
                        : c.status
                          ? "The update address doesn't work, so Zotero can't update it"
                          : "The update address doesn't respond, so Zotero can't update it";
  return {
    ...c,
    label,
    releaseFile: label && offered ? `${slug}/${offered.file}` : null,
    note,
  };
}

/** How long after the manifest and the release a file must arrive to read as a later one. */
const REPLACED_AFTER_MS = 2 * 60_000;

/**
 * The project's own update manifest offers this build's version at this build's address with a
 * hash the file doesn't have, and the file was uploaded more than REPLACED_AFTER_MS after the
 * manifest last changed and after the release was published: the file behind the tag isn't the one
 * the manifest was written for (ccf-rank: its workflow's build, deleted and replaced by a hand-built
 * one six minutes later). A manifest rewritten after the upload (zotero-pick2anki), uploaded within
 * a couple of minutes of it (the same workflow run, even one uploading with a person's token:
 * zotero2eagle--yueneiqi, 18 seconds), or with no date (raw.githubusercontent.com gives none)
 * doesn't say which of the two changed; nor does a release a person published and attached the file
 * to afterwards (zotero-roam), which may be its first file. A release whose author we don't know is
 * read as before.
 */
export function writtenForAnotherFile(
  c: UpdateCheck,
  build: {
    doc: Pick<ReleaseDoc, "version" | "publishedAt" | "manifest" | "asset" | "releaseAuthor">;
  },
): boolean {
  const installed = build.doc.manifest.version || build.doc.version;
  const uploaded = Date.parse(build.doc.asset.uploadedAt ?? "");
  return (
    !(build.doc.releaseAuthor && !/\[bot\]$/i.test(build.doc.releaseAuthor)) &&
    c.result === "same-file" &&
    c.hashMatches === false &&
    c.sha256 === build.doc.asset.sha256 &&
    Boolean(c.version && installed) &&
    compareVersions(c.version as string, installed) === 0 &&
    uploaded - Date.parse(c.manifestModifiedAt ?? "") > REPLACED_AFTER_MS &&
    uploaded - Date.parse(build.doc.publishedAt) > REPLACED_AFTER_MS
  );
}

/**
 * A release's builds, the one users install first: identical bytes under two names collapse to
 * one, then the order below.
 */
function orderBuilds(builds: Artifact[], zv: ZoteroVersions): Artifact[] {
  // The same bytes under two names (`plugin.xpi` and `plugin-1.2.3.xpi`) are one build, named after
  // the file that carries the version, so the install file's name doesn't flip between runs.
  const versioned = (art: Artifact) => Number(art.doc.asset.name.includes(art.doc.version));
  const bySha = new Map<string, Artifact>();
  for (const art of builds) {
    const seen = bySha.get(art.doc.asset.sha256);
    if (
      !seen ||
      versioned(art) - versioned(seen) > 0 ||
      (versioned(art) === versioned(seen) &&
        art.doc.asset.name.localeCompare(seen.doc.asset.name, "en") < 0)
    )
      bySha.set(art.doc.asset.sha256, art);
  }
  const artifacts = [...bySha.values()];
  // The file users install: the build that works with the current Zotero when a release ships
  // several (review K1: zotero-reference's headline was a build Zotero 10 refuses), then a
  // manifest.json build, then the one supporting the newest Zotero. Otherwise GitHub's order.
  const current = newestRelease(zv.currentMajor, zv);
  const covers = (art: Artifact) => supportsVersion(asXpiManifest(art.doc.manifest), current);
  return artifacts.sort(
    (a, b) =>
      Number(covers(b)) - Number(covers(a)) ||
      Number(b.doc.manifest.format === "manifest.json") -
        Number(a.doc.manifest.format === "manifest.json") ||
      compareVersions(
        b.doc.manifest.strictMaxVersion ?? "0",
        a.doc.manifest.strictMaxVersion ?? "0",
      ) ||
      // Several builds of the same line: the newest (word-zotero-bridge ships 0.1.0 to 0.1.6).
      compareVersions(b.doc.version, a.doc.version) ||
      (b.doc.asset.uploadedAt ?? "").localeCompare(a.doc.asset.uploadedAt ?? "", "en"),
  );
}

/**
 * The profile and its release files from what `gather` found. No network and no file access, so
 * the regression check can rebuild every profile the same way the nightly run does.
 */
export function assemble(
  c: Candidate,
  ctx: Context,
  listing: ReturnType<ReturnType<typeof resolveListing>["get"]>,
  existing: Profile | null,
  g: Gathered,
): { profile: Profile; releases: { file: string; doc: ReleaseDoc; replaces?: string }[] } {
  const { row, slug, kind } = c;
  const developer = developerHints(row.repo, row.addonId, null);
  const { release, scanError, docs, alternates } = g;
  const artifacts = orderBuilds(g.artifacts, ctx.zv);
  const primary = artifacts[0] ?? null;
  const primaryAsset = release?.assets.find((a) => a.name.toLowerCase().endsWith(".xpi")) ?? null;

  const ui = primary ? uiLocales(primary.doc.files.map((f) => f.path)) : [];

  // Compatibility
  const zv = ctx.zv;
  const tagOf = (m: number) => newestRelease(m, zv);
  const devVersion = Object.values(zv.dev)[0];
  // Current, previous and next Zotero, each checked at the exact version it names (10.0.4, which a
  // maximum of "10.0.2" doesn't reach): the whole release's for the profile, where any of its
  // builds counts, and each build's own for its card (zotero-reference's Zotero 7–9 build isn't a
  // Zotero 10 one).
  const targets = (works: (major: number, version: string) => boolean, known: boolean) => {
    const status = (m: number, v: string) =>
      !known
        ? ("unknown" as const)
        : works(m, v)
          ? ("compatible" as const)
          : ("incompatible" as const);
    const at = (major: number, zoteroVersion: string) => ({
      major,
      zoteroVersion,
      status: status(major, zoteroVersion),
    });
    return {
      current: at(zv.currentMajor, tagOf(zv.currentMajor)),
      previous: at(zv.currentMajor - 1, tagOf(zv.currentMajor - 1)),
      next: zv.nextMajor && devVersion ? at(zv.nextMajor, devVersion) : null,
    };
  };
  // The census reads the release's first file; the builds we analysed decide, so a build Zotero
  // won't install counts for no Zotero 7+ major (Zotero 6 reads install.rdf, which the release
  // records don't keep). Without analysed builds, the census's majors.
  const manifests = artifacts.map((art) => asXpiManifest(art.doc.manifest));
  const supports = manifests.length
    ? row.supports.filter((m) => m < 7 || manifests.some((x) => supportsMajor(x, m, zv)))
    : row.supports;
  const { current, previous, next } = targets(
    (m, v) =>
      manifests.length ? manifests.some((x) => supportsVersion(x, v)) : supports.includes(m),
    !(kind === "no-release" && !row.supports.length),
  );
  const version = primary?.doc.version ?? row.manifestVersion;
  const blocked = blockedBy(
    ctx.blocklist,
    row.addonId ?? primary?.doc.manifest.addonId ?? null,
    version,
  );
  // A build's own compatibility, for its card.
  const compatOf = (m: XpiManifest) => {
    const t = targets((_, v) => supportsVersion(m, v), true);
    const supported = supportedMajors([m], zv);
    const problem = installProblem(m, zv);
    return {
      ...t,
      supported,
      blockedByZotero: blocked,
      ...(problem ? { installProblem: problem } : {}),
      // It runs on another release of the current major but not this one: where its range ends.
      ...(t.current.status === "incompatible" && supported.includes(zv.currentMajor)
        ? { range: { min: m.minVersion, max: m.maxVersion } }
        : {}),
    };
  };

  // Integrity: the same release file name under the same tag now has different bytes.
  const integrityEvents = [...(existing?.integrityEvents ?? [])];
  const prevInstall = existing?.install;
  if (
    primary &&
    prevInstall &&
    prevInstall.tag === primary.doc.tag &&
    prevInstall.asset.name === primary.doc.asset.name &&
    prevInstall.asset.sha256 &&
    prevInstall.asset.sha256 !== primary.doc.asset.sha256
  ) {
    integrityEvents.push({
      kind: "asset-replaced",
      tag: primary.doc.tag ?? "",
      detectedAt: ctx.now,
      before: { sha256: prevInstall.asset.sha256, uploadedAt: null },
      after: { sha256: primary.doc.asset.sha256, uploadedAt: primary.doc.asset.uploadedAt },
    });
  }
  // A new build added to a release tag we'd already seen (zotero-reference's 1.7.2 tag got a
  // 1.8.17 build months later).
  if (release && prevInstall && prevInstall.tag === release.tag_name) {
    const before = new Set([prevInstall.asset.name, ...prevInstall.otherAssets.map((o) => o.name)]);
    for (const x of release.assets) {
      if (!x.name.toLowerCase().endsWith(".xpi") || before.has(x.name)) continue;
      const seen = integrityEvents.some(
        (e) => e.kind === "asset-added" && e.tag === release.tag_name && e.asset === x.name,
      );
      if (seen) continue;
      integrityEvents.push({
        kind: "asset-added",
        tag: release.tag_name,
        asset: x.name,
        detectedAt: ctx.now,
        before: { sha256: null, uploadedAt: null },
        after: {
          sha256: x.digest?.replace(/^sha256:/, "") ?? null,
          uploadedAt: x.updated_at || null,
        },
      });
    }
  }
  const assetReplaced = integrityEvents.some(
    (e) => e.tag === primary?.doc.tag && e.after.sha256 === primary?.doc.asset.sha256,
  );
  const manifestMismatch = Boolean(
    primary && g.update && writtenForAnotherFile(g.update.check, primary),
  );

  // Trust Card for each analysed file; the profile shows the primary one. The file the update
  // address offers is scored first, because the builds' cards say what it is.
  const own = { repo: row.repo, addonIdSharedWith: listing?.addonIdSharedWith ?? [] };
  const offered = g.update?.target ?? null;
  const separate = offered && !artifacts.includes(offered) ? offered : null;
  const scoreFile = (art: Artifact, check?: UpdateCheck | null) => {
    if (!art.doc.analysis || !art.doc.provenance) return;
    const classified = classifyUpdateSource(art.doc.manifest.updateUrl, own, ctx.projects);
    // GitHub redirects a renamed repository's addresses: the old name is still this project.
    const moved =
      classified.kind === "other-repository" && check?.finalUrl
        ? classifyUpdateSource(check.finalUrl, own, ctx.projects)
        : null;
    const renamed =
      moved?.kind === "this-project"
        ? { ...moved, url: classified.url, label: `${moved.label} (under its old name)` }
        : classified;
    const updates = check?.ownerMissing
      ? {
          ...renamed,
          kind: "unclaimed-namespace" as const,
          label: unclaimedLabel(art.doc.manifest.updateUrl ?? "", check.missing),
        }
      : renamed;
    // The sandbox's record counts only for the exact file it ran.
    const record = g.sandbox?.sha256 === art.doc.analysis.input.sha256 ? g.sandbox : null;
    const card = score({
      analysis: art.doc.analysis,
      repo: row.repo,
      fork: Boolean(listing?.fork) || (listing?.addonIdSharedWith ?? []).length > 0,
      updateHost: updateHostOf(art.doc.manifest.updateUrl, ctx.table, developer),
      updateSource: {
        kind: updates.kind,
        label: updates.label,
        // A placeholder address needs no second line saying it doesn't answer.
        ...(check && updates.kind !== "none"
          ? {
              check: {
                result: check.result,
                note: check.note,
                targetLabel: check.label,
                ...(check.hashMatches === false ? { refused: true } : {}),
              },
            }
          : {}),
      },
      provenance: art.doc.provenance,
      assetReplaced: art === primary && assetReplaced,
      ...(art === primary && manifestMismatch ? { manifestMismatch: true } : {}),
      maintenance: {
        status: row.maintenance,
        lastReleaseAt: row.latestReleaseAt,
        lastCommitAt: row.lastCommitAt,
      },
      compatibility: compatOf(asXpiManifest(art.doc.manifest)),
      currentZotero: current.zoteroVersion,
      computedAt: ctx.now,
      ...(record ? { tested: { record, hosts: observedHosts(record, ctx.table, developer) } } : {}),
      ...(g.downloadReview
        ? { downloadReview: { ...g.downloadReview, files: reviewedFiles(g.downloadReview) } }
        : {}),
    });
    const before = art.doc.trustCard;
    art.doc.trustCard = before && stable(before) === stable(card) ? before : card;
  };
  for (const art of [...artifacts, ...(separate ? [separate] : [])]) scoreFile(art);
  const check = g.update ? finishCheck(g.update.check, offered, slug, zv.currentMajor) : null;
  if (check)
    for (const art of artifacts)
      if (art !== offered && art.doc.manifest.updateUrl === primary?.doc.manifest.updateUrl)
        scoreFile(art, check);
  const releases = [...artifacts, ...(separate ? [separate] : [])].map((art) => ({
    file: art.file,
    doc: Release.parse(art.doc),
    ...(art.replaces ? { replaces: art.replaces } : {}),
  }));

  const a = primary?.doc.analysis ?? null;
  let updates = primary
    ? classifyUpdateSource(primary.doc.manifest.updateUrl, own, ctx.projects)
    : null;
  if (updates && check?.ownerMissing)
    updates = {
      ...updates,
      kind: "unclaimed-namespace",
      label: unclaimedLabel(updates.url ?? "", check.missing),
    };
  // GitHub redirects a renamed repository's addresses: the old name is still this project.
  if (updates?.kind === "other-repository" && check?.finalUrl) {
    const moved = classifyUpdateSource(check.finalUrl, own, ctx.projects);
    if (moved.kind === "this-project")
      updates = { ...moved, url: updates.url, label: `${moved.label} (under its old name)` };
  }
  const manifestDescription = primary?.doc.manifest.description ?? null;
  const profile: Profile = {
    schemaVersion: 1,
    profilerVersion: PROFILER_VERSION,
    generatedAt: ctx.now,
    slug,
    repo: row.repo.toLowerCase(),
    repoName: row.repo,
    name: displayName(row),
    listing: {
      kind,
      hiddenByDefault: listing?.hiddenByDefault ?? false,
      hiddenReason: listing?.hiddenReason ?? null,
    },
    links: {
      repo: `https://github.com/${row.repo}`,
      homepage: primary?.doc.manifest.homepageUrl ?? null,
      issues: `https://github.com/${row.repo}/issues`,
      releases: `https://github.com/${row.repo}/releases`,
    },
    author: {
      login: row.repo.split("/")[0] ?? "",
      url: `https://github.com/${row.repo.split("/")[0]}`,
    },
    license: row.license,
    sources: row.sources,
    about: {
      githubDescription: row.description,
      manifestDescription:
        manifestDescription && !/^(__MSG_|&[\w.-]+;$|\$\{|__\w+__$)/.test(manifestDescription)
          ? manifestDescription
          : null,
      topics: row.topics,
      categoryHint: row.sheetWorkflowPart,
    },
    languages: {
      docs,
      docsAlternates: alternates,
      ui,
      chineseOnlyDocs: docs.includes("zh") && !docs.includes("en") && !alternates.includes("en"),
      chineseOnlyUi: ui.length > 0 && ui.every((l) => l.startsWith("zh")),
    },
    popularity: {
      stars: row.stars,
      forks: row.forks,
      contributors: row.contributors,
      downloads: row.totalXpiDownloads,
      latestDownloads: row.latestXpiDownloads,
      releaseCount: row.releaseCount,
      createdAt: row.createdAt,
    },
    maintenance: {
      status: row.maintenance,
      lastReleaseAt: row.latestReleaseAt,
      lastCommitAt: row.lastCommitAt,
      lastActivityAt: row.lastActivityAt,
    },
    compatibility: {
      supports,
      // The headline build's range: the census reads the release's first file, which for
      // zotero-reference is its Zotero 7–9 build.
      minVersion: primary?.doc.manifest.strictMinVersion ?? row.minVersion,
      maxVersion: primary?.doc.manifest.strictMaxVersion ?? row.maxVersion,
      current: kind === "no-release" ? null : current,
      previous: kind === "no-release" ? null : previous,
      next: kind === "no-release" ? null : next,
      blockedByZotero: blocked,
    },
    install:
      release && (primary || primaryAsset)
        ? {
            version: version ?? row.latestTag ?? "",
            tag: release.tag_name,
            publishedAt: release.published_at,
            prerelease: release.prerelease,
            asset: primary
              ? {
                  name: primary.doc.asset.name,
                  url: primary.doc.asset.url,
                  size: primary.doc.asset.size,
                  sha256: primary.doc.asset.sha256,
                }
              : {
                  name: primaryAsset?.name ?? "",
                  url: primaryAsset?.browser_download_url ?? "",
                  size: primaryAsset?.size ?? 0,
                  sha256: null,
                },
            otherAssets: release.assets
              .filter(
                (x) =>
                  x.name.toLowerCase().endsWith(".xpi") &&
                  x.name !== (primary?.doc.asset.name ?? primaryAsset?.name),
              )
              .map((x) => ({ name: x.name, url: x.browser_download_url })),
            // A working update address: set, answering, and listing this add-on.
            autoUpdates: updates
              ? updates.kind !== "none" &&
                !["unreachable", "not-listed"].includes(check?.result ?? "")
              : false,
            builds: artifacts
              .filter((art) => art !== primary)
              .map((art) => ({
                asset: art.doc.asset.name,
                version: art.doc.version,
                supports: supportedMajors([asXpiManifest(art.doc.manifest)], ctx.zv),
                label: art.doc.trustCard?.overall.label ?? null,
                releaseFile: `${slug}/${art.file}`,
              })),
            ...(updates ? { updates: { ...updates, ...(check ? { check } : {}) } } : {}),
            releaseFile: primary ? `${slug}/${primary.file}` : null,
          }
        : null,
    fork: listing?.fork ?? null,
    forks: listing?.forks ?? [],
    addonId:
      primary?.doc.manifest.addonId && primary.doc.manifest.addonId !== "(none)"
        ? primary.doc.manifest.addonId
        : row.addonId,
    addonIdSharedWith: listing?.addonIdSharedWith ?? [],
    trust: primary?.doc.trustCard ?? null,
    provenance: primary?.doc.provenance
      ? {
          level: primary.doc.provenance.level,
          attestation: primary.doc.provenance.attestation.present,
          explanation: primary.doc.provenance.explanation,
        }
      : null,
    scan: primary?.doc.analysis
      ? { status: "analyzed", reason: null }
      : { status: "not-analyzed", reason: scanError ?? "Not analyzed" },
    requirementsHints: a ? hintsFrom(a) : null,
    integrityEvents,
    ...(g.curated?.responses.length ? { responses: g.curated.responses } : {}),
    ...(g.curated?.notices.length ? { notices: g.curated.notices } : {}),
    content: existing?.content ?? null,
    categories: existing?.categories ?? null,
    requirements: existing?.requirements ?? null,
  };
  return { profile: PluginProfile.parse(profile), releases };
}

/** Who created the release, as its stored file recorded it (nothing when it predates that). */
const releaseAuthorOf = (d: ReleaseDoc): Pick<RestRelease, "author"> =>
  d.releaseAuthor === undefined
    ? {}
    : { author: d.releaseAuthor ? { login: d.releaseAuthor } : null };

/**
 * The release as we stored it, when the census shows the same tag with the same .xpi files (name,
 * size, upload time). Saves a GitHub call per plugin per night.
 */
export function unchangedRelease(
  row: CensusRow,
  existing: Profile | null,
  known: Map<string, { file: string; doc: ReleaseDoc }>,
): RestRelease | null {
  // A new profiler version refreshes release details from GitHub once.
  if (
    !existing?.install ||
    existing.profilerVersion !== PROFILER_VERSION ||
    existing.install.tag !== row.latestTag ||
    !row.latestAssets.length
  )
    return null;
  const docs = [...known.values()].map((k) => k.doc).filter((d) => d.tag === row.latestTag);
  const matched = row.latestAssets
    .slice(0, MAX_BUILDS)
    .map((a) =>
      docs.find(
        (d) =>
          d.asset.name === a.name && d.asset.size === a.size && d.asset.uploadedAt === a.updatedAt,
      ),
    );
  if (matched.some((d) => !d)) return null;
  const first = matched[0] as ReleaseDoc;
  return {
    tag_name: first.tag ?? row.latestTag,
    ...releaseAuthorOf(first),
    published_at: existing.install.publishedAt,
    created_at: first.publishedAt,
    prerelease: first.prerelease,
    assets: [
      ...(matched as ReleaseDoc[]).map((d) => ({
        id: d.asset.githubAssetId ?? 0,
        name: d.asset.name,
        size: d.asset.size,
        updated_at: d.asset.uploadedAt ?? "",
        browser_download_url: d.asset.url,
        digest: `sha256:${d.asset.sha256}`,
        uploader: d.asset.uploader ? { login: d.asset.uploader } : null,
      })),
      ...existing.install.otherAssets
        .filter((o) => !matched.some((d) => d?.asset.name === o.name))
        .map((o) => ({
          id: 0,
          name: o.name,
          size: 0,
          updated_at: "",
          browser_download_url: o.url,
          digest: null,
          uploader: null,
        })),
    ],
  };
}

/**
 * The current release as stored in data/generated, for offline rebuilds: the install file first,
 * then the other analysed files of the same tag, then the release's other .xpi files.
 */
function storedRelease(
  existing: Profile | null,
  known: Map<string, { file: string; doc: ReleaseDoc }>,
): RestRelease | null {
  const install = existing?.install;
  if (!install) return null;
  const docs = [...known.values()]
    .map((k) => k.doc)
    .filter((d) => d.tag === install.tag)
    .sort((a, b) => (a.asset.githubAssetId ?? 0) - (b.asset.githubAssetId ?? 0));
  const fromDoc = (d: ReleaseDoc, name = d.asset.name): RestAsset => ({
    id: d.asset.githubAssetId ?? 0,
    name,
    size: d.asset.size,
    updated_at: d.asset.uploadedAt ?? "",
    browser_download_url: d.asset.url,
    digest: `sha256:${d.asset.sha256}`,
    uploader: d.asset.uploader ? { login: d.asset.uploader } : null,
  });
  const main = docs.find((d) => d.asset.sha256 === install.asset.sha256);
  const assets: RestAsset[] = [
    main
      ? {
          ...fromDoc(main, install.asset.name),
          size: install.asset.size,
          browser_download_url: install.asset.url,
        }
      : {
          id: 0,
          name: install.asset.name,
          size: install.asset.size,
          updated_at: "",
          browser_download_url: install.asset.url,
          digest: install.asset.sha256 ? `sha256:${install.asset.sha256}` : null,
          uploader: null,
        },
  ];
  for (const d of docs) if (!assets.some((x) => x.name === d.asset.name)) assets.push(fromDoc(d));
  for (const o of install.otherAssets)
    if (!assets.some((x) => x.name === o.name))
      assets.push({
        id: 0,
        name: o.name,
        size: 0,
        updated_at: "",
        browser_download_url: o.url,
        digest: null,
        uploader: null,
      });
  const first = main ?? docs[0];
  return {
    tag_name: install.tag,
    ...(first ? releaseAuthorOf(first) : {}),
    published_at: install.publishedAt,
    created_at: first?.publishedAt ?? install.publishedAt ?? "",
    prerelease: first?.prerelease ?? install.prerelease,
    assets,
  };
}

/**
 * Fetches the update address and follows it to the file Zotero would install today. Offline, the
 * last check is reused, and its file is rebuilt from the stored record like any other build.
 */
async function checkUpdates(
  lead: Artifact,
  builds: Artifact[],
  row: CensusRow,
  slug: string,
  known: Map<string, { file: string; doc: ReleaseDoc }>,
  developer: DeveloperHints,
  ctx: Context,
  existing: Profile | null,
): Promise<Gathered["update"]> {
  const url = lead.doc.manifest.updateUrl;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const targetFrom = async (
    link: string,
    sha256: string,
    size: number,
    modified: string | null,
  ) => {
    const name = decodeURIComponent(new URL(link).pathname.split("/").pop() || "") || "update.xpi";
    const asset: RestAsset = {
      id: 0,
      name,
      size,
      updated_at: modified ?? "",
      browser_download_url: link,
      digest: `sha256:${sha256}`,
      uploader: null,
    };
    const synthetic: RestRelease = {
      tag_name: "",
      published_at: ctx.now,
      created_at: ctx.now,
      prerelease: false,
      assets: [],
    };
    const art = await artifactFor(asset, synthetic, row, slug, known, developer, ctx);
    const previous = known.get(sha256)?.doc;
    art.doc.source = "update-feed";
    art.doc.tag = null;
    art.doc.publishedAt = previous?.publishedAt ?? ctx.now;
    art.doc.asset.githubAssetId = null;
    art.doc.asset.uploadedAt = modified;
    // Same version as a release build but other bytes: keep both records.
    if (builds.some((b) => b.file === art.file))
      art.file = art.file.replace(/\.json$/, `+${sha256.slice(0, 8)}.json`);
    return art;
  };

  if (ctx.offline) {
    const prev = existing?.install?.updates;
    if (!prev?.check || prev.url !== url) return null;
    const installed = lead.doc.manifest.version || lead.doc.version;
    if (
      prev.check.result === "different-file" &&
      prev.check.version &&
      installed &&
      compareVersions(prev.check.version, installed) <= 0
    ) {
      const { statedHash: _s, hashMatches: _m, manifestModifiedAt: _t, ...rest } = prev.check;
      return {
        check: { ...rest, result: "not-newer", sha256: null, label: null, releaseFile: null },
        target: null,
      };
    }
    const c = await restateHash(prev.check, url, lead, ctx);
    if (c.result !== "different-file" || !c.sha256 || !c.link) return { check: c, target: null };
    const same = builds.find((b) => b.doc.asset.sha256 === c.sha256) ?? null;
    if (same) return { check: c, target: same };
    const stored = known.get(c.sha256)?.doc;
    const target = await targetFrom(
      c.link,
      c.sha256,
      stored?.asset.size ?? 0,
      stored?.asset.uploadedAt ?? null,
    );
    return { check: c, target };
  }

  const { status, text, finalUrl, modifiedAt } = await fetchUpdateText(
    url,
    ctx.updateCache,
    ctx.userAgent,
  );
  // An update address under a GitHub account that doesn't exist can be claimed by anyone who
  // registers the name (review: fusion-reader's "thalluo").
  // The same when the account exists but the repository doesn't: whoever owns that account (not
  // the developer: zotero-progress points at "kazusa", its author is "kazusa3e") can create it.
  const owner = url.match(
    /^https:\/\/(?:raw\.githubusercontent\.com\/([a-z0-9-]+)\/([\w.-]+)|github\.com\/([a-z0-9-]+)\/([\w.-]+)|([a-z0-9-]+)\.github\.io\/([\w.-]+))/i,
  );
  const name = owner?.[1] ?? owner?.[3] ?? owner?.[5];
  const repoName = owner?.[2] ?? owner?.[4] ?? owner?.[6];
  let ownerMissing = false;
  let missing: "account" | "repository" | undefined;
  // Only an address that would serve a file once someone holds the name: a raw file, a release
  // download or a github.io page. A repository's web page, or `github.com/releases/…` (a reserved
  // route, not an account), can't deliver an update whoever registers what.
  const canServe =
    /^https:\/\/(raw\.githubusercontent\.com\/[^/]+\/[^/]+\/|github\.com\/[^/]+\/[^/]+\/(releases\/(latest\/)?download|raw)\/|[a-z0-9-]+\.github\.io\/)/i.test(
      url,
    ) && !/^(releases|orgs|settings|marketplace|sponsors|topics|features|about)$/i.test(name ?? "");
  if (
    name &&
    canServe &&
    status === 404 &&
    name.toLowerCase() !== row.repo.split("/")[0]?.toLowerCase()
  ) {
    const u = await ctx.gh.rest(`/users/${encodeURIComponent(name)}`);
    ownerMissing = u.status === 404;
    if (ownerMissing) missing = "account";
    if (!ownerMissing && u.status === 200 && repoName) {
      const r = await ctx.gh.rest(
        `/repos/${encodeURIComponent(name)}/${encodeURIComponent(repoName)}`,
      );
      ownerMissing = r.status === 404;
      if (ownerMissing) missing = "repository";
    }
  }
  // A repository renamed on GitHub keeps serving its old raw address without a redirect
  // (zotero-cita): ask GitHub for the repository's current name.
  let canonical = finalUrl;
  if (
    name &&
    repoName &&
    `${name}/${repoName}`.toLowerCase() !== row.repo.toLowerCase() &&
    status === 200
  ) {
    const r = await ctx.gh.rest<{ full_name?: string }>(
      `/repos/${encodeURIComponent(name)}/${encodeURIComponent(repoName)}`,
    );
    const full = r.status === 200 ? r.data?.full_name : undefined;
    if (full && full.toLowerCase() === row.repo.toLowerCase())
      canonical = url.replace(`${name}/${repoName}`, full);
  }
  const base: UpdateCheck = {
    checkedAt: ctx.now,
    status,
    ...(canonical !== url ? { finalUrl: canonical } : {}),
    ...(ownerMissing ? { ownerMissing } : {}),
    ...(missing ? { missing } : {}),
    result: "unreachable",
    version: null,
    link: null,
    sha256: null,
    label: null,
    releaseFile: null,
    note: "",
  };
  if (status !== 200 || text === null) return { check: base, target: null };
  const entries = parseUpdateManifest(text, lead.doc.manifest.addonId);
  if (!entries) return { check: { ...base, result: "not-listed" }, target: null };
  // What Zotero would install for someone running this build: on current Zotero, or on the newest
  // Zotero it supports when it doesn't run on current Zotero (ZotFile's update.rdf serves 5–6).
  const max = Number.parseInt(lead.doc.manifest.strictMaxVersion ?? "", 10);
  const major = Number.isFinite(max) && max < ctx.zv.currentMajor ? max : ctx.zv.currentMajor;
  const zoteroVersion = ctx.zv.lastTagPerMajor[major] ?? `${major}.0`;
  const checkedFor = { ...base, zoteroVersion };
  const pick = pickUpdate(entries, zoteroVersion);
  if (!pick?.link)
    return { check: { ...checkedFor, result: "no-update-for-current" }, target: null };
  const link = pick.link;
  const offered = { ...checkedFor, version: pick.version, link };
  // Zotero hashes the file it downloads and refuses the update when the entry states another hash.
  const stated = statedHash(pick);
  const last = existing?.install?.updates?.url === url ? existing.install.updates.check : undefined;
  const hashed = async (sha256: string): Promise<Partial<UpdateCheck>> => {
    if (!stated) return {};
    const matches = await checkStatedHash(stated, sha256, link, ctx, last);
    return {
      statedHash: `${stated.algorithm}:${stated.hex}`,
      ...(matches === null ? {} : { hashMatches: matches }),
      ...(matches === false && modifiedAt ? { manifestModifiedAt: modifiedAt } : {}),
    };
  };
  // Zotero only installs a newer version: a fork at 3.9.9.4 isn't replaced by upstream's 3.9.9.
  const installed = lead.doc.manifest.version || lead.doc.version;
  const sha = statedSha256(pick);
  const isLead =
    lead.doc.asset.url.toLowerCase() === link.toLowerCase() || sha === lead.doc.asset.sha256;
  if (!isLead && installed && compareVersions(pick.version, installed) <= 0)
    return { check: { ...offered, result: "not-newer" }, target: null };

  // One of this release's builds: by address, by the hash the manifest states, or GitHub's
  // "latest release" link to a file of this release.
  const latest = link.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/([^/?#]+)$/i,
  );
  let match =
    builds.find((b) => b.doc.asset.url.toLowerCase() === link.toLowerCase()) ??
    (sha ? builds.find((b) => b.doc.asset.sha256 === sha) : undefined) ??
    (latest && latest[1]?.toLowerCase() === row.repo.toLowerCase()
      ? builds.find((b) => b.doc.asset.name === decodeURIComponent(latest[2] as string))
      : undefined);
  let target: Artifact | null = null;
  if (!match) {
    let got: { sha256: string; size: number; modified: string | null };
    try {
      got = await fetchUpdateFile(link, ctx);
    } catch (error) {
      return {
        check: {
          ...offered,
          result: "not-analysed",
          error: (error as Error).message.slice(0, 120),
        },
        target: null,
      };
    }
    match = builds.find((b) => b.doc.asset.sha256 === got.sha256);
    if (!match) {
      try {
        target = await targetFrom(link, got.sha256, got.size, got.modified);
      } catch (error) {
        return {
          check: {
            ...offered,
            result: "not-analysed",
            sha256: got.sha256,
            ...(await hashed(got.sha256)),
            error: (error as Error).message.slice(0, 120),
          },
          target: null,
        };
      }
    }
  }
  if (match && match === lead)
    return {
      check: {
        ...offered,
        result: "same-file",
        sha256: match.doc.asset.sha256,
        ...(await hashed(match.doc.asset.sha256)),
      },
      target: null,
    };
  const file = (match ?? target) as Artifact;
  return {
    check: {
      ...offered,
      result: "different-file",
      sha256: file.doc.asset.sha256,
      ...(await hashed(file.doc.asset.sha256)),
    },
    target: file,
  };
}

/**
 * Whether the file with this SHA-256 has the hash an update entry states: read from the blob cache,
 * else the last check's answer for the same file and hash, else by downloading the link (CI keeps
 * no blobs). Null when we couldn't get the file.
 */
async function checkStatedHash(
  stated: { algorithm: HashAlgorithm; hex: string },
  sha256: string,
  link: string,
  ctx: Context,
  last: UpdateCheck | undefined,
): Promise<boolean | null> {
  if (stated.algorithm === "sha256") return stated.hex === sha256;
  let bytes = await readBlob(ctx.cacheDir, sha256);
  if (!bytes) {
    if (
      last?.statedHash === `${stated.algorithm}:${stated.hex}` &&
      last.sha256 === sha256 &&
      typeof last.hashMatches === "boolean"
    )
      return last.hashMatches;
    if (ctx.offline) return null;
    try {
      // Only the file we mean: a link that now serves other bytes answers nothing here.
      if ((await fetchUpdateFile(link, ctx)).sha256 === sha256)
        bytes = await readBlob(ctx.cacheDir, sha256);
    } catch {}
  }
  return bytes ? matchesStatedHash(stated, bytes) : null;
}

/**
 * Offline, a stored check from before we compared hashes: the hash comes from the update address's
 * file as we last fetched it, for the same version at the same link, and the file from the blobs.
 */
async function restateHash(
  c: UpdateCheck,
  url: string,
  lead: Artifact,
  ctx: Context,
): Promise<UpdateCheck> {
  if (c.statedHash !== undefined || !c.link || !c.version || !c.sha256) return c;
  if (!["same-file", "different-file", "not-analysed"].includes(c.result)) return c;
  const feed = await cachedUpdateText(url, ctx.updateCache);
  const entries = feed ? parseUpdateManifest(feed.text, lead.doc.manifest.addonId) : null;
  const entry = entries?.find(
    (e) => e.version === c.version && e.link?.toLowerCase() === c.link?.toLowerCase(),
  );
  const stated = entry ? statedHash(entry) : null;
  if (!stated) return c;
  const matches = await checkStatedHash(stated, c.sha256, c.link, ctx, undefined);
  return {
    ...c,
    statedHash: `${stated.algorithm}:${stated.hex}`,
    ...(matches === null ? {} : { hashMatches: matches }),
    ...(matches === false && feed?.modifiedAt ? { manifestModifiedAt: feed.modifiedAt } : {}),
  };
}

interface CachedUpdateFile {
  etag: string | null;
  lastModified: string | null;
  sha256: string;
  size: number;
}

/** Downloads an update file into the blob cache, revalidating with ETag / Last-Modified. */
async function fetchUpdateFile(
  link: string,
  ctx: Context,
): Promise<{ sha256: string; size: number; modified: string | null }> {
  const key = `update-file:${link}`;
  const cached = await ctx.updateCache.get<CachedUpdateFile>(key);
  const have = cached ? await readBlob(ctx.cacheDir, cached.sha256) : null;
  const headers: Record<string, string> = { "user-agent": ctx.userAgent };
  if (cached && have) {
    if (cached.etag) headers["if-none-match"] = cached.etag;
    if (cached.lastModified) headers["if-modified-since"] = cached.lastModified;
  }
  const res = await fetchWithRetry(link, { headers, redirect: "follow" }, 2);
  if (res.status === 304 && cached && have) {
    await res.body?.cancel();
    return { sha256: cached.sha256, size: cached.size, modified: isoTime(cached.lastModified) };
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`the update file answers HTTP ${res.status}`);
  }
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_XPI_BYTES) {
    await res.body?.cancel();
    throw new Error(`the update file is over our ${MAX_XPI_BYTES / MB} MB analysis limit`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_XPI_BYTES)
    throw new Error(`the update file is over our ${MAX_XPI_BYTES / MB} MB analysis limit`);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("the update file isn't a .xpi");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = join(ctx.cacheDir, "blobs", "sha256", sha256.slice(0, 2), `${sha256}.xpi`);
  await mkdir(join(ctx.cacheDir, "blobs", "sha256", sha256.slice(0, 2)), { recursive: true });
  await writeFile(file, bytes);
  const lastModified = res.headers.get("last-modified");
  await ctx.updateCache.set<CachedUpdateFile>(key, {
    etag: res.headers.get("etag"),
    lastModified,
    sha256,
    size: bytes.length,
  });
  return { sha256, size: bytes.length, modified: isoTime(lastModified) };
}

async function readBlob(cacheDir: string, sha256: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(
      await readFile(join(cacheDir, "blobs", "sha256", sha256.slice(0, 2), `${sha256}.xpi`)),
    );
  } catch {
    return null;
  }
}

async function artifactFor(
  asset: RestAsset,
  release: RestRelease,
  row: CensusRow,
  slug: string,
  known: Map<string, { file: string; doc: ReleaseDoc }>,
  developer: DeveloperHints,
  ctx: Context,
): Promise<Artifact> {
  const digest = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : null;
  const indexKey = `${asset.browser_download_url}|${asset.size}|${asset.updated_at}`;
  const sha0 = digest ?? (await ctx.blobIndex.get<string>(indexKey)) ?? null;
  // Older assets have no digest, and CI has no blob cache: the same GitHub asset ID, upload time
  // and size also identify a file we've already analysed.
  const prev = sha0
    ? known.get(sha0)
    : [...known.values()].find(
        (k) =>
          k.doc.asset.githubAssetId === asset.id &&
          k.doc.asset.uploadedAt === asset.updated_at &&
          k.doc.asset.size === asset.size,
      );

  let analysis: Analysis;
  let manifest: ReleaseDoc["manifest"];
  let files: ReleaseDoc["files"];
  let sha256: string;
  let isNew = false;
  if (prev?.doc.analysis && prev.doc.analysis.analyzerVersion === ANALYZER_VERSION && !ctx.force) {
    analysis = reclassifyHosts(prev.doc.analysis, ctx.table, developer);
    manifest = prev.doc.manifest;
    files = prev.doc.files;
    sha256 = prev.doc.asset.sha256;
  } else {
    if (asset.size > MAX_XPI_BYTES) {
      throw new Error(
        `${asset.name} is ${Math.round(asset.size / MB)} MB, over our ${MAX_XPI_BYTES / MB} MB analysis limit`,
      );
    }
    const cached = sha0 ? await readBlob(ctx.cacheDir, sha0) : null;
    if (!cached && ctx.offline) throw new Error(`${asset.name} is not in the blob cache`);
    const blob = cached
      ? { bytes: cached, sha256: sha0 as string }
      : await download(asset, ctx.blobIndex, ctx.cacheDir, ctx.userAgent);
    sha256 = blob.sha256;
    const entries = await unzip(blob.bytes);
    const result = analyzeXpi({
      slug,
      sha256,
      entries,
      table: ctx.table,
      analyzedAt: ctx.now,
      developer,
    });
    analysis = result.analysis;
    const m = pickManifest(result.manifests) ?? null;
    manifest = toManifest(m, analysis.input.version);
    files = entries
      .filter((e) => !e.path.endsWith("/"))
      .map((e) => ({
        path: e.path,
        size: e.data.length,
        sha256: createHash("sha256").update(e.data).digest("hex"),
      }))
      .sort((x, y) => x.path.localeCompare(y.path, "en"));
    isNew = true;
  }

  const obfuscated =
    analysis.transparency.obfuscation.detected &&
    analysis.transparency.obfuscation.confidence !== "low";
  // Stored with the release file so re-analysis on the no-GitHub-call path keeps it.
  const uploader = asset.uploader?.login ?? prev?.doc.asset.uploader ?? null;
  // Whether GitHub holds an attestation belongs to the file, so it is fetched once per file; the
  // level and wording are recomputed every time (re-analysis can change the obfuscation finding).
  const prevProvenance = prev?.doc.provenance ?? null;
  const stored = prevProvenance?.attestation;
  const attestation =
    uploader !== ACTIONS_BOT
      ? { present: false as const }
      : ctx.offline || (prevProvenance && !isNew)
        ? {
            present: stored?.present ?? false,
            ...(stored?.workflow ? { workflow: stored.workflow } : {}),
          }
        : await fetchAttestation(ctx.gh, row.repo, sha256);
  const releaseAuthor =
    release.author === undefined
      ? (prev?.doc.releaseAuthor ?? null)
      : (release.author?.login ?? null);
  const fresh = provenanceLite({
    uploader,
    releaseAuthor,
    attestation,
    obfuscated,
    checkedAt: ctx.now,
  });
  const provenance: Provenance =
    prevProvenance && stable(prevProvenance) === stable(fresh) ? prevProvenance : fresh;

  const version = analysis.input.version;
  const safe = version.replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 60) || "unknown";
  // A stored file keeps its name unless re-analysis read a different version from it.
  let file = prev && prev.doc.version === version ? prev.file : `${safe}.json`;
  if (!prev || prev.doc.version !== version) {
    const clash = [...known.values()].some((k) => k.file === file && k.doc.asset.sha256 !== sha256);
    if (clash) file = `${safe}+${sha256.slice(0, 8)}.json`;
  }
  const replaces = prev && prev.file !== file ? prev.file : undefined;
  const doc: ReleaseDoc = {
    schemaVersion: 1,
    slug,
    repo: row.repo.toLowerCase(),
    version,
    tag: release.tag_name,
    ...(release.tag_name ? { releaseAuthor } : {}),
    publishedAt: release.published_at ?? release.created_at,
    prerelease: release.prerelease,
    asset: {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      sha256,
      githubAssetId: asset.id,
      uploader,
      uploadedAt: asset.updated_at,
      fetchedAt: prev?.doc.asset.fetchedAt ?? ctx.now,
    },
    manifest,
    files,
    analysis,
    provenance,
    dataFlow: null,
    trustCard: prev?.doc.trustCard ?? null,
  };
  return { asset, doc, file, isNew, ...(replaces ? { replaces } : {}) };
}

/** Enough of a parsed manifest for the compatibility helpers. */
function asXpiManifest(m: ReleaseDoc["manifest"]): XpiManifest {
  return {
    target: "zotero",
    format: m.format,
    addonId: m.addonId === "(none)" ? null : m.addonId,
    updateUrl: m.updateUrl ?? null,
    minVersion: m.strictMinVersion ?? null,
    maxVersion: m.strictMaxVersion ?? null,
  } as unknown as XpiManifest;
}

function toManifest(m: XpiManifest | null, version: string): ReleaseDoc["manifest"] {
  const opt = (k: string, v: string | null | undefined) => (v ? { [k]: v } : {});
  return Manifest.parse({
    format: m?.format ?? "manifest.json",
    legacy: m?.format === "install.rdf",
    addonId: m?.addonId || "(none)",
    name: m?.name ?? "",
    version: m?.version || version,
    ...opt("description", m?.description),
    ...opt("homepageUrl", m?.homepageUrl),
    ...opt("updateUrl", m?.updateUrl),
    ...opt("strictMinVersion", m?.minVersion),
    ...opt("strictMaxVersion", m?.maxVersion),
  });
}

/** Requirement hints straight from the code; enrichment and review confirm or correct them. */
export function hintsFrom(a: Analysis): NonNullable<Profile["requirementsHints"]> {
  const used = a.network.hosts.filter(
    (h) => h.usage !== "link" && !(h.inVendoredCode && h.usage !== "request"),
  );
  const names = (cats: string[]) =>
    [
      ...new Set(used.filter((h) => cats.includes(h.category)).map((h) => h.provider ?? h.host)),
    ].sort();
  const cap = (id: string) => a.capabilities.some((c) => c.id === id && !c.inVendoredCodeOnly);
  return {
    aiServices: names(["llm-provider"]),
    otherServices: names(["translation", "scholarly-api", "integration"]),
    storesCredentials: cap("credential-storage") || cap("login-manager"),
    localModels: used.some((h) => h.category === "localhost"),
    launchesPrograms: cap("process-launch"),
  };
}

export async function loadReleaseDocs(
  dir: string,
): Promise<Map<string, { file: string; doc: ReleaseDoc }>> {
  const out = new Map<string, { file: string; doc: ReleaseDoc }>();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const file of names) {
    if (file === "profile.json" || !file.endsWith(".json")) continue;
    const doc = await readJson<ReleaseDoc>(join(dir, file));
    if (doc?.asset?.sha256) out.set(doc.asset.sha256, { file, doc });
  }
  return out;
}

async function loadAllProfiles(): Promise<Profile[]> {
  const out: Profile[] = [];
  let dirs: string[] = [];
  try {
    dirs = await readdir(paths.generated);
  } catch {
    return out;
  }
  for (const d of dirs.sort()) {
    const p = await readJson<Profile>(join(paths.generated, d, "profile.json"));
    if (p) out.push(p);
  }
  return out.sort(
    (a, b) =>
      (b.popularity.downloads ?? 0) - (a.popularity.downloads ?? 0) ||
      a.slug.localeCompare(b.slug, "en"),
  );
}

function indexEntry(p: Profile): ProfileIndexEntry {
  return {
    slug: p.slug,
    repo: p.repo,
    name: p.name,
    description: p.about.githubDescription ?? p.about.manifestDescription,
    kind: p.listing.kind,
    hidden: p.listing.hiddenByDefault,
    label: p.trust?.overall.label ?? null,
    dataSharing: p.trust?.facets.dataSharing.value ?? null,
    supports: p.compatibility.supports,
    worksWithCurrent: p.compatibility.current?.status === "compatible",
    stars: p.popularity.stars,
    downloads: p.popularity.downloads,
    maintenance: p.maintenance.status,
    lastActivityAt: p.maintenance.lastActivityAt,
    docs: p.languages.docs,
    chineseOnlyDocs: p.languages.chineseOnlyDocs,
    aiServices: p.requirementsHints?.aiServices ?? [],
    categoryHint: p.about.categoryHint,
  };
}

const VOLATILE = new Set(["generatedAt", "computedAt", "checkedAt", "fetchedAt", "analyzedAt"]);

/**
 * JSON for change detection: keys sorted (a parsed file and a freshly built object order keys
 * differently), and timestamps that move without the content changing left out.
 */
export function stable(doc: unknown): string {
  return JSON.stringify(doc, (key, value) => {
    if (VOLATILE.has(key)) return undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return value;
  });
}
