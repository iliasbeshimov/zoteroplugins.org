import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allPlugins, CURRENT_ZOTERO_MAJOR, type Plugin, ROOT } from "./atlas.ts";

/**
 * What the guide check (zotero-atlas/server/guides.js) needs to know about every plugin we have a
 * card for, listed or not: a library guide may link a fork, a Zotero 6 plugin or one that's gone.
 * Served as /data/guide-index.json and fetched by the server, so it changes with every build.
 */
export interface GuideIndexPlugin {
  /** Card slug. */
  s: string;
  /** Display name. */
  n: string;
  /** GitHub owner/name, lower case. */
  r: string;
  /** Zotero Plugins grade. */
  g: string;
  /** Why it has that grade, as on its card. */
  b: string;
  /** removed | retired | z6 | notcur | norelease | ok: the first that applies. */
  st: string;
  /** Its repository is archived (it may still work). */
  ar?: 1;
  /** Zotero versions it works with, e.g. "8–10, 11 beta". */
  w: string;
  /** Downloads, to pick between plugins with the same name. */
  d: number;
  /** Names a guide might use for it without a link; only for well-known, distinctive names. */
  al?: string[];
  /** The plugin its developer points to, when retired. */
  alt?: { n: string; s: string | null };
  /** Its repository holds several plugins, so a link to the repository doesn't say which one. */
  mp?: 1;
}

/** Repositories that hold more than one plugin; our card is for one of them. */
const MULTI_PLUGIN_REPOS = new Set(["dcartertod/zotero-plugins"]);

export interface GuideIndex {
  generatedAt: string;
  currentMajor: number;
  /** Repositories renamed or transferred on GitHub, lower case: old owner/name -> card slug. */
  moved: Record<string, string>;
  plugins: GuideIndexPlugin[];
}

function status(p: Plugin): string {
  if (p.removed) return "removed";
  if (p.retired) return "retired";
  if (p.legacy) return "z6";
  if (p.noRelease) return "norelease";
  if (!p.currentOk) return "notcur";
  return "ok";
}

/**
 * Names a guide might use for a plugin without linking it, matched exactly as written (case and
 * all) as whole words. Kept by hand, for well-known plugins only: a generated list matched
 * ordinary phrases ("Zotero plugins", "Open PDF"), and a guide check that names the wrong plugin
 * is worse than one that misses a mention. Linked plugins are always found by their repository.
 */
const NAMED: Record<string, string[]> = {
  "zotero-better-bibtex": ["Better BibTeX", "Better BibTex", "Better Bibtex", "BetterBibTeX"],
  "zotero-better-notes": ["Better Notes"],
  "zotero-pdf-translate": ["Translate for Zotero", "Zotero PDF Translate", "PDF Translate"],
  "zotero-reference": ["Ethereal Reference"],
  "zotero-style": ["Ethereal Style"],
  "zotero-addons": ["Add-on Market", "Addon Market"],
  "zotero-format-metadata": ["Linter for Zotero", "Zotero Linter"],
  "zotero-attanger": ["Attanger"],
  "zotero-actions-tags": ["Actions & Tags", "Actions and Tags"],
  zotfile: ["ZotFile", "Zotfile", "zotfile"],
  zotcard: ["ZotCard"],
  zotmoov: ["ZotMoov", "Zotmoov"],
  "llm-for-zotero": ["LLM for Zotero", "llm-for-zotero"],
  "zotero-gpt": ["Zotero-GPT", "Zotero GPT", "Awesome GPT"],
  "zotero-ocr": ["Zotero OCR"],
  "zotero-reading-list": ["Zotero Reading List"],
  "zotero-shortdoi--bwiernik": ["DOI Manager", "Zotero Short DOI", "Zotero ShortDOI"],
  zutilo: ["Zutilo"],
  "zotero-markdb-connect": ["MarkDB-Connect"],
  "zotero-pdf-preview": ["Zotero PDF Preview"],
  "zotero-night": ["Night for Zotero", "Zotero Night"],
  "scite-zotero-plugin": ["Scite Zotero Plugin", "Scite plugin", "scite plugin", "Zotero Scite"],
  zotxt: ["zotxt"],
  "zotero-citationcounts": ["Citation Counts Manager", "Zotero Citation Counts"],
  "zotero-google-scholar-citation-count": ["Google Scholar Citation Count"],
  "zotero-mdnotes": ["Mdnotes", "mdnotes"],
  "zotero-storage-scanner": ["Storage Scanner"],
  "zotero-attachment-scanner": ["Attachment Scanner"],
  "zotero-folder-import": ["Folder Import for Zotero"],
  "zotero-pin-items": ["Zotero Pin Items"],
  "zotero-excalidraw": ["Zotero Excalidraw"],
  zoteroduplicatesmerger: ["Duplicates Merger"],
  zotlit: ["ZotLit"],
  zotodo: ["Zotodo"],
  "zotero-pdf-background": ["Zotero PDF Background"],
  zoplicate: ["Zoplicate"],
  notero: ["Notero"],
  "zotero-syllabus": ["Zotero Syllabus"],
  bibgenie: ["BibGenie"],
  "zotero-open-pdf": ["Zotero Open PDF"],
};

function movedMap(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, "generated", "redirects.json"), "utf8")) as {
      moved?: { from: string; target: string }[];
    };
    return Object.fromEntries((raw.moved ?? []).map((m) => [m.from.toLowerCase(), m.target]));
  } catch {
    return {};
  }
}

let cached: GuideIndex | null = null;
export function guideIndex(): GuideIndex {
  if (cached) return cached;
  const plugins = allPlugins().map((p): GuideIndexPlugin => {
    const e: GuideIndexPlugin = {
      s: p.slug,
      n: p.name,
      r: p.repo.toLowerCase(),
      g: p.grade,
      b: p.because,
      st: status(p),
      w: p.worksRange,
      d: p.downloadsN,
    };
    if (p.maintStatus === "archived") e.ar = 1;
    const al = NAMED[p.slug];
    if (al) e.al = al;
    const alt = p.retired?.alternative;
    if (alt) e.alt = { n: alt.name, s: alt.slug };
    if (MULTI_PLUGIN_REPOS.has(e.r)) e.mp = 1;
    return e;
  });
  cached = {
    generatedAt: new Date().toISOString(),
    currentMajor: CURRENT_ZOTERO_MAJOR(),
    moved: movedMap(),
    plugins,
  };
  return cached;
}
