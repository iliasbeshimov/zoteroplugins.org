import { type GitHub, partialErrors } from "../net/github.ts";

/**
 * GitHub metadata via batched GraphQL (GitHub resolves renamed repos to their current name).
 * Pass A is cheap and runs on every candidate to find repos that release .xpi files;
 * pass B fetches full metadata and download counts for the ones worth keeping.
 */

export interface RepoLight {
  nameWithOwner: string;
  stars: number;
  isFork: boolean;
  hasXpi: boolean;
}

export interface AssetInfo {
  name: string;
  size: number;
  downloadCount: number;
  updatedAt: string;
  downloadUrl: string;
}

export interface ReleaseInfo {
  tag: string;
  publishedAt: string | null;
  prerelease: boolean;
  assets: AssetInfo[];
}

export interface RepoFull {
  nameWithOwner: string;
  url: string;
  stars: number;
  forks: number;
  isFork: boolean;
  parent: string | null;
  /** Branch names, for comparing a fork with its parent. */
  defaultBranch: string | null;
  parentDefaultBranch: string | null;
  archived: boolean;
  createdAt: string;
  pushedAt: string | null;
  description: string | null;
  homepage: string | null;
  license: string | null;
  topics: string[];
  lastCommitAt: string | null;
  commitCount: number | null;
  releaseCount: number;
  /**
   * The newest releases (50, or 10 for a repo too big to ask more of), then, when none of them ships
   * an .xpi, the older ones that do, up to the first that isn't a prerelease.
   */
  releases: ReleaseInfo[];
  totalXpiDownloads: number;
  /**
   * Its GitHub issues, not pull requests (REST's open_issues_count counts both): whether the repo
   * takes them, and how many are open and closed. Null when GitHub didn't say.
   */
  issues: { enabled: boolean; open: number; closed: number } | null;
}

const isXpi = (name: string) => name.toLowerCase().endsWith(".xpi");

/**
 * A release that carries no plugin file, only update manifests: the "release" tag that
 * zotero-plugin-template's workflow keeps update.json on. A place for Zotero to look, not a version.
 */
export function isManifestOnly(tag: string, assetNames: string[]): boolean {
  if (assetNames.some(isXpi)) return false;
  if (tag === "release") return true;
  return assetNames.length > 0 && assetNames.every((n) => /^update[\w.-]*\.(json|rdf)$/i.test(n));
}

/** GraphQL connections can contain null entries (e.g. assets GitHub can't resolve). */
const present = <T>(nodes: (T | null)[] | null | undefined): T[] =>
  (nodes ?? []).filter((n): n is T => n !== null);
const lit = (s: string) => JSON.stringify(s);

/** Each key's repository: null when GitHub says it doesn't exist, missing when GitHub kept failing. */
async function batched<T>(
  gh: GitHub,
  keys: string[],
  size: number,
  fields: string,
  log: (msg: string) => void,
  label: string,
  /** What to ask for when one repo alone is too big for `fields` (fewer releases). */
  lighter?: string,
): Promise<Map<string, T | null>> {
  const out = new Map<string, T | null>();
  const run = async (chunk: string[], asked = fields): Promise<void> => {
    const body = chunk
      .map((key, i) => {
        const [owner, name] = key.split("/");
        return `r${i}: repository(owner: ${lit(owner ?? "")}, name: ${lit(name ?? "")}) { ${asked} }`;
      })
      .join("\n");
    try {
      const { data, errors } = await gh.graphql<Record<string, T | null>>(`query { ${body} }`);
      // One repo with hundreds of releases can push a batch over GitHub's resource limits; GitHub
      // then blanks every release asset in the batch, and all its repos would read as "no .xpi".
      const partial = partialErrors(errors)[0];
      if (partial) throw new Error(`${partial.type ?? "error"}: ${partial.message}`);
      chunk.forEach((key, i) => {
        out.set(key, data?.[`r${i}`] ?? null);
      });
    } catch (error) {
      // Heavy batches time out or exceed GitHub's limits; split and retry.
      if (chunk.length === 1) {
        // Hundreds of releases with 20 files each can be too big even alone (bydb/mindgraph-notes):
        // ask for fewer first.
        if (lighter && asked !== lighter) return run(chunk, lighter);
        // Left out, not null: null means GitHub says there's no such repository, and the census
        // would carry it as unavailable for good. Left out, the census keeps its last row.
        log(`  ${label}: giving up on ${chunk[0]}: ${(error as Error).message}`);
        return;
      }
      const mid = Math.ceil(chunk.length / 2);
      await run(chunk.slice(0, mid));
      await run(chunk.slice(mid));
    }
  };
  for (let i = 0; i < keys.length; i += size) {
    await run(keys.slice(i, i + size));
    if ((i / size) % 10 === 0) log(`  ${label}: ${Math.min(i + size, keys.length)}/${keys.length}`);
  }
  return out;
}

