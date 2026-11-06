import { readFile, writeFile } from "node:fs/promises";
import { PublicRatings } from "@atlas/schema";
import { RATINGS_FILE } from "./catalog.ts";

/**
 * `atlas ratings`: the published ratings from zoteroatlas.com into data/generated/ratings.json, for
 * the catalogue (writeCatalog reads it) and the site's plugin pages. The file is the
 * server's public one, checked against the schema; when the server can't be reached or answers
 * something else, the file we have is kept, so a bad night never empties the ratings.
 */
export const RATINGS_URL = "https://zoteroatlas.com/api/v1/ratings.json";

export async function fetchRatings(
  userAgent: string,
  log: (msg: string) => void = console.log,
): Promise<boolean> {
  let body: unknown;
  try {
    const res = await fetch(RATINGS_URL, {
      headers: { accept: "application/json", "user-agent": userAgent },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (e) {
    log(`Ratings not fetched (${(e as Error).message}); keeping the file we have.`);
    return false;
  }
  const parsed = PublicRatings.safeParse(body);
  if (!parsed.success) {
    log(`Ratings from ${RATINGS_URL} don't match the schema; keeping the file we have.`);
    return false;
  }
  const text = serializeRatings(parsed.data);
  let before = "";
  try {
    before = await readFile(RATINGS_FILE, "utf8");
  } catch {
    before = "";
  }
  // generatedAt changes every time; write only when a rating did, so a quiet night is no commit.
  const strip = (t: string) => t.replace(/"generatedAt":"[^"]*"/, "");
  if (strip(before) === strip(text)) {
    log("Ratings unchanged.");
    return true;
  }
  await writeFile(RATINGS_FILE, text);
  const n = Object.values(parsed.data.plugins).reduce((sum, p) => sum + p.all.count, 0);
  log(`Wrote ${n} ratings of ${Object.keys(parsed.data.plugins).length} plugins to ratings.json`);
  return true;
}

/** The header on one line, then one plugin per line, so a day's changes read as a diff. */
export function serializeRatings(r: PublicRatings): string {
  const slugs = Object.keys(r.plugins).sort();
  const lines = slugs.map((s) => `${JSON.stringify(s)}:${JSON.stringify(r.plugins[s])}`);
  return `{"generatedAt":${JSON.stringify(r.generatedAt)},"plugins":{\n${lines.join(",\n")}\n}}\n`;
}
