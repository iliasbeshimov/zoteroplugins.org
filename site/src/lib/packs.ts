import { bySlug, type Plugin, RANK } from "./atlas.ts";

/**
 * Plugin packs: five or six plugins for one kind of Zotero user (undergraduates, PhD students…),
 * one per task they need done. The picks are chosen by hand; each lists fallbacks for the same task,
 * so a plugin that drops below B or stops working with the current Zotero gives way to the next one
 * on the next build instead of staying on the page until someone notices.
 *
 * Shadow-library tools are left out: the packs are written to be handed out by university
 * libraries.
 */
export interface PackPick {
  /** The task, as a heading: "Cite in LaTeX, Overleaf or Markdown". */
  task: string;
  /** Why this reader wants it, in their terms. One or two sentences. */
  why: string;
  /** Only for some readers: completes "If you …", e.g. "write in Microsoft Word". */
  ifYou?: string;
  /** The plugin for the task, then fallbacks for the same task, best first. */
  plugins: string[];
  /** A plugin for readers who work differently, e.g. in Obsidian rather than Zotero's notes. */
  or?: { ifYou: string; why: string; plugins: string[] };
}

export interface Pack {
  slug: string;
  /** Who it's for, as a plural noun: "PhD students". */
  name: string;
  /** One line under the name on the packs page. */
  who: string;
  /** The page's opening sentence after "Six plugins " (the count is computed): "for writing a thesis: …". */
  lead: string;
  picks: PackPick[];
}

const LINTER = "zotero-format-metadata";
const ZOPLICATE = "zoplicate";
const READING_LIST = ["zotero-reading-list", "zotero-reading-flow"];
const FILES = ["zotmoov", "zotero-attanger"];
const BBT = "zotero-better-bibtex";
const INCITEFUL = "inciteful-zotero-plugin";

export const PACKS: Pack[] = [
  {
    slug: "undergraduates",
    name: "Undergraduates",
    who: "Essays, lab reports and a first research project, cited against a deadline.",
    lead: "for what an undergraduate needs from Zotero: citations that come out right, one copy of each source, and a reading list that keeps itself.",
    picks: [
      {
        task: "Get citation details right",
        why: "Fixes title capitalisation, journal abbreviations, dates and DOIs in one click, so your bibliography comes out right in any citation style.",
        plugins: [LINTER],
      },
      {
        task: "Keep one copy of each source",
        why: "Save an article from Google Scholar and again from the library database and you have two copies. Zoplicate asks which to keep as you import, and merges them without losing notes.",
        plugins: [ZOPLICATE],
      },
      {
        task: "Track what you've read",
        why: "Adds a status to every source (To Read, In Progress, Read) in a column you can sort, so a course reading list stays in one place.",
        plugins: READING_LIST,
      },
      {
        task: "Cite faster in Word",
        ifYou: "write in Microsoft Word",
        why: "Insert the selected source at your cursor with one key or by dragging it in, and merge [1][2] into [1, 2].",
        plugins: ["zotero-citation"],
      },
      {
        task: "Send your sources to Notion",
        ifYou: "take notes in Notion",
        why: "Each source in the collections you choose becomes a page in a Notion database, with its details and notes, and stays up to date.",
        plugins: ["notero"],
      },
      {
        task: "Read in your own language",
        ifYou: "read English as a second language",
        why: "Select text in a PDF to see it translated by Google, DeepL, Microsoft or one of 20 more services, with a dictionary for single words.",
        plugins: ["zotero-pdf-translate"],
      },
    ],
  },
  {
    slug: "masters-students",
    name: "Master's students",
    who: "A thesis or capstone, with a library that grows to a few hundred sources over a year.",
    lead: "for writing a thesis: PDFs kept in your own cloud folder, a clean bibliography, linked notes, and a check that your literature review hasn't missed anything.",
    picks: [
      {
        task: "Keep PDFs in your own cloud folder",
        why: "Moves attachments into a folder you choose, such as OneDrive or Dropbox, so a growing thesis library doesn't fill Zotero's free storage.",
        plugins: FILES,
      },
      {
        task: "Keep one copy of each source",
        why: "A thesis library grows from many searches, and duplicates creep in. Zoplicate catches them as you import and merges them without losing attachments or notes.",
        plugins: [ZOPLICATE],
      },
      {
        task: "Clean up references before you submit",
        why: "Fixes title capitalisation, journal abbreviations, dates and DOIs, so a long bibliography is consistent without checking every entry by hand.",
        plugins: [LINTER],
      },
      {
        task: "Write notes you can find again",
        why: "Builds notes from your highlights with templates, links them with backlinks, and exports an outline to Word when you start writing.",
        plugins: ["zotero-better-notes"],
      },
      {
        task: "Check your literature review for gaps",
        why: "Starts from the papers you've collected and finds others in the same citation network, so a key source doesn't slip past you.",
        plugins: [INCITEFUL],
      },
      {
        task: "Track what you've read",
        why: "A status column (To Read, In Progress, Read) for every source, so you know where you are in a reading list of hundreds.",
        plugins: READING_LIST,
      },
    ],
  },
  {
    slug: "phd-students",
    name: "PhD students",
    who: "Years of reading, thousands of PDFs, and a literature review that has to be complete.",
    lead: "for a library that has to last a whole PhD: citations for LaTeX and Markdown, files kept in order, notes that turn into chapters, and a map of the literature.",
    picks: [
      {
        task: "Cite in LaTeX, Overleaf or Markdown",
        ifYou: "write in LaTeX or Markdown",
        why: "Stable citation keys, and a .bib file that updates itself whenever a collection changes. It also works with Pandoc and Markdown note apps.",
        plugins: [BBT],
      },
      {
        task: "Keep thousands of PDFs in order",
        why: "Moves attachments into a folder you choose, such as OneDrive or Dropbox, so your files stay organised outside Zotero's storage and open on any computer.",
        plugins: FILES,
      },
      {
        task: "Keep one copy of each source",
        why: "Catches duplicates the moment you import, merges them without losing attachments or notes, and bulk-merges the ones already in your library.",
        plugins: [ZOPLICATE],
      },
      {
        task: "Turn reading into writing",
        why: "Literature notes built from your highlights with templates, linked with backlinks and outlines, with two-way Markdown sync.",
        plugins: ["zotero-better-notes"],
        or: {
          ifYou: "keep your notes in Obsidian",
          why: "Creates Obsidian literature notes from your items and annotations, using your own templates.",
          plugins: ["zotlit", "zotero-markdb-connect"],
        },
      },
      {
        task: "Map the literature",
        why: "A graph search from a collection finds the most connected papers in a field, and Connect Papers finds the work that links two of them.",
        plugins: [INCITEFUL],
      },
      {
        task: "Automate the routine",
        why: "Rules that tag new items, mark papers when you open them, or run a script from a shortcut. Worth setting up once your library passes a few hundred items.",
        plugins: ["zotero-actions-tags"],
      },
    ],
  },
  {
    slug: "researchers",
    name: "Researchers and faculty",
    who: "Publishing, reviewing and teaching, with a library you share with co-authors and students.",
    lead: "for working researchers: citation counts in a column, a flag on papers others have questioned, faster editing of a large library, and readings for the courses you teach.",
    picks: [
      {
        task: "See how often a paper is cited",
        why: "Google Scholar citation counts for any item or collection, in a column you can sort, for deciding what to cite or preparing a review.",
        plugins: ["zotero-google-scholar-citation-count", "zotero-citation-tally"],
      },
      {
        task: "Know which papers have been questioned",
        why: "Flags the papers in your library that have comments on PubPeer, alongside the retraction alerts Zotero already shows.",
        plugins: ["pubpeer-zotero-plugin"],
      },
      {
        task: "Keep up with a field",
        why: "Run a graph search from a collection to find the papers it's missing, or connect two papers to find the work between them.",
        plugins: [INCITEFUL],
      },
      {
        task: "Edit a large library quickly",
        why: "Copy and paste tags across items, relate many items at once, and copy citations in several formats, from a right-click menu or shortcuts.",
        plugins: ["zutilo"],
      },
      {
        task: "Cite in LaTeX and Overleaf",
        ifYou: "write in LaTeX",
        why: "Stable citation keys, and a .bib file that updates itself whenever a collection changes, so a paper's references always match your library.",
        plugins: [BBT],
      },
      {
        task: "Share readings with your students",
        ifYou: "teach",
        why: "Turns a collection into a syllabus ordered by class, with a reading schedule and due dates.",
        plugins: ["zotero-syllabus"],
      },
    ],
  },
];