const LIGHT_FIELDS = `
  nameWithOwner stargazerCount isFork
  releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
    pageInfo { hasNextPage endCursor }
    nodes { releaseAssets(first: 20) { nodes { name } } }
  }`;

type NamesPage = {
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  nodes: ({ releaseAssets: { nodes: ({ name: string } | null)[] } } | null)[];
};

interface LightRaw {
  nameWithOwner: string;
  stargazerCount: number;
  isFork: boolean;
  releases: NamesPage | null;
}

const namesHaveXpi = (page: NamesPage | null | undefined) =>
  present(page?.nodes).some((rel) => present(rel.releaseAssets.nodes).some((a) => isXpi(a.name)));

/** Pages of 100 releases this far back at most: past them, a repo isn't looked at further. */
const DEEP_PAGES = 10;

/**
 * Whether an older release, past the first page, ships an .xpi. A repo whose main project is
 * something else can release its Zotero add-on under its own tags, far behind the newest
 * (Heptazero/obsidian-lexis: zotero-v0.2.2 is its 37th newest of 78 releases; jmiba's
 * zotero-redisearch-rag: v0.6.1, about 90 back).
 */
async function xpiFurtherBack(gh: GitHub, nwo: string, cursor: string): Promise<boolean> {
  const [owner, name] = nwo.split("/");
  let after: string | null = cursor;
  for (let page = 0; after && page < DEEP_PAGES; page++) {
    const res: { data: { repository: { releases: NamesPage } | null } | null } = await gh.graphql(
      `query { repository(owner: ${lit(owner ?? "")}, name: ${lit(name ?? "")}) {
        releases(first: 100, after: ${lit(after)}, orderBy: {field: CREATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { releaseAssets(first: 20) { nodes { name } } } } } }`,
    );
    const releases = res.data?.repository?.releases;
    if (!releases) return false;
    if (namesHaveXpi(releases)) return true;
    after = releases.pageInfo?.hasNextPage ? releases.pageInfo.endCursor : null;
  }
  return false;
}

export async function fetchLight(
  gh: GitHub,
  keys: string[],
  log: (msg: string) => void,
): Promise<Map<string, RepoLight | null>> {
  const raw = await batched<LightRaw>(gh, keys, 50, LIGHT_FIELDS, log, "pass A");
  const out = new Map<string, RepoLight | null>();
  const deeper: [string, string, string][] = [];
  for (const [key, r] of raw) {
    const hasXpi = namesHaveXpi(r?.releases);
    const next = r?.releases?.pageInfo;
    if (r && !hasXpi && next?.hasNextPage && next.endCursor)
      deeper.push([key, r.nameWithOwner, next.endCursor]);
    out.set(
      key,
      r && { nameWithOwner: r.nameWithOwner, stars: r.stargazerCount, isFork: r.isFork, hasXpi },
    );
  }
  // No .xpi in the newest 10 releases, but there are more: look through the rest.
  let found = 0;
  for (const [key, nwo, cursor] of deeper) {
    const light = out.get(key);
    if (!light) continue;
    try {
      light.hasXpi = await xpiFurtherBack(gh, nwo, cursor);
    } catch (error) {
      // Measure it anyway: pass B reads every release.
      light.hasXpi = true;
      log(`  pass A: ${nwo}'s older releases unread, measured anyway: ${(error as Error).message}`);
    }
    if (light.hasXpi) found++;
  }
  if (deeper.length)
    log(
      `  pass A: ${deeper.length} repos with more releases looked at further back, ${found} with an .xpi`,
    );
  return out;
}

