import { type ScanResult, type ScanSummary, summarize } from "./run.ts";

interface Meta {
  generatedAt: string;
  analyzerVersion: string;
  hostsTableVersion: string;
  censusGeneratedAt: string;
  options: { top: number; sample: number };
}

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : n.toLocaleString("en-US");
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const code = (s: string) => `\`${s}\``;
const list = (xs: string[], max = 6) =>
  xs.length
    ? `${xs.slice(0, max).map(code).join(", ")}${xs.length > max ? ` +${xs.length - max}` : ""}`
    : "–";

function table(header: string[], rows: (string | number)[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

const LABELS = ["high-concern", "review-details", "low-concern", "insufficient-data"] as const;
const LABEL_TEXT: Record<string, string> = {
  "high-concern": "Serious concerns found",
  "review-details": "Review the details",
  "low-concern": "Few concerns found",
  "insufficient-data": "Not enough data",
};
const SHARING = [
  "no-network-found",
  "user-configured-only",
  "named-third-parties",
  "developer-servers",
  "unknown-endpoints",
  "bundled-library-only",
];

export function buildScanReport(results: ScanResult[], meta: Meta): string {
  const all = results.map(summarize);
  const ok = all.filter((s) => !s.error);
  const groups: [string, ScanSummary[]][] = [
    [`Top ${meta.options.top} by downloads`, ok.filter((s) => s.group === "top")],
    ["Sample of 2026 plugins", ok.filter((s) => s.group === "sample-2026")],
  ];
  const out: string[] = [];
  out.push(`# Code scan, ${meta.generatedAt.slice(0, 10)}`);
  out.push(
    `Static analysis of the latest release file of ${fmt(all.length)} plugins: the top ${meta.options.top} by GitHub downloads, the brief's regression targets, and a fixed random sample of ${meta.options.sample} plugins created in 2026 (census of ${meta.censusGeneratedAt.slice(0, 10)}). Analyzer ${meta.analyzerVersion}, hosts table ${meta.hostsTableVersion}. Deterministic, no LLM calls. Per-plugin evidence: \`data/scan/plugins/<slug>.json\`.`,
  );
  out.push(
    "**Preview labels leave out provenance** (whether the release matches its source), which isn't checked yet, and are computed from the rule table in pipeline/src/profile/score.ts. Static analysis shows what we found, not that a plugin is harmless.",
  );

  const failed = all.filter((s) => s.error);
  out.push("## Coverage");
  out.push(
    [
      `- Scanned: ${fmt(ok.length)} of ${fmt(all.length)} plugins (${fmt(failed.length)} failed: ${
        failed
          .slice(0, 5)
          .map((f) => `${f.repo} (${f.error})`)
          .join("; ") || "none"
      })`,
      `- Code files analyzed: ${fmt(ok.reduce((s, x) => s + x.filesAnalyzed, 0))}; files that needed the regex fallback: ${fmt(ok.reduce((s, x) => s + x.parseFailures, 0))} across ${fmt(ok.filter((x) => x.parseFailures > 0).length)} plugins`,
    ].join("\n"),
  );

  out.push("## Do the preview cards tell plugins apart?");
  out.push(
    table(
      ["Preview label", ...groups.map(([g]) => g)],
      LABELS.map((l) => [
        LABEL_TEXT[l] ?? l,
        ...groups.map(
          ([, g]) =>
            `${fmt(g.filter((s) => s.label === l).length)} (${pct(g.filter((s) => s.label === l).length, g.length)})`,
        ),
      ]),
    ),
  );
  out.push(
    table(
      ["Data sharing", ...groups.map(([g]) => g)],
      SHARING.map((v) => [
        v,
        ...groups.map(([, g]) => fmt(g.filter((s) => s.dataSharing === v).length)),
      ]),
    ),
  );
  const driverCounts = new Map<string, number[]>();
  groups.forEach(([, g], gi) => {
    for (const s of g)
      for (const d of s.drivers) {
        const row = driverCounts.get(d) ?? groups.map(() => 0);
        row[gi] = (row[gi] ?? 0) + 1;
        driverCounts.set(d, row);
      }
  });
  out.push("Which rules fired (a plugin can trigger several):");
  out.push(
    table(
      ["Rule", ...groups.map(([g]) => g)],
      [...driverCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([d, c]) => [d, ...c.map(fmt)]),
    ),
  );

  out.push("## Regression checks from the brief");
  const find = (repo: string) => ok.find((s) => s.repo.toLowerCase() === repo.toLowerCase());
  const check = (
    repo: string,
    what: string,
    pass: (s: ScanSummary) => boolean,
    detail: (s: ScanSummary) => string,
  ) => {
    const s = find(repo);
    return [repo, what, s ? (pass(s) ? "yes" : "**no**") : "not scanned", s ? detail(s) : "–"];
  };
  out.push(
    table(
      ["Plugin", "Check", "Result", "Detail"],
      [
        check(
          "MuiseDestiny/zotero-style",
          "latest release flagged obfuscated",
          (s) => s.obfuscated,
          (s) =>
            `v${s.version}; signals ${list(s.obfuscationSignals)}; hosts ${list(s.countedHosts)}`,
        ),
        check(
          "MuiseDestiny/zotero-gpt",
          "licence endpoints surfaced",
          (s) => s.ipHosts.length + s.developerHosts.length + s.unknownHosts.length > 0,
          (s) =>
            `v${s.version}; obfuscated: ${s.obfuscated}; IP hosts ${list(s.ipHosts)}; developer/cloud ${list(s.developerHosts)}`,
        ),
        check(
          "MuiseDestiny/zotero-reference",
          "licence endpoints surfaced",
          (s) => s.ipHosts.length + s.developerHosts.length + s.unknownHosts.length > 0,
          (s) =>
            `v${s.version}; obfuscated: ${s.obfuscated}; IP hosts ${list(s.ipHosts)}; developer/cloud ${list(s.developerHosts)}`,
        ),
        check(
          "windingwind/zotero-pdf-translate",
          "translation hosts listed",
          (s) => s.countedHosts.length >= 5,
          (s) => `${fmt(s.countedHosts.length)} hosts, e.g. ${list(s.countedHosts, 8)}`,
        ),
        check(
          "retorquere/zotero-better-bibtex",
          "local HTTP server endpoints",
          (s) => s.serverEndpoints.length > 0,
          (s) => list(s.serverEndpoints, 8),
        ),
      ],
    ),
  );
  const quiet = ok.filter((s) => s.dataSharing === "no-network-found");
  out.push(
    `Plugins with no network access found: ${fmt(quiet.length)}${
      quiet.length
        ? `, e.g. ${quiet
            .slice(0, 5)
            .map((s) => s.repo)
            .join(", ")}`
        : ""
    }.`,
  );

  out.push("## Transparency");
  out.push(
    table(
      ["", ...groups.map(([g]) => g)],
      [
        [
          "Obfuscation detected (medium/high confidence)",
          ...groups.map(([, g]) => fmt(g.filter((s) => s.obfuscated).length)),
        ],
        [
          "Minified own code",
          ...groups.map(([, g]) => fmt(g.filter((s) => s.verdict === "minified").length)),
        ],
        [
          "Readable own code",
          ...groups.map(([, g]) => fmt(g.filter((s) => s.verdict === "readable").length)),
        ],
        [
          "Suspicious invisible Unicode",
          ...groups.map(([, g]) => fmt(g.filter((s) => s.suspiciousUnicode).length)),
        ],
      ],
    ),
  );
  const obf = ok.filter((s) => s.obfuscated);
  if (obf.length) {
    out.push(
      table(
        ["Plugin", "Group", "Version", "Signals", "Counted hosts"],
        obf.map((s) => [
          s.repo,
          s.group,
          s.version ?? "–",
          list(s.obfuscationSignals),
          list(s.countedHosts),
        ]),
      ),
    );
  }

  out.push("## Where the code sends data");
  const hostCount = new Map<string, number>();
  for (const s of ok) for (const h of s.countedHosts) hostCount.set(h, (hostCount.get(h) ?? 0) + 1);
  out.push("Most common destinations (plugins whose code requests or configures each host):");
  out.push(
    table(
      ["Host", "Plugins"],
      [...hostCount.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"))
        .slice(0, 25)
        .map(([h, n]) => [code(h), fmt(n)]),
    ),
  );
  const unknown = new Map<string, string[]>();
  for (const s of ok)
    for (const h of s.unknownHosts) unknown.set(h, [...(unknown.get(h) ?? []), s.repo]);
  out.push(
    `Unclassified hosts (candidates for \`pipeline/data/hosts.yaml\`), ${fmt(unknown.size)} in total:`,
  );
  out.push(
    table(
      ["Host", "Plugins", "Example"],
      [...unknown.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "en"))
        .slice(0, 30)
        .map(([h, rs]) => [code(h), fmt(rs.length), rs[0] ?? ""]),
    ),
  );
  const flagged = (label: string, pick: (s: ScanSummary) => string[]) => {
    const hits = ok.filter((s) => pick(s).length);
    return `- ${label}: ${fmt(hits.length)} plugins${
      hits.length
        ? ` (${hits
            .slice(0, 8)
            .map((s) => `${s.repo}: ${pick(s).slice(0, 3).join(", ")}`)
            .join("; ")})`
        : ""
    }`;
  };
  out.push(
    [
      flagged("Bare IP addresses", (s) => s.ipHosts),
      flagged("Telemetry or analytics", (s) => s.telemetryHosts),
      flagged("Developer-run or cloud-function servers", (s) => s.developerHosts),
      flagged("Shadow-library hosts (legal-risk notice)", (s) => s.legalRiskHosts),
    ].join("\n"),
  );

  out.push("## Powerful capabilities (in the plugin's own code)");
  const caps = new Map<string, number[]>();
  groups.forEach(([, g], gi) => {
    for (const s of g)
      for (const c of s.capabilities) {
        const row = caps.get(c) ?? groups.map(() => 0);
        row[gi] = (row[gi] ?? 0) + 1;
        caps.set(c, row);
      }
  });
  out.push(
    table(
      ["Capability", ...groups.map(([g]) => g)],
      [...caps.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([c, n]) => [c, ...n.map(fmt)]),
    ),
  );
  const db = ok.filter((s) => s.dbTables.length);
  if (db.length) {
    out.push("Direct database writes (Zotero says plugins must not modify `zotero.sqlite`):");
    out.push(
      table(
        ["Plugin", "Tables written"],
        db.map((s) => [s.repo, list(s.dbTables, 10)]),
      ),
    );
  }

  out.push("## Every scanned plugin");
  out.push(
    table(
      ["Plugin", "Group", "Label", "Sharing", "Rules", "Counted hosts"],
      ok
        .sort((a, b) => a.group.localeCompare(b.group, "en") || a.rank - b.rank)
        .map((s) => [
          `${s.repo}${s.version ? ` v${s.version}` : ""}`,
          s.group,
          LABEL_TEXT[s.label ?? ""] ?? "–",
          s.dataSharing ?? "–",
          s.drivers.join(", "),
          list(s.countedHosts, 4),
        ]),
    ),
  );

  out.push("## Limits");
  out.push(
    [
      '- A URL counts as a request when it reaches a network call directly or through one named constant; anything else is "unknown" usage. Minified bundles with reused short names can defeat this in both directions.',
      "- Obfuscated code hides its strings, so its hosts are mostly invisible to static analysis; the obfuscation flag is what we can state.",
      "- Bundled libraries are recognised by file path, licence banners and bundler section comments; code minified into one file without markers is treated as the plugin's own.",
      "- Only the latest release is scanned; version-to-version diffs need a previous analysis and come with the nightly pipeline.",
      "- No manual verification yet: the next step is a 10-plugin precision spot-check (brief M2).",
    ].join("\n"),
  );
  return `${out.join("\n\n")}\n`;
}
