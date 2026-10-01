import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bySlug, fmtDate, type Grade, RANK } from "./atlas.ts";

/**
 * The public log of grade changes, newest first. The pipeline doesn't write it yet (only the latest
 * release of each plugin is graded today), so until data/generated/grade-log.json exists
 * the log is empty and the pages say so.
 */
export interface GradeChange {
  slug: string;
  name: string;
  version: string;
  date: string;
  month: string;
  from: Grade | null;
  to: Grade;
  why: string;
  dir: "new" | "up" | "down";
}

interface RawChange {
  slug: string;
  version: string;
  date: string;
  from: Grade | null;
  to: Grade;
  why: string;
}

function logFile(): string | null {
  for (let d = process.cwd(); ; d = dirname(d)) {
    const f = join(d, "data", "generated", "grade-log.json");
    if (existsSync(f)) return f;
    if (dirname(d) === d) return null;
  }
}

let cache: GradeChange[] | null = null;
export function gradeLog(): GradeChange[] {
  if (cache) return cache;
  const f = logFile();
  const raw: RawChange[] = f ? JSON.parse(readFileSync(f, "utf8")) : [];
  const plugins = bySlug();
  cache = raw
    .filter((c) => plugins[c.slug])
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((c) => {
      const d = new Date(c.date);
      return {
        ...c,
        name: plugins[c.slug].name,
        date: fmtDate(c.date),
        month: d.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
        dir: !c.from ? "new" : RANK[c.to] > RANK[c.from] ? "up" : "down",
      };
    });
  return cache;
}
