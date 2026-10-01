import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginProfile } from "@atlas/schema";
import { JOB_BY_SLUG, jobsFor } from "./jobs.ts";

/**
 * Turns data/generated/<slug>/profile.json into what the pages show: the Atlas grade, its
 * "because" line, the scorecard's areas and the notices. Everything comes from the deterministic
 * profile; the only AI-written text is the summaries in data/census/summaries.json, tagged as such.
 */

/** The repository's data/ folder, found from where the build runs (the site or the repo root). */
function findData(): string {
  for (let d = process.cwd(); ; d = dirname(d)) {
    if (existsSync(join(d, "data", "generated"))) return `${join(d, "data")}/`;
    if (dirname(d) === d) throw new Error("data/generated not found above the working directory");
  }
}
const ROOT = findData();
const GENERATED = `${ROOT}generated/`;

export type Grade = "A+" | "A" | "B" | "C" | "–";
export type Tone = "few" | "rev" | "ser" | "nd";
export type Level = "low" | "medium" | "high" | "unknown" | "info";

export const GRADES: { g: Grade; word: string; long: string; sub: string; tone: Tone }[] = [
  {
    g: "A+",
    word: "Recommended",
    long: "Recommended, tested in Zotero",
    sub: "Passed the code checks, and behaved as its card describes installed in a live Zotero",
    tone: "few",
  },
  {
    g: "A",
    word: "Recommended",
    long: "Recommended",
    sub: "Every check of the code came out low",
    tone: "few",
  },
  {
    g: "B",
    word: "Use with care",
    long: "Use with care",
    sub: "Read why before installing",
    tone: "rev",
  },
  {
    g: "C",
    word: "Not recommended",
    long: "Not recommended",
    sub: "We found serious problems",
    tone: "ser",
  },
  {
    g: "–",
    word: "Not graded yet",
    long: "Not graded yet",
    sub: "We couldn't check it yet",
    tone: "nd",
  },
];
const G = Object.fromEntries(GRADES.map((x) => [x.g, x])) as Record<Grade, (typeof GRADES)[number]>;
export const RANK: Record<Grade, number> = { "A+": 4, A: 3, B: 2, C: 1, "–": 0 };

export interface Item {
  t: string;
  note?: string;
  tone?: Tone | "accent";
  mono?: boolean;
}
export interface ItemGroup {
  name: string | null;
  items: Item[];
}
export interface Evidence {
  what: string;
  loc: string;
  code: string;
  /** What the finding means here, in a sentence (the badge's second line). */
  note?: string;
}
export interface Area {
  key: "code" | "data" | "caps" | "compat" | "needs" | "maint" | "lang";
  title: string;
  level: Level;
  value: string;
  sub?: string;
  highlight?: boolean;
  groups: ItemGroup[];
  evidence: Evidence[];
}
export interface Notice {
  kind:
    | "lang"
    | "fork"
    | "id"
    | "compat"
    | "legacy"
    | "release"
    | "analysis"
    | "blocklist"
    | "info"
    | "legal";
  t: string;
  sub: string;
}

export interface Plugin {
  slug: string;
  name: string;
  repo: string;
  repoUrl: string;
  issuesUrl: string;
  releasesUrl: string;
  author: string;
  license: string;
  stars: string;
  downloads: string;
  downloadsN: number;
  contributors: string;
  maint: string;
  maintStatus: string;
  /** Explains the maintenance status, for its tooltip. */
  maintTip: string;
  lastActivity: string;
  /** Zotero versions it works with, e.g. ["8", "9", "10", "11 beta"]. */
  worksWith: string[];
  /** The same as a short range, e.g. "8–10, 11 beta". */
  worksRange: string;
  oneLiner: string;
  descSoon: boolean;
  description: string[] | null;
  version: string;
  released: string;
  size: string;
  installUrl: string | null;
  grade: Grade;
  gradeWord: string;
  gradeLong: string;
  gradeTone: Tone;
  because: string;
  next: string;
  jobs: string[];
  categories: string[];
  hidden: boolean;
  /** Why it's hidden from lists ("fork", "legacy", "no-release"), when it is. */
  hiddenReason: string | null;
  addonId: string | null;
  currentOk: boolean;
  currentMajor: number;
  legacy: boolean;
  noRelease: boolean;
  banner: string | null;
  needsKey: boolean;
  /** From the requirements check (data/requirements): required, optional, none, or unknown. */
  keyNeed: "required" | "optional" | "none" | "unknown";
  keyTip: string;
  localModel: boolean;
  needsShort: string;
  chineseDocs: boolean;
  forkOf: { name: string; slug: string | null } | null;
  sameId: number;
  forksCount: number;
  notices: Notice[];
  areas: Area[];
  needs: { t: string; sub: string }[];
  docs: string;
  ui: string;
  compat: { v: string; cur: boolean; ok: boolean | null }[];
  autoText: string;
  liveTest: { zotero: string; date: string; verdict: string } | null;
  searchText: string;
  /** Findings to fix for the next rung, for the developer page. */
  toFix: { t: string; level: Level; evidence: Evidence | null }[];
  passing: string[];
  /** IDs of the capability findings on its card, e.g. "link-installs-addons". */
  capIds: string[];
  /** Where its data goes, as the card's value, e.g. "unknown-endpoints". */
  dataValue: string | null;
  responses: {
    who: string;
    date: string;
    text: string;
    url: string;
    status: string;
    reply: string | null;
  }[];
}

