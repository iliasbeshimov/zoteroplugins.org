import type { Concern, TrustCard } from "@atlas/schema";
import { ANALYZER_VERSION, type CheckResult, RULES_VERSION } from "./check.ts";
import type { CheckData } from "./data.ts";

/** The check's Markdown report: what the catalogue's code checks say about each built file. */

/** Who runs a host, in the words the site's data-flow lists use (site/src/lib/atlas.ts). */
const HOST_GROUP: Record<string, string> = {
  "llm-provider": "AI services",
  translation: "Translation",
  "scholarly-api": "Scholarly services",
  zotero: "Zotero",
  integration: "Apps you connect",
  "code-hosting": "Code hosting",
  cdn: "Content delivery",
  documentation: "Documentation",
  telemetry: "Analytics and tracking",
  "cloud-function": "Cloud functions",
  "developer-server": "Developer's servers",
  unknown: "Not identified",
  localhost: "On your computer",
};
/** Most worrying first, as the site orders them. */
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

const RANK: Record<Concern, number> = { none: 0, low: 1, unknown: 2, medium: 2, high: 3 };
const LEVEL: Record<Concern, string> = {
  none: "Not a concern",
  low: "Low concern",
  unknown: "Medium concern",
  medium: "Medium concern",
  high: "High concern",
};

/** The grade ordering for --fail-on: C is the worst. */
export const FAIL_ORDER = { C: 1, B: 2, A: 3 } as const;

export type FailOn = "B" | "C";