/** Every plugin slug a pack names, fallbacks included (for the test that they all exist). */
export const packSlugs = (): string[] =>
  PACKS.flatMap((k) => k.picks.flatMap((p) => [...p.plugins, ...(p.or?.plugins ?? [])]));

/** Fit for a pack: listed, working with the current Zotero, graded B or better, still offered. */
export const packable = (p: Plugin): boolean =>
  !p.hidden && p.currentOk && RANK[p.grade] >= RANK.B && !p.retired && !p.removed;

export interface ResolvedPick {
  task: string;
  why: string;
  ifYou: string | null;
  plugin: Plugin;
  or: { ifYou: string; why: string; plugin: Plugin } | null;
}

/** The first plugin in the list that's fit for a pack, or null. */
function first(slugs: string[], all: Record<string, Plugin>): Plugin | null {
  for (const s of slugs) {
    const p = all[s];
    if (p && packable(p)) return p;
  }
  return null;
}

/** A pack's picks with today's plugins; a task with no fit plugin left is dropped. */
export function resolvePack(pack: Pack): ResolvedPick[] {
  const all = bySlug();
  return pack.picks.flatMap((k) => {
    const plugin = first(k.plugins, all);
    if (!plugin) return [];
    const orPlugin = k.or ? first(k.or.plugins, all) : null;
    return [
      {
        task: k.task,
        why: k.why,
        ifYou: k.ifYou ?? null,
        plugin,
        or: k.or && orPlugin ? { ifYou: k.or.ifYou, why: k.or.why, plugin: orPlugin } : null,
      },
    ];
  });
}

/** "six", for "Six plugins…" when the count is small. */
export const countWord = (n: number): string =>
  ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"][n] ?? String(n);

/** "Zotero plugins for PhD students": the pack's page heading. */
export const packTitle = (pack: Pack) =>
  `Zotero plugins for ${pack.name.toLowerCase().replace(/^phd\b/, "PhD")}`;

/** The pack's page and its PDF. */
export const packPath = (pack: Pack) => `/for/${pack.slug}`;
export const packPdf = (pack: Pack) => `/for/${pack.slug}.pdf`;
/** The file name a downloaded PDF is saved under. */
export const packPdfName = (pack: Pack) => `zotero-plugins-for-${pack.slug}.pdf`;
