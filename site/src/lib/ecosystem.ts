import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { PluginProfile } from "@atlas/schema";
import { allPlugins, type Grade, type Plugin, ROOT } from "./atlas.ts";

/**
 * The numbers on /state-of-zotero-plugins, computed at build time from the census
 * (data/census/census.csv and its history) and the published profiles. Every plugin with a page
 * counts; plugins on its "copies" list (forks) are left out of the counts about who starts plugins
 * and when. Dates are when the GitHub repository was created; downloads are GitHub release
 * downloads.
 */

/** A whole CSV file into rows of fields; quoted fields may hold commas, quotes ("") and line breaks. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const [head, ...body] = rows;
  return body
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const n = (s: string | number | null | undefined) => {
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const share = (a: number, b: number) => (b ? a / b : 0);
const DAY = 86_400_000;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Plugins for shadow libraries have pages like any other, but the highlights don't feature them. */
const NOT_FEATURED = /sci-?hub|libgen|shadow ?librar/i;

/** What each kind of service in the data-sharing check is called on the page. */
const KIND_LABEL: Record<string, string> = {
  "llm-provider": "AI providers",
  "scholarly-api": "Scholarly databases",
  integration: "Other apps and services",
  translation: "Translation services",
  "code-hosting": "GitHub and other code hosts",
  "developer-server": "The developer's own server",
  unknown: "Servers we couldn't identify",
};

interface Row {
  p: Plugin;
  prof: PluginProfile;
  c: Record<string, string> | null;
  /** When its GitHub repository was created. */
  born: Date | null;
  downloads: number;
  original: boolean;
  installable: boolean;
  text: string;
}

type Dated = Row & { born: Date };
type Censused = Row & { c: Record<string, string> };

export interface Named {
  name: string;
  slug: string;
  value: number;
  note?: string;
}

function load(): Row[] {
  const census = parseCsv(readFileSync(`${ROOT}census/census.csv`, "utf8"));
  const byRepo = new Map(census.map((r) => [r.repo.toLowerCase(), r]));
  const plugins = new Map(allPlugins().map((p) => [p.slug, p]));
  const out: Row[] = [];
  for (const slug of readdirSync(`${ROOT}generated`)) {
    const f = `${ROOT}generated/${slug}/profile.json`;
    const p = plugins.get(slug);
    if (!existsSync(f) || !p) continue;
    const prof = JSON.parse(readFileSync(f, "utf8")) as PluginProfile;
    const c = byRepo.get(prof.repo.toLowerCase()) ?? null;
    const created = prof.popularity?.createdAt ?? c?.created_at ?? null;
    const about = prof.about;
    out.push({
      p,
      prof,
      c,
      born: created ? new Date(created.length === 10 ? `${created}T00:00:00Z` : created) : null,
      downloads: n(prof.popularity?.downloads),
      original: c ? c.is_fork !== "true" : !p.forkOf,
      installable: c
        ? c.verdict === "zotero-plugin" || c.verdict === "zotero-plugin-legacy"
        : !p.noRelease,
      text: [
        prof.name,
        about?.githubDescription,
        about?.manifestDescription,
        ...(about?.topics ?? []),
        prof.repo,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    });
  }
  return out;
}

/** Downloads per plugin on the first day of each of the last two monthly history files. */
function lastMonth(repos: Set<string>) {
  const dir = `${ROOT}census/history`;
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f))
        .sort()
        .slice(-2)
    : [];
  if (files.length < 2) return null;
  const firstDay = (f: string) => {
    const rows = parseCsv(readFileSync(`${dir}/${f}`, "utf8"));
    const d = rows.reduce((m, r) => (r.date && r.date < m ? r.date : m), "9999");
    return new Map(
      rows.filter((r) => r.date === d).map((r) => [r.repo.toLowerCase(), n(r.downloads)]),
    );
  };
  const [a, b] = files.map(firstDay);
  const gains: { repo: string; gain: number }[] = [];
  for (const [repo, end] of b) {
    if (!repos.has(repo) || !a.has(repo)) continue;
    const g = end - (a.get(repo) ?? 0);
    if (g > 0) gains.push({ repo, gain: g });
  }
  const [y, m] = files[0].slice(0, 7).split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const total = gains.reduce((s, g) => s + g.gain, 0);
  return {
    month: `${MONTHS[m - 1]} ${y}`,
    days,
    total,
    gains: gains.sort((x, z) => z.gain - x.gain),
  };
}

