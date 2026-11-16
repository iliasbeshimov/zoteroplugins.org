import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  becauseOf,
  type Catalog,
  type CatalogBuild,
  type CatalogEntry,
  type CatalogGrade,
  type Growth,
  gradeOf,
  jobsFor,
  newest,
  PACKS,
  PICKS,
  type PluginProfile,
  PublicRatings,
  type Release,
  RISING_DAYS,
  rising,
  type ShelfPlugin,
} from "@atlas/schema";
import { loadGrowth, loadUsage } from "@atlas/schema/usage";
import { compareVersions } from "../census/compat.ts";
import { paths, repoRoot } from "../paths.ts";
import { RULES_VERSION } from "./score.ts";

/**
 * data/generated/catalog.json: what the Zotero Atlas plugin reads (schema/src/catalog.ts). One
 * line per plugin, so a day's changes read as a diff. Only listed plugins with a release: hidden
 * ones (forks, retired, Zotero 6 only, nothing to install) aren't offered for installation.
 */
export const CATALOG_FILE = join(paths.generated, "catalog.json");
export const RATINGS_FILE = join(paths.generated, "ratings.json");
export const SITE = "https://zoteroplugins.org";
/** Where `atlas icons` writes each plugin's icon (profile/icons.ts). */
const ICON_DIR = join(repoRoot, "site", "public", "icons");

export interface CatalogSources {
  /** The site's one-line summaries (data/census/summaries.json), keyed by owner/name. */
  summaries: Record<string, { does: string }>;
  /** The requirements check's answers (data/requirements/<slug>.json). */
  requirements: Record<
    string,
    { apiKey: { need: string; services: string[] }; localModel?: string }
  >;
  /** A release document by its path relative to data/generated, for the other builds. */
  release: (file: string) => Release | null;
  /** Published ratings by slug (data/generated/ratings.json, fetched by `atlas ratings`). */
  ratings?: PublicRatings["plugins"];
  /** The release documents of a plugin's analysed versions (data/generated/<slug>/<version>.json). */
  releasesOf?: (slug: string) => Release[];
  /** The site's one-line taglines (data/census/taglines.json), keyed by owner/name. */
  taglines?: Record<string, string>;
  /** owner/name in lower case → about how many copies of Zotero have it (census history). */
  usage?: Map<string, number>;
  /** owner/name in lower case → stars and downloads gained in the last RISING_DAYS. */
  growth?: Map<string, Growth>;
  /** Slugs with an icon at site/public/icons/<slug>.png. */
  icons?: Set<string>;
}

/** How many plugins the Rising and New shelves carry, so Atlas can skip ones it already shows. */
const SHELF_LENGTH = 20;

/** How many earlier releases a catalogue row carries for Atlas to go back to. */
const PREVIOUS = 3;
const MAJORS_NOW = [7, 8, 9, 10, 11];

/** Zotero majors a manifest range reaches, read literally (Atlas compares the exact version). */
function majorsOf(min: string | null, max: string | null): number[] {
  return MAJORS_NOW.filter(
    (m) =>
      compareVersions(min ?? "0", `${m}.99999`) <= 0 && compareVersions(max ?? "*", `${m}.0`) >= 0,
  );
}

/** Up to three earlier, finished releases we analysed, newest first, each with its grade then. */
export function previousReleases(
  docs: Release[],
  current: string,
): NonNullable<CatalogEntry["previous"]> {
  const byVersion = new Map<string, Release>();
  for (const d of docs) {
    if (d.prerelease || !d.asset?.sha256 || !d.trustCard) continue;
    if (compareVersions(d.version, current) >= 0) continue;
    if (!byVersion.has(d.version)) byVersion.set(d.version, d);
  }
  return [...byVersion.values()]
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, PREVIOUS)
    .map((d) => {
      const min = d.manifest.strictMinVersion ?? null;
      const max = d.manifest.strictMaxVersion ?? null;
      return {
        version: d.version,
        grade: GRADE_OF_LABEL[d.trustCard?.overall.label ?? ""] ?? ("–" as const),
        file: {
          name: d.asset.name,
          url: d.asset.url,
          sha256: d.asset.sha256,
          supports: majorsOf(min, max),
          min,
          max,
        },
      };
    });
}

