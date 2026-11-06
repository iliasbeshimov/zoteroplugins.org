import type { Job } from "@atlas/schema";
import { allPlugins, fmtDate, type Plugin } from "./atlas.ts";
import { REPO, SITE } from "./links.ts";
import { indexable } from "./seo.ts";

/**
 * Titles, meta descriptions, the plugin pages' verdict sentence and the JSON-LD blocks: what
 * search results show and what answer engines quote. Titles lead with what people search for
 * ("Zotero AI plugins", a plugin's name); descriptions answer first and stay within 155 characters.
 */

export const BRAND = "Zotero Plugins Atlas";
const SEP = " · ";

/** A page title: the brand is added when the whole fits in 70 characters. */
export function pageTitle(core: string): string {
  const full = `${core}${SEP}${BRAND}`;
  return full.length <= 70 ? full : core;
}

/** Cuts text to `max` characters at a word boundary, ending with "…". */
export function clip(s: string, max = 155): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.·–-]+$/, "")}…`;
}

// ---------- plugin pages ----------

/** Names shared by more than one indexed plugin: all but the most downloaded get "by <owner>". */
let shared: Map<string, string> | null = null;
function sharedName(p: Plugin): boolean {
  if (!shared) {
    shared = new Map();
    for (const x of allPlugins().filter(indexable)) {
      const k = x.name.toLowerCase();
      if (!shared.has(k))
        shared.set(k, x.slug); // allPlugins() is sorted by downloads
      else shared.set(`${k}\u0000${x.slug}`, x.slug);
    }
  }
  return shared.has(`${p.name.toLowerCase()}\u0000${p.slug}`);
}
const owner = (p: Plugin) => p.repo.split("/")[0];

function gradePhrase(p: Plugin): string {
  return p.grade === "–" ? "not graded yet" : `grade ${p.grade}, ${p.gradeWord.toLowerCase()}`;
}

export function pluginTitle(p: Plugin): string {
  const kind = p.legacy
    ? "Zotero 6 plugin"
    : p.retired
      ? "retired Zotero plugin"
      : /zotero/i.test(p.name)
        ? "plugin"
        : "Zotero plugin";
  const by = p.forkOf ? `, fork by ${owner(p)}` : sharedName(p) ? ` by ${owner(p)}` : "";
  return pageTitle(`${p.name} (${kind}${by}): ${gradePhrase(p)}`);
}

/** The "because" line without its asides in brackets, for places with little room. */
const shortBecause = (p: Plugin) => p.because.replace(/\s*\([^)]*\)/g, "").replace(/\s+,/g, ",");

function compatShort(p: Plugin): string {
  if (p.legacy) return "Zotero 6 only.";
  if (!p.worksWith.length) return "";
  return `Works with Zotero ${p.worksRange}.`;
}

export function pluginDescription(p: Plugin): string {
  const verdict =
    p.grade === "–"
      ? `Not graded yet: ${shortBecause(p)}.`
      : `Grade ${p.grade} (${p.gradeWord.toLowerCase()}) because ${shortBecause(p)}.`;
  const head = [verdict, compatShort(p)].filter(Boolean).join(" ");
  // What it does follows when it fits, or when enough of it fits to be worth reading.
  const room = 155 - head.length - 1;
  return room >= 50 || p.oneLiner.length <= room ? clip(`${head} ${p.oneLiner}`) : clip(head);
}

/**
 * One sentence an answer engine can quote on its own: the plugin's name, its grade and why, which
 * Zotero it works with, and when it was last checked.
 */
export function verdictSentence(p: Plugin): string {
  const grade =
    p.grade === "–"
      ? `${p.name} isn't graded yet: ${p.because}.`
      : `${p.name} has Atlas grade ${p.grade} (${p.gradeWord.toLowerCase()}) because ${p.because}.`;
  const compat = p.legacy
    ? "It's a Zotero 6 plugin, so Zotero 7 and later can't load it."
    : !p.worksWith.length
      ? ""
      : p.currentOk
        ? `It works with Zotero ${p.worksRange}.`
        : `It works with Zotero ${p.worksRange}, not the current Zotero ${p.currentMajor}.`;
  return [grade, compat].filter(Boolean).join(" ");
}

export const checkedOn = (p: Plugin) => fmtDate(p.checkedAt);

// ---------- category pages ----------