const ASSET_FIELDS = "name size downloadCount updatedAt downloadUrl";
const fullFields = (releases: number) => `
  nameWithOwner url stargazerCount forkCount isFork isArchived pushedAt createdAt description
  homepageUrl parent { nameWithOwner defaultBranchRef { name } } licenseInfo { spdxId }
  hasIssuesEnabled openIssues: issues(states: OPEN) { totalCount }
  closedIssues: issues(states: CLOSED) { totalCount }
  repositoryTopics(first: 20) { nodes { topic { name } } }
  defaultBranchRef { name target { ... on Commit { committedDate history { totalCount } } } }
  listed: releases { totalCount }
  releases(first: ${releases}, orderBy: {field: CREATED_AT, direction: DESC}) {
    totalCount pageInfo { hasNextPage endCursor }
    nodes { tagName publishedAt isPrerelease isDraft
      releaseAssets(first: 20) { nodes { ${ASSET_FIELDS} } } }
  }`;

interface ReleaseRaw {
  tagName: string;
  publishedAt: string | null;
  isPrerelease: boolean;
  isDraft: boolean;
  releaseAssets: { nodes: (AssetInfo | null)[] };
}

interface FullRaw {
  nameWithOwner: string;
  url: string;
  stargazerCount: number;
  forkCount: number;
  isFork: boolean;
  isArchived: boolean;
  pushedAt: string | null;
  createdAt: string;
  description: string | null;
  homepageUrl: string | null;
  parent: { nameWithOwner: string; defaultBranchRef?: { name: string } | null } | null;
  licenseInfo: { spdxId: string } | null;
  repositoryTopics: { nodes: ({ topic: { name: string } } | null)[] };
  defaultBranchRef: {
    name?: string;
    target: { committedDate?: string; history?: { totalCount: number } };
  } | null;
  listed: { totalCount: number };
  releases: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (ReleaseRaw | null)[];
  };
  hasIssuesEnabled?: boolean;
  openIssues?: { totalCount: number } | null;
  closedIssues?: { totalCount: number } | null;
}

/**
 * The releases GitHub lists. Ordered, the connection also returns releases whose tag was deleted,
 * which GitHub's page and count leave out (dralkh/seerai: 15 listed, 32 ordered); unordered, the
 * count stops at 1,000 (retorquere/zotero-better-bibtex has more).
 */
export const listedReleases = (listed: number, ordered: number) =>
  listed < 1000 ? listed : ordered;

const xpiDownloads = (releases: { releaseAssets: { nodes: (AssetInfo | null)[] } }[]) =>
  releases.reduce(
    (sum, r) =>
      sum +
      present(r.releaseAssets.nodes)
        .filter((a) => isXpi(a.name))
        .reduce((s, a) => s + a.downloadCount, 0),
    0,
  );

interface ReleasePage {
  repository: {
    releases: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ({
        tagName: string;
        publishedAt: string | null;
        isPrerelease: boolean;
        isDraft: boolean;
        releaseAssets: { nodes: (AssetInfo | null)[] };
      } | null)[];
    };
  } | null;
}

const manifestOnlyCount = (
  releases: { tagName: string; isDraft: boolean; releaseAssets: { nodes: (AssetInfo | null)[] } }[],
) =>
  releases.filter(
    (r) =>
      !r.isDraft &&
      isManifestOnly(
        r.tagName,
        present(r.releaseAssets.nodes).map((a) => a.name),
      ),
  ).length;

/**
 * Remaining release pages: lifetime download totals, and releases that aren't versions. With
 * `findXpi` (none of the first page's releases ships one), also the releases further back that
 * ship an .xpi, newest first, up to the first that isn't a prerelease: what pickRelease chooses
 * from (jmiba/zotero-redisearch-rag's Zotero add-on is in v0.6.1, about 90 releases back).
 */
