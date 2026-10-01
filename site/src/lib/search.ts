import MiniSearch, { type Options, type SearchOptions } from "minisearch";
import { stemmer } from "stemmer";

/**
 * The browse page's search: ranked (BM25) rather than "every word must appear", with stemming,
 * British spellings, a Zotero synonym list, prefix and typo tolerance, and Chinese bigrams. The
 * same module builds the index at build time (search.json) and runs in the browser, so the two
 * sides always tokenize the same way. Documents are the plugin's own words (name, repository,
 * descriptions, topics, jobs) plus the "ways people ask" phrases in data/search/phrases.json.
 */

/** One plugin as the search sees it; served as /search.json. */
export interface SearchDoc {
  slug: string;
  name: string;
  repo: string;
  /** GitHub and manifest descriptions. */
  desc: string;
  /** The plain-language summary, when one is written. */
  does: string;
  topics: string;
  /** Job titles, e.g. "Citing & writing". */
  jobs: string;
  /** How people ask for it, from data/search/phrases.json. */
  ask: string;
  /** Downloads, a mild tie-breaker. */
  dl: number;
}

/** A pasted repository link becomes its owner/name: "https://github.com/Owner/repo/releases" → "Owner/repo". */
export const unlink = (q: string) =>
  q.replace(
    /(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}\/+([^/\s#?]+)(?:\/+([^/\s#?]+))?\S*/gi,
    (_, owner: string, name?: string) => (name ? `${owner}/${name}` : owner).replace(/\.git$/, ""),
  );

/** Words that say nothing about which plugin is meant. */
const STOP = new Set(
  (
    "a an the to in on at of for with and or my me i we you your it its is are be can do does how " +
    "want need would like something that this these those into from by as up out all any some " +
    "zotero plugin plugins addon addons add-on extension extensions tool tools http https www"
  ).split(" "),
);

/**
 * Synonym groups: a document term indexes every word of its group, so a query with any of them
 * matches. Keep them narrow; a broad group makes everything match everything.
 */
const SYNONYMS: string[][] = [
  ["summarize", "summary", "summarise", "digest", "tldr"],
  ["annotation", "annotate", "highlight", "highlights", "markup"],
  ["note", "notes", "markdown", "md"],
  ["cite", "citation", "citekey", "cite-key"],
  ["bibliography", "bib", "bibtex", "biblatex"],
  ["latex", "tex", "overleaf"],
  ["word", "docx", "msword", "libreoffice"],
  ["theme", "skin", "appearance", "colour", "color"],
  ["dark", "night"],
  ["tag", "tags", "label", "labels"],
  ["ai", "llm", "gpt", "chatgpt", "assistant", "chatbot"],
  ["chat", "ask", "question"],
  ["translate", "translation", "translator"],
  ["sync", "synchronize", "synchronise", "backup"],
  ["cloud", "webdav", "dropbox", "onedrive", "nextcloud", "nutstore"],
  ["rename", "renaming", "filename", "filenames"],
  ["attachment", "attachments", "pdf", "pdfs"],
  ["download", "fetch", "retrieve", "grab"],
  ["search", "find", "lookup", "discover"],
  ["duplicate", "duplicates", "dedupe", "deduplicate", "merge"],
  ["folder", "directory", "subfolder"],
  ["read", "reader", "reading", "viewer"],
  ["auto", "automatic", "automatically", "automate"],
  ["export", "output"],
  ["import", "ingest"],
  ["preview", "quicklook", "thumbnail"],
  ["shortcut", "shortcuts", "hotkey", "hotkeys", "keyboard", "keybinding"],
  ["style", "csl"],
  ["metadata", "fields", "field"],
  ["doi", "identifier", "identifiers"],
  ["journal", "venue", "publication"],
  ["impact", "if", "jcr", "ranking", "rank"],
  ["statistics", "stats", "chart", "charts", "graph", "visualize", "visualise", "dashboard"],
  ["count", "counts", "wordcount"],
  ["kindle", "ereader", "e-reader", "remarkable", "tablet"],
  ["obsidian", "logseq", "notion", "roam", "zettelkasten"],
  ["chinese", "cnki", "中文", "知网"],
  ["scihub", "sci-hub", "libgen", "fulltext", "full-text"],
  ["retracted", "retraction", "retractions", "withdrawn"],
  ["abstract", "abstracts"],
  ["mobile", "phone", "ipad", "android", "ios"],
];

const HAN = /\p{Script=Han}/u;

/** Lower-case words; Chinese runs become overlapping bigrams so a 2-character query finds them. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}+#-]+/u)) {
    if (!raw) continue;
    if (!HAN.test(raw)) {
      out.push(raw);
      continue;
    }
    for (const part of raw.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []) {
      if (!HAN.test(part)) out.push(part);
      else {
        const chars = Array.from(part);
        if (chars.length === 1) out.push(part);
        for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
      }
    }
  }
  return out;
}

/** British → American before stemming, so "summarise" and "summarize" share a stem. */
const american = (t: string) =>
  t.length < 5
    ? t
    : t
        .replace(/is(e|ed|es|ing|ation|ations)$/, "iz$1")
        .replace(/ys(e|ed|es|ing)$/, "yz$1")
        .replace(/our(s?)$/, "or$1")
        .replace(/ogue$/, "og");

/** The indexable form of a word, or null for a stop word. */
export function stem(term: string): string | null {
  const t = term.toLowerCase();
  if (STOP.has(t) || t.length < 2) return null;
  if (HAN.test(t)) return t;
  const parts = t.split("-").filter(Boolean);
  if (parts.length > 1) return parts.map((p) => stemmer(american(p))).join("");
  return stemmer(american(t));
}

const SYNONYM_OF = new Map<string, string[]>();
for (const group of SYNONYMS) {
  const stems = [...new Set(group.map((w) => stem(w)).filter((s): s is string => !!s))];
  for (const s of stems) SYNONYM_OF.set(s, [...new Set([...(SYNONYM_OF.get(s) ?? []), ...stems])]);
}

/** Indexing: a term plus its synonyms, so any word of the group finds the document. */
const indexTerm = (term: string): string[] | null => {
  const s = stem(term);
  if (!s) return null;
  const syn = SYNONYM_OF.get(s);
  return syn ? [s, ...syn.filter((x) => x !== s)] : [s];
};

const FIELDS: (keyof SearchDoc)[] = ["name", "ask", "jobs", "repo", "does", "desc", "topics"];
const BOOST: Partial<Record<keyof SearchDoc, number>> = {
  name: 5,
  ask: 3,
  jobs: 2,
  repo: 2,
  does: 1.5,
  desc: 1,
  topics: 1,
};

const OPTIONS: Options<SearchDoc> = {
  idField: "slug",
  fields: FIELDS,
  storeFields: ["dl"],
  tokenize,
  processTerm: indexTerm,
};

const QUERY: SearchOptions = {
  tokenize,
  processTerm: (t) => stem(t),
  boost: BOOST,
  prefix: (t) => t.length >= 3,
  fuzzy: (t) => (t.length >= 5 ? 0.2 : false),
  combineWith: "OR",
  // Popular plugins win ties: a 1M-download plugin scores about 30% over an unknown one.
  boostDocument: (_id, _term, stored) => 1 + Math.log10(1 + Number(stored?.dl ?? 0)) / 20,
};

export type SearchIndex = MiniSearch<SearchDoc>;

export function createIndex(docs: SearchDoc[]): SearchIndex {
  const index = new MiniSearch<SearchDoc>(OPTIONS);
  index.addAll(docs);
  return index;
}

export interface Hit {
  slug: string;
  score: number;
}

/** Hits scoring under this share of the best hit are noise ("pdf" alone against "chat with my pdf"). */
const FLOOR = 0.15;

/**
 * Ranked hits for a query, or null when the query has no searchable words (show everything).
 * A plugin must match at least half of the query's words ("chat with my pdf" needs "chat" or
 * "pdf", not both; a one-word brush with a six-word question isn't a hit) and score at least
 * FLOOR of the best hit.
 */
export function search(index: SearchIndex, query: string): Hit[] | null {
  const q = unlink(query);
  const words = tokenize(q).filter((t) => stem(t));
  if (!words.length) return null;
  const distinct = [...new Set(words)];
  const need = Math.ceil(distinct.length / 2);
  let covered: Map<string, number> | null = null;
  if (distinct.length > 1) {
    covered = new Map();
    for (const w of distinct)
      for (const r of index.search(w, QUERY)) covered.set(r.id, (covered.get(r.id) ?? 0) + 1);
  }
  const hits = index
    .search(q, QUERY)
    .filter((r) => !covered || (covered.get(r.id) ?? 0) >= need)
    .map((r) => ({ slug: r.id as string, score: r.score }));
  const floor = (hits[0]?.score ?? 0) * FLOOR;
  return hits.filter((h) => h.score >= floor);
}
