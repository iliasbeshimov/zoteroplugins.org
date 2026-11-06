import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  becauseOf,
  type Catalog,
  type CatalogBuild,
  type CatalogEntry,
  type CatalogGrade,
  gradeOf,
  jobsFor,
  type PluginProfile,
  PublicRatings,
  type Release,
} from "@atlas/schema";
import { paths } from "../paths.ts";
import { RULES_VERSION } from "./score.ts";

/**
 * data/generated/catalog.json: what the Zotero Atlas plugin reads (schema/src/catalog.ts). One
 * line per plugin, so a day's changes read as a diff. Only listed plugins with a release: hidden
 * ones (forks, retired, Zotero 6 only, nothing to install) aren't offered for installation.
 */
export const CATALOG_FILE = join(paths.generated, "catalog.json");
export const RATINGS_FILE = join(paths.generated, "ratings.json");
export const SITE = "https://zoteroplugins.org";

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
      ? { version: check.version, grade: GRADE_OF_LABEL[check.label ?? ""] ?? ("–" as const) }
      : null;
  const need = req?.apiKey.need;
  const tested = p.trust?.tested;
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
    ratings: ratingsOf(src.ratings?.[p.slug], inst.version),
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
    plugins,
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
  return {
    summaries,
    requirements,
    release: (file) => releases.get(file) ?? null,
    ratings: ratings.success ? ratings.data.plugins : {},
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
