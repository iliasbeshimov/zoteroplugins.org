import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { becauseOf, type Grade, gradeOf, type PluginProfile } from "@atlas/schema";
import { paths } from "../paths.ts";

/**
 * The public grade log: every time a listed plugin's grade moves, or a plugin gets its first one.
 * data/generated/grade-log.json is what /log, the home page and /log.xml show.
 * data/generated/grade-state.json is the last grade the log recorded for each plugin, so a plugin
 * that briefly has no grade (a release GitHub didn't return one day) isn't logged again, or as new,
 * when it comes back.
 */
export interface GradeLogEntry {
  slug: string;
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** null: its first grade. */
  from: Grade | null;
  to: Grade;
  why: string;
}

export interface GradeState {
  grade: Grade;
  version: string;
  /** The Zotero version of an "as described" live test of this file, if any. */
  tested: string | null;
  rules: string | null;
  analyzer: string | null;
}

const LOG_FILE = join(paths.generated, "grade-log.json");
const STATE_FILE = join(paths.generated, "grade-state.json");

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function stateOf(p: PluginProfile, grade: Grade): GradeState {
  const t = p.trust;
  const tested = t?.tested?.verdict === "as-described" ? t.tested.zotero : null;
  return {
    grade,
    version: t?.appliesTo.version ?? p.install?.version ?? "",
    tested,
    rules: t?.rulesVersion ?? null,
    analyzer: t?.inputs.analyzerVersion ?? null,
  };
}

/** Why the grade is what it is now, given what the log recorded last time. */
export function whyOf(prev: GradeState | null, p: PluginProfile, grade: Grade): string {
  const because = becauseOf(p, grade);
  if (!prev) return `${capFirst(because)}.`;
  const now = stateOf(p, grade);
  const tested = p.trust?.tested;
  if (now.version !== prev.version) {
    if (prev.grade === "A+" && grade === "A")
      return "New release, not yet tested in Zotero; every code check came out low.";
    return `New release: ${because}.`;
  }
  if (grade === "A+" && now.tested !== prev.tested)
    return `Tested in Zotero ${now.tested}: it did only what its card says.`;
  // The live test only decides A+ versus A; any other move comes from the code.
  if (prev.grade === "A+" && grade === "A") {
    if (tested?.verdict === "unexpected")
      return `Our live test in Zotero ${tested.zotero} found something its card doesn't describe.`;
    if (tested?.verdict === "as-described")
      return `Its live test was in Zotero ${tested.zotero}; not yet tested in the current Zotero.`;
    return "Its live test no longer applies; every code check came out low.";
  }
  // The developer replaced the file, whatever else changed that day.
  if (because.startsWith("its release file was replaced")) return `${capFirst(because)}.`;
  if (now.rules !== prev.rules || now.analyzer !== prev.analyzer)
    return `Our checks changed: ${because}.`;
  return `Rechecked: ${because}.`;
}

/**
 * Compares each profile's grade with the last one recorded and returns the log entries; `state` is
 * updated in place. Only listed plugins are logged; hidden ones (forks, retired) and plugins
 * without a grade update nothing that would show.
 */
export function recordGrades(
  profiles: PluginProfile[],
  state: Record<string, GradeState>,
  date: string,
): GradeLogEntry[] {
  const entries: GradeLogEntry[] = [];
  for (const p of profiles) {
    const grade = gradeOf(p);
    if (grade === "–") continue;
    const prev = state[p.slug] ?? null;
    const now = stateOf(p, grade);
    if (!p.listing.hiddenByDefault && prev?.grade !== grade)
      entries.push({
        slug: p.slug,
        version: now.version,
        date,
        from: prev?.grade ?? null,
        to: grade,
        why: whyOf(prev, p, grade),
      });
    state[p.slug] = now;
  }
  return entries;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function save(log: GradeLogEntry[], state: Record<string, GradeState>): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(LOG_FILE, `${JSON.stringify(log, null, 1)}\n`);
  await writeFile(STATE_FILE, `${JSON.stringify(sorted, null, 1)}\n`);
}

/**
 * After a profile run: log what moved since the last run. Without a state file (first run), the
 * current grades become the starting point and nothing is logged.
 */
