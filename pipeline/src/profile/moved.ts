import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Cards for repos that moved on GitHub. A renamed or transferred repo leaves the census under its
 * old name and comes back under its new one with a card of its own, so the old card stays up as a
 * duplicate (zotero-local-dictionary and zotero-local-mdx-click both became
 * Noahxie83/zotero-lexibridge). When GitHub answers the old name with a repo that has a card, the
 * old card goes and its addresses redirect to the new one (the site writes them to _redirects).
 */
export interface Moved {
  /** The repo the old card was for, as its card recorded it. */
  from: string;
  /** Where GitHub sends that name now. */
  to: string;
  /** The old card's slug, whose addresses redirect... */
  slug: string;
  /** ...to this card's. */
  target: string;
  /** When we found it (YYYY-MM-DD). */
  date: string;
}

export interface Redirects {
  schemaVersion: 1;
  moved: Moved[];
}

export const REDIRECTS_FILE = "redirects.json";

/**
 * Old cards whose repo GitHub now answers under another name that has a card. Only repos the
 * census no longer lists are asked about. `currentName` gives GitHub's owner/name for a repo, or
 * null when it's gone or GitHub didn't answer.
 */
export async function findMoved(
  cards: { slug: string; repo: string }[],
  inCensus: Set<string>,
  currentName: (repo: string) => Promise<string | null>,
  date: string,
): Promise<Moved[]> {
  const slugOf = new Map(cards.map((c) => [c.repo.toLowerCase(), c.slug]));
  const out: Moved[] = [];
  for (const c of cards) {
    if (inCensus.has(c.repo.toLowerCase())) continue;
    const now = await currentName(c.repo);
    if (!now || now.toLowerCase() === c.repo.toLowerCase()) continue;
    const target = slugOf.get(now.toLowerCase());
    if (!target || target === c.slug) continue;
    out.push({ from: c.repo, to: now, slug: c.slug, target, date });
  }
  return out;
}

export async function readRedirects(generatedDir: string): Promise<Redirects> {
  try {
    const r = JSON.parse(await readFile(join(generatedDir, REDIRECTS_FILE), "utf8")) as Redirects;
    return { schemaVersion: 1, moved: r.moved ?? [] };
  } catch {
    return { schemaVersion: 1, moved: [] };
  }
}

/**
 * Adds the moves to the redirects file and removes the old cards. A slug that already redirected
 * to a card that has now moved too redirects straight to the newest one.
 */
export async function applyMoved(generatedDir: string, moves: Moved[]): Promise<Redirects> {
  const r = await readRedirects(generatedDir);
  if (!moves.length) return r;
  const bySlug = new Map(r.moved.map((m) => [m.slug, m]));
  for (const m of moves) bySlug.set(m.slug, m);
  const final = (slug: string, seen = new Set<string>()): string => {
    const next = bySlug.get(slug);
    if (!next || seen.has(slug)) return slug;
    seen.add(slug);
    return final(next.target, seen);
  };
  const moved = [...bySlug.values()]
    .map((m) => ({ ...m, target: final(m.target, new Set([m.slug])) }))
    .sort((a, b) => a.slug.localeCompare(b.slug, "en"));
  const out: Redirects = { schemaVersion: 1, moved };
  await writeFile(join(generatedDir, REDIRECTS_FILE), `${JSON.stringify(out, null, 1)}\n`);
  for (const m of moves) await rm(join(generatedDir, m.slug), { recursive: true, force: true });
  return out;
}
