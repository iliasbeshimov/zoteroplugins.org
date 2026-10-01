import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../paths.ts";

/**
 * Plugins people submit on the site. Two kinds of file under data/submissions/:
 * - queue/<owner>__<name>.json: a submission waiting to be processed. The site's function asks the
 *   workflow to write it; the same repo always gives the same file, so a repeat changes nothing.
 * - <owner>__<name>.json: what we decided, keyed by GitHub's canonical owner/name (lower case).
 * GitHub owners can't contain underscores, so "__" separates owner and name unambiguously.
 */

export const SUBMISSIONS_DIR = join(paths.root, "data", "submissions");
export const QUEUE_DIR = join(SUBMISSIONS_DIR, "queue");

export const Queued = z.object({ repo: z.string(), receivedAt: z.string() });
export type Queued = z.infer<typeof Queued>;

export const SubmissionRecord = z.object({
  schemaVersion: z.literal(1),
  /** GitHub's canonical owner/name, as GitHub spells it. */
  repo: z.string(),
  /**
   * in-review: a Zotero plugin, listed without a grade while its checks run; added: its profile
   * exists; rejected: not a plugin (or not found), for the release we checked; waiting: over the
   * day's cap, processed first next time.
   */
  status: z.enum(["in-review", "added", "rejected", "waiting"]),
  /** Why it was rejected, in words for the person who submitted it. */
  reason: z.string().nullable(),
  /** The latest release tag we checked; a rejected repo is checked again only when it changes. */
  checkedTag: z.string().nullable(),
  slug: z.string().nullable(),
  name: z.string().nullable(),
  submittedAt: z.string(),
  decidedAt: z.string(),
  addedAt: z.string().nullable(),
});
export type SubmissionRecord = z.infer<typeof SubmissionRecord>;

/** owner/name → the file name both kinds of file use. */
export function fileKey(repo: string): string {
  const [owner = "", name = ""] = repo.toLowerCase().split("/");
  return `${owner}__${name}`;
}

async function readJsonDir<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const n of names) {
    const parsed = schema.safeParse(JSON.parse(await readFile(join(dir, n), "utf8")));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export const readRecords = () => readJsonDir(SUBMISSIONS_DIR, SubmissionRecord);
export const readQueue = () => readJsonDir(QUEUE_DIR, Queued);

export async function writeRecord(r: SubmissionRecord): Promise<void> {
  await mkdir(SUBMISSIONS_DIR, { recursive: true });
  await writeFile(
    join(SUBMISSIONS_DIR, `${fileKey(r.repo)}.json`),
    `${JSON.stringify(r, null, 2)}\n`,
  );
}

/** Adds a repo to the queue; a repo already queued keeps its first file untouched. */
export async function enqueue(repo: string, receivedAt: string): Promise<boolean> {
  await mkdir(QUEUE_DIR, { recursive: true });
  const file = join(QUEUE_DIR, `${fileKey(repo)}.json`);
  try {
    await readFile(file);
    return false;
  } catch {
    const q: Queued = { repo: repo.toLowerCase(), receivedAt };
    await writeFile(file, `${JSON.stringify(q, null, 2)}\n`);
    return true;
  }
}

export async function dequeue(repo: string): Promise<void> {
  await rm(join(QUEUE_DIR, `${fileKey(repo)}.json`), { force: true });
}

/** Accepted submissions, which the census keeps as candidates (source "submitted"). */
export async function submittedRepos(): Promise<string[]> {
  return (await readRecords())
    .filter((r) => r.status === "in-review" || r.status === "added")
    .map((r) => r.repo.toLowerCase());
}
