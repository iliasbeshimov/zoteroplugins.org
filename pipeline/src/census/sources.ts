import type { GitHub } from "../net/github.ts";
import { fetchWithRetry } from "../net/http.ts";
import { parseCsv } from "./csv.ts";

/**
 * Candidate discovery. Every source is free; each one only nominates repos. Whether a repo is
 * actually a Zotero plugin is decided later, from the manifest inside its released .xpi.
 */

export const SOURCE_IDS = [
  "addon-market",
  "addon-market-tracked",
  "zotero-chinese",
  "sheet",
  "zotero-wiki-archive",
  "topic",
  "name-or-description",
  "code-search",
  "template-fork",
  // Someone submitted it on the site (submit/run.ts).
  "submitted",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface AddonMarketRelease {
  targetZoteroVersion: string;
  tagName: string;
  id?: string;
  xpiVersion?: string;
  minZoteroVersion?: string;
  maxZoteroVersion?: string;
  releaseDate?: string;
}

export interface AddonMarketEntry {
  repo: string;
  name?: string;
  description?: string;
  tags?: string[];
  recommended?: boolean;
  releases: AddonMarketRelease[];
}

export interface SheetRow {
  name: string;
  summary: string;
  workflowPart: string;
  toolType: string;
  pricing: string;
}

export interface Discovery {
  candidates: Map<string, Set<SourceId>>;
  addonMarket: Map<string, AddonMarketEntry>;
  sheet: Map<string, SheetRow>;
  queries: { source: SourceId; query: string; repos: number }[];
}

const ADDON_MARKET_URL =
  "https://raw.githubusercontent.com/syt2/zotero-addons-scraper/publish/addon_infos.json";
const ZOTERO_CHINESE_URL =
  "https://raw.githubusercontent.com/zotero-chinese/zotero-plugins/main/src/plugins.ts";
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1U145pN0sCTudY5GqWpgcw3DmvE91lsB6roBDTLlXgpU/export?format=csv&gid=1815139709";
// Zotero's own community plugin list, last archived before it was replaced (2026-04-14).
const ZOTERO_WIKI_ARCHIVE_URL =
  "https://web.archive.org/web/20260414000000id_/https://www.zotero.org/support/plugins";

const TOPICS = [
  "zotero-plugin",
  "zotero-plugins",
  "zotero-addon",
  "zotero-addons",
  "zotero-extension",
  "zotero7",
  "zotero-7",
];
const CODE_QUERIES = [
  "zotero@chnm.gmu.edu filename:install.rdf",
  '"strict_max_version" zotero filename:manifest.json',
  "zotero-plugin-toolkit filename:package.json",
  "zotero-plugin-scaffold filename:package.json",
  "zotero-types filename:package.json",
];
const TEMPLATES = ["windingwind/zotero-plugin-template", "zotero/make-it-red"];

const RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "collections",
  "contact",
  "enterprise",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "topics",
  "trending",
  "users",
]);

export function repoKeyFromUrl(url: string): string | null {
  const m = url.match(
    /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)/i,
  );
  if (!m?.[1] || !m[2]) return null;
  const owner = m[1].toLowerCase();
  const repo = m[2].toLowerCase().replace(/\.git$/, "");
  if (RESERVED_OWNERS.has(owner) || !repo || repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
}

