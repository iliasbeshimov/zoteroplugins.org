import type { ListingKind } from "@atlas/schema";
import type { CensusRow } from "../census/run.ts";
import { CURATED_SOURCES } from "../census/run.ts";

/** Sheet tool types that aren't Zotero plugins: kept out of the directory for now. */
const NOT_PLUGINS = new Set(["Service", "Companion", "Integration", "Browser Extension"]);

/**
 * Everything the census confirmed is listed. Repos without an .xpi are listed only when a
 * curated list calls them a plugin, since nothing else confirms they are one.
 */
export function listingKind(row: CensusRow): ListingKind | null {
  if (row.verdict === "zotero-plugin") return "plugin";
  if (row.verdict === "zotero-plugin-legacy") return "legacy";
  if (
    row.verdict === "no-xpi-release" &&
    row.sources.some((s) => CURATED_SOURCES.includes(s)) &&
    !NOT_PLUGINS.has(row.sheetToolType ?? "")
  ) {
    return "no-release";
  }
  return null;
}

const slugPart = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Slug rules: the repo name, lowercased; on a clash the later assignment gets
 * `<name>--<owner>`. Existing assignments never change. Repos are assigned in the order given,
 * so callers pass the most-downloaded first and the original keeps the short name.
 */
export function assignSlugs(
  existing: Record<string, string>,
  repos: string[],
): Record<string, string> {
  const out = { ...existing };
  const taken = new Set(Object.values(out));
  for (const repo of repos) {
    const key = repo.toLowerCase();
    if (out[key]) continue;
    const [owner = "", name = ""] = key.split("/");
    let base = slugPart(name).slice(0, 80);
    if (base.length < 2) base = `${base || "plugin"}-plugin`;
    let slug = base;
    if (taken.has(slug)) slug = `${base}--${slugPart(owner).slice(0, 18)}`;
    for (let i = 2; taken.has(slug); i++) slug = `${base}--${slugPart(owner).slice(0, 18)}-${i}`;
    out[key] = slug;
    taken.add(slug);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b, "en")));
}

export interface ListingInput {
  repo: string;
  slug: string;
  kind: ListingKind;
  isFork: boolean;
  parent: string | null;
  downloads: number;
  maintenance: string;
  addonId: string | null;
}

export interface ListingResult {
  hiddenByDefault: boolean;
  hiddenReason: "fork" | "legacy" | "no-release" | null;
  fork: { of: string; ofSlug: string | null } | null;
  forks: string[];
  addonIdSharedWith: string[];
}

/**
 * Forks of a listed plugin are hidden from the default view unless they've overtaken the
 * original: more downloads, or still active while the original has stopped.
 */
export function resolveListing(items: ListingInput[]): Map<string, ListingResult> {
  const byRepo = new Map(items.map((i) => [i.repo.toLowerCase(), i]));
  const forksOf = new Map<string, string[]>();
  const byAddonId = new Map<string, string[]>();
  for (const i of items) {
    if (i.isFork && i.parent && byRepo.has(i.parent.toLowerCase())) {
      const k = i.parent.toLowerCase();
      forksOf.set(k, [...(forksOf.get(k) ?? []), i.slug]);
    }
    if (i.addonId) {
      const k = i.addonId.toLowerCase();
      byAddonId.set(k, [...(byAddonId.get(k) ?? []), i.slug]);
    }
  }
  const out = new Map<string, ListingResult>();
  for (const i of items) {
    const parent = i.isFork && i.parent ? byRepo.get(i.parent.toLowerCase()) : undefined;
    const overtook =
      parent !== undefined &&
      (i.downloads > parent.downloads ||
        (i.maintenance === "active" && ["dormant", "archived"].includes(parent.maintenance)));
    const hiddenReason =
      i.kind === "legacy"
        ? "legacy"
        : i.kind === "no-release"
          ? "no-release"
          : parent && !overtook
            ? "fork"
            : null;
    out.set(i.repo.toLowerCase(), {
      hiddenByDefault: hiddenReason !== null,
      hiddenReason,
      fork: i.isFork && i.parent ? { of: i.parent, ofSlug: parent?.slug ?? null } : null,
      forks: (forksOf.get(i.repo.toLowerCase()) ?? []).sort(),
      addonIdSharedWith: i.addonId
        ? (byAddonId.get(i.addonId.toLowerCase()) ?? []).filter((s) => s !== i.slug).sort()
        : [],
    });
  }
  return out;
}
