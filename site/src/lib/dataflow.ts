import { existsSync, readFileSync } from "node:fs";
import type { PluginProfile } from "@atlas/schema";
import { HOST_GROUP, type Plugin, RANK, ROOT, shownPlugins } from "./atlas.ts";

/**
 * The numbers on /where-plugins-send-data, computed at build time from the listed plugins and
 * their published profiles. "Listed" is every plugin the catalogue shows by default. A plugin
 * counts only when its code was checked for where it can send data (the profile's dataSharing).
 */

const profileOf = (p: Plugin): PluginProfile | null => {
  const f = `${ROOT}generated/${p.slug}/profile.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as PluginProfile) : null;
};

/** Kinds of address a plugin's code can name, as the plugin pages group them. */
const KINDS = [
  "llm-provider",
  "scholarly-api",
  "translation",
  "integration",
  "zotero",
  "code-hosting",
  "cdn",
  "documentation",
  "telemetry",
  "cloud-function",
  "developer-server",
  "unknown",
] as const;

/** "OpenAI" and "OpenAI ChatGPT" are one company; "Google Gemini (API)" is "Google Gemini". */
export function mergeServices(names: string[]): string[] {
  const clean = [...new Set(names.map((s) => s.replace(/ \(.*\)$/, "").trim()))].filter(Boolean);
  return clean
    .filter((x) => !clean.some((y) => y !== x && x.startsWith(`${y} `)))
    .sort((a, b) => a.localeCompare(b));
}

export interface AiRow {
  p: Plugin;
  services: string[];
}

let cache: ReturnType<typeof compute> | null = null;
export const dataflow = () => (cache ??= compute());

function compute() {
  const listed = shownPlugins();
  const rows = listed.map((p) => ({ p, prof: profileOf(p) }));
  type Row = (typeof rows)[number];
  const value = (r: Row) => r.prof?.trust?.facets?.dataSharing?.value ?? null;
  const scanned = rows.filter((r) => value(r));
  const count = (v: string) => scanned.filter((r) => value(r) === v).length;

  const kinds = KINDS.map((k) => ({
    kind: k,
    name: HOST_GROUP[k][0],
    count: scanned.filter((r) =>
      (r.prof?.trust?.facets?.dataSharing?.hosts ?? []).some((h) => h.category === k),
    ).length,
  }))
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count);

  const current = (r: Row) => r.p.currentOk && !r.p.retired && !r.p.removed;
  const quiet = scanned
    .filter((r) => value(r) === "no-network-found" && current(r))
    .map((r) => r.p)
    .sort((a, b) => RANK[b.grade] - RANK[a.grade] || b.downloadsN - a.downloadsN);

  const ai: AiRow[] = rows
    .filter((r) => r.p.jobs.includes("ai") && current(r))
    .map((r) => {
      // The providers its requirements check names, plus the AI addresses in its data-sharing check.
      const named = mergeServices(r.prof?.requirementsHints?.aiServices ?? []);
      const hosts = (r.prof?.trust?.facets?.dataSharing?.hosts ?? [])
        .filter((g) => g.category === "llm-provider")
        .flatMap((g) => g.hosts)
        // Raw addresses add nothing once its providers are named; without names they're all there is.
        .filter((h) => !(named.length && /^[\w.-]+\.[a-z]{2,}$/i.test(h)))
        .filter((h) => !named.some((n) => h.toLowerCase().includes(n.toLowerCase())));
      return { p: r.p, services: [...named, ...new Set(hosts)] };
    })
    .sort((a, b) => b.p.downloadsN - a.p.downloadsN);
  const services = new Map<string, number>();
  for (const r of ai) for (const s of r.services) services.set(s, (services.get(s) ?? 0) + 1);

  return {
    listed: listed.length,
    scanned: scanned.length,
    noRequests: count("no-network-found"),
    bundledOnly: count("bundled-library-only"),
    ownServers: count("user-configured-only"),
    kinds,
    quiet,
    ai,
    aiLocal: ai.filter((r) => r.p.localModel).length,
    aiNoKey: ai.filter((r) => r.p.keyNeed === "none").length,
    topServices: [...services.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 12),
  };
}