// ---------- formatting ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function fmtCount(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toPrecision(3).replace(/\.?0+$/, "")}M`;
  return n.toLocaleString("en-GB");
}
function fmtSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${mb < 0.1 ? mb.toFixed(2) : mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
export const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const VERBS = new Set(
  "Launches Contacts Runs Downloads Sends Installs Uses Loads Keeps Changes Signs Hands Reuses Writes Watches Opens Lets Turns Adds Reads Stores Decrypts Borrows Disables Imports Injects Starts Makes Asks Registers".split(
    " ",
  ),
);
/** A card reason ("Launches programs on your computer") as the rest of "because …". */
export function becauseClause(reason: string): string {
  if (/^Obfuscated code/.test(reason))
    return reason.replace(/^Obfuscated code/, "its code is obfuscated");
  if (/^Release file replaced/.test(reason))
    return reason.replace(/^Release file replaced/, "its release file was replaced");
  const first = reason.split(/\s/)[0] ?? "";
  const lower = reason.charAt(0).toLowerCase() + reason.slice(1);
  return VERBS.has(first) ? `it ${lower}` : lower;
}

const LANG: Record<string, string> = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  latin: "another language",
};
const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
function localeName(tag: string): string {
  try {
    return displayNames.of(tag) ?? tag;
  } catch {
    return tag;
  }
}
const listJoin = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

const MAINT: Record<string, string> = {
  active: "Active",
  slowing: "Slowing down",
  dormant: "Dormant",
  archived: "Archived",
  unknown: "Unknown",
};

const HOST_GROUP: Record<string, [string, Tone | null]> = {
  "llm-provider": ["AI services", null],
  translation: ["Translation", null],
  "scholarly-api": ["Scholarly services", null],
  zotero: ["Zotero", null],
  integration: ["Apps you connect", null],
  "code-hosting": ["Code hosting", null],
  cdn: ["Content delivery", null],
  documentation: ["Documentation", null],
  telemetry: ["Analytics and tracking", "rev"],
  "cloud-function": ["Cloud functions", "rev"],
  "developer-server": ["Developer's servers", "rev"],
  unknown: ["Not identified", "nd"],
  localhost: ["On your computer", "few"],
};
const HOST_ORDER = [
  "developer-server",
  "cloud-function",
  "unknown",
  "telemetry",
  "llm-provider",
  "translation",
  "scholarly-api",
  "integration",
  "zotero",
  "code-hosting",
  "cdn",
  "documentation",
  "localhost",
];

const CONCERN_LEVEL: Record<string, Level> = {
  none: "low",
  low: "low",
  medium: "medium",
  high: "high",
  unknown: "unknown",
};
const CONCERN_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0, unknown: 0 };
const LEVEL_TONE: Record<string, Tone | undefined> = { medium: "rev", high: "ser" };