async function getText(url: string, userAgent: string): Promise<string> {
  const res = await fetchWithRetry(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Repository search beyond the 1,000-result cap by bisecting the creation-date range. */
async function searchRepositories(gh: GitHub, q: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (from: Date, to: Date): Promise<void> => {
    const scoped = `${q} created:${isoDay(from)}..${isoDay(to)}`;
    const first = await gh.search<{ full_name: string }>("repositories", scoped, 1);
    if (first.total > 1000 && to.getTime() - from.getTime() > 86_400_000) {
      const mid = new Date((from.getTime() + to.getTime()) / 2);
      await walk(from, mid);
      await walk(new Date(mid.getTime() + 86_400_000), to);
      return;
    }
    for (const item of first.items) out.add(item.full_name.toLowerCase());
    const pages = Math.min(10, Math.ceil(first.total / 100));
    for (let page = 2; page <= pages; page++) {
      const r = await gh.search<{ full_name: string }>("repositories", scoped, page);
      for (const item of r.items) out.add(item.full_name.toLowerCase());
    }
  };
  await walk(new Date("2008-01-01"), new Date());
  return out;
}

/** Code search beyond the 1,000-result cap by bisecting file size (index covers < 384 KB). */
async function searchCode(gh: GitHub, q: string): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (lo: number, hi: number): Promise<void> => {
    const scoped = `${q} size:${lo}..${hi}`;
    const first = await gh.search<{ repository: { full_name: string } }>("code", scoped, 1);
    if (first.total > 1000 && hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      await walk(lo, mid);
      await walk(mid + 1, hi);
      return;
    }
    for (const item of first.items) out.add(item.repository.full_name.toLowerCase());
    const pages = Math.min(10, Math.ceil(first.total / 100));
    for (let page = 2; page <= pages; page++) {
      const r = await gh.search<{ repository: { full_name: string } }>("code", scoped, page);
      for (const item of r.items) out.add(item.repository.full_name.toLowerCase());
    }
  };
  await walk(0, 384_000);
  return out;
}

/** The two curated lists whose per-plugin fields the census keeps (names, targets, sheet tags). */
export async function loadSeeds(
  userAgent: string,
): Promise<Pick<Discovery, "addonMarket" | "sheet">> {
  const market = JSON.parse(await getText(ADDON_MARKET_URL, userAgent)) as AddonMarketEntry[];
  const addonMarket = new Map(market.map((a) => [a.repo.toLowerCase(), a]));
  const rows = parseCsv(await getText(SHEET_URL, userAgent));
  const header = rows[0] ?? [];
  const col = (name: string) => header.indexOf(name);
  const sheet = new Map<string, SheetRow>();
  for (const r of rows.slice(1)) {
    const key = repoKeyFromUrl(r[col("Canonical URL")] || r[col("Link")] || "");
    if (!key || sheet.has(key)) continue;
    sheet.set(key, {
      name: r[col("Name")] ?? "",
      summary: r[col("Summary")] ?? "",
      workflowPart: r[col("Workflow Part")] ?? "",
      toolType: r[col("Tool Type")] ?? "",
      pricing: r[col("Pricing")] ?? "",
    });
  }
  return { addonMarket, sheet };
}

export async function discover(
  gh: GitHub,
  userAgent: string,
  log: (msg: string) => void,
): Promise<Discovery> {
  const candidates = new Map<string, Set<SourceId>>();
  const queries: Discovery["queries"] = [];
  const add = (source: SourceId, query: string, repos: Iterable<string>) => {
    let n = 0;
    for (const key of repos) {
      if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(key)) continue;
      if (!candidates.has(key)) candidates.set(key, new Set());
      candidates.get(key)?.add(source);
      n++;
    }
    queries.push({ source, query, repos: n });
    log(`  ${source.padEnd(20)} ${String(n).padStart(5)}  ${query}`);
  };

  // Curated lists
  const { addonMarket, sheet } = await loadSeeds(userAgent);
  add("addon-market", "addon_infos.json", addonMarket.keys());

  const tree = await gh.rest<{ tree: { path: string; type: string }[] }>(
    "/repos/syt2/zotero-addons-scraper/git/trees/master?recursive=1",
  );
  const tracked = (tree.data?.tree ?? [])
    .filter((t) => t.type === "blob" && t.path.startsWith("addons/"))
    .map((t) => t.path.slice("addons/".length).replace("@", "/").toLowerCase());
  add("addon-market-tracked", "syt2/zotero-addons-scraper addons/", tracked);

  const zc = await getText(ZOTERO_CHINESE_URL, userAgent);
  add(
    "zotero-chinese",
    "zotero-chinese/zotero-plugins src/plugins.ts",
    [...zc.matchAll(/repo:\s*['"]([^'"]+)['"]/g)].map((m) => (m[1] ?? "").toLowerCase()),
  );

  add("sheet", "research sheet, Plugins tab", sheet.keys());

  try {
    const html = await getText(ZOTERO_WIKI_ARCHIVE_URL, userAgent);
    const links = [...html.matchAll(/https?:\/\/github\.com\/[^\s"'<>)]+/g)].map((m) => m[0]);
    add("zotero-wiki-archive", "web.archive.org zotero.org/support/plugins 2026-04-14", [
      ...new Set(links.map(repoKeyFromUrl).filter((k): k is string => k !== null)),
    ]);
  } catch (error) {
    log(`  zotero-wiki-archive skipped: ${(error as Error).message}`);
  }

  // GitHub search
  for (const topic of TOPICS) {
    add("topic", `topic:${topic}`, await searchRepositories(gh, `topic:${topic} fork:true`));
  }
  add(
    "name-or-description",
    "zotero in:name,description fork:true",
    await searchRepositories(gh, "zotero in:name,description fork:true"),
  );
  for (const q of CODE_QUERIES) add("code-search", q, await searchCode(gh, q));

  for (const template of TEMPLATES) {
    const forks = await gh.restPaginate<{ full_name: string }>(`/repos/${template}/forks`, 20);
    add(
      "template-fork",
      `forks of ${template}`,
      forks.map((f) => f.full_name.toLowerCase()),
    );
  }

  return { candidates, addonMarket, sheet, queries };
}
