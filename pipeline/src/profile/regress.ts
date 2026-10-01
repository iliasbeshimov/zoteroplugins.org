import { fork } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginProfile } from "@atlas/schema";
import { loadConfig } from "../config.ts";
import { mapLimit } from "../net/http.ts";
import { paths } from "../paths.ts";
import { ANALYZER_VERSION } from "../scan/analyze.ts";
import {
  assemble,
  gather,
  loadReleaseDocs,
  makeContext,
  prepare,
  selectCandidates,
  stable,
} from "./run.ts";

/**
 * Regression check for analyzer and scoring changes (the label-diff gate). Rebuilds every profile
 * offline, from the stored release files and the cached .xpi blobs, with the code as it is now,
 * and lists every change against the profiles in data/generated. Never writes to data/.
 *
 * Every change it reports is read and accepted before a batch of fixes lands; an unchanged
 * analyzer must report no changes at all.
 */

type Profile = PluginProfile;

export interface Snapshot {
  label: string | null;
  dataSharing: string | null;
  dataSharingLabel: string | null;
  hosts: string[];
  /** Hosts the card marks as seen when we ran it. */
  observed: string[];
  badges: string[];
  transparency: string | null;
  drivers: string[];
  asset: string | null;
  version: string | null;
  autoUpdates: boolean | null;
  scan: string;
  /** The sandbox's verdict on this file, when the card has one. */
  tested: string | null;
  /** The card's compatibility line, and whether the release works with the current Zotero. */
  compatibility: string | null;
  worksWithCurrent: boolean | null;
}

export interface Change {
  slug: string;
  hidden: boolean;
  downloads: number;
  before: Snapshot;
  after: Snapshot;
  /** Top-level profile fields that differ, beyond the snapshot. */
  fields: string[];
}

export interface RegressResult {
  slug: string;
  error?: string;
  change?: Change;
}

export function snapshot(p: Profile): Snapshot {
  const t = p.trust;
  return {
    label: t?.overall.label ?? null,
    dataSharing: t?.facets.dataSharing.value ?? null,
    dataSharingLabel: t?.facets.dataSharing.label ?? null,
    hosts: (t?.facets.dataSharing.hosts ?? [])
      .flatMap((h) => h.hosts.map((x) => `${h.category}:${x}`))
      .sort(),
    observed: (t?.facets.dataSharing.hosts ?? [])
      .flatMap((h) => (h.observed ?? []).map((x) => `${h.category}:${x}`))
      .sort(),
    badges: (t?.facets.capabilities.badges ?? []).map((b) => `${b.id}:${b.concern}`).sort(),
    transparency: t?.facets.sourceTransparency.label ?? null,
    drivers: t
      ? [
          ...t.facets.sourceTransparency.drivers,
          ...t.facets.dataSharing.drivers,
          ...t.facets.capabilities.drivers,
        ].sort()
      : [],
    asset: p.install?.asset.name ?? null,
    version: p.install?.version ?? null,
    autoUpdates: p.install?.autoUpdates ?? null,
    scan: p.scan.status,
    tested: t?.tested?.verdict ?? null,
    compatibility: t?.facets.compatibility.label ?? null,
    worksWithCurrent: p.compatibility.current
      ? p.compatibility.current.status === "compatible"
      : null,
  };
}

/** Paths of the values that differ, two levels deep: `install.asset`, `trust.facets`. */
function fieldDiff(a: Profile, b: Profile): string[] {
  const strip = (p: Profile) => ({
    ...p,
    generatedAt: "",
    trust: p.trust ? { ...p.trust, inputs: { ...p.trust.inputs, inputHash: "" } } : null,
  });
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string, depth: number) => {
    if (stable(x) === stable(y)) return;
    const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (depth === 0 || !isObj(x) || !isObj(y)) {
      out.push(path);
      return;
    }
    const xo = x as Record<string, unknown>;
    const yo = y as Record<string, unknown>;
    for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)]))
      walk(xo[k], yo[k], path ? `${path}.${k}` : k, depth - 1);
  };
  walk(strip(a), strip(b), "", 2);
  return out.sort();
}