async function olderReleases(
  gh: GitHub,
  nwo: string,
  cursor: string,
  findXpi: boolean,
): Promise<{ downloads: number; manifestOnly: number; withXpi: ReleaseInfo[] }> {
  const [owner, name] = nwo.split("/");
  let downloads = 0;
  let manifestOnly = 0;
  const withXpi: ReleaseInfo[] = [];
  let looking = findXpi;
  let after: string | null = cursor;
  while (after) {
    const res: { data: ReleasePage | null } = await gh.graphql<ReleasePage>(
      `query { repository(owner: ${lit(owner ?? "")}, name: ${lit(name ?? "")}) {
        releases(first: 100, after: ${lit(after)}, orderBy: {field: CREATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { tagName publishedAt isPrerelease isDraft
            releaseAssets(first: 20) { nodes { ${ASSET_FIELDS} } } } } } }`,
    );
    const page = res.data?.repository?.releases;
    if (!page) break;
    const nodes = present(page.nodes);
    downloads += xpiDownloads(nodes.filter((r) => !r.isDraft));
    manifestOnly += manifestOnlyCount(nodes);
    for (const r of nodes) {
      if (!looking || r.isDraft) continue;
      const assets = present(r.releaseAssets.nodes);
      if (!assets.some((a) => isXpi(a.name))) continue;
      withXpi.push({
        tag: r.tagName,
        publishedAt: r.publishedAt,
        prerelease: r.isPrerelease,
        assets,
      });
      if (!r.isPrerelease) looking = false;
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  }
  return { downloads, manifestOnly, withXpi };
}

export async function fetchFull(
  gh: GitHub,
  keys: string[],
  log: (msg: string) => void,
): Promise<Map<string, RepoFull | null>> {
  const raw = await batched<FullRaw>(gh, keys, 20, fullFields(50), log, "pass B", fullFields(10));
  const out = new Map<string, RepoFull | null>();
  for (const [key, r] of raw) {
    if (!r) {
      out.set(key, null);
      continue;
    }
    const releases = present(r.releases.nodes).filter((rel) => !rel.isDraft);
    let totalXpiDownloads = xpiDownloads(releases);
    let manifestOnly = manifestOnlyCount(releases);
    // Kept apart from `releases`, the newest ones: only what pickRelease needs further back.
    let furtherBack: ReleaseInfo[] = [];
    if (r.releases.pageInfo.hasNextPage && r.releases.pageInfo.endCursor) {
      const findXpi = !releases.some((rel) =>
        present(rel.releaseAssets.nodes).some((a) => isXpi(a.name)),
      );
      const older = await olderReleases(
        gh,
        r.nameWithOwner,
        r.releases.pageInfo.endCursor,
        findXpi,
      );
      totalXpiDownloads += older.downloads;
      manifestOnly += older.manifestOnly;
      furtherBack = older.withXpi;
    }
    out.set(key, {
      nameWithOwner: r.nameWithOwner,
      url: r.url,
      stars: r.stargazerCount,
      forks: r.forkCount,
      isFork: r.isFork,
      parent: r.parent?.nameWithOwner ?? null,
      defaultBranch: r.defaultBranchRef?.name ?? null,
      parentDefaultBranch: r.parent?.defaultBranchRef?.name ?? null,
      archived: r.isArchived,
      createdAt: r.createdAt,
      pushedAt: r.pushedAt,
      description: r.description,
      homepage: r.homepageUrl,
      license: r.licenseInfo?.spdxId ?? null,
      topics: present(r.repositoryTopics.nodes).map((n) => n.topic.name),
      issues:
        r.openIssues && r.closedIssues
          ? {
              enabled: r.hasIssuesEnabled ?? true,
              open: r.openIssues.totalCount,
              closed: r.closedIssues.totalCount,
            }
          : null,
      lastCommitAt: r.defaultBranchRef?.target.committedDate ?? null,
      commitCount: r.defaultBranchRef?.target.history?.totalCount ?? null,
      // Versions: the template's update-manifest release isn't one.
      releaseCount: Math.max(
        0,
        listedReleases(r.listed.totalCount, r.releases.totalCount) - manifestOnly,
      ),
      releases: [
        ...releases.map((rel) => ({
          tag: rel.tagName,
          publishedAt: rel.publishedAt,
          prerelease: rel.isPrerelease,
          assets: present(rel.releaseAssets.nodes),
        })),
        ...furtherBack,
      ],
      totalXpiDownloads,
    });
  }
  return out;
}

export { isXpi };
