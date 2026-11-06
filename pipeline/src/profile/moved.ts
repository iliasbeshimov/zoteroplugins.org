import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginProfile as Profile } from "@atlas/schema";

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

/** GitHub's answer for a repo: its HTTP status and, when it answered, its current owner/name. */
export interface RepoAnswer {
  status: number;
  name: string | null;
}

/** GitHub answers these for a repository that's deleted, made private or taken down. */
const GONE = new Set([404, 410, 451]);

/**
 * Cards whose repo the census no longer lists, asked about by name: one GitHub now answers under
 * another name that has a card has moved; one GitHub says is gone was removed (its page stays,
 * hidden, with no install: D47). Anything else (no answer, a rate limit, a repo that's still there
 * under its name) leaves the card as it is.
 */
export async function followLostCards(
  cards: { slug: string; repo: string }[],
  inCensus: Set<string>,
  lookup: (repo: string) => Promise<RepoAnswer>,
  date: string,
): Promise<{ moves: Moved[]; removed: string[] }> {
  const slugOf = new Map(cards.map((c) => [c.repo.toLowerCase(), c.slug]));
  const moves: Moved[] = [];
  const removed: string[] = [];
  for (const c of cards) {
    if (inCensus.has(c.repo.toLowerCase())) continue;
    const r = await lookup(c.repo);
    if (GONE.has(r.status)) {
      removed.push(c.slug);
      continue;
    }
    if (r.status !== 200 || !r.name || r.name.toLowerCase() === c.repo.toLowerCase()) continue;
    const target = slugOf.get(r.name.toLowerCase());
    if (!target || target === c.slug) continue;
    moves.push({ from: c.repo, to: r.name, slug: c.slug, target, date });
  }
  return { moves, removed };
}

/**
 * Marks the cards whose repo is gone: hidden from lists and counts as "removed", with the day we
 * found it gone. A card already marked keeps its first date. Returns the slugs newly marked.
 */
export async function markRemoved(
  generatedDir: string,
  slugs: string[],
  date: string,
): Promise<string[]> {
  const marked: string[] = [];
  for (const slug of slugs) {
    const file = join(generatedDir, slug, "profile.json");
    let p: Profile;
    try {
      p = JSON.parse(await readFile(file, "utf8")) as Profile;
    } catch {
      continue;
    }
    if (p.removed) continue;
    p.removed = { since: date };
    p.listing = { ...p.listing, hiddenByDefault: true, hiddenReason: "removed" };
    await writeFile(file, `${JSON.stringify(p, null, 1)}\n`);
    marked.push(slug);
  }
  return marked;
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

/**
 * Removes the cards of repos found not to be Zotero plugins (listing.ts, not-plugins.json): they
 * leave the site rather than staying up hidden, since they were never plugins. Returns the slugs.
 */
export async function dropCards(
  generatedDir: string,
  cards: { slug: string; repo: string }[],
  notPlugins: ReadonlySet<string>,
): Promise<string[]> {
  const gone = cards.filter((c) => notPlugins.has(c.repo.toLowerCase())).map((c) => c.slug);
  for (const slug of gone) await rm(join(generatedDir, slug), { recursive: true, force: true });
  return gone.sort();
}