/** What people search for, per job: the title's keyword and the page's heading. */
const JOB_SEO: Record<string, { title: string; h1: string }> = {
  reading: { title: "Zotero PDF reader plugins", h1: "Plugins for reading PDFs in Zotero" },
  citing: { title: "Zotero citation plugins", h1: "Plugins for citing and writing with Zotero" },
  ai: { title: "Zotero AI plugins", h1: "AI and summary plugins for Zotero" },
  translation: { title: "Zotero translation plugins", h1: "Translation plugins for Zotero" },
  organising: {
    title: "Zotero plugins for tags and organising",
    h1: "Plugins for organising and tagging in Zotero",
  },
  metadata: { title: "Zotero metadata plugins", h1: "Import and metadata plugins for Zotero" },
  interface: { title: "Zotero interface plugins", h1: "Plugins that change how Zotero looks" },
  files: {
    title: "Zotero plugins for files and sync",
    h1: "Plugins for files, sync and backup in Zotero",
  },
};
export const jobHeading = (job: Job) => JOB_SEO[job.slug]?.h1 ?? `${job.title} plugins for Zotero`;
export const jobTitle = (job: Job, n: number) =>
  pageTitle(
    `${JOB_SEO[job.slug]?.title ?? `Zotero ${job.title} plugins`}: ${n.toLocaleString("en-GB")} checked and graded`,
  );
export function jobDescription(job: Job, plugins: Plugin[]): string {
  const n = (g: string[]) => plugins.filter((p) => g.includes(p.grade)).length;
  const counts = `${plugins.length.toLocaleString("en-GB")} checked and graded: ${n(["A+", "A"])} recommended, ${n(["B"])} use with care, ${n(["C"])} not recommended.`;
  return clip(`${job.lead} ${counts}`);
}

// ---------- JSON-LD ----------

const ORG = `${SITE}/#org`;
const WEBSITE = `${SITE}/#website`;
type Ld = Record<string, unknown>;

export function breadcrumbs(items: [string, string][]): Ld {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, path], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: `${SITE}${path}`,
    })),
  };
}

const graph = (...nodes: Ld[]): Ld => ({ "@context": "https://schema.org", "@graph": nodes });

export function siteLd(description: string): Ld {
  return graph(
    {
      "@type": "WebSite",
      "@id": WEBSITE,
      url: `${SITE}/`,
      name: BRAND,
      description,
      inLanguage: "en",
      publisher: { "@id": ORG },
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${SITE}/browse?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "Organization",
      "@id": ORG,
      name: BRAND,
      url: `${SITE}/`,
      logo: `${SITE}/logo.png`,
      sameAs: [REPO],
    },
  );
}

const SPDX = /^(AGPL|GPL|LGPL|MIT|Apache|MPL|BSD|CC0|CC-BY|EUPL|Unlicense|0BSD|ISC)/;

export function pluginLd(p: Plugin, crumbs: [string, string][]): Ld {
  const url = `${SITE}/p/${p.slug}`;
  return graph(
    {
      "@type": "ItemPage",
      "@id": `${url}#page`,
      url,
      name: pluginTitle(p),
      description: verdictSentence(p),
      inLanguage: "en",
      isPartOf: { "@id": WEBSITE },
      lastReviewed: p.checkedAt.slice(0, 10),
      reviewedBy: { "@id": ORG },
      breadcrumb: breadcrumbs(crumbs),
      mainEntity: { "@id": `${url}#plugin` },
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${url}#plugin`,
      name: p.name,
      description: p.oneLiner,
      codeRepository: p.repoUrl,
      programmingLanguage: "JavaScript",
      runtimePlatform: p.worksWith.length ? `Zotero ${p.worksRange}` : "Zotero",
      ...(p.version ? { version: p.version } : {}),
      ...(p.releasedAt ? { datePublished: p.releasedAt.slice(0, 10) } : {}),
      ...(SPDX.test(p.license) ? { license: `https://spdx.org/licenses/${p.license}.html` } : {}),
      author: { name: p.author, url: `https://github.com/${owner(p)}` },
    },
  );
}

export function categoryLd(job: Job, plugins: Plugin[], title: string, description: string): Ld {
  const url = `${SITE}/c/${job.slug}`;
  return graph({
    "@type": "CollectionPage",
    "@id": `${url}#page`,
    url,
    name: title,
    description,
    inLanguage: "en",
    isPartOf: { "@id": WEBSITE },
    breadcrumb: breadcrumbs([
      ["Home", "/"],
      [job.title, `/c/${job.slug}`],
    ]),
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: plugins.length,
      itemListElement: plugins.slice(0, 50).map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${SITE}/p/${p.slug}`,
        name: p.name,
      })),
    },
  });
}

export function datasetLd(checkedAt: string, count: number): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${SITE}/about#dataset`,
    name: "Zotero Plugins Atlas: grades and findings for every Zotero plugin",
    description: `A grade, the findings behind it, compatibility, requirements and a plain-language summary for each of ${count.toLocaleString("en-GB")} Zotero plugins, from a check of each release's code. Updated daily from GitHub.`,
    url: `${SITE}/about`,
    license: "https://creativecommons.org/licenses/by/4.0/",
    isAccessibleForFree: true,
    creator: { "@id": ORG },
    dateModified: checkedAt.slice(0, 10),
    keywords: [
      "Zotero",
      "Zotero plugins",
      "software security",
      "browser extensions",
      "research software",
    ],
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: `${SITE}/api/plugins.json`,
      },
    ],
  };
}