/** ["7","8","9","11 beta"] → "7–9, 11 beta". */
function rangeOf(vs: string[]): string {
  const nums = vs.filter((v) => /^\d+$/.test(v)).map(Number);
  const rest = vs.filter((v) => !/^\d+$/.test(v));
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}–${nums[j]}` : String(nums[i]));
    i = j + 1;
  }
  return [...parts, ...rest].join(", ");
}

// ---------- loading ----------

interface Summary {
  does: string;
  pain: string;
}
function loadSummaries(): Record<string, Summary> {
  const f = `${ROOT}census/summaries.json`;
  if (!existsSync(f)) return {};
  return (JSON.parse(readFileSync(f, "utf8")) as { summaries: Record<string, Summary> }).summaries;
}

interface Requirement {
  apiKey: { need: Plugin["keyNeed"]; keyFor: string; worksWithout: string; services: string[] };
  localModel: "yes" | "no" | "unknown";
}
/** The requirements check's answers: each backed by quoted evidence, "unknown" otherwise. */
function loadRequirements(): Record<string, Requirement> {
  const dir = `${ROOT}requirements/`;
  if (!existsSync(dir)) return {};
  const out: Record<string, Requirement> = {};
  for (const f of readdirSync(dir))
    if (f.endsWith(".json")) out[f.slice(0, -5)] = JSON.parse(readFileSync(dir + f, "utf8"));
  return out;
}

interface CodeEv {
  file: string;
  line: number;
  snippet: string;
  inVendoredCode?: boolean;
}
interface ReleaseAnalysis {
  network?: { hosts?: { host: string; category: string; usage: string; evidence: CodeEv[] }[] };
  capabilities?: { id: string; evidence: CodeEv[] }[];
}
function loadRelease(p: PluginProfile): ReleaseAnalysis | null {
  const rf = p.install?.releaseFile;
  if (!rf || !existsSync(GENERATED + rf)) return null;
  try {
    return (
      (JSON.parse(readFileSync(GENERATED + rf, "utf8")) as { analysis?: ReleaseAnalysis })
        .analysis ?? null
    );
  } catch {
    return null;
  }
}
const pickEv = (evs: CodeEv[] | undefined) =>
  (evs ?? []).find((e) => !e.inVendoredCode) ?? evs?.[0];
const toEv = (what: string, e: CodeEv): Evidence => ({
  what,
  loc: `${e.file} · line ${e.line}`,
  code: e.snippet.trim().slice(0, 240),
});

// ---------- the view model ----------

function gradeOf(p: PluginProfile): Grade {
  const t = p.trust;
  if (!t) return "–";
  switch (t.overall.label) {
    case "high-concern":
      return "C";
    case "review-details":
      return "B";
    case "insufficient-data":
      return "–";
    case "low-concern": {
      const cur = t.inputs.currentZotero.split(".")[0];
      const tested = t.tested;
      return tested?.verdict === "as-described" && tested.zotero.split(".")[0] === cur ? "A+" : "A";
    }
  }
}

function build(
  p: PluginProfile,
  summaries: Record<string, Summary>,
  reqs: Record<string, Requirement>,
): Plugin {
  const t = p.trust;
  const f = t?.facets;
  const rel = loadRelease(p);
  const grade = gradeOf(p);
  const gx = G[grade];
  const reasons = t?.overall.reasons ?? [];
  const legacy = p.listing.kind === "legacy";
  const noRelease = p.listing.kind === "no-release" || !p.install;
  const blocked = p.compatibility.blockedByZotero;
  const installProblem = f?.compatibility.installProblem;
  const currentMajor =
    p.compatibility.current?.major ?? Number((t?.inputs.currentZotero ?? "10").split(".")[0]);
  const currentOk = p.compatibility.current?.status === "compatible" && !blocked && !installProblem;
  const tested = t?.tested;
  const summary = summaries[p.repoName] ?? summaries[p.repo];

  // because / next
  let because: string;
  if (grade === "A+")
    because = "every code check came out low, and our live test in Zotero found nothing unexpected";
  else if (grade === "A") because = "every code check came out low";
  else if (grade === "–")
    because = p.scan.reason ? becauseClause(p.scan.reason) : "we couldn't analyse its code yet";
  else {
    because = reasons[0] ? becauseClause(reasons[0]) : "of the findings below";
    if (reasons.length > 1)
      because += `, and ${reasons.length - 1} more finding${reasons.length > 2 ? "s" : ""}`;
  }
  const next =
    grade === "A+"
      ? "Top of the ladder. The A+ lapses if a later release fails a check or the live test."
      : grade === "A"
        ? tested?.verdict === "unexpected"
          ? "Next rung: A+. In our live test it did something its card didn't describe."
          : tested?.verdict === "not-loaded"
            ? "Next rung: A+. It didn't load when we installed it in Zotero."
            : `Next rung: A+, once we've tested it installed in Zotero ${currentMajor}.`
        : grade === "B"
          ? "Next rung: A, once every finding in the code comes out low."
          : grade === "C"
            ? "Next rung: B, once nothing in the code is a serious concern."
            : "We'll grade it once we can check it.";

  // areas
  const areas: Area[] = [];
  const st = f?.sourceTransparency;
  areas.push({
    key: "code",
    title: "Code transparency",
    level: st ? CONCERN_LEVEL[st.concern] : "unknown",
    value: st?.label ?? "Not analysed yet",
    sub: [p.provenance?.explanation, st?.partialAnalysis].filter(Boolean).join(" ") || undefined,
    groups: st?.updates
      ? [
          {
            name: "Updates",
            items: [
              { t: st.updates.label },
              ...(st.updates.check ? [{ t: st.updates.check }] : []),
            ],
          },
        ]
      : [],
    evidence: [],
  });

  const ds = f?.dataSharing;
  const dataEv: Evidence[] = [];
  if (rel?.network?.hosts) {
    const order = (c: string) => HOST_ORDER.indexOf(c);
    for (const h of [...rel.network.hosts]
      .filter((h) => h.usage === "request" && h.category !== "localhost")
      .sort((a, b) => order(a.category) - order(b.category))) {
      const e = pickEv(h.evidence);
      if (e) dataEv.push(toEv(h.host, e));
      if (dataEv.length >= 3) break;
    }
  }
  const hostCount = ds?.hosts.reduce((n, g) => n + g.hosts.length, 0) ?? 0;
  areas.push({
    key: "data",
    title: "Where your data goes",
    level: ds ? CONCERN_LEVEL[ds.concern] : "unknown",
    value: ds?.label ?? "Not checked yet",
    sub: hostCount
      ? `${hostCount} address${hostCount > 1 ? "es" : ""} in ${ds?.hosts.length} group${(ds?.hosts.length ?? 0) > 1 ? "s" : ""}.`
      : undefined,
    groups: [...(ds?.hosts ?? [])]
      .sort((a, b) => HOST_ORDER.indexOf(a.category) - HOST_ORDER.indexOf(b.category))
      .map((g) => {
        const [name, tone] = HOST_GROUP[g.category] ?? [g.category, null];
        return {
          name: `${name} (${g.hosts.length})`,
          items: g.hosts.map((h) => {
            const note = g.unencrypted?.includes(h)
              ? "unencrypted"
              : g.observed?.includes(h)
                ? "seen when we ran it"
                : g.unconfirmed?.includes(h)
                  ? "named in its code"
                  : undefined;
            return {
              t: h,
              mono: true,
              note,
              tone: (note === "unencrypted" ? "rev" : tone) ?? undefined,
            };
          }),
        };
      }),
    evidence: dataEv,
  });

  const caps = f?.capabilities;
  const badges = [...(caps?.badges ?? [])].sort(
    (a, b) => CONCERN_RANK[b.concern] - CONCERN_RANK[a.concern],
  );
  // Every medium or high finding gets its evidence, with what it means here.
  const capEv: Evidence[] = [];
  for (const b of badges.filter((b) => CONCERN_RANK[b.concern] >= 2)) {
    const e = pickEv(rel?.capabilities?.find((c) => c.id === b.id)?.evidence);
    if (e)
      capEv.push({
        ...toEv(b.label.length > 70 ? `${b.label.slice(0, 68)}…` : b.label, e),
        ...(b.detail ? { note: b.detail } : {}),
      });
  }
  areas.push({
    key: "caps",
    title: "Powerful capabilities",
    level: caps ? CONCERN_LEVEL[caps.concern] : "unknown",
    value: !caps
      ? "Not checked yet"
      : badges.length
        ? badges[0].label + (badges.length > 1 ? `, and ${badges.length - 1} more` : "")
        : "No powerful capabilities found",
    groups: badges.length
      ? [
          {
            name: null,
            items: badges.map((b) => ({
              t: b.label + (b.libraries?.length ? ` (from ${b.libraries.join(", ")})` : ""),
              note: b.concern === "none" ? undefined : b.concern,
              tone: LEVEL_TONE[b.concern],
            })),
          },
        ]
      : [],
    evidence: capEv,
  });

  // compatibility rows
  const majors = new Set<number>(p.compatibility.supports);
  for (const c of [p.compatibility.previous, p.compatibility.current, p.compatibility.next])
    if (c) majors.add(c.major);
  const nextMajor = p.compatibility.next?.major;
  const compat = [...majors]
    .filter((m) => m >= 7 || legacy)
    .sort((a, b) => a - b)
    .map((m) => {
      const target = [p.compatibility.previous, p.compatibility.current, p.compatibility.next].find(
        (c) => c?.major === m,
      );
      const ok = target
        ? target.status === "unknown"
          ? null
          : target.status === "compatible"
        : p.compatibility.supports.includes(m);
      return {
        v: m === nextMajor ? `${m} beta` : String(m),
        cur: m === currentMajor,
        ok: blocked || installProblem ? false : ok,
      };
    });
  const okList = compat.filter((c) => c.ok).map((c) => c.v);
  const noList = compat.filter((c) => c.ok === false).map((c) => c.v);
  const autoText = blocked
    ? "On Zotero's official blocklist"
    : installProblem
      ? "Zotero won't install this file"
      : p.install?.autoUpdates
        ? "Updates automatically"
        : "Manual updates only";
  areas.push({
    key: "compat",
    title: "Works with",
    level: currentOk ? "info" : "medium",
    value: legacy
      ? "Zotero 6 only (legacy plugin)"
      : blocked
        ? "Blocked by Zotero"
        : installProblem
          ? "Zotero won't install this file"
          : okList.length
            ? `Zotero ${okList.join(", ")}${noList.length ? ` · not ${noList.join(", ")}` : ""}`
            : "No Zotero version we know of",
    sub: currentOk ? autoText : `Doesn't work with the current Zotero (${currentMajor})`,
    groups: [
      {
        name: null,
        items: compat.map((c) => ({
          t: `Zotero ${c.v}  ${c.ok ? "✓ works" : c.ok === false ? "✗ doesn't work" : "? not known"}`,
          tone: c.ok ? "few" : c.v.includes("beta") || c.ok === null ? "nd" : "rev",
        })),
      },
    ],
    evidence: [],
  });

  // what you'll need: only what the requirements check could show from quoted evidence
  // (data/requirements); "unknown" shows nothing. The code alone can't tell whether a stored key is
  // required, and a local address isn't necessarily a model.
  const req = reqs[p.slug];
  const keyNeed = req?.apiKey.need ?? "unknown";
  const svc = req?.apiKey.services.length ? ` (${listJoin(req.apiKey.services)})` : "";
  const keyTip =
    keyNeed === "required"
      ? `Needs a key you get from the service${svc}. What needs it: ${req?.apiKey.keyFor}.`
      : keyNeed === "optional"
        ? `Works without one: ${req?.apiKey.worksWithout}. Needs a key${svc}: ${req?.apiKey.keyFor}.`
        : keyNeed === "none"
          ? "Nothing in it needs a key you supply."
          : "";
  const needs: { t: string; sub: string }[] = [];
  if (keyNeed === "required") needs.push({ t: "An API key", sub: keyTip });
  if (keyNeed === "optional") needs.push({ t: "An API key for some features", sub: keyTip });
  const needsKey = keyNeed === "required";
  const localModel = req?.localModel === "yes";
  if (localModel)
    needs.push({
      t: "Or: a model on your own computer",
      sub: "It can use a local model such as Ollama",
    });
  if (!currentOk && compat.length && !legacy)
    needs.push({
      t: okList.length ? `Zotero ${okList.join(", ")}` : "An older Zotero",
      sub: `Not working with Zotero ${currentMajor}`,
    });
  const needsShort =
    keyNeed === "required"
      ? "Needs an API key"
      : keyNeed === "optional"
        ? "API key optional"
        : keyNeed === "none"
          ? "No API key needed"
          : "";
  areas.push({
    key: "needs",
    title: "What you'll need",
    level: t ? "info" : "unknown",
    value: needs[0]?.t ?? (t ? "Nothing extra detected" : "Not detected yet"),
    sub: t ? "Detected automatically from its code" : undefined,
    groups: [],
    evidence: [],
  });

  const m = p.maintenance;
  const maint = MAINT[m.status] ?? "Unknown";
  areas.push({
    key: "maint",
    title: "Maintenance",
    level: "info",
    value: `${maint}${m.lastReleaseAt ? ` · last release ${fmtDate(m.lastReleaseAt)}` : ""}`,
    sub: p.popularity.contributors
      ? `${p.popularity.contributors} contributor${p.popularity.contributors > 1 ? "s" : ""}`
      : undefined,
    groups: [],
    evidence: [],
  });

  const L = p.languages;
  const docsLangs = L.docs.map((d) => LANG[d] ?? d);
  const docs = L.chineseOnlyDocs
    ? "Chinese only"
    : docsLangs.length
      ? listJoin(docsLangs)
      : "Not detected";
  const uiNames = [...new Set(L.ui.map((tag) => localeName(tag.split(/[-_]/)[0] ?? tag)))];
  const ui = uiNames.length ? listJoin(uiNames) : "Not declared";
  areas.push({
    key: "lang",
    title: "Languages",
    level: "info",
    value: L.chineseOnlyDocs
      ? "Documentation in Chinese only"
      : docsLangs.length
        ? `Documentation in ${listJoin(docsLangs)}`
        : "Documentation language not detected",
    highlight: L.chineseOnlyDocs,
    sub: uiNames.length ? `Interface: ${ui}` : "Interface language not declared",
    groups: [],
    evidence: [],
  });

  // notices
  const notices: Notice[] = [];
  if (blocked)
    notices.push({ kind: "blocklist", t: "On Zotero's official blocklist", sub: blocked.reason });
  if (legacy)
    notices.push({
      kind: "legacy",
      t: "Legacy plugin for Zotero 6 only",
      sub: "Uses the old plugin format. Zotero 7 and later can't load it.",
    });
  if (noRelease && !legacy)
    notices.push({
      kind: "release",
      t: "No installable release",
      sub: "We couldn't find a release file for current Zotero on GitHub.",
    });
  if (installProblem)
    notices.push({
      kind: "compat",
      t: "Zotero won't install this file",
      sub:
        t?.facets.compatibility.label ??
        "Its manifest fails one of the checks Zotero makes before installing.",
    });
  else if (!currentOk && !legacy && !noRelease && !blocked)
    notices.push({
      kind: "compat",
      t: `Doesn't work with the current Zotero (${currentMajor})`,
      sub: okList.length ? `Works with Zotero ${okList.join(", ")}.` : "",
    });
  if (p.scan.status === "not-analyzed")
    notices.push({
      kind: "analysis",
      t: "Code not analysed",
      sub: p.scan.reason ?? "We couldn't analyse the release file yet.",
    });
  if (p.fork)
    notices.push({
      kind: "fork",
      t: `Fork of ${p.fork.of}`,
      sub: "A copy of another listed plugin, changed by someone else.",
    });
  if (p.addonIdSharedWith.length)
    notices.push({
      kind: "id",
      t: "Another plugin uses the same ID",
      sub: `${p.addonIdSharedWith.length === 1 ? "One other plugin shares" : `${p.addonIdSharedWith.length} other plugins share`} this add-on ID. Zotero can only install one of them.`,
    });
  if (L.chineseOnlyDocs)
    notices.push({
      kind: "lang",
      t: "Documentation in Chinese only",
      sub: "Our summary is in English, but the plugin's own docs and support are in Chinese.",
    });
  if (ds?.legalRisk)
    notices.push({
      kind: "legal",
      t: "Contacts a shadow library",
      sub: "Using a site such as Sci-Hub carries legal risk in some countries.",
    });
  for (const n of p.notices ?? []) notices.push({ kind: "info", t: n.text, sub: fmtDate(n.date) });

  // developer checklist
  const toFix: Plugin["toFix"] = [];
  if (grade === "B" || grade === "C") {
    const want = grade === "C" ? 3 : 2;
    for (const b of badges.filter((b) => CONCERN_RANK[b.concern] >= want)) {
      const e = pickEv(rel?.capabilities?.find((c) => c.id === b.id)?.evidence);
      toFix.push({
        t: b.label,
        level: CONCERN_LEVEL[b.concern],
        evidence: e ? toEv(b.id, e) : null,
      });
    }
    if (st && CONCERN_RANK[st.concern] >= want)
      toFix.push({ t: st.label, level: CONCERN_LEVEL[st.concern], evidence: null });
    if (ds && CONCERN_RANK[ds.concern] >= want)
      toFix.push({ t: ds.label, level: CONCERN_LEVEL[ds.concern], evidence: dataEv[0] ?? null });
    if (!toFix.length)
      for (const r of reasons)
        toFix.push({ t: r, level: grade === "C" ? "high" : "medium", evidence: null });
  }
  const passing: string[] = [];
  if (st && CONCERN_RANK[st.concern] <= 1) passing.push(st.label);
  if (ds && CONCERN_RANK[ds.concern] <= 1) passing.push(ds.label);
  if (caps && CONCERN_RANK[caps.concern] <= 1)
    passing.push(
      badges.length ? "No powerful capability above low concern" : "No powerful capabilities found",
    );
  if (currentOk) passing.push(`Works with Zotero ${currentMajor}`);

  const oneLiner =
    summary?.does.split(/(?<=\.)\s/)[0] ??
    p.about.githubDescription ??
    p.about.manifestDescription ??
    "Description coming soon.";
  const size = p.install ? fmtSize(p.install.asset.size) : "";
  const jobs = jobsFor(p);

  return {
    slug: p.slug,
    name: p.name,
    repo: p.repoName,
    repoUrl: p.links.repo,
    issuesUrl: p.links.issues,
    releasesUrl: p.links.releases,
    author: p.author.login,
    license: p.license ?? "None stated",
    stars: fmtCount(p.popularity.stars),
    downloads: fmtCount(p.popularity.downloads),
    downloadsN: p.popularity.downloads ?? 0,
    contributors: fmtCount(p.popularity.contributors),
    maint,
    maintStatus: m.status,
    maintTip: {
      active: `Last commit or release on ${fmtDate(m.lastActivityAt)}, within the past 6 months.`,
      slowing: `No commit or release since ${fmtDate(m.lastActivityAt)}: 6 to 18 months ago.`,
      dormant: `No commit or release since ${fmtDate(m.lastActivityAt)}, more than 18 months ago. Problems may not get fixed.`,
      archived: "The developer has archived the repository: it won't get updates or fixes.",
      unknown: "We couldn't tell when it was last worked on.",
    }[m.status],
    lastActivity: fmtDate(m.lastActivityAt),
    worksWith: okList,
    worksRange: rangeOf(okList),
    oneLiner,
    descSoon: !summary && !p.about.githubDescription && !p.about.manifestDescription,
    description: summary ? [summary.does, summary.pain] : null,
    version: p.install?.version ?? "",
    released: fmtDate(p.install?.publishedAt ?? m.lastReleaseAt),
    size,
    installUrl: blocked || noRelease || installProblem ? null : (p.install?.asset.url ?? null),
    grade,
    gradeWord: gx.word,
    gradeLong: gx.long,
    gradeTone: gx.tone,
    because,
    next,
    jobs,
    categories: jobs.map((j) => JOB_BY_SLUG[j].title),
    hidden: p.listing.hiddenByDefault,
    hiddenReason: p.listing.hiddenReason ?? null,
    addonId: p.addonId ?? null,
    currentOk,
    currentMajor,
    legacy,
    noRelease,
    banner: blocked ? `${blocked.reason} It will not install.` : null,
    needsKey,
    keyNeed,
    keyTip,
    localModel,
    needsShort,
    chineseDocs: L.chineseOnlyDocs,
    forkOf: p.fork ? { name: p.fork.of, slug: p.fork.ofSlug } : null,
    sameId: p.addonIdSharedWith.length,
    forksCount: p.forks.length,
    notices,
    areas,
    needs,
    docs,
    ui,
    compat,
    autoText,
    liveTest: tested
      ? { zotero: tested.zotero, date: fmtDate(tested.testedAt), verdict: tested.verdict }
      : null,
    searchText: [
      p.name,
      p.repoName,
      p.about.githubDescription,
      p.about.manifestDescription,
      summary?.does,
      p.about.topics.join(" "),
      jobs.map((j) => JOB_BY_SLUG[j].title).join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    toFix,
    passing,
    capIds: badges.map((b) => b.id),
    dataValue: ds?.value ?? null,
    responses: (p.responses ?? []).map((r) => ({
      who: r.from,
      date: fmtDate(r.date),
      text: r.text,
      url: r.url,
      status: r.status,
      reply: r.reply ?? null,
    })),
  };
}

