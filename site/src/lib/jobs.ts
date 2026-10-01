import type { PluginProfile } from "@atlas/schema";

/**
 * The jobs people come with ("I want to cite in Word"), which the home page and category pages
 * are built around. Until enrichment writes `categories`, a plugin's jobs are guessed
 * from its name, descriptions, topics, the research sheet's category and the AI services its code
 * contacts. A plugin can do several jobs.
 */
export interface Job {
  slug: string;
  title: string;
  eg: string;
  lead: string;
  watch: string;
  /** Word-start matches on lower-cased text; CJK entries match anywhere. */
  keywords: string[];
  hints: string[];
  categories: string[];
}

export const JOBS: Job[] = [
  {
    slug: "reading",
    title: "Reading & PDFs",
    eg: "Outlines, highlights, reader tools",
    lead: "Plugins that work inside Zotero's reader: outlines, highlights, annotations and notes.",
    watch:
      "Reader tools see the full text of what you open. Check <strong>Where your data goes</strong> if a plugin sends text anywhere, and whether it works with your Zotero version.",
    keywords: [
      "pdf",
      "reader",
      "reading",
      "annotat",
      "highlight",
      "epub",
      "outline",
      "notes",
      "阅读",
      "标注",
    ],
    hints: ["PDF Annotation"],
    categories: ["pdf-annotation"],
  },
  {
    slug: "citing",
    title: "Citing & writing",
    eg: "Word, LibreOffice, LaTeX, Markdown",
    lead: "Plugins for citing as you write: word processors, LaTeX, Markdown and note apps.",
    watch:
      "Citation plugins touch your manuscripts. Check <strong>What you'll need</strong> for companion apps, and <strong>Powerful capabilities</strong> for reading and writing files outside Zotero.",
    keywords: [
      "citation",
      "cite",
      "citekey",
      "bibtex",
      "biblatex",
      "latex",
      "word",
      "libreoffice",
      "markdown",
      "obsidian",
      "writing",
      "csl",
      "bibliograph",
      "引用",
    ],
    hints: ["Citation/Bibliography", "Writing Integration"],
    categories: ["citation-bibliography", "writing-integration"],
  },
  {
    slug: "ai",
    title: "AI & summaries",
    eg: "Summaries, outlines, chat with papers",
    lead: "Plugins that summarise, outline or explain papers using a language model.",
    watch:
      "These plugins send your paper's text to an AI service. Check <strong>Where your data goes</strong> on each plugin page, and prefer ones that can use a model on your own computer.",
    keywords: [
      "ai",
      "gpt",
      "llm",
      "chatgpt",
      "openai",
      "claude",
      "gemini",
      "deepseek",
      "copilot",
      "chat",
      "summar",
      "agent",
      "rag",
      "ollama",
      "kimi",
      "qwen",
      "智能",
      "大模型",
    ],
    hints: ["AI/LLM"],
    categories: ["ai-llm"],
  },
  {
    slug: "translation",
    title: "Translation",
    eg: "PDFs, metadata, notes",
    lead: "Plugins that translate PDFs, titles and abstracts, annotations and notes.",
    watch:
      "The text you select goes to a translation service. Check <strong>Where your data goes</strong> for which services, and whether any of it travels unencrypted.",
    keywords: ["translat", "deepl", "翻译"],
    hints: [],
    categories: [],
  },
  {
    slug: "organising",
    title: "Organising & tags",
    eg: "Tags, collections, duplicates",
    lead: "Plugins that tag, sort, merge and tidy the items in your library.",
    watch:
      "These plugins change many items at once. Check <strong>Powerful capabilities</strong> for direct writes to Zotero's database, and back up before a bulk change.",
    keywords: [
      "tag",
      "tags",
      "collection",
      "duplicat",
      "organiz",
      "organis",
      "folder",
      "sort",
      "label",
      "标签",
      "分类",
    ],
    hints: ["Organization"],
    categories: ["organization"],
  },
  {
    slug: "metadata",
    title: "Import & metadata",
    eg: "DOIs, journals, retractions",
    lead: "Plugins that find, import and fill in metadata: DOIs, journals, citation counts.",
    watch:
      "Metadata plugins look your items up online. Check <strong>Where your data goes</strong> for which services receive your titles and DOIs.",
    keywords: [
      "metadata",
      "doi",
      "import",
      "journal",
      "retract",
      "crossref",
      "isbn",
      "arxiv",
      "pubmed",
      "scholar",
      "impact factor",
      "search",
      "discover",
      "cnki",
      "知网",
      "期刊",
    ],
    hints: ["Import", "Search/Discovery"],
    categories: ["import", "search-discovery"],
  },
  {
    slug: "interface",
    title: "Interface & look",
    eg: "Columns, themes, shortcuts",
    lead: "Plugins that change how Zotero looks and behaves: columns, themes, shortcuts.",
    watch:
      "Interface plugins run on every screen. Check <strong>Code transparency</strong>: code nobody can read runs all the time.",
    keywords: [
      "theme",
      "interface",
      "column",
      "shortcut",
      "dark mode",
      "font",
      "toolbar",
      "layout",
      "keyboard",
      "hotkey",
      "ui",
      "主题",
      "界面",
    ],
    hints: ["UI/Customization"],
    categories: ["ui-customization"],
  },
  {
    slug: "files",
    title: "Files, sync & backup",
    eg: "Attachments, storage, export",
    lead: "Plugins that move, rename, sync, back up or export your files.",
    watch:
      "These plugins move or copy your files. Check <strong>Where your data goes</strong> for storage services, and whether it keeps a password for one.",
    keywords: [
      "sync",
      "backup",
      "attachment",
      "storage",
      "webdav",
      "export",
      "cloud",
      "zotfile",
      "rename",
      "同步",
      "附件",
    ],
    hints: ["Sync", "Export"],
    categories: ["sync", "export"],
  },
];

export const JOB_BY_SLUG = Object.fromEntries(JOBS.map((j) => [j.slug, j]));

const hasCjk = (s: string) => /[　-鿿]/.test(s);
const matchers = new Map(
  JOBS.map((j) => [
    j.slug,
    j.keywords.map((k) =>
      hasCjk(k)
        ? (t: string) => t.includes(k)
        : (
            (re: RegExp) => (t: string) =>
              re.test(t)
          )(new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
    ),
  ]),
);

export function jobsFor(p: PluginProfile): string[] {
  if (p.categories) {
    const cats = [p.categories.primary, ...p.categories.secondary];
    return JOBS.filter((j) => j.categories.some((c) => cats.includes(c as never))).map(
      (j) => j.slug,
    );
  }
  const text = [
    p.name,
    p.about.githubDescription,
    p.about.manifestDescription,
    p.about.topics.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const out = JOBS.filter(
    (j) =>
      (p.about.categoryHint && j.hints.includes(p.about.categoryHint)) ||
      (matchers.get(j.slug) ?? []).some((m) => m(text)),
  ).map((j) => j.slug);
  if ((p.requirementsHints?.aiServices.length ?? 0) > 0 && !out.includes("ai")) out.push("ai");
  return out;
}
