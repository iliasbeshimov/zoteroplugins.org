import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZoteroVersions } from "../census/compat.ts";
import type { CensusRow, Verdict } from "../census/run.ts";
import { measureRepos } from "../census/run.ts";
import { repoKeyFromUrl, type SourceId } from "../census/sources.ts";
import { loadConfig, requireGithubToken } from "../config.ts";
import { GitHub } from "../net/github.ts";
import { DiskCache } from "../net/http.ts";
import { paths } from "../paths.ts";
import { assignSlugs } from "../profile/listing.ts";
import {
  dequeue,
  enqueue,
  readQueue,
  readRecords,
  type SubmissionRecord,
  writeRecord,
} from "./records.ts";

/**
 * Plugins people submit on the site. The site's function checks the address and asks the
 * workflow (.github/workflows/submit.yml) to queue it; the workflow then, one run at a time:
 * 1. `atlas submit process`: decides each queued repo. A Zotero plugin joins the census, gets a
 *    slug and shows on the site as "In review"; anything else is recorded as rejected, with the
 *    reason, for the release we checked.
 * 2. `atlas submit check`: builds the profile and grade of every plugin in review, then marks it
 *    added. The nightly census keeps it from then on.
 * Nothing a submission does depends on how often it's sent: a repo already listed, in review or
 * rejected for an unchanged release is dropped from the queue without writing anything.
 */

const CENSUS_FILE = join(paths.root, "data", "census", "census.json");
const SLUGS_FILE = join(paths.root, "data", "slugs.json");

export const REJECTED: Record<
  Exclude<Verdict, "zotero-plugin" | "zotero-plugin-legacy">,
  string
> = {
  "repo-unavailable": "We couldn't find a public GitHub repository at that address.",
  "no-xpi-release": "It has no GitHub release with a plugin file (.xpi).",
  "firefox-extension": "Its release file is a Firefox extension, not a Zotero plugin.",
  "xpi-unreadable": "We couldn't read the plugin file in its latest release.",
};

/** A submitted address as owner/name, or null when it isn't a GitHub repository address. */
export function repoFromInput(input: string): string | null {
  const t = input.trim();
  if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(t)) return repoKeyFromUrl(`https://github.com/${t}`);
  return repoKeyFromUrl(t);
}

export type Decision =
  | { action: "drop"; why: "listed" | "in-review" | "added" | "unchanged-rejection" }
  | { action: "wait" }
  | { action: "measure" };

/** What to do with a queued repo before measuring it (the measurement decides the rest). */
export function decide(input: {
  listed: boolean;
  record: SubmissionRecord | undefined;
  acceptedToday: number;
  cap: number;
}): Decision {
  const { listed, record, acceptedToday, cap } = input;
  if (listed) return { action: "drop", why: "listed" };
  if (record?.status === "in-review" || record?.status === "added")
    return { action: "drop", why: record.status };
  if (acceptedToday >= cap) return { action: "wait" };
  return { action: "measure" };
}

const isPlugin = (v: Verdict) => v === "zotero-plugin" || v === "zotero-plugin-legacy";

export async function enqueueSubmission(input: string, now = new Date()): Promise<string> {
  const repo = repoFromInput(input);
  if (!repo) throw new Error(`Not a GitHub repository address: ${input}`);
  // Listed or already being checked under this name: nothing to queue (a renamed repo still goes
  // through the queue, which resolves GitHub's current name).
  const census = JSON.parse(await readFile(CENSUS_FILE, "utf8")) as { rows: CensusRow[] };
  if (census.rows.some((r) => r.repo.toLowerCase() === repo && isPlugin(r.verdict)))
    return `${repo} is already listed`;
  const record = (await readRecords()).find((r) => r.repo.toLowerCase() === repo);
  if (record?.status === "in-review" || record?.status === "added")
    return `${repo} is already ${record.status}`;
  const added = await enqueue(repo, now.toISOString());
  return added ? `Queued ${repo}` : `${repo} is already queued`;
}

