import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityId } from "@atlas/schema";
import type { ZoteroVersions } from "../census/compat.ts";
import {
  build,
  Catalogue,
  type LibraryIndex,
  LibraryReference,
  libraryFileName,
} from "../libs/index.ts";
import {
  type FindingReview,
  type NetworkReview,
  readFindingReview,
  readNetworkReview,
} from "../profile/reviews.ts";
import { type HostTable, parseHostTable } from "../scan/hosts.ts";

/**
 * What the plugin check needs besides the analyzer's code: the tables the catalogue's checks read.
 * They change nightly, so the file is built from the repository (data/ and pipeline/data/) and
 * shipped beside the check; the report says which day it is from.
 */
export interface CheckDataFile {
  schemaVersion: 1;
  /** When the tables were read from the repository. */
  builtAt: string;
  /** pipeline/data/hosts.yaml, as written. */
  hostsYaml: string;
  /** Zotero's versions, for the "works with Zotero N" line (the census's). */
  zoteroVersions: ZoteroVersions;
  /** data/libraries: each official release's hashed calls and literals, and the catalogue. */
  libraries: {
    catalogue: Catalogue;
    sets: Record<string, { calls: string[]; literals: string[] }>;
  };
  reviews: {
    /** Lower-case repository → slug, for plugins with a review. */
    slugs: Record<string, string>;
    findings: Record<string, FindingReview[]>;
    network: Record<string, NetworkReview>;
  };
}

export interface CheckData {
  builtAt: string;
  hostsVersion: string;
  table: HostTable;
  libraries: LibraryIndex;
  zoteroVersions: ZoteroVersions;
  reviews: CheckDataFile["reviews"];
  /** Which plugin each reviewed release file belongs to (any file a review names). */
  slugBySha: Map<string, string>;
}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8"));

/** Reads the tables from a checkout of the repository. */
export async function buildCheckDataFile(root: string, now = new Date()): Promise<CheckDataFile> {
  const hostsYaml = await readFile(join(root, "pipeline", "data", "hosts.yaml"), "utf8");
  const census = await readJson<{ zoteroVersions: ZoteroVersions }>(
    join(root, "data", "census", "census.json"),
  );

  const libDir = join(root, "data", "libraries");
  const catalogue = Catalogue.parse(await readJson(join(libDir, "catalogue.json")));
  const sets: CheckDataFile["libraries"]["sets"] = {};
  for (const name of Object.keys(catalogue.libraries)) {
    const file = join(libDir, `${libraryFileName(name)}.json`);
    if (!existsSync(file)) continue;
    const ref = LibraryReference.parse(await readJson(file));
    sets[name] = { calls: ref.calls, literals: ref.literals };
  }

  const reviewsRoot = join(root, "data", "reviews");
  const findings: CheckDataFile["reviews"]["findings"] = {};
  for (const dir of (await readdir(reviewsRoot)).sort()) {
    const id = CapabilityId.safeParse(dir);
    if (!id.success) continue;
    for (const f of (await readdir(join(reviewsRoot, dir))).sort()) {
      if (!f.endsWith(".json")) continue;
      const slug = f.slice(0, -".json".length);
      const review = await readFindingReview(id.data, slug, reviewsRoot);
      if (review) findings[slug] = [...(findings[slug] ?? []), review];
    }
  }
  const network: CheckDataFile["reviews"]["network"] = {};
  const netDir = join(reviewsRoot, "network");
  if (existsSync(netDir))
    for (const f of (await readdir(netDir)).sort()) {
      if (!f.endsWith(".json")) continue;
      const slug = f.slice(0, -".json".length);
      const review = await readNetworkReview(slug, netDir);
      if (review) network[slug] = review;
    }

  const registry = await readJson<Record<string, string>>(join(root, "data", "slugs.json"));
  const reviewed = new Set([...Object.keys(findings), ...Object.keys(network)]);
  const slugs: Record<string, string> = {};
  for (const [repo, slug] of Object.entries(registry)) if (reviewed.has(slug)) slugs[repo] = slug;

  return {
    schemaVersion: 1,
    builtAt: now.toISOString(),
    hostsYaml,
    zoteroVersions: census.zoteroVersions,
    libraries: { catalogue, sets },
    reviews: { slugs, findings, network },
  };
}

/** The ready-to-use tables from their file. */
export function loadCheckData(file: CheckDataFile): CheckData {
  const table = parseHostTable(file.hostsYaml);
  const aliases: Record<string, string[]> = {};
  const network = new Map<string, NonNullable<Catalogue["libraries"][string]["network"]>>();
  for (const [name, entry] of Object.entries(file.libraries.catalogue.libraries)) {
    aliases[name] = entry.aliases;
    if (entry.network) network.set(name, entry.network);
  }
  const sets = new Map(Object.entries(file.libraries.sets));
  const slugBySha = new Map<string, string>();
  for (const [slug, list] of Object.entries(file.reviews.findings))
    for (const r of list)
      for (const sha of [r.sha256, ...(r.alsoAppliesTo ?? []).map((x) => x.sha256)])
        slugBySha.set(sha, slug);
  for (const [slug, r] of Object.entries(file.reviews.network))
    for (const sha of [r.sha256, ...(r.alsoAppliesTo ?? []).map((x) => x.sha256)])
      slugBySha.set(sha, slug);
  return {
    builtAt: file.builtAt,
    hostsVersion: table.version,
    table,
    libraries: build(sets, aliases, network),
    zoteroVersions: file.zoteroVersions,
    reviews: file.reviews,
    slugBySha,
  };
}
