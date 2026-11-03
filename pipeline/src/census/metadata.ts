import { type GitHub, lastPage, partialErrors } from "../net/github.ts";

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
  releases: ReleaseInfo[];
  totalXpiDownloads: number;
}

const isXpi = (name: string) => name.toLowerCase().endsWith(".xpi");
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
    nodes { releaseAssets(first: 20) { nodes { name } } }
  }`;

interface LightRaw {
  nameWithOwner: string;
  stargazerCount: number;
  isFork: boolean;
  releases: { nodes: ({ releaseAssets: { nodes: ({ name: string } | null)[] } } | null)[] } | null;
}

export async function fetchLight(
  gh: GitHub,
  keys: string[],
  log: (msg: string) => void,
): Promise<Map<string, RepoLight | null>> {
  const raw = await batched<LightRaw>(gh, keys, 50, LIGHT_FIELDS, log, "pass A");
  const out = new Map<string, RepoLight | null>();
  for (const [key, r] of raw) {
    out.set(
      key,
      r && {
        nameWithOwner: r.nameWithOwner,
        stars: r.stargazerCount,
        isFork: r.isFork,
        hasXpi: present(r.releases?.nodes).some((rel) =>
          present(rel.releaseAssets.nodes).some((a) => isXpi(a.name)),
        ),
      },
    );
  }
  return out;
}

const ASSET_FIELDS = "name size downloadCount updatedAt downloadUrl";
const fullFields = (releases: number) => `
  nameWithOwner url stargazerCount forkCount isFork isArchived pushedAt createdAt description
  homepageUrl parent { nameWithOwner } licenseInfo { spdxId }
  repositoryTopics(first: 20) { nodes { topic { name } } }
  defaultBranchRef { target { ... on Commit { committedDate history { totalCount } } } }
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
  parent: { nameWithOwner: string } | null;
  licenseInfo: { spdxId: string } | null;
  repositoryTopics: { nodes: ({ topic: { name: string } } | null)[] };
  defaultBranchRef: { target: { committedDate?: string; history?: { totalCount: number } } } | null;
  releases: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (ReleaseRaw | null)[];
  };
}

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
      nodes: ({ releaseAssets: { nodes: (AssetInfo | null)[] } } | null)[];
    };
  } | null;
}

/** Remaining release pages, for lifetime download totals only. */
async function olderReleaseDownloads(gh: GitHub, nwo: string, cursor: string): Promise<number> {
  const [owner, name] = nwo.split("/");
  let total = 0;
  let after: string | null = cursor;
  while (after) {
    const res: { data: ReleasePage | null } = await gh.graphql<ReleasePage>(
      `query { repository(owner: ${lit(owner ?? "")}, name: ${lit(name ?? "")}) {
        releases(first: 100, after: ${lit(after)}, orderBy: {field: CREATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { releaseAssets(first: 20) { nodes { ${ASSET_FIELDS} } } } } } }`,
    );
    const page = res.data?.repository?.releases;
    if (!page) break;
    total += xpiDownloads(present(page.nodes));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  }
  return total;
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
    if (r.releases.pageInfo.hasNextPage && r.releases.pageInfo.endCursor) {
      totalXpiDownloads += await olderReleaseDownloads(
        gh,
        r.nameWithOwner,
        r.releases.pageInfo.endCursor,
      );
    }
    out.set(key, {
      nameWithOwner: r.nameWithOwner,
      url: r.url,
      stars: r.stargazerCount,
      forks: r.forkCount,
      isFork: r.isFork,
      parent: r.parent?.nameWithOwner ?? null,
      archived: r.isArchived,
      createdAt: r.createdAt,
      pushedAt: r.pushedAt,
      description: r.description,
      homepage: r.homepageUrl,
      license: r.licenseInfo?.spdxId ?? null,
      topics: present(r.repositoryTopics.nodes).map((n) => n.topic.name),
      lastCommitAt: r.defaultBranchRef?.target.committedDate ?? null,
      commitCount: r.defaultBranchRef?.target.history?.totalCount ?? null,
      releaseCount: r.releases.totalCount,
      releases: releases.map((rel) => ({
        tag: rel.tagName,
        publishedAt: rel.publishedAt,
        prerelease: rel.isPrerelease,
        assets: present(rel.releaseAssets.nodes),
      })),
      totalXpiDownloads,
    });
  }
  return out;
}

/** Contributor count from the `last` page link at per_page=1 (anonymous contributors included). */
export async function fetchContributors(gh: GitHub, nwo: string): Promise<number | null> {
  const res = await gh.rest<unknown[]>(`/repos/${nwo}/contributors?per_page=1&anon=true`);
  if (res.status === 204) return 0;
  if (res.status !== 200 || !Array.isArray(res.data)) return null; // 403: history too large to list
  return lastPage(res.link) ?? res.data.length;
}

export { isXpi };