let cache: Plugin[] | null = null;
/** Every profiled plugin, most downloaded first. `hidden` ones (forks, legacy, no release) have pages but stay out of lists. */
export function allPlugins(): Plugin[] {
  if (cache) return cache;
  const summaries = loadSummaries();
  const reqs = loadRequirements();
  const out: Plugin[] = [];
  for (const slug of readdirSync(GENERATED)) {
    const f = `${GENERATED}${slug}/profile.json`;
    if (!existsSync(f)) continue;
    out.push(build(JSON.parse(readFileSync(f, "utf8")) as PluginProfile, summaries, reqs));
  }
  out.sort((a, b) => b.downloadsN - a.downloadsN);
  cache = out;
  return out;
}
/** What the live test showed, for the scorecard's meta line and the cards. */
export function testedText(p: Plugin, short = false): string {
  const t = p.liveTest;
  if (!t) return short ? "code checked only" : "Code checked · not yet tested in a live Zotero";
  if (t.verdict === "as-described")
    return short
      ? `tested in Zotero ${t.zotero}`
      : `Code checked · tested installed in Zotero ${t.zotero} on ${t.date}`;
  if (t.verdict === "unexpected")
    return short
      ? "live test: did something unexpected"
      : `Code checked · in Zotero ${t.zotero} on ${t.date} it did something its card didn't describe`;
  if (t.verdict === "not-loaded")
    return short
      ? "didn't load in our live test"
      : `Code checked · it didn't load when we installed it in Zotero ${t.zotero}`;
  return short
    ? "code checked; live test incomplete"
    : `Code checked · the live test in Zotero ${t.zotero} was incomplete`;
}

