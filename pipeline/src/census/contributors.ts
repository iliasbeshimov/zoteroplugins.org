import { type GitHub, lastPage } from "../net/github.ts";
import { mapLimit } from "../net/http.ts";
import type { RepoFull } from "./metadata.ts";
import type { CensusRow } from "./run.ts";

/**
 * Contributors: the people who committed to the plugin. Not bots, and not the authors of the code
 * it started from. GitHub's own count covers a repository's whole history, so a fork counts its
 * parent's authors, and a plugin made by copying zotero-plugin-template with its history counts the
 * template's 16 authors and dependabot as its own.
 */

/** Copied with their history, these bring their authors along. Always considered as a source. */
export const TEMPLATES = ["windingwind/zotero-plugin-template"];

/** A history longer than this isn't walked: the plugin keeps GitHub's count, bots aside. */
const MAX_COMMIT_PAGES = 50;
const MAX_LIST_PAGES = 5;
const MAX_AHEAD_PAGES = 10;

interface ContributorEntry {
  login?: string;
  type?: string;
  name?: string;
  email?: string;
}

interface CommitEntry {
  sha: string;
  author: { login?: string; type?: string } | null;
  commit: { author: { name?: string; email?: string } | null };
}

export function isBot(who: {
  login?: string;
  type?: string;
  name?: string;
  email?: string;
}): boolean {
  return (
    who.type === "Bot" ||
    /\[bot\]$/i.test(who.login ?? "") ||
    /\[bot\]/i.test(who.name ?? "") ||
    /^actions-user$/i.test(who.login ?? "") ||
    /\[bot\]@|dependabot|renovate|github-actions|^action@github\.com$/i.test(who.email ?? "")
  );
}

/** The people behind some commits: a GitHub login where the commit is linked to one, else the email. */
export function authorsOf(commits: CommitEntry[]): Set<string> {
  const out = new Set<string>();
  for (const c of commits) {
    const who = {
      login: c.author?.login,
      type: c.author?.type,
      name: c.commit.author?.name,
      email: c.commit.author?.email,
    };
    if (isBot(who)) continue;
    const id = who.login
      ? `@${who.login.toLowerCase()}`
      : (who.email || who.name || "").toLowerCase();
    if (id) out.add(id);
  }
  return out;
}

export interface ContributorList {
  /** GitHub's count, anonymous authors included. */
  total: number;
  /** The same without bots. */
  people: number;
  /** Logins of the people (lower case), to spot a shared history. */
  logins: Set<string>;
}

/** GitHub's contributor list. Null when GitHub won't list it (403: history too large) or a page failed. */
export async function contributorList(gh: GitHub, nwo: string): Promise<ContributorList | null> {
  const path = `/repos/${nwo}/contributors?per_page=100&anon=true`;
  const first = await gh.rest<ContributorEntry[]>(path);
  if (first.status === 204) return { total: 0, people: 0, logins: new Set() };
  if (first.status !== 200 || !Array.isArray(first.data)) return null;
  const entries = [...first.data];
  const last = lastPage(first.link) ?? 1;
  for (let p = 2; p <= Math.min(last, MAX_LIST_PAGES); p++) {
    const page = await gh.rest<ContributorEntry[]>(`${path}&page=${p}`);
    if (page.status !== 200 || !Array.isArray(page.data)) return null;
    entries.push(...page.data);
  }
  let total = entries.length;
  if (last > MAX_LIST_PAGES) {
    const tail = await gh.rest<ContributorEntry[]>(`${path}&page=${last}`);
    if (tail.status !== 200 || !Array.isArray(tail.data)) return null;
    total = (last - 1) * 100 + tail.data.length;
  }
  const people = entries.filter((e) => !isBot(e));
  return {
    total,
    people: total - (entries.length - people.length),
    logins: new Set(people.flatMap((e) => (e.login ? [e.login.toLowerCase()] : []))),
  };
}

export interface RepoFacts {
  repo: string;
  createdAt: string | null;
  isFork: boolean | null;
  logins: Set<string>;
}

/**
 * For each repository that isn't a fork, the older ones it may have been copied from with their
 * history: those sharing at least three contributors besides its owner (a template's authors
 * arrive together). Any template among them, and the closest three others; together their
 * commits cover what was copied even when the closest is itself a copy of an older state.
 */
