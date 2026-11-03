import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fmtDate } from "./atlas.ts";

/**
 * "Changes to the checks": the table at the end of docs/methodology.md, newest first. The doc is
 * the one place it's written; How we grade shows it, and the grade log's "Our checks changed"
 * entries link to it.
 */
export interface CheckChange {
  date: string;
  analyzer: string;
  rules: string;
  what: string;
}

function methodologyFile(): string | null {
  for (let d = process.cwd(); ; d = dirname(d)) {
    const f = join(d, "docs", "methodology.md");
    if (existsSync(f)) return f;
    if (dirname(d) === d) return null;
  }
}

/** Table rows under "## Changes to the checks". Markdown links and code marks become plain text. */
export function parseCheckChanges(md: string): CheckChange[] {
  const start = md.indexOf("## Changes to the checks");
  if (start < 0) return [];
  const rows: CheckChange[] = [];
  for (const line of md.slice(start).split("\n").slice(1)) {
    if (line.startsWith("## ")) break;
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|([^|]*)\|([^|]*)\|(.*)\|\s*$/);
    if (!m) continue;
    const what = m[4]
      .trim()
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1");
    rows.push({ date: m[1], analyzer: m[2].trim(), rules: m[3].trim(), what });
  }
  return rows;
}

let cache: (CheckChange & { shown: string })[] | null = null;
export function checkChanges(): (CheckChange & { shown: string })[] {
  if (cache) return cache;
  const f = methodologyFile();
  cache = (f ? parseCheckChanges(readFileSync(f, "utf8")) : []).map((c) => ({
    ...c,
    shown: fmtDate(c.date),
  }));
  return cache;
}