export async function runRegress(
  opts: { plugin?: string; limit?: number; jobs?: number; shard?: string; out?: string },
  log: (msg: string) => void = console.log,
): Promise<RegressResult[]> {
  const config = loadConfig();
  const outDir = join(config.cacheDir, "regress");
  await mkdir(outDir, { recursive: true });
  const prep = await prepare();
  const all = selectCandidates(prep.candidates, opts);
  const [shard, shards] = (opts.shard ?? "0/1").split("/").map(Number) as [number, number];
  const mine = all.filter((_, i) => i % shards === shard);

  const jobs = opts.shard ? 1 : Math.max(1, opts.jobs ?? 1);
  if (jobs > 1) {
    log(
      `Regression check: ${all.length} plugins, ${jobs} workers (analyzer ${ANALYZER_VERSION}, hosts ${prep.table.version})`,
    );
    const bin = fileURLToPath(new URL("../../bin/atlas.js", import.meta.url));
    const files = await Promise.all(
      Array.from({ length: jobs }, (_, i) => {
        const out = join(outDir, `shard-${i}.json`);
        const args = ["regress", "--shard", `${i}/${jobs}`, "--out", out];
        if (opts.plugin) args.push("--plugin", opts.plugin);
        if (opts.limit) args.push("--limit", String(opts.limit));
        return new Promise<string>((resolve, reject) => {
          const child = fork(bin, args, { stdio: ["ignore", "ignore", "inherit", "ipc"] });
          child.on("exit", (code) =>
            code === 0 ? resolve(out) : reject(new Error(`worker ${i} exited with ${code}`)),
          );
        });
      }),
    );
    const results: RegressResult[] = [];
    for (const f of files)
      results.push(...(JSON.parse(await readFile(f, "utf8")) as RegressResult[]));
    return finish(results, prep.table.version, outDir, log);
  }

  const ctx = await makeContext(prep, { force: true, offline: true });
  const results: RegressResult[] = [];
  let done = 0;
  await mapLimit(mine, 2, async (c) => {
    const dir = join(paths.generated, c.slug);
    try {
      const existing = JSON.parse(await readFile(join(dir, "profile.json"), "utf8")) as Profile;
      const known = await loadReleaseDocs(dir);
      const listing = prep.listing.get(c.row.repo.toLowerCase());
      const built = assemble(c, ctx, listing, existing, await gather(c, ctx, existing, known));
      // ATLAS_REGRESS_CARDS=<dir>: also write each rebuilt card and update line, to read them whole.
      const cards = process.env.ATLAS_REGRESS_CARDS;
      if (cards) {
        await mkdir(cards, { recursive: true });
        await writeFile(
          join(cards, `${c.slug}.json`),
          JSON.stringify(
            { trust: built.profile.trust, updates: built.profile.install?.updates ?? null },
            null,
            1,
          ),
        );
      }
      const before = snapshot(existing);
      const after = snapshot(built.profile);
      const fields = fieldDiff(existing, built.profile);
      results.push(
        stable(before) === stable(after) && fields.length === 0
          ? { slug: c.slug }
          : {
              slug: c.slug,
              change: {
                slug: c.slug,
                hidden: existing.listing.hiddenByDefault,
                downloads: existing.popularity.downloads ?? 0,
                before,
                after,
                fields,
              },
            },
      );
    } catch (error) {
      results.push({ slug: c.slug, error: (error as Error).message.slice(0, 300) });
    }
    if (++done % 100 === 0 && !opts.shard) log(`  ${done}/${mine.length}`);
  });
  if (opts.shard && opts.out) {
    await writeFile(opts.out, JSON.stringify(results));
    return results;
  }
  return finish(results, prep.table.version, outDir, log);
}

async function finish(
  results: RegressResult[],
  hostsVersion: string,
  outDir: string,
  log: (msg: string) => void,
): Promise<RegressResult[]> {
  results.sort((a, b) => a.slug.localeCompare(b.slug, "en"));
  await writeFile(join(outDir, "results.json"), `${JSON.stringify(results, null, 1)}\n`);
  const report = buildRegressReport(results, hostsVersion);
  await writeFile(join(outDir, "report.md"), report);
  const changes = results.filter((r) => r.change).length;
  const flips = results.filter((r) => r.change && r.change.before.label !== r.change.after.label);
  const errors = results.filter((r) => r.error).length;
  log(
    `${results.length} plugins: ${changes} changed (${flips.length} labels), ${errors} couldn't be rebuilt offline`,
  );
  log(`Report: ${join(outDir, "report.md")}`);
  return results;
}

const LABEL: Record<string, string> = {
  "high-concern": "Serious",
  "review-details": "Review",
  "low-concern": "Few",
  "insufficient-data": "Not enough data",
};
const short = (l: string | null) => (l ? (LABEL[l] ?? l) : "none");

function listDiff(before: string[], after: string[]): string {
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  return [...added.map((x) => `+${x}`), ...removed.map((x) => `-${x}`)].join(" ");
}

