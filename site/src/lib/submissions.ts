import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allPlugins } from "./atlas.ts";

/**
 * Plugins people submitted (pipeline/src/submit), as the site uses them: the ones in review get
 * a page before their checks finish, and /api/known.json tells the submit function what we already
 * know, so a repeat or an address we've turned down doesn't start anything.
 */

export interface SubmissionRecord {
  repo: string;
  status: "in-review" | "added" | "rejected" | "waiting";
  reason: string | null;
  checkedTag: string | null;
  slug: string | null;
  name: string | null;
  submittedAt: string;
  decidedAt: string;
}

function dataDir(): string {
  for (let d = process.cwd(); ; d = dirname(d)) {
    if (existsSync(join(d, "data", "generated"))) return join(d, "data");
    if (dirname(d) === d) throw new Error("data/ not found above the working directory");
  }
}

let cache: SubmissionRecord[] | null = null;
export function submissions(): SubmissionRecord[] {
  if (cache) return cache;
  const dir = join(dataDir(), "submissions");
  cache = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as SubmissionRecord)
    : [];
  return cache;
}

/** In review and not profiled yet: these get the "In review" page instead of a scorecard. */
export function inReview(): (SubmissionRecord & { slug: string })[] {
  const profiled = new Set(allPlugins().map((p) => p.slug));
  return submissions()
    .filter((r): r is SubmissionRecord & { slug: string } => r.status === "in-review" && !!r.slug)
    .filter((r) => !profiled.has(r.slug))
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
}

export type Known =
  | { status: "listed" | "in-review"; slug: string; name: string }
  | { status: "rejected"; reason: string; checkedTag: string | null }
  | { status: "waiting" };

/** Every repo we already know, by lower-case owner/name, plus every slug in use. */
export function known(): { repos: Record<string, Known>; slugs: string[] } {
  const repos: Record<string, Known> = {};
  for (const r of submissions()) {
    const key = r.repo.toLowerCase();
    if (r.status === "rejected") {
      repos[key] = { status: "rejected", reason: r.reason ?? "", checkedTag: r.checkedTag };
    } else if (r.status === "waiting") repos[key] = { status: "waiting" };
    else if (r.slug) repos[key] = { status: "in-review", slug: r.slug, name: r.name ?? r.repo };
  }
  for (const p of allPlugins())
    repos[p.repo.toLowerCase()] = { status: "listed", slug: p.slug, name: p.name };
  const slugs = [
    ...new Set([...allPlugins().map((p) => p.slug), ...inReview().map((r) => r.slug)]),
  ];
  return { repos, slugs: slugs.sort() };
}
