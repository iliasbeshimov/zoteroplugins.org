import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ROOT } from "./atlas.ts";

/**
 * A repository's GitHub stars over the last weeks, from the census history
 * (data/census/history/YYYY-MM.csv, one row per plugin per census day). Shown on plugin pages
 * next to ratings until a version has enough ratings of its own. Stars never feed the grade.
 */
export const STAR_DAYS = 42;

export interface StarHistory {
  /** Stars on the newest census day. */
  now: number;
  /** Stars gained (or lost) since the last row on or before STAR_DAYS earlier; null without one. */
  gain: number | null;
  /** [ISO date, stars] from the first row in the window to the newest, oldest first. */
  points: [string, number][];
}

/** One CSV line into fields; fields may be quoted, with "" for a quote. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Each repository's [date, stars] rows (owner/repo in lower case), oldest first, and the newest date. */
export interface StarRows {
  latest: string;
  byRepo: Map<string, [string, number][]>;
}

/** Reads the last three months of census history from `dir`. */
export function readStarRows(dir: string): StarRows {
  const byRepo = new Map<string, [string, number][]>();
  let latest = "";
  if (!existsSync(dir)) return { latest, byRepo };
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f))
    .sort()
    .slice(-3);
  for (const f of files) {
    const [head, ...lines] = readFileSync(`${dir}/${f}`, "utf8").split(/\r?\n/);
    const at = Object.fromEntries(splitCsv(head ?? "").map((n, i) => [n, i]));
    if (!("repo" in at && "date" in at && "stars" in at)) continue;
    for (const l of lines) {
      if (!l) continue;
      const r = splitCsv(l);
      const repo = r[at.repo] ?? "";
      const date = r[at.date] ?? "";
      const raw = r[at.stars] ?? "";
      const stars = Number(raw);
      if (!repo || !date || raw === "" || !Number.isFinite(stars)) continue;
      const k = repo.toLowerCase();
      const rows = byRepo.get(k) ?? [];
      rows.push([date, stars]);
      byRepo.set(k, rows);
      if (date > latest) latest = date;
    }
  }
  for (const rows of byRepo.values()) rows.sort((a, b) => a[0].localeCompare(b[0]));
  return { latest, byRepo };
}

/** owner/repo's stars over the last STAR_DAYS days; null when the newest census has no row for it. */
export function historyOf({ latest, byRepo }: StarRows, repo: string): StarHistory | null {
  const rows = byRepo.get(repo.toLowerCase());
  const last = rows?.[rows.length - 1];
  // Only a repository still in the newest census: an old row would show a stale count.
  if (!rows || !last || last[0] !== latest) return null;
  const cut = day(latest) - STAR_DAYS * 86_400_000;
  const start = rows.filter((r) => day(r[0]) <= cut).pop();
  const points = rows.filter((r) => day(r[0]) >= (start ? day(start[0]) : cut));
  return { now: last[1], gain: start ? last[1] - start[1] : null, points };
}

let cache: StarRows | null = null;

/** The plugin's star history from data/census/history. */
export function starHistory(repo: string): StarHistory | null {
  if (!cache) cache = readStarRows(`${ROOT}census/history`);
  return historyOf(cache, repo);
}

/** A sparkline's path through the points, in a w × h box with `pad` px kept free at top and bottom. */
export function sparkPath(points: [string, number][], w: number, h: number, pad = 4): string {
  if (points.length < 2) return "";
  const t0 = day(points[0][0]);
  const span = day(points[points.length - 1][0]) - t0 || 1;
  const vals = points.map((p) => p[1]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const range = hi - lo || 1;
  return points
    .map(([d, v], i) => {
      const x = ((day(d) - t0) / span) * w;
      // A flat line sits in the middle rather than on the floor.
      const y = hi === lo ? h / 2 : pad + (1 - (v - lo) / range) * (h - 2 * pad);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
