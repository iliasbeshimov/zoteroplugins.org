import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Growth } from "./shelves.ts";

/**
 * How many copies of Zotero have a plugin, estimated from the census history
 * (data/census/history/YYYY-MM.csv, one row per plugin per day).
 *
 * Zotero downloads each new version of a plugin once for every copy that has it installed, so the
 * downloads of a single release follow the number of copies in use. All-time downloads don't: they
 * add up every update, so a plugin that releases weekly counts each user dozens of times.
 *
 * For each plugin we take the most-downloaded release seen in the last WINDOW_DAYS, so a release
 * that came out yesterday doesn't hide the one before it. It counts low for plugins that update
 * from somewhere other than GitHub releases, and for those that release so often that people skip
 * versions; a release that has been out for years also gathers new installs. It's an estimate for
 * ranking, shown rounded.
 */
const WINDOW_DAYS = 60;

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

/** Field `i` of a row, "" when the column or the field is missing. */
const field = (r: string[], i: number | undefined): string => (i === undefined ? "" : (r[i] ?? ""));

/** owner/repo in lower case → the estimate. Empty when there is no history. */
export function loadUsage(historyDir: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(historyDir)) return out;
  // Monthly files, newest last; two or three cover the window.
  const files = readdirSync(historyDir)
    .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f))
    .sort()
    .slice(-3);
  const rows: string[][] = [];
  let latest = "";
  let cols: Record<string, number> = {};
  for (const f of files) {
    const [head, ...lines] = readFileSync(`${historyDir}/${f}`, "utf8").split(/\r?\n/);
    const names = splitCsv(head ?? "");
    const at = Object.fromEntries(names.map((n, i) => [n, i]));
    if (!("repo" in at && "date" in at && "latest_tag" in at && "latest_downloads" in at)) continue;
    cols = at;
    for (const l of lines) {
      if (!l) continue;
      const r = splitCsv(l);
      // Columns can change between months: keep each row with its own file's positions.
      const date = field(r, at.date);
      rows.push([date, field(r, at.repo), field(r, at.latest_tag), field(r, at.latest_downloads)]);
      if (date > latest) latest = date;
    }
  }
  if (!latest || !Object.keys(cols).length) return out;
  const since = day(latest) - WINDOW_DAYS * 86_400_000;
  // repo → tag → the most downloads seen for that release.
  const perTag = new Map<string, Map<string, number>>();
  for (const [date = "", repo, tag, dl] of rows) {
    if (!repo || !tag || day(date) < since) continue;
    const n = Number(dl);
    if (!Number.isFinite(n)) continue;
    const k = repo.toLowerCase();
    const tags = perTag.get(k) ?? new Map<string, number>();
    tags.set(tag, Math.max(tags.get(tag) ?? 0, n));
    perTag.set(k, tags);
  }
  for (const [k, tags] of perTag) out.set(k, Math.max(...tags.values()));
  return out;
}

/** 572,471 → "570k", 1,234,567 → "1.2M", 9,876 → "9.9k", 840 → "840": two significant figures. */
export function fmtUse(n: number): string {
  if (n < 1000) return String(n < 100 ? n : Math.round(n / 10) * 10);
  const r = Number(n.toPrecision(2));
  if (r >= 1_000_000) return `${(r / 1_000_000).toString()}M`;
  return `${(r / 1000).toString()}k`;
}

/**
 * owner/repo in lower case → how many stars and downloads it gained between its last row on or
 * before `days` before the newest date and its newest row. A repository without a row that old
 * (new to the census, or history shorter than `days`) has no entry.
 */
export function loadGrowth(historyDir: string, days: number): Map<string, Growth> {
  const out = new Map<string, Growth>();
  if (!existsSync(historyDir)) return out;
  const files = readdirSync(historyDir)
    .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f))
    .sort()
    .slice(-3);
  // repo → [date, stars, downloads] rows.
  const byRepo = new Map<string, [string, number, number][]>();
  let latest = "";
  for (const f of files) {
    const [head, ...lines] = readFileSync(`${historyDir}/${f}`, "utf8").split(/\r?\n/);
    const at = Object.fromEntries(splitCsv(head ?? "").map((n, i) => [n, i]));
    if (!("repo" in at && "date" in at && "stars" in at && "downloads" in at)) continue;
    for (const l of lines) {
      if (!l) continue;
      const r = splitCsv(l);
      const repo = field(r, at.repo);
      const date = field(r, at.date);
      const stars = Number(field(r, at.stars));
      const dl = Number(field(r, at.downloads));
      if (!repo || field(r, at.stars) === "" || !Number.isFinite(stars) || !Number.isFinite(dl))
        continue;
      const k = repo.toLowerCase();
      const rows = byRepo.get(k) ?? [];
      rows.push([date, stars, dl]);
      byRepo.set(k, rows);
      if (date > latest) latest = date;
    }
  }
  if (!latest) return out;
  const cut = day(latest) - days * 86_400_000;
  for (const [k, rows] of byRepo) {
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    const now = rows[rows.length - 1];
    const then = rows.filter((r) => day(r[0]) <= cut).pop();
    if (!now || !then) continue;
    out.set(k, { stars: now[1] - then[1], downloads: now[2] - then[2] });
  }
  return out;
}