const GRADE_OF_LABEL: Record<string, CatalogGrade> = {
  "low-concern": "A",
  "review-details": "B",
  "high-concern": "C",
};

const KEY_NEEDS = new Set(["none", "optional", "required", "unknown"]);

/** One catalogue row, or null for a plugin the catalogue doesn't offer. */
export function catalogEntry(p: PluginProfile, src: CatalogSources): CatalogEntry | null {
  const inst = p.install;
  if (p.listing.hiddenByDefault || p.listing.kind !== "plugin" || !inst) return null;
  const grade = gradeOf(p);
  const summary =
    src.summaries[p.repoName]?.does ??
    src.summaries[p.repo]?.does ??
    p.about.githubDescription ??
    p.about.manifestDescription ??
    null;
  const req = src.requirements[p.slug];
  const hints = p.requirementsHints;
  const file: CatalogBuild = {
    name: inst.asset.name,
    url: inst.asset.url,
    sha256: inst.asset.sha256,
    supports: p.compatibility.supports,
    min: p.compatibility.minVersion,
    max: p.compatibility.maxVersion,
  };
  const builds: CatalogBuild[] = [];
  for (const b of inst.builds ?? []) {
    if (b.asset === inst.asset.name) continue;
    const doc = src.release(b.releaseFile);
    builds.push({
      name: b.asset,
      url: doc?.asset.url ?? `${p.links.releases}/download/${inst.tag}/${b.asset}`,
      sha256: doc?.asset.sha256 ?? null,
      supports: b.supports,
      min: doc?.manifest.strictMinVersion ?? null,
      max: doc?.manifest.strictMaxVersion ?? null,
    });
  }
  const check = inst.updates?.check;
  const update =
    check?.result === "different-file"
      ? {
          version: check.version,
          grade: GRADE_OF_LABEL[check.label ?? ""] ?? ("–" as const),
          sha256: check.sha256 ?? null,
        }
      : null;
  const need = req?.apiKey.need;
  const tested = p.trust?.tested;
  const line =
    src.taglines?.[p.repoName] ??
    src.taglines?.[p.repo] ??
    (src.summaries[p.repoName] ?? src.summaries[p.repo])?.does.split(/(?<=\.)\s/)[0] ??
    p.about.githubDescription ??
    p.about.manifestDescription ??
    undefined;
  return {
    slug: p.slug,
    name: p.name,
    id: p.addonId,
    repo: p.links.repo,
    page: `${SITE}/p/${p.slug}`,
    summary,
    jobs: jobsFor(p),
    grade,
    because: becauseOf(p, grade),
    version: inst.version,
    publishedAt: inst.publishedAt,
    supports: p.compatibility.supports,
    current: p.compatibility.current
      ? { zotero: p.compatibility.current.zoteroVersion, status: p.compatibility.current.status }
      : null,
    file,
    builds,
    update,
    blocked: p.compatibility.blockedByZotero?.reason ?? null,
    tested: tested ? { zotero: tested.zotero, verdict: tested.verdict } : null,
    needs: {
      apiKey: need && KEY_NEEDS.has(need) ? (need as CatalogEntry["needs"]["apiKey"]) : "unknown",
      services: req?.apiKey.services ?? hints?.aiServices ?? [],
      localModel: req?.localModel === "yes" || Boolean(hints?.localModels),
      launchesPrograms: Boolean(hints?.launchesPrograms),
    },
    downloads: p.popularity.downloads,
    stars: p.popularity.stars,
    maintenance: p.maintenance.status,
    lastReleaseAt: p.maintenance.lastReleaseAt,
    docsChineseOnly: p.languages.chineseOnlyDocs,
    previous: previousReleases(src.releasesOf?.(p.slug) ?? [], inst.version),
    ratings: ratingsOf(src.ratings?.[p.slug], inst.version),
    ...(line ? { line } : {}),
    ...(src.icons ? { icon: src.icons.has(p.slug) } : {}),
    ...(src.usage ? { inUse: src.usage.get(p.repoName.toLowerCase()) ?? null } : {}),
  };
}