export async function updateGradeLog(
  profiles: PluginProfile[],
  date: string,
  log: (msg: string) => void = console.log,
): Promise<GradeLogEntry[]> {
  const state = await readJson<Record<string, GradeState>>(STATE_FILE);
  const entries = await readJson<GradeLogEntry[]>(LOG_FILE);
  if (!state) {
    const fresh: Record<string, GradeState> = {};
    recordGrades(profiles, fresh, date);
    await save(entries ?? [], fresh);
    log(`Grade log: no earlier grades recorded; ${Object.keys(fresh).length} grades are the start`);
    return [];
  }
  const added = recordGrades(profiles, state, date);
  await save([...(entries ?? []), ...added], state);
  if (added.length) log(`Grade log: ${added.length} grade changes`);
  return added;
}

// ---------------------------------------------------------------------------------------------
// Rebuilding the log from git history: every commit that changed data/generated, oldest first.

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: paths.root });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} exited ${code}`)),
    );
  });
}

/** Reads blobs through one `git cat-file --batch`. */
function blobReader() {
  const child = spawn("git", ["cat-file", "--batch"], { cwd: paths.root });
  const chunks: Buffer[] = [];
  let buffered = 0;
  const waiting: (() => void)[] = [];
  child.stdout.on("data", (d: Buffer) => {
    chunks.push(d);
    buffered += d.length;
    waiting.shift()?.();
  });
  const take = async (n: number): Promise<Buffer> => {
    while (buffered < n) await new Promise<void>((r) => waiting.push(r));
    const all = Buffer.concat(chunks);
    chunks.length = 0;
    chunks.push(all.subarray(n));
    buffered = all.length - n;
    return all.subarray(0, n);
  };
  const line = async (): Promise<string> => {
    for (;;) {
      const all = Buffer.concat(chunks);
      const i = all.indexOf(10);
      if (i >= 0) return (await take(i + 1)).toString("utf8").trimEnd();
      await new Promise<void>((r) => waiting.push(r));
    }
  };
  return {
    async read(sha: string): Promise<string> {
      child.stdin.write(`${sha}\n`);
      const size = Number((await line()).split(" ")[2]);
      const body = await take(size + 1);
      return body.subarray(0, size).toString("utf8");
    },
    close: () => child.stdin.end(),
  };
}

/** Only what the grade and its reason read, so years of snapshots fit in memory. */
function slim(p: PluginProfile): PluginProfile {
  const t = p.trust;
  return {
    slug: p.slug,
    listing: p.listing,
    install: p.install ? { version: p.install.version } : null,
    scan: p.scan,
    trust: t
      ? {
          overall: t.overall,
          inputs: {
            currentZotero: t.inputs.currentZotero,
            analyzerVersion: t.inputs.analyzerVersion,
          },
          tested: t.tested,
          appliesTo: t.appliesTo,
          rulesVersion: t.rulesVersion,
        }
      : null,
  } as unknown as PluginProfile;
}

/**
 * Replays every committed snapshot of data/generated since the first one (launch): the first
 * snapshot's grades are the start, and each later one logs what moved, dated by its commit.
 * Rewrites grade-log.json and grade-state.json.
 */
export async function rebuildGradeLog(
  current: PluginProfile[],
  today: string,
  log: (msg: string) => void = console.log,
): Promise<GradeLogEntry[]> {
  const commits = (
    await git(["log", "--reverse", "--format=%H %cs", "HEAD", "--", "data/generated"])
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ") as [string, string]);
  const blobs = blobReader();
  const parsed = new Map<string, PluginProfile>();
  const state: Record<string, GradeState> = {};
  const entries: GradeLogEntry[] = [];
  try {
    for (const [i, [commit, date]] of commits.entries()) {
      const tree = await git(["ls-tree", "-r", commit, "--", "data/generated"]);
      const profiles: PluginProfile[] = [];
      for (const row of tree.split("\n")) {
        const [meta, path] = row.split("\t");
        if (!meta || !path?.endsWith("/profile.json")) continue;
        const sha = meta.split(" ")[2] as string;
        let p = parsed.get(sha);
        if (!p) {
          p = slim(JSON.parse(await blobs.read(sha)) as PluginProfile);
          parsed.set(sha, p);
        }
        profiles.push(p);
      }
      const added = recordGrades(profiles, state, date);
      if (i > 0) entries.push(...added);
    }
  } finally {
    blobs.close();
  }
  entries.push(...recordGrades(current, state, today));
  await save(entries, state);
  log(
    `Grade log rebuilt from ${commits.length} snapshots since ${commits[0]?.[1] ?? "?"}: ${entries.length} changes`,
  );
  return entries;
}
