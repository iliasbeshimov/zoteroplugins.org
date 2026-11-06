import { allPlugins, type Plugin, RANK, shownPlugins } from "./atlas.ts";
import { stem, tokenize } from "./search.ts";

/**
 * "Other plugins that do this" on a plugin page: plugins for the same job, matched on what they do.
 * A candidate shares a job category with the plugin and its text is close to the plugin's: TF-IDF
 * cosine over descriptions, summary, "ways people ask" phrases (counted double) and GitHub topics.
 * It's shown only when it also works with the current Zotero, is graded B or better (A or better
 * for a plugin graded A or A+), isn't a copy or fork of the plugin (those are under "Forks and
 * copies"), and has some users. Closest match first, at most three.
 */
export interface Similar {
  p: Plugin;
  /** Cosine similarity to the plugin, 0 to 1. */
  score: number;
  /** The candidate's search phrase that shares most words with the plugin: why it's here. */
  matched: string;
  /** What it offers that the plugin doesn't, at most two. */
  labels: string[];
}

/** Below this a match is a shared word or two, not the same job. */
const MIN_SCORE = 0.28;
/** A match also has to be at least this share of the closest one, so a weak tail drops off. */
const MIN_SHARE = 0.5;
/** Plugins with fewer downloads are mostly days-old experiments. */
const MIN_DOWNLOADS = 50;
const MAX_SHOWN = 3;

/** Words every plugin's text uses, so they say nothing about the job. */
const GENERIC = new Set([
  "zotero",
  "plugin",
  "addon",
  "add-on",
  "extens",
  "tool",
  "librari",
  "item",
  "support",
  "simpl",
]);
const terms = (text: string) =>
  tokenize(text)
    .map((w) => stem(w))
    .filter((w): w is string => !!w && w.length > 1 && !GENERIC.has(w) && !/^\d+$/.test(w));

let vectors: Map<string, Map<string, number>> | null = null;
/** Unit-length TF-IDF vectors for every plugin, built once per build. */
function vectorsBySlug(): Map<string, Map<string, number>> {
  if (vectors) return vectors;
  const bags = new Map<string, Map<string, number>>();
  for (const p of allPlugins()) {
    const bag = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const t of terms(text)) bag.set(t, (bag.get(t) ?? 0) + weight);
    };
    add(p.search.desc, 1);
    add(p.search.does, 1);
    add(p.search.ask, 2);
    add(p.search.topics, 0.5);
    bags.set(p.slug, bag);
  }
  const df = new Map<string, number>();
  for (const bag of bags.values()) for (const t of bag.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = bags.size;
  vectors = new Map();
  for (const [slug, bag] of bags) {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, tf] of bag) {
      const w = (1 + Math.log(tf)) * Math.log(n / (df.get(t) ?? 1));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    vectors.set(slug, v);
  }
  return vectors;
}

function cosine(a: Plugin, b: Plugin): number {
  const vs = vectorsBySlug();
  const x = vs.get(a.slug);
  const y = vs.get(b.slug);
  if (!x || !y) return 0;
  let s = 0;
  for (const [t, w] of x) s += w * (y.get(t) ?? 0);
  return s;
}

/** A name or repository name without the words every Zotero plugin has. */
const core = (s: string) => s.toLowerCase().replace(/zotero|plugin|for|[^a-z0-9]/g, "");
const repoCore = (repo: string) => core(repo.split("/").pop() ?? "");

/** The same plugin under another name: a fork, a copy that kept its ID or name, or its repo renamed. */
function isCopy(p: Plugin, x: Plugin): boolean {
  if (p.addonId && p.addonId === x.addonId) return true;
  if (x.forkOf?.slug === p.slug || p.forkOf?.slug === x.slug) return true;
  if (p.forkOf?.slug && p.forkOf.slug === x.forkOf?.slug) return true;
  if (core(p.name).length > 3 && core(x.name) === core(p.name)) return true;
  const a = repoCore(p.repo);
  const b = repoCore(x.repo);
  return (a.length > 5 && b.includes(a)) || (b.length > 5 && a.includes(b));
}

function matchedPhrase(p: Plugin, x: Plugin): string {
  const mine = new Set(terms(`${p.search.ask} ${p.search.desc} ${p.search.does}`));
  let best = "";
  let most = 0;
  for (const phrase of x.search.ask.split("; ")) {
    const shared = new Set(terms(phrase).filter((t) => mine.has(t))).size;
    if (shared > most) {
      most = shared;
      best = phrase;
    }
  }
  return best;
}

function labels(p: Plugin, x: Plugin): string[] {
  const out: string[] = [];
  if (!p.currentOk && x.currentOk) out.push(`Works with Zotero ${x.currentMajor}`);
  if (p.keyNeed === "required" && x.keyNeed === "none") out.push("No API key needed");
  if (!p.localModel && x.localModel) out.push("Can use a local model");
  if (p.maintStatus !== "active" && x.maintStatus === "active") out.push("Actively maintained");
  return out.slice(0, 2);
}

/** The lowest grade worth suggesting next to this plugin: B, or A when the plugin itself is A or A+. */
export const similarFloor = (p: Plugin) => (RANK[p.grade] >= RANK.A ? "A" : "B");

/** Plugins that do the same job as `p` and pass the bar, closest first; `total` counts all that pass. */
export function similarPlugins(p: Plugin, n = MAX_SHOWN): { shown: Similar[]; total: number } {
  const floor = RANK[similarFloor(p)];
  const sameJob = shownPlugins()
    .filter((x) => x.slug !== p.slug && !x.retired && x.jobs.some((j) => p.jobs.includes(j)))
    .map((x) => ({ x, score: cosine(p, x), copy: isCopy(p, x) }));
  const best = Math.max(0, ...sameJob.filter((c) => !c.copy).map((c) => c.score));
  const passing = sameJob
    .filter(
      (c) =>
        !c.copy &&
        c.score >= MIN_SCORE &&
        c.score >= MIN_SHARE * best &&
        c.x.currentOk &&
        RANK[c.x.grade] >= floor &&
        c.x.downloadsN >= MIN_DOWNLOADS,
    )
    .sort((a, b) => b.score - a.score);
  return {
    shown: passing.slice(0, n).map((c) => ({
      p: c.x,
      score: c.score,
      matched: matchedPhrase(p, c.x),
      labels: labels(p, c.x),
    })),
    total: passing.length,
  };
}