export const shownPlugins = () => allPlugins().filter((p) => !p.hidden);

/** IDs that templates ship with as a placeholder, so plugins sharing one are otherwise unrelated. */
const TEMPLATE_IDS = new Set(["addontemplate@euclpts.com"]);

export interface SameIdGroup {
  id: string;
  /** The URL segment of its page, /id/<path>. */
  path: string;
  /** Most downloaded first. */
  plugins: Plugin[];
  /** copies: the others are forks of the most used one or carry its name; template: a template's placeholder ID; shared: neither. */
  cause: "copies" | "template" | "shared";
}

let groups: Map<string, SameIdGroup> | null = null;
/** Every add-on ID that two or more profiled plugins share, built once per site build. */
export function sameIdGroups(): Map<string, SameIdGroup> {
  if (groups) return groups;
  const byId = new Map<string, Plugin[]>();
  for (const p of allPlugins())
    if (p.addonId) byId.set(p.addonId, [...(byId.get(p.addonId) ?? []), p]);
  groups = new Map();
  // A name's core: no brackets, no "zotero", "for", "pdf" or "plugin", letters and digits only.
  const core = (t: string) =>
    t
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/\b(zotero\d*|for|pdf|plugin)\b/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const repoCore = (r: string) => core(r.split("/").pop() ?? "");
  for (const [id, plugins] of byId) {
    if (plugins.length < 2) continue;
    const [top, ...rest] = plugins; // allPlugins() is most downloaded first
    const isCopy = (x: Plugin) =>
      x.forkOf?.slug === top.slug ||
      (core(x.name) !== "" && core(x.name) === core(top.name)) ||
      (repoCore(top.repo).length > 2 && repoCore(x.repo).includes(repoCore(top.repo)));
    const cause = TEMPLATE_IDS.has(id) ? "template" : rest.every(isCopy) ? "copies" : "shared";
    groups.set(id, { id, path: id.toLowerCase().replace(/[^a-z0-9.]+/g, "-"), plugins, cause });
  }
  return groups;
}
export const sameIdGroupOf = (p: Plugin) => (p.addonId ? sameIdGroups().get(p.addonId) : undefined);
export const bySlug = () => Object.fromEntries(allPlugins().map((p) => [p.slug, p]));