export function copySources(
  repos: RepoFacts[],
  templates: RepoFacts[] = [],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const pool = [...repos, ...templates.filter((t) => !repos.some((r) => same(r.repo, t.repo)))];
  for (const r of repos) {
    if (r.isFork || !r.createdAt) continue;
    const owner = r.repo.split("/")[0]?.toLowerCase();
    const created = Date.parse(r.createdAt);
    const found: { repo: string; shared: number; created: number }[] = [];
    for (const u of pool) {
      if (same(u.repo, r.repo) || !u.createdAt || Date.parse(u.createdAt) >= created) continue;
      let shared = 0;
      for (const login of r.logins) if (login !== owner && u.logins.has(login)) shared++;
      if (shared >= 3) found.push({ repo: u.repo, shared, created: Date.parse(u.createdAt) });
    }
    found.sort((a, b) => b.shared - a.shared || a.created - b.created);
    // A template that qualifies always counts: windingwind's own plugins share many of its people.
    const isTemplate = (repo: string) =>
      templates.some((t) => same(t.repo, repo)) || TEMPLATES.some((t) => same(t, repo));
    const chosen = [
      ...found.filter((f) => isTemplate(f.repo)),
      ...found.filter((f) => !isTemplate(f.repo)).slice(0, 3),
    ];
    if (chosen.length)
      out.set(
        r.repo,
        chosen.map((f) => f.repo),
      );
  }
  return out;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The authors of the commits a fork made itself: those ahead of its parent. Null when GitHub can't
 * compare them, or the fork is too far ahead to list.
 */
export async function forkAuthors(
  gh: GitHub,
  repo: string,
  branch: string,
  parent: string,
  parentBranch: string,
): Promise<Set<string> | null> {
  const owner = repo.split("/")[0] ?? "";
  const base = `/repos/${parent}/compare/${encodeURIComponent(parentBranch)}...${encodeURIComponent(`${owner}:${branch}`)}`;
  const commits: CommitEntry[] = [];
  for (let p = 1; p <= MAX_AHEAD_PAGES; p++) {
    const res = await gh.rest<{ ahead_by: number; commits: CommitEntry[] }>(
      `${base}?per_page=100&page=${p}`,
    );
    if (res.status !== 200 || !res.data) return null;
    commits.push(...res.data.commits);
    if (res.data.commits.length < 100 || commits.length >= res.data.ahead_by)
      return authorsOf(commits);
  }
  return null;
}

/**
 * The authors of the commits a repository made itself after copying another's history: its
 * commits less the sources'. Null when it shares no commit with them (the shared contributors are
 * a coincidence), or its history is too long to walk.
 */
export async function copyAuthors(
  gh: GitHub,
  repo: string,
  sourceShas: Set<string>,
): Promise<Set<string> | null> {
  const commits: CommitEntry[] = [];
  for (let p = 1; ; p++) {
    if (p > MAX_COMMIT_PAGES) return null;
    const res = await gh.rest<CommitEntry[]>(`/repos/${repo}/commits?per_page=100&page=${p}`);
    if (res.status !== 200 || !Array.isArray(res.data)) return null;
    commits.push(...res.data);
    if (res.data.length < 100) break;
  }
  const own = commits.filter((c) => !sourceShas.has(c.sha));
  return own.length < commits.length ? authorsOf(own) : null;
}

/** Sets each plugin's `contributors`: the people who committed to it (see above). */
export async function countContributors(
  gh: GitHub,
  rows: CensusRow[],
  full: Map<string, RepoFull | null>,
  log: (msg: string) => void,
): Promise<void> {
  const lists = new Map<string, ContributorList | null>();
  await mapLimit(rows, 8, async (row) => {
    lists.set(row.repo, await contributorList(gh, row.repo));
  });
  // Templates the census doesn't list today still count as a source (a run limited by --only).
  const templates: RepoFacts[] = [];
  for (const t of TEMPLATES) {
    if (rows.some((r) => same(r.repo, t))) continue;
    const meta = await gh.rest<{ created_at?: string }>(`/repos/${t}`);
    const list = await contributorList(gh, t);
    if (meta.data?.created_at && list)
      templates.push({
        repo: t,
        createdAt: meta.data.created_at,
        isFork: false,
        logins: list.logins,
      });
  }
  const sources = copySources(
    rows.map((r) => ({
      repo: r.repo,
      createdAt: r.createdAt,
      isFork: r.isFork,
      logins: lists.get(r.repo)?.logins ?? new Set(),
    })),
    templates,
  );

  const byName = new Map<string, RepoFull>();
  for (const f of full.values()) if (f) byName.set(f.nameWithOwner.toLowerCase(), f);
  const shaSets = new Map<string, Promise<Set<string>>>();
  const shasOf = (repo: string) => {
    let set = shaSets.get(repo.toLowerCase());
    if (!set) {
      set = gh
        .restPaginate<{ sha: string }>(`/repos/${repo}/commits`, MAX_COMMIT_PAGES)
        .then((cs) => new Set(cs.map((c) => c.sha)));
      shaSets.set(repo.toLowerCase(), set);
    }
    return set;
  };

  let forks = 0;
  let copies = 0;
  await mapLimit(rows, 4, async (row) => {
    const list = lists.get(row.repo) ?? null;
    let own: Set<string> | null = null;
    try {
      const meta = byName.get(row.repo.toLowerCase());
      if (row.isFork && row.parent && meta?.defaultBranch && meta.parentDefaultBranch) {
        own = await forkAuthors(
          gh,
          row.repo,
          meta.defaultBranch,
          row.parent,
          meta.parentDefaultBranch,
        );
        if (own) forks++;
      } else if (sources.has(row.repo)) {
        const shas = new Set<string>();
        for (const s of sources.get(row.repo) ?? [])
          for (const sha of await shasOf(s)) shas.add(sha);
        own = await copyAuthors(gh, row.repo, shas);
        if (own) copies++;
      }
    } catch (error) {
      log(`  contributors: ${row.repo}: ${(error as Error).message.slice(0, 120)}`);
    }
    const people = own ? own.size : (list?.people ?? null);
    // Someone published the plugin even when no commit names them: a fork released from another
    // branch has none ahead of its parent, and GitHub's list is empty when the commits carry no
    // usable email.
    row.contributors = people === null ? null : Math.max(people, 1);
  });
  log(`  ${forks} forks and ${copies} copies of another history counted by their own commits`);
}
