import type { PluginProfile } from "@atlas/schema";

interface Meta {
  generatedAt: string;
  censusGeneratedAt: string;
  analyzerVersion: string;
  hostsTableVersion: string;
  currentMajor: number;
  nextMajor: number | null;
}

const LABEL_TEXT: Record<string, string> = {
  "high-concern": "Serious concerns found",
  "review-details": "Review the details",
  "low-concern": "Few concerns found",
  "insufficient-data": "Not enough data",
  none: "Not analyzed",
};

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");

function tally<T>(items: T[], key: (t: T) => string | string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    for (const v of Array.isArray(k) ? k : [k]) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"));
}

/** Markdown table; numeric columns (judged from the first row) are right-aligned. */
const table = (head: string[], rows: (string | number)[][]) =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map((_, i) => (i > 0 && /^[\d,.%–-]+$/.test(String(rows[0]?.[i] ?? "")) ? "---:" : "---")).join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

const contactsAi = (p: PluginProfile) =>
  p.trust?.facets.dataSharing.hosts.some((h) => h.category === "llm-provider") ?? false;

export function buildProfileReport(profiles: PluginProfile[], meta: Meta): string {
  const shown = profiles.filter((p) => !p.listing.hiddenByDefault);
  const analyzed = profiles.filter((p) => p.scan.status === "analyzed");
  const installable = profiles.filter((p) => p.listing.kind !== "no-release");
  const label = (p: PluginProfile) => p.trust?.overall.label ?? "none";
  const lines: string[] = [];
  lines.push(
    "# Plugin profiles",
    "",
    `Generated ${meta.generatedAt.slice(0, 16).replace("T", " ")} UTC from the census of ${meta.censusGeneratedAt.slice(0, 10)}.`,
    `Analyzer ${meta.analyzerVersion}, hosts table ${meta.hostsTableVersion}. Deterministic: no LLM was used.`,
    "",
    "Labels are previews: the check that the released file matches its source code is only a",
    "first pass (was it uploaded by the project's GitHub Actions workflow?), and no card has been",
    "reviewed by a person yet.",
    "",
    "## Directory",
    "",
    table(
      ["", "Profiles", "Shown by default"],
      [
        [
          "Zotero 7+ plugins",
          profiles.filter((p) => p.listing.kind === "plugin").length,
          shown.filter((p) => p.listing.kind === "plugin").length,
        ],
        [
          "Legacy (Zotero 6 and earlier)",
          profiles.filter((p) => p.listing.kind === "legacy").length,
          0,
        ],
        ["No release on GitHub", profiles.filter((p) => p.listing.kind === "no-release").length, 0],
        ["**Total**", profiles.length, shown.length],
      ],
    ),
    "",
    `Forks hidden behind their original: ${profiles.filter((p) => p.listing.hiddenReason === "fork").length}. ` +
      `Forks shown because they overtook the original: ${profiles.filter((p) => p.fork?.ofSlug && !p.listing.hiddenByDefault).length}. ` +
      `Plugins sharing an add-on ID with another listed plugin: ${profiles.filter((p) => p.addonIdSharedWith.length).length}.`,
    "",
    "## Scorecards",
    "",
    `Analyzed ${analyzed.length} of ${installable.length} installable plugins (${pct(analyzed.length, installable.length)}).`,
    "",
    table(
      ["Label", "All profiles", "Shown by default"],
      ["high-concern", "review-details", "low-concern", "insufficient-data", "none"].map((l) => [
        LABEL_TEXT[l] ?? l,
        profiles.filter((p) => label(p) === l).length,
        shown.filter((p) => label(p) === l).length,
      ]),
    ),
    "",
    "What drove the labels (shown by default):",
    "",
    table(
      ["Rule", "Plugins"],
      tally(
        shown.filter((p) => p.trust),
        (p) => {
          const f = p.trust?.facets;
          return [
            ...(f?.sourceTransparency.drivers ?? []),
            ...(f?.dataSharing.drivers ?? []),
            ...(f?.capabilities.drivers ?? []),
          ];
        },
      ),
    ),
    "",
    "Source match, first pass:",
    "",
    table(
      ["", "Plugins"],
      [
        [
          "Uploaded by the project's GitHub Actions workflow",
          analyzed.filter((p) => p.trust?.facets.sourceTransparency.provenance === "plausible")
            .length,
        ],
        [
          "GitHub build attestation present",
          analyzed.filter((p) => p.provenance?.attestation).length,
        ],
        [
          "Not checked yet",
          analyzed.filter((p) => p.trust?.facets.sourceTransparency.provenance === "not-checked")
            .length,
        ],
      ],
    ),
    "",
  );

  const notAnalyzed = tally(
    installable.filter((p) => p.scan.status !== "analyzed"),
    (p) =>
      (p.scan.reason ?? "unknown")
        .replace(/[\w.-]+\.xpi/g, "<file>")
        .replace(/\d+ MB/, "N MB")
        .replace(/release \S+/, "release <tag>"),
  );
  if (notAnalyzed.length) {
    lines.push("Not analyzed:", "", table(["Reason", "Plugins"], notAnalyzed.slice(0, 10)), "");
  }

  lines.push(
    "## Ease of use",
    "",
    table(
      ["", "Plugins", "Share of installable"],
      [
        [
          `Works with Zotero ${meta.currentMajor}`,
          installable.filter((p) => p.compatibility.current?.status === "compatible").length,
          pct(
            installable.filter((p) => p.compatibility.current?.status === "compatible").length,
            installable.length,
          ),
        ],
        ...(meta.nextMajor
          ? [
              [
                `Declares Zotero ${meta.nextMajor} (beta) support`,
                installable.filter((p) => p.compatibility.next?.status === "compatible").length,
                pct(
                  installable.filter((p) => p.compatibility.next?.status === "compatible").length,
                  installable.length,
                ),
              ],
            ]
          : []),
        [
          "Updates automatically through Zotero",
          installable.filter((p) => p.install?.autoUpdates).length,
          pct(installable.filter((p) => p.install?.autoUpdates).length, installable.length),
        ],
        [
          // From the card's destinations, not every AI hostname that appears in the code.
          "Contacts an AI service",
          analyzed.filter(contactsAi).length,
          pct(analyzed.filter(contactsAi).length, installable.length),
        ],
        [
          "Stores an API key, token or password",
          analyzed.filter((p) => p.requirementsHints?.storesCredentials).length,
          pct(
            analyzed.filter((p) => p.requirementsHints?.storesCredentials).length,
            installable.length,
          ),
        ],
        [
          "Launches programs on your computer",
          analyzed.filter((p) => p.requirementsHints?.launchesPrograms).length,
          pct(
            analyzed.filter((p) => p.requirementsHints?.launchesPrograms).length,
            installable.length,
          ),
        ],
        [
          "On Zotero's blocklist (this version)",
          profiles.filter((p) => p.compatibility.blockedByZotero).length,
          "",
        ],
      ],
    ),
    "",
    "AI services named in the code:",
    "",
    table(
      ["Service", "Plugins"],
      tally(analyzed, (p) => p.requirementsHints?.aiServices ?? []).slice(0, 15),
    ),
    "",
    "## Languages",
    "",
    table(
      ["", "Plugins", "Share"],
      [
        [
          "README in Chinese only (no linked English version)",
          profiles.filter((p) => p.languages.chineseOnlyDocs).length,
          pct(profiles.filter((p) => p.languages.chineseOnlyDocs).length, profiles.length),
        ],
        [
          "Interface in Chinese only",
          profiles.filter((p) => p.languages.chineseOnlyUi).length,
          pct(profiles.filter((p) => p.languages.chineseOnlyUi).length, profiles.length),
        ],
        [
          "README includes English",
          profiles.filter(
            (p) => p.languages.docs.includes("en") || p.languages.docsAlternates.includes("en"),
          ).length,
          pct(
            profiles.filter(
              (p) => p.languages.docs.includes("en") || p.languages.docsAlternates.includes("en"),
            ).length,
            profiles.length,
          ),
        ],
        [
          "No README, or too short to tell",
          profiles.filter((p) => !p.languages.docs.length).length,
          pct(profiles.filter((p) => !p.languages.docs.length).length, profiles.length),
        ],
      ],
    ),
    "",
    "Main README language:",
    "",
    table(
      ["Language", "Plugins"],
      tally(
        profiles.filter((p) => p.languages.docs.length),
        (p) => p.languages.docs[0] ?? "",
      ),
    ),
    "",
  );

  const blocked = profiles.filter((p) => p.compatibility.blockedByZotero);
  const events = profiles.flatMap((p) => p.integrityEvents.map((e) => ({ p, e })));
  if (blocked.length || events.length) {
    lines.push("## Flags", "");
    for (const p of blocked)
      lines.push(
        `- **${p.name}** ${p.install?.version ?? ""} is on Zotero's blocklist: ${p.compatibility.blockedByZotero?.reason}`,
      );
    for (const { p, e } of events)
      lines.push(
        `- **${p.name}**: the file behind ${e.tag} changed (detected ${e.detectedAt.slice(0, 10)}).`,
      );
    lines.push("");
  }

  lines.push(
    "## Most downloaded, shown by default",
    "",
    table(
      ["Plugin", "Downloads", "Label", "Data sharing", `Zotero ${meta.currentMajor}`, "README"],
      shown
        .slice(0, 40)
        .map((p) => [
          `[${p.name.replace(/\|/g, "/")}](${p.links.repo})`,
          (p.popularity.downloads ?? 0).toLocaleString("en-US"),
          LABEL_TEXT[label(p)] ?? label(p),
          p.trust?.facets.dataSharing.label ?? "–",
          p.compatibility.current?.status === "compatible" ? "yes" : "no",
          p.languages.docs.join(", ") || "–",
        ]),
    ),
    "",
  );
  return `${lines.join("\n")}\n`;
}