/** The catalogue's short form of a plugin's ratings: all versions, and the listed one. */
function ratingsOf(
  r: PublicRatings["plugins"][string] | undefined,
  version: string,
): CatalogEntry["ratings"] {
  if (!r || r.all.count === 0) return null;
  const v = r.versions[version];
  return {
    count: r.all.count,
    average: r.all.average,
    version: v ? { count: v.count, average: v.average } : null,
  };
}

/** Most downloaded first, so a list cut short still shows what most people use. */
export function buildCatalog(
  profiles: PluginProfile[],
  src: CatalogSources,
  generatedAt: string,
): Catalog {
  const plugins = profiles
    .map((p) => catalogEntry(p, src))
    .filter((e): e is CatalogEntry => e !== null)
    .sort(
      (a, b) =>
        (b.downloads ?? 0) - (a.downloads ?? 0) ||
        a.name.localeCompare(b.name, "en") ||
        a.slug.localeCompare(b.slug, "en"),
    );
  const shelves = src.usage ? buildShelves(profiles, plugins, src, generatedAt) : undefined;
  const currentZotero =
    profiles.find((p) => p.trust)?.trust?.inputs.currentZotero ??
    profiles.find((p) => p.compatibility.current)?.compatibility.current?.zoteroVersion ??
    "";
  return {
    schemaVersion: 1,
    generatedAt,
    currentZotero,
    rulesVersion: RULES_VERSION,
    site: SITE,
    ...(shelves ? { shelves } : {}),
    plugins,
  };
}

/**
 * The site's home-page shelves for Atlas: our picks, Rising, New and catching on, and the plugin
 * packs, chosen by the same code as the site (schema/src/shelves.ts, schema/src/packs.ts). Picks
 * and packs keep every listed plugin they name, fallbacks included: Atlas picks the ones that
 * work with the reader's own Zotero.
 */