let cache: ReturnType<typeof compute> | null = null;
export const ecosystem = () => (cache ??= compute());

function compute() {
  const rows = load();
  const summary = parseCsv(readFileSync(`${ROOT}census/history/summary.csv`, "utf8"));
  const asOf = summary.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const now = new Date(`${asOf}T00:00:00Z`);
  const year = now.getUTCFullYear();
  const named = (r: Row, value: number, note?: string): Named => ({
    name: r.p.name,
    slug: r.p.slug,
    value,
    note,
  });
  const featured = (r: Row) => !NOT_FEATURED.test(r.text);
  const originals = rows.filter((r): r is Dated => r.original && r.born !== null);
  const installable = rows.filter((r): r is Censused => r.installable && r.c !== null);
  const listed = rows.filter((r) => !r.p.hidden);

  // Hero
  const owners = new Map<string, number>();
  for (const r of rows.filter((x) => x.original)) {
    const o = r.prof.repo.split("/")[0].toLowerCase();
    owners.set(o, (owners.get(o) ?? 0) + 1);
  }
  const totalDownloads = rows.reduce((s, r) => s + r.downloads, 0);

  // Pace: plugins started each year, and each month of this year
  const perYear = new Map<number, number>();
  const perMonth = new Map<number, number>();
  for (const r of originals) {
    const y = r.born.getUTCFullYear();
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
    if (y === year)
      perMonth.set(r.born.getUTCMonth(), (perMonth.get(r.born.getUTCMonth()) ?? 0) + 1);
  }
  const years = [...perYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, count]) => ({ y, count }));
  const thisYear = perYear.get(year) ?? 0;
  const hoursSoFar = (now.getTime() - Date.UTC(year, 0, 1)) / 3_600_000;
  // The busiest whole month (this month isn't over yet).
  const fullMonths = [...perMonth.entries()].filter(([m]) => m < now.getUTCMonth());
  const busiest = fullMonths.sort((a, b) => b[1] - a[1])[0] ?? null;
  const earlierCut = year - 1;
  const beforeLastYear = years.filter((x) => x.y < earlierCut).reduce((s, x) => s + x.count, 0);
  const firstYear = years[0]?.y ?? year;

  // Old timers: the earliest-started plugins that still work in today's Zotero
  const oldTimers = originals
    .filter((r) => r.p.currentOk && !r.p.hidden && featured(r))
    .sort((a, b) => a.born.getTime() - b.born.getTime())
    .slice(0, 4)
    .map((r) => ({
      ...named(r, now.getUTCFullYear() - r.born.getUTCFullYear()),
      since: r.born.getUTCFullYear(),
      lastActivity: r.prof.maintenance?.lastActivityAt?.slice(0, 7) ?? null,
    }));
  const veterans = originals.filter((r) => r.born.getUTCFullYear() < earlierCut && r.installable);
  const veteransOk = veterans.filter((r) => r.p.currentOk).length;

  // The Zotero 6 plugins that Zotero 7 left behind
  const legacy = rows.filter((r) => r.p.legacy);
  const legacyTop = [...legacy]
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 5)
    .map((r) => named(r, r.downloads));

  // Popularity
  const top10 = rows
    .filter(featured)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 10)
    .map((r) => named(r, r.downloads));
  const dl = installable.map((r) => r.downloads).sort((a, b) => b - a);
  const dlTotal = dl.reduce((s, x) => s + x, 0);
  const top10Share = share(
    dl.slice(0, 10).reduce((s, x) => s + x, 0),
    dlTotal,
  );
  const bySlugRepo = new Map(rows.map((r) => [r.prof.repo.toLowerCase(), r]));
  const month = lastMonth(new Set(bySlugRepo.keys()));
  const gainOf = new Map((month?.gains ?? []).map((g) => [g.repo, g.gain]));
  const monthTop = (month?.gains ?? [])
    .map((g) => bySlugRepo.get(g.repo))
    .filter((r): r is Row => !!r && featured(r))
    .slice(0, 3)
    .map((r) => named(r, gainOf.get(r.prof.repo.toLowerCase()) ?? 0));
  const halfYearAgo = now.getTime() - 183 * DAY;
  const breakouts = originals
    .filter((r) => r.born.getTime() > halfYearAgo && !r.p.hidden && featured(r))
    .map((r) => ({
      r,
      perDay: r.downloads / Math.max(14, (now.getTime() - r.born.getTime()) / DAY),
    }))
    .sort((a, b) => b.perDay - a.perDay)
    .slice(0, 3)
    .map(({ r, perDay }) => named(r, Math.round(perDay), MONTHS[r.born.getUTCMonth()]));

  // Compatibility: what installable plugins declare
  const majors = [6, 7, 8, 9, 10, 11, 12].filter((v) =>
    installable.some((r) => r.c[`z${v}`] !== undefined),
  );
  const versions = majors.map((v) => ({
    v,
    count: installable.filter((r) => r.c[`z${v}`] === "true").length,
  }));
  const currentMajor = rows.find((r) => r.p.currentMajor)?.p.currentMajor ?? 10;
  const nextMajor = versions.find((v) => v.v === currentMajor + 1) ?? null;
  const maxMajor = (s: string) => (s === "*" ? Number.POSITIVE_INFINITY : n(/^(\d+)/.exec(s)?.[1]));
  const optimists = installable.filter((r) => maxMajor(r.c.max_version ?? "") >= 99);
  const biggestFinite = Math.max(
    ...optimists.map((r) => maxMajor(r.c.max_version)).filter(Number.isFinite),
    0,
  );
  const anyVersion = optimists.filter((r) => r.c.max_version === "*").length;
  const atBiggest = optimists.filter((r) => maxMajor(r.c.max_version) === biggestFinite).length;

  // AI
  const aiByYear = years
    .filter((x) => x.y >= year - 7)
    .map(({ y }) => {
      const born = originals.filter((r) => r.born.getUTCFullYear() === y);
      const ai = born.filter((r) => r.p.jobs.includes("ai")).length;
      return { y, count: born.length, ai, share: share(ai, born.length) };
    });
  const providers = new Map<string, number>();
  for (const r of rows)
    for (const s of new Set(r.prof.requirementsHints?.aiServices ?? []))
      providers.set(s, (providers.get(s) ?? 0) + 1);
  const aiProviders = [...providers.entries()]
    .map(([name, count]) => ({ name: name.replace(/ \(.*\)$/, ""), count }))
    .reduce<{ name: string; count: number }[]>((acc, x) => {
      // "OpenAI" and "OpenAI ChatGPT" are the same company: keep the larger count.
      const k = acc.find((a) => x.name.startsWith(a.name) || a.name.startsWith(x.name));
      if (k) k.count = Math.max(k.count, x.count);
      else acc.push({ ...x });
      return acc;
    }, [])
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const aiCount = rows.filter((r) => r.p.jobs.includes("ai")).length;
  const mcp = rows.filter((r) => /\bmcp\b|model context protocol/.test(r.text)).length;
  const team = rows
    .filter((r) => r.original && featured(r))
    .sort((a, b) => n(b.c?.contributors) - n(a.c?.contributors))[0];

  // Privacy and checks
  const scanned = rows.filter((r) => r.prof.trust?.facets?.dataSharing?.value);
  const sharing = (r: Row) => r.prof.trust?.facets?.dataSharing?.value;
  const noRequests = scanned.filter((r) => sharing(r) === "no-network-found").length;
  const ownServers = scanned.filter((r) => sharing(r) === "user-configured-only").length;
  const kinds = new Map<string, number>();
  for (const r of scanned) {
    const cats = new Set((r.prof.trust?.facets?.dataSharing?.hosts ?? []).map((h) => h.category));
    for (const c of cats) if (KIND_LABEL[c]) kinds.set(c, (kinds.get(c) ?? 0) + 1);
  }
  const kindList = [...kinds.entries()]
    .map(([k, count]) => ({ name: KIND_LABEL[k], count }))
    .sort((a, b) => b.count - a.count);
  const gradeOrder: Grade[] = ["A+", "A", "B", "C", "–"];
  const grades = gradeOrder.map((g) => ({
    g,
    count: listed.filter((r) => r.p.grade === g).length,
  }));
  const tested = rows.filter((r) => r.p.liveTest);
  const asDescribed = tested.filter((r) => r.p.liveTest?.verdict === "as-described").length;

  // People
  const solo = rows.filter((r) => r.original && r.c?.contributors).map((r) => n(r.c?.contributors));
  const prolific = [...owners.entries()].sort((a, b) => b[1] - a[1])[0];
  const prolificBest = rows
    .filter((r) => r.original && r.prof.repo.split("/")[0].toLowerCase() === prolific?.[0])
    .sort((a, b) => b.downloads - a.downloads)[0];
  const langs = new Map<string, number>();
  for (const r of listed)
    for (const l of new Set((r.prof.languages?.ui ?? []).map((x) => x.split("-")[0].toLowerCase())))
      langs.set(l, (langs.get(l) ?? 0) + 1);
  const langNames = new Intl.DisplayNames(["en"], { type: "language" });
  const languages = [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([code, count]) => ({
      name: langNames.of(code) ?? code,
      count,
      share: share(count, listed.length),
    }));
  const newFinds = rows.filter((r) => r.c?.new_find === "true").length;
  const withSources = rows.filter((r) => r.c).length;

  // Fun facts
  const sized = rows
    .map((r) => ({ r, size: n(r.prof.install?.asset?.size) }))
    .filter((x) => x.size > 0)
    .sort((a, b) => a.size - b.size);
  const names = rows.map((r) => r.p.name);
  const nameCount = new Map<string, number>();
  for (const r of rows) {
    const k = r.prof.repo.split("/")[1].toLowerCase();
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
  }
  const reused = [...nameCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const [small, large] = [sized[0], sized.at(-1)];
  const niche = (re: RegExp) => rows.filter((r) => re.test(r.text)).length;

  return {
    asOf,
    asOfLabel: `${MONTHS[now.getUTCMonth()]} ${year}`,
    screened: n(summary.at(-1)?.candidates),
    checked: rows.length,
    listed: listed.length,
    totalDownloads,
    developers: owners.size,
    pace: {
      year,
      thisYear,
      hoursPerPlugin: thisYear ? hoursSoFar / thisYear : null,
      busiest: busiest ? { month: MONTHS[busiest[0]], count: busiest[1] } : null,
      beforeLastYear,
      earlierCut,
      firstYear,
      years,
    },
    oldTimers,
    veterans: { count: veterans.length, ok: veteransOk, before: earlierCut },
    legacy: {
      count: legacy.length,
      downloads: legacy.reduce((s, r) => s + r.downloads, 0),
      top: legacyTop,
    },
    popularity: {
      top10,
      top10Share,
      median: median(dl),
      under100: share(dl.filter((x) => x < 100).length, dl.length),
      month: month
        ? { name: month.month, total: month.total, perDay: month.total / month.days, top: monthTop }
        : null,
      breakouts,
    },
    compat: {
      versions,
      currentMajor,
      next: nextMajor,
      installable: installable.length,
      optimists: optimists.length,
      anyVersion,
      biggestFinite,
      atBiggest,
    },
    ai: {
      byYear: aiByYear,
      providers: aiProviders,
      count: aiCount,
      mcp,
      team: team ? { name: team.p.name, slug: team.p.slug, count: n(team.c?.contributors) } : null,
    },
    privacy: {
      scanned: scanned.length,
      noRequests,
      ownServers,
      kinds: kindList.slice(0, 6),
      grades,
      tested: tested.length,
      asDescribed,
    },
    people: {
      onePlugin: share([...owners.values()].filter((v) => v === 1).length, owners.size),
      solo: share(solo.filter((x) => x <= 1).length, solo.length),
      prolific: prolific
        ? {
            login: prolific[0],
            count: prolific[1],
            best: prolificBest ? { name: prolificBest.p.name, slug: prolificBest.p.slug } : null,
          }
        : null,
      languages,
      newFinds,
      newFindShare: share(newFinds, withSources),
    },
    fun: {
      smallest: small ? { name: small.r.p.name, slug: small.r.p.slug, size: small.size } : null,
      biggest: large ? { name: large.r.p.name, slug: large.r.p.slug, size: large.size } : null,
      medianSize: median(sized.map((x) => x.size)),
      zot: share(names.filter((x) => /zot/i.test(x)).length, names.length),
      reused: reused ? { name: reused[0], count: reused[1] } : null,
      niches: {
        translation: rows.filter((r) => r.p.jobs.includes("translation")).length,
        obsidian: niche(/obsidian/),
        latex: niche(/latex|overleaf|bibtex/),
        markdown: niche(/markdown/),
      },
    },
  };
}

export type Ecosystem = ReturnType<typeof compute>;