/** Whether a grade is at or below the threshold; "–" (not graded) never fails the check. */
export function failsOn(grade: CheckResult["grade"], failOn: FailOn | undefined): boolean {
  if (!failOn || grade === "–") return false;
  return FAIL_ORDER[grade] <= FAIL_ORDER[failOn];
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The findings that cost grade points: everything at medium concern or worse, worst first. */
export function costlyFindings(card: TrustCard): { concern: Concern; text: string }[] {
  const out: { concern: Concern; text: string }[] = [];
  const st = card.facets.sourceTransparency;
  // "We haven't checked the source match" is a gap in our checks, not a finding (it never counts).
  const stReal = st.drivers.filter((d) => !["ST-NOT-CHECKED", "ST-PLAUSIBLE"].includes(d));
  if (stReal.length && RANK[st.concern] >= 2) out.push({ concern: st.concern, text: st.label });
  const ds = card.facets.dataSharing;
  if (RANK[ds.concern] >= 2) out.push({ concern: ds.concern, text: ds.label });
  for (const b of card.facets.capabilities.badges)
    if (RANK[b.concern] >= 2)
      out.push({
        concern: b.concern,
        text: b.libraries ? `${b.label} (from ${b.libraries.join(", ")})` : b.label,
      });
  return out.sort((a, b) => RANK[b.concern] - RANK[a.concern]);
}

function destinations(r: CheckResult): string[] {
  const hosts = r.card.facets.dataSharing.hosts;
  if (!hosts.length) return ["Its code names no web addresses we could identify."];
  const lines: string[] = [];
  const order = (c: string) => {
    const i = HOST_ORDER.indexOf(c);
    return i < 0 ? HOST_ORDER.length : i;
  };
  for (const group of [...hosts].sort((a, b) => order(a.category) - order(b.category))) {
    const named = (h: string) => {
      const provider = r.providers[h];
      const notes = [
        ...(provider && provider !== h ? [provider] : []),
        ...(group.unencrypted?.includes(h) ? ["plain http, unencrypted"] : []),
      ];
      return notes.length ? `${h} (${notes.join("; ")})` : h;
    };
    // A host its code names without a request we could trace is listed apart from the ones it
    // visibly contacts.
    const unconfirmed = new Set(group.unconfirmed ?? []);
    const traced = group.hosts.filter((h) => !unconfirmed.has(h)).map(named);
    const mentioned = group.hosts.filter((h) => unconfirmed.has(h));
    const parts = [
      ...(traced.length ? [traced.join(", ")] : []),
      ...(mentioned.length
        ? [`named in its code, no request traced: ${mentioned.join(", ")}`]
        : []),
    ];
    lines.push(`- **${HOST_GROUP[group.category] ?? group.category}**: ${parts.join("; ")}`);
  }
  return lines;
}

function notChecked(r: CheckResult): string[] {
  const lines = [
    "- **Who uploads the release file.** The catalogue notes whether GitHub's own build or a person uploads it, and whether the file changes after you publish it.",
    r.updateUrl
      ? `- **The update address.** Zotero installs whatever ${r.updateUrl} offers, so the catalogue fetches it, grades the file it serves, and checks that the GitHub account or repository it names exists (an update address nobody holds costs a grade). This check only reads the address in the manifest.`
      : "- **The update address.** The manifest has none; Zotero 7 and later won't install a plugin without one.",
    "- **Our live test in Zotero.** It earns A+, and it settles network code the static check couldn't trace. CI can't run it.",
  ];
  if (r.reviewedAs)
    lines.push(
      r.reviewsApplied.length || r.networkReviewApplied
        ? `- **Hand reviews.** ${r.reviewsApplied.length + (r.networkReviewApplied ? 1 : 0)} of our reviews of ${r.reviewedAs} apply to this build and are counted above. A review names the exact file or the same code, so a build whose code changed goes back to the automatic result until we review it again.`
        : `- **Hand reviews.** We have reviewed ${r.reviewedAs} before, but not this build's code, so none applies here; the catalogue grades it by the automatic checks until we review it again.`,
    );
  else
    lines.push(
      "- **Hand reviews.** We review some findings by hand (a download, a server it runs); a listed plugin's reviews apply when its repository is given with `--repo` or `GITHUB_REPOSITORY`.",
    );
  lines.push(
    "- **Also on the published card:** Zotero's blocklist, the compatibility check against the latest Zotero, how recently the project was updated, and the project's own responses.",
  );
  return lines;
}

function one(r: CheckResult): string[] {
  const c = r.card;
  const lines: string[] = [];
  lines.push(`## ${r.name} ${r.version}`, "");
  lines.push(
    r.grade === "–"
      ? `**Not graded yet**, because ${r.because}.`
      : `**Grade from the code: ${r.grade}**, because ${r.because}.`,
    "",
  );
  lines.push(
    r.grade === "A"
      ? "This is what the code alone earns. It stops at A: an A+ also needs our live test in Zotero, which CI can't run."
      : "This is what the code alone earns. The published grade also looks at the release and our live test.",
    "",
  );
  if (c.overall.label === "checking")
    lines.push(
      "Network code the static check can't trace is settled by our live test in Zotero or a hand review. The catalogue shows no grade until then, and this check can't give one.",
      "",
    );
  if (c.overall.label === "insufficient-data")
    lines.push(
      "We couldn't analyse enough of this file to grade it (most of it is code we can't read).",
      "",
    );
  lines.push(`### Where it sends data`, "", `${c.facets.dataSharing.label}.`, "");
  lines.push(...destinations(r), "");
  if (c.facets.dataSharing.legalRisk)
    lines.push("It names a destination with legal risks (a shadow library).", "");
  const badges = c.facets.capabilities.badges;
  lines.push("### What it can do", "");
  if (!badges.length) lines.push("Nothing the check flags.", "");
  else {
    lines.push("| Concern | Capability |", "|---|---|");
    for (const b of badges)
      lines.push(
        `| ${LEVEL[b.concern]} | **${esc(b.label)}**${b.detail ? `: ${esc(b.detail)}` : ""} |`,
      );
    lines.push("");
  }
  const costly = costlyFindings(c);
  lines.push("### Findings that cost grade points", "");
  if (!costly.length) lines.push("None. Every code check came out low.", "");
  else {
    for (const f of costly) lines.push(`- **${LEVEL[f.concern]}.** ${f.text}`);
    lines.push("");
  }
  lines.push("### Not checked before release", "", ...notChecked(r), "");
  lines.push(
    `<sub>${r.file} · SHA-256 ${r.sha256.slice(0, 12)} · ${(r.size / 1024).toFixed(0)} KB · ${c.facets.compatibility.label}</sub>`,
    "",
  );
  return lines;
}

/** Days after which the tables are called out as old: the catalogue's change nightly. */
export const STALE_DAYS = 45;

export function renderReport(results: CheckResult[], data: CheckData, now = new Date()): string {
  const lines = ["# Zotero Plugins check", ""];
  const age = Math.floor((now.getTime() - Date.parse(data.builtAt)) / 86_400_000);
  if (age > STALE_DAYS)
    lines.push(
      `> The tables this check reads (hosts, libraries, reviews) are ${age} days old, so the catalogue may say something different today. Update to the latest release of the check.`,
      "",
    );
  for (const r of results) lines.push(...one(r));
  lines.push(
    "### Versions",
    "",
    `Analyzer ${ANALYZER_VERSION}, rules ${RULES_VERSION}, hosts table ${data.hostsVersion}, tables built ${data.builtAt.slice(0, 10)}. ` +
      "Nothing about the plugin was sent anywhere: the check ran on this machine, on the file alone. " +
      "Results follow the catalogue at zoteroplugins.org.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
