import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths.ts";
import type { ZoteroVersions } from "./compat.ts";
import type { CensusRow } from "./run.ts";
import type { SourceId } from "./sources.ts";

/**
 * Builds data/census/explorer.html: a self-contained page (data inlined) for exploring the census.
 * Deterministic: same census.json and summaries.json in, same page out.
 */

interface CensusFile {
  generatedAt: string;
  zoteroVersions: ZoteroVersions;
  queries: { source: SourceId }[];
  rows: CensusRow[];
}

/** AI-written plain-language summaries of the top plugins, kept apart from the census data. */
interface SummariesFile {
  writtenBy: string;
  writtenAt: string;
  minDownloads: number;
  summaries: Record<string, { does: string; pain: string }>;
}

/** Curated lists, with the Add-on Market feed and its tracked list counted once. */
const LIST_GROUPS: SourceId[][] = [
  ["addon-market", "addon-market-tracked"],
  ["zotero-chinese"],
  ["sheet"],
  ["zotero-wiki-archive"],
];

export function explorerData(census: CensusFile, summaries?: SummariesFile) {
  const sums = summaries?.summaries ?? {};
  const rows = census.rows
    .filter((r) => r.verdict === "zotero-plugin" || r.verdict === "zotero-plugin-legacy")
    .map((r) => ({
      r: r.repo,
      n: r.name,
      v: r.verdict === "zotero-plugin" ? "p" : "l",
      s: r.stars,
      d: r.totalXpiDownloads,
      c: r.contributors,
      a: r.lastActivityAt?.slice(0, 10) ?? null,
      lt: r.latestTag,
      z: r.supports,
      m: r.maintenance,
      nf: r.newFind,
      f: r.isFork ?? false,
      src: r.sources,
      cl: LIST_GROUPS.filter((g) => g.some((s) => r.sources.includes(s))).length,
      desc:
        r.description && r.description.length > 180
          ? `${r.description.slice(0, 177)}…`
          : r.description,
      ...(sums[r.repo] ? { sum: sums[r.repo] } : {}),
    }));
  const zv = census.zoteroVersions;
  return {
    meta: {
      generatedAt: census.generatedAt,
      currentMajor: zv.currentMajor,
      nextMajor: zv.nextMajor,
      release: zv.release,
      sources: new Set(census.queries.map((q) => q.source)).size,
      summaryMin: summaries?.minDownloads ?? null,
      summaryDate: summaries?.writtenAt ?? null,
      method: [
        "Candidates come from the Add-on Market feed and its tracked-repo list, the zotero-chinese plugin list, the research sheet, Zotero's archived community plugin page, GitHub topic search, GitHub name/description search, GitHub code search (Zotero manifests and plugin toolkits), and forks of the plugin templates.",
        "A repo counts as a plugin only if one of its GitHub releases ships an .xpi whose manifest targets Zotero. The manifest is read straight out of the release file with HTTP range requests.",
        `Zotero compatibility is what the latest release's manifest declares, judged against the versions Zotero actually shipped (the last stable of each older major, e.g. ${zv.lastTagPerMajor[7] ?? "7.0.x"}). It is not a test of whether the plugin works.`,
        "Downloads are GitHub's own counts for .xpi assets across all releases. They miss mirror downloads and reset when an asset is replaced, so treat them as a floor.",
        "Maintenance uses the later of the last commit on the default branch and the latest release: active within 6 months, slowing within 18, dormant beyond that.",
        'A "new find" is a confirmed plugin that appears in none of the curated lists (Add-on Market, zotero-chinese, the research sheet, Zotero\'s archived page).',
        ...(summaries
          ? [
              `The "what it does" and "pain it solves" summaries cover the plugins that had ${summaries.minDownloads.toLocaleString("en-US")}+ downloads on ${summaries.writtenAt}, and were written by ${summaries.writtenBy}. They are the only AI-written part of this page, and they describe what each project says it does, not whether it works.`,
            ]
          : []),
      ],
    },
    rows,
  };
}

export async function buildExplorer(): Promise<string> {
  const census = JSON.parse(
    await readFile(join(paths.root, "data", "census", "census.json"), "utf8"),
  ) as CensusFile;
  const summaries = await readFile(join(paths.root, "data", "census", "summaries.json"), "utf8")
    .then((t) => JSON.parse(t) as SummariesFile)
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
  const template = await readFile(new URL("./explorer.template.html", import.meta.url), "utf8");
  // Inline JSON must not be able to close the <script> element it lives in.
  const json = JSON.stringify(explorerData(census, summaries)).replaceAll("</", "<\\/");
  const out = join(paths.root, "data", "census", "explorer.html");
  await writeFile(
    out,
    template.replace('{"placeholder":"__DATA__"}', () => json),
  );
  return out;
}