export function buildShelves(
  profiles: PluginProfile[],
  plugins: CatalogEntry[],
  src: CatalogSources,
  generatedAt: string,
): NonNullable<Catalog["shelves"]> {
  const listed = new Set(plugins.map((e) => e.slug));
  const profileOf = new Map(profiles.map((p) => [p.slug, p]));
  const candidates: (ShelfPlugin & { since: string | null })[] = plugins.map((e) => {
    const p = profileOf.get(e.slug);
    return {
      slug: e.slug,
      repo: p?.repoName ?? "",
      grade: e.grade,
      currentOk: e.current?.status === "compatible" && !e.blocked,
      inUse: e.inUse ?? null,
      createdAt: p?.popularity.createdAt ?? null,
      since: p?.popularity.createdAt ?? null,
    };
  });
  const keep = (slugs: string[]) => slugs.filter((s) => listed.has(s));
  return {
    picks: PICKS.filter((k) => listed.has(k.slug)).map((k) => ({
      slug: k.slug,
      shot: k.shot.replace(/^\//, ""),
      w: k.w,
      h: k.h,
      alt: k.alt,
    })),
    rising: rising(candidates, src.growth ?? new Map(), new Set(), SHELF_LENGTH).map((r) => ({
      slug: r.plugin.slug,
      stars: r.stars,
    })),
    new: newest(candidates, Date.parse(generatedAt), SHELF_LENGTH).map((p) => ({
      slug: p.slug,
      since: p.since ?? generatedAt,
    })),
    packs: PACKS.map((pack) => ({
      slug: pack.slug,
      name: pack.name,
      who: pack.who,
      lead: pack.lead,
      picks: pack.picks.map((k) => ({
        task: k.task,
        why: k.why,
        ifYou: k.ifYou ?? null,
        plugins: keep(k.plugins),
        or: k.or ? { ifYou: k.or.ifYou, why: k.or.why, plugins: keep(k.or.plugins) } : null,
      })),
    })),
  };
}

/** The header on one line, then one plugin per line. */
export function serializeCatalog(c: Catalog): string {
  const { plugins, ...meta } = c;
  const head = JSON.stringify(meta);
  return `${head.slice(0, -1)},"plugins":[\n${plugins.map((e) => JSON.stringify(e)).join(",\n")}\n]}\n`;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Summaries, requirements and the release documents the profiles' other builds point to. */
export async function loadCatalogSources(profiles: PluginProfile[]): Promise<CatalogSources> {
  const summaries =
    (
      await readJson<{ summaries: CatalogSources["summaries"] }>(
        join(paths.root, "data", "census", "summaries.json"),
      )
    )?.summaries ?? {};
  const requirements: CatalogSources["requirements"] = {};
  const reqDir = join(paths.root, "data", "requirements");
  let names: string[] = [];
  try {
    names = await readdir(reqDir);
  } catch {
    names = [];
  }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const doc = await readJson<CatalogSources["requirements"][string]>(join(reqDir, f));
    if (doc?.apiKey) requirements[f.slice(0, -5)] = doc;
  }
  const releases = new Map<string, Release | null>();
  for (const p of profiles)
    for (const b of p.install?.builds ?? [])
      if (!releases.has(b.releaseFile))
        releases.set(b.releaseFile, await readJson<Release>(join(paths.generated, b.releaseFile)));
  const ratings = PublicRatings.safeParse(await readJson(RATINGS_FILE));
  // Each plugin's analysed versions, for the earlier releases Atlas can go back to.
  const versions = new Map<string, Release[]>();
  for (const p of profiles) {
    if (!p.install) continue;
    let files: string[] = [];
    try {
      files = await readdir(join(paths.generated, p.slug));
    } catch {
      files = [];
    }
    const own: Release[] = [];
    const other: Release[] = [];
    for (const f of files.sort()) {
      if (!f.endsWith(".json") || f === "profile.json") continue;
      const doc =
        releases.get(`${p.slug}/${f}`) ??
        (await readJson<Release>(join(paths.generated, p.slug, f)));
      if (!doc?.version || !doc.asset) continue;
      // A version's own document (4.0.3.json) before other builds of it.
      (f === `${doc.version}.json` ? own : other).push(doc);
    }
    versions.set(p.slug, [...own, ...other]);
  }
  const history = join(paths.root, "data", "census", "history");
  const taglines =
    (await readJson<{ taglines: Record<string, string> }>(
      join(paths.root, "data", "census", "taglines.json"),
    )) ?? null;
  const iconIndex = await readJson<{ icons: Record<string, { status: string }> }>(
    join(paths.generated, "icons.json"),
  );
  const icons = new Set(
    Object.entries(iconIndex?.icons ?? {})
      .filter(([slug, r]) => r.status === "ok" && existsSync(join(ICON_DIR, `${slug}.png`)))
      .map(([slug]) => slug),
  );
  return {
    summaries,
    requirements,
    taglines: taglines?.taglines ?? {},
    usage: loadUsage(history),
    growth: loadGrowth(history, RISING_DAYS),
    icons,
    release: (file) => releases.get(file) ?? null,
    ratings: ratings.success ? ratings.data.plugins : {},
    releasesOf: (slug) => versions.get(slug) ?? [],
  };
}

export async function writeCatalog(
  profiles: PluginProfile[],
  generatedAt: string,
  log: (msg: string) => void = console.log,
): Promise<Catalog> {
  const catalog = buildCatalog(profiles, await loadCatalogSources(profiles), generatedAt);
  const text = serializeCatalog(catalog);
  await writeFile(CATALOG_FILE, text);
  log(
    `Wrote ${catalog.plugins.length} plugins to catalog.json (${Math.round(text.length / 1024)} KB)`,
  );
  return catalog;
}