export function describeChange(c: Change): string[] {
  const b = c.before;
  const a = c.after;
  const out: string[] = [];
  if (b.dataSharingLabel !== a.dataSharingLabel)
    out.push(`data sharing: "${b.dataSharingLabel}" → "${a.dataSharingLabel}"`);
  const hosts = listDiff(b.hosts, a.hosts);
  if (hosts) out.push(`hosts: ${hosts}`);
  const observed = listDiff(b.observed, a.observed);
  if (observed) out.push(`seen when we ran it: ${observed}`);
  const badges = listDiff(b.badges, a.badges);
  if (badges) out.push(`badges: ${badges}`);
  if (b.transparency !== a.transparency)
    out.push(`transparency: "${b.transparency}" → "${a.transparency}"`);
  const drivers = listDiff(b.drivers, a.drivers);
  if (drivers) out.push(`rules: ${drivers}`);
  if (b.asset !== a.asset) out.push(`install file: ${b.asset} → ${a.asset}`);
  if (b.version !== a.version) out.push(`version: ${b.version} → ${a.version}`);
  if (b.autoUpdates !== a.autoUpdates) out.push(`updates: ${b.autoUpdates} → ${a.autoUpdates}`);
  if (b.scan !== a.scan) out.push(`scan: ${b.scan} → ${a.scan}`);
  if (b.tested !== a.tested) out.push(`tested: ${b.tested ?? "no"} → ${a.tested ?? "no"}`);
  if (b.compatibility !== a.compatibility)
    out.push(`compatibility: "${b.compatibility}" → "${a.compatibility}"`);
  if (b.worksWithCurrent !== a.worksWithCurrent)
    out.push(`works with current Zotero: ${b.worksWithCurrent} → ${a.worksWithCurrent}`);
  const shown = ["trust.overall", "trust.facets", "install.asset", "install.version"];
  const other = c.fields.filter((f) => !shown.includes(f) && f !== "scan.status");
  if (other.length) out.push(`other fields: ${other.join(", ")}`);
  return out;
}

export function buildRegressReport(results: RegressResult[], hostsVersion: string): string {
  const changes = results.map((r) => r.change).filter((c): c is Change => Boolean(c));
  const flips = changes.filter((c) => c.before.label !== c.after.label);
  const quiet = changes.filter((c) => c.before.label === c.after.label);
  const errors = results.filter((r) => r.error);
  const byDownloads = (x: Change, y: Change) =>
    y.downloads - x.downloads || x.slug.localeCompare(y.slug, "en");

  const matrix = new Map<string, Change[]>();
  for (const c of flips) {
    const key = `${short(c.before.label)} → ${short(c.after.label)}`;
    matrix.set(key, [...(matrix.get(key) ?? []), c]);
  }
  const lines: string[] = [
    "# Regression check",
    "",
    `Analyzer ${ANALYZER_VERSION}, hosts ${hostsVersion}. ${results.length} profiles rebuilt offline; ` +
      `${changes.length} changed, ${flips.length} of them in the overall label; ` +
      `${errors.length} couldn't be rebuilt.`,
    "",
  ];
  if (flips.length) {
    lines.push("## Label changes", "", "| Change | Plugins | Shown |", "|---|--:|--:|");
    for (const [k, cs] of [...matrix.entries()].sort((x, y) => y[1].length - x[1].length))
      lines.push(`| ${k} | ${cs.length} | ${cs.filter((c) => !c.hidden).length} |`);
    lines.push("");
    for (const [k, cs] of [...matrix.entries()].sort((x, y) => y[1].length - x[1].length)) {
      lines.push(`### ${k}`, "");
      for (const c of cs.sort(byDownloads)) {
        lines.push(
          `- **${c.slug}**${c.hidden ? " (hidden)" : ""}, ${c.downloads.toLocaleString("en")} downloads`,
        );
        for (const d of describeChange(c)) lines.push(`  - ${d}`);
      }
      lines.push("");
    }
  }
  if (quiet.length) {
    lines.push("## Same label, other changes", "");
    for (const c of quiet.sort(byDownloads)) {
      lines.push(
        `- **${c.slug}**${c.hidden ? " (hidden)" : ""} (${short(c.after.label)}), ${c.downloads.toLocaleString("en")} downloads`,
      );
      for (const d of describeChange(c)) lines.push(`  - ${d}`);
    }
    lines.push("");
  }
  if (errors.length) {
    lines.push("## Couldn't rebuild", "");
    for (const e of errors) lines.push(`- ${e.slug}: ${e.error}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