export async function processQueue(
  opts: { cap: number; now?: Date },
  log: (msg: string) => void = console.log,
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  const today = iso.slice(0, 10);
  const config = loadConfig();
  const gh = new GitHub(
    requireGithubToken(config),
    config.userAgent,
    new DiskCache(join(config.cacheDir, "http")),
  );
  const census = JSON.parse(await readFile(CENSUS_FILE, "utf8")) as {
    zoteroVersions: ZoteroVersions;
    rows: CensusRow[];
  };
  const slugs = JSON.parse(await readFile(SLUGS_FILE, "utf8")) as Record<string, string>;
  const records = new Map((await readRecords()).map((r) => [r.repo.toLowerCase(), r]));
  // Waiting ones (over an earlier day's cap) go first, then the queue in arrival order.
  const queue = [
    ...[...records.values()]
      .filter((r) => r.status === "waiting")
      .map((r) => ({ repo: r.repo.toLowerCase(), receivedAt: r.submittedAt })),
    ...(await readQueue()).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
  ];
  let acceptedToday = [...records.values()].filter(
    (r) => (r.status === "in-review" || r.status === "added") && r.decidedAt.startsWith(today),
  ).length;
  const accepted: string[] = [];
  let censusChanged = false;
  const seen = new Set<string>();

  for (const q of queue) {
    if (seen.has(q.repo)) {
      await dequeue(q.repo);
      continue;
    }
    seen.add(q.repo);
    const base = (repo: string, prev?: SubmissionRecord): SubmissionRecord => ({
      schemaVersion: 1,
      repo,
      status: "rejected",
      reason: null,
      checkedTag: null,
      slug: null,
      name: null,
      submittedAt: prev?.submittedAt ?? q.receivedAt,
      decidedAt: iso,
      addedAt: null,
    });
    // GitHub's own name for it: follows renames and transfers, and fixes the letter case.
    const res = await gh.rest<{ full_name: string; private: boolean }>(`/repos/${q.repo}`);
    if (res.status !== 200 || !res.data || res.data.private) {
      if (!records.has(q.repo))
        await writeRecord({ ...base(q.repo), reason: REJECTED["repo-unavailable"] });
      log(`${q.repo}: not found`);
      await dequeue(q.repo);
      continue;
    }
    const repo = res.data.full_name;
    const key = repo.toLowerCase();
    const record = records.get(key);
    const listed = census.rows.some((r) => r.repo.toLowerCase() === key && isPlugin(r.verdict));
    const d = decide({ listed, record, acceptedToday, cap: opts.cap });
    if (d.action === "drop") {
      log(`${repo}: already ${d.why}`);
      await dequeue(q.repo);
      continue;
    }
    if (d.action === "wait") {
      if (record?.status !== "waiting")
        await writeRecord({ ...base(repo, record), status: "waiting" });
      log(`${repo}: over today's cap of ${opts.cap}, waiting`);
      await dequeue(q.repo);
      continue;
    }
    const empty = { candidates: new Map(), addonMarket: new Map(), sheet: new Map(), queries: [] };
    const [row] = await measureRepos(
      gh,
      [key],
      new Map([[key, new Set<SourceId>(["submitted"])]]),
      empty,
      census.zoteroVersions,
      now.getTime(),
      () => {},
    );
    if (!row) throw new Error(`${repo}: no census row`);
    if (record?.status === "rejected" && record.checkedTag === row.latestTag) {
      log(`${repo}: rejected before for ${row.latestTag ?? "no release"}, unchanged`);
      await dequeue(q.repo);
      continue;
    }
    if (isPlugin(row.verdict)) {
      census.rows = census.rows.filter((r) => r.repo.toLowerCase() !== key);
      census.rows.push(row);
      censusChanged = true;
      Object.assign(slugs, assignSlugs(slugs, [row.repo]));
      await writeRecord({
        ...base(repo, record),
        status: "in-review",
        checkedTag: row.latestTag,
        slug: slugs[key] ?? null,
        name: row.name,
      });
      acceptedToday++;
      accepted.push(repo);
      log(`${repo}: in review as ${slugs[key]}`);
    } else {
      await writeRecord({
        ...base(repo, record),
        reason: REJECTED[row.verdict as keyof typeof REJECTED],
        checkedTag: row.latestTag,
        name: row.name,
      });
      log(`${repo}: rejected (${row.verdict})`);
    }
    await dequeue(q.repo);
  }

  if (censusChanged) {
    census.rows.sort(
      (a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.repo.localeCompare(b.repo, "en"),
    );
    await writeFile(CENSUS_FILE, `${JSON.stringify(census, null, 1)}\n`);
    await writeFile(SLUGS_FILE, `${JSON.stringify(assignSlugs(slugs, []), null, 1)}\n`);
  }
  return accepted;
}

/** Profiles every plugin in review, then marks the ones with a profile as added. */
export async function checkInReview(log: (msg: string) => void = console.log): Promise<string[]> {
  const { runProfile } = await import("../profile/run.ts");
  const added: string[] = [];
  for (const r of await readRecords()) {
    if (r.status !== "in-review" || !r.slug) continue;
    try {
      await runProfile({ plugin: r.repo, force: false }, log);
    } catch (e) {
      log(`${r.repo}: profile failed: ${(e as Error).message}`);
      continue;
    }
    const exists = await stat(join(paths.root, "data", "generated", r.slug, "profile.json")).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    await writeRecord({ ...r, status: "added", addedAt: new Date().toISOString() });
    added.push(r.repo);
  }
  return added;
}