/** Other shown plugins for the same job, best grade first, then most downloaded. */
export function alternatives(p: Plugin, n = 4, betterThan?: Grade): Plugin[] {
  return shownPlugins()
    .filter((x) => x.slug !== p.slug && x.jobs.some((j) => p.jobs.includes(j)))
    .filter((x) => !betterThan || RANK[x.grade] > RANK[betterThan])
    .sort((a, b) => RANK[b.grade] - RANK[a.grade] || b.downloadsN - a.downloadsN)
    .slice(0, n);
}

export const CURRENT_ZOTERO_MAJOR = () => shownPlugins()[0]?.currentMajor ?? 10;

/** Plain-language text about a shared ID, worded by its cause; `from` is the plugin whose page shows it. */
export function sameIdText(g: SameIdGroup, from?: Plugin) {
  const top = g.plugins[0];
  const others = g.plugins.length - 1;
  const tag = "Every Zotero plugin carries an ID, a name tag Zotero uses to tell plugins apart.";
  const why =
    g.cause === "copies"
      ? `These ${g.plugins.length} plugins carry the same one, because people copied ${top.name} to make their own versions and kept its ID.`
      : g.cause === "template"
        ? "Developers often start from a ready-made template, which comes with a placeholder ID. These plugins never replaced it, so they have nothing in common except that ID."
        : `These ${g.plugins.length} plugins carry the same one.`;
  const n = from ? others : g.plugins.length;
  const heading = from
    ? `${n === 1 ? "1 other plugin uses" : `${n} other plugins use`} the same ID as this one`
    : `${n} plugins share one ID`;
  const longWhy =
    g.cause === "copies"
      ? `Zotero plugins are open source, so anyone can copy one, change it and publish their own version. Each plugin has an ID that's meant to be unique, but when people copy a plugin they often keep its ID. That's what happened here: ${top.name} was copied.`
      : g.cause === "template"
        ? "Developers often start a new plugin from a ready-made template. The template comes with a placeholder ID, meant to be replaced. These plugins kept it, so Zotero can't tell them apart, even though they do different things."
        : "Each plugin has an ID that's meant to be unique, but these plugins use the same one. We can't tell from their code or names why.";
  return { tag, why, heading, longWhy };
}
