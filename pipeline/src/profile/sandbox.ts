import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Analysis, type SandboxHostUsage, SandboxRecord, type TrustCard } from "@atlas/schema";
import { paths } from "../paths.ts";
import { type DeveloperHints, isDeveloperHost } from "../scan/analyze.ts";
import { classifyHost, type HostClass, type HostTable } from "../scan/hosts.ts";

/**
 * What a plugin did when we ran it in a throwaway Zotero (sandbox/README.md), as the card uses it.
 * sandbox/export.py writes one record per plugin to data/sandbox/<slug>.json, naming the exact
 * release file it ran by SHA-256: it applies to that file's card only, so a new release is
 * untested until it's tested again. The hosts it sent data to count as traced requests for the
 * data-sharing rules (DS-OBSERVED in score.ts); the ones it only loaded pages from are listed, and
 * nothing else from the test changes a rating yet.
 */

const SANDBOX_DIR = join(paths.root, "data", "sandbox");

/** data/sandbox/<slug>.json, when there is one that validates; anything else is "not tested". */
export async function readSandboxRecord(
  slug: string,
  dir = SANDBOX_DIR,
): Promise<SandboxRecord | null> {
  let text: string;
  try {
    text = await readFile(join(dir, `${slug}.json`), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = SandboxRecord.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.slug === slug ? parsed.data : null;
  } catch {
    return null;
  }
}

/** GitHub serves release downloads and source archives from these hosts: they're github.com. */
const SAME_AS: Record<string, string> = {
  "release-assets.githubusercontent.com": "github.com",
  "objects.githubusercontent.com": "github.com",
  "codeload.github.com": "github.com",
};

/** A contacted host's name as the card uses it: GitHub's download hosts are github.com. */
const sameHost = (raw: string) => {
  const name = raw.toLowerCase().replace(/\.$/, "");
  return SAME_AS[name] ?? name;
};

type Usage = SandboxHostUsage["usage"];

export type ObservedHost = HostClass & {
  host: string;
  /**
   * What its requests carried during the test (the record's hostUsage), the most any of its names
   * received for GitHub's download hosts; absent when the record doesn't say (sandboxVersion 1.0.0).
   */
  usage?: Usage;
};

/** Least to most: a host counts by the most any request to it carried. */
const CARRIED: Usage[] = ["fetches", "sends-data", "sends-library-data"];

/** What the record says a contacted host's requests carried; undefined when it doesn't say. */
const usageOf = (record: SandboxRecord, raw: string): Usage | undefined =>
  record.hostUsage?.[raw]?.usage;

/**
 * Whether a host a test contacted counts as a traced request (DS-OBSERVED): only one that received
 * data. One the record doesn't say about (sandboxVersion 1.0.0) counts, as a page load and a
 * request that sends data can't be told apart there. So does a usage-tracking service: loading its
 * page is how it counts users (a counter's /hit/ address, a tracker's script).
 */
export const receivedData = (o: { usage?: Usage; category?: string }) =>
  o.usage !== "fetches" || o.category === "telemetry";

/**
 * The hosts a test contacted, classified the way the analysis classifies the hosts in the code
 * (reclassifyHosts): the hosts table, then the developer's own names. Hosts the test refused (this
 * computer, a private network) aren't among them; the record lists those as unexpected.
 */
export function observedHosts(
  record: SandboxRecord,
  table: HostTable,
  developer: DeveloperHints,
): ObservedHost[] {
  // A plugin that didn't start contacted nothing itself.
  if (!record.loaded) return [];
  const out = new Map<string, ObservedHost>();
  for (const raw of record.contacted) {
    const host = sameHost(raw);
    if (!host) continue;
    const usage = usageOf(record, raw);
    const known = out.get(host);
    if (known) {
      // One host under several names received the most any of them did; a name the record
      // doesn't say about counts as data.
      const { usage: was, ...rest } = known;
      const most =
        was && usage ? (CARRIED.indexOf(was) >= CARRIED.indexOf(usage) ? was : usage) : undefined;
      out.set(host, most ? { ...rest, usage: most } : rest);
      continue;
    }
    // The table's ignore list is for names in code that are never destinations (XML namespaces,
    // help pages); one the plugin actually contacted is a destination we can't classify.
    const found = classifyHost(table, host) ?? { category: "unknown" as const, flags: [] };
    const dev =
      found.category === "unknown" &&
      !found.flags.includes("ip-literal") &&
      isDeveloperHost(host, developer);
    out.set(host, {
      ...(dev
        ? {
            host,
            category: "developer-server",
            provider: "Plugin developer (name match)",
            flags: [],
          }
        : { host, ...found }),
      ...(usage ? { usage } : {}),
    });
  }
  return [...out.values()];
}

/**
 * The analysis with the hosts a test sent data to as traced requests: one the code names without a
 * request we traced becomes one ("named in its code" no longer), one it doesn't name at all is
 * added with its own classification. A host it only loaded pages from (receivedData) changes
 * nothing the rules read: one the code names is still marked seen (contacted), one it doesn't name
 * isn't added (the card's `tested.fetched` lists it). `seen` is the names the card lists them under.
 */
export function withObserved(
  a: Analysis,
  observed: ObservedHost[],
): { analysis: Analysis; seen: Set<string> } {
  const seen = new Set<string>();
  const hosts = [...a.network.hosts];
  for (const o of observed) {
    // www.x and x are one host, as in the hosts table.
    const twin = o.host.startsWith("www.") ? o.host.slice(4) : `www.${o.host}`;
    const exact = hosts.some((h) => h.host.toLowerCase() === o.host);
    const match = (h: Analysis["network"]["hosts"][number]) =>
      h.host.toLowerCase() === (exact ? o.host : twin);
    if (hosts.some(match)) {
      hosts.forEach((h, i) => {
        if (!match(h)) return;
        seen.add(h.host);
        if (receivedData(o) && h.usage !== "request") hosts[i] = { ...h, usage: "request" };
      });
      continue;
    }
    if (!receivedData(o)) continue;
    hosts.push({
      host: o.host,
      category: o.category,
      ...(o.provider ? { provider: o.provider } : {}),
      flags: o.flags,
      usage: "request",
      inVendoredCode: false,
      occurrences: 1,
      evidence: [],
    });
    seen.add(o.host);
  }
  return { analysis: { ...a, network: { ...a.network, hosts } }, seen };
}

/** A host the record says its card doesn't list. */
const NOT_LISTED = /^contacted \S+, which its card doesn't list$/;

/** sandbox/report.py also counts GitHub's raw files as github.com when it checks a card. */
const LISTED_AS: Record<string, string> = {
  ...SAME_AS,
  "raw.githubusercontent.com": "github.com",
};

/**
 * Whether a card's hosts include one a test contacted, decided as sandbox/report.py's host_on_card
 * decides it: the same name or its www twin, or a name under or over one the card lists.
 */
function listedOn(contacted: string, listed: string[]): boolean {
  const name = contacted.toLowerCase();
  const host = LISTED_AS[name] ?? name;
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  return listed.some((raw) => {
    const h = raw.toLowerCase().replace(/^www\./, "");
    return bare === h || host === h || bare.endsWith(`.${h}`) || h.endsWith(`.${bare}`);
  });
}

/**
 * Services that serve their own pages: loading one the card didn't list follows from what the card
 * says (a DOI resolving to the publisher's page). Everywhere else a page load is news: a server we
 * couldn't identify, the developer's own or one on a hosting platform learns someone uses the
 * plugin, a code host or CDN serves whatever the developer put there (an update list, a program),
 * and a usage-tracking service counts the visit.
 */
const OWN_PAGES = new Set([
  "scholarly-api",
  "zotero",
  "integration",
  "llm-provider",
  "translation",
  "documentation",
]);

/**
 * The card's `tested`, judged against the card without the test (`listed`: the hosts that card
 * lists; `hosts`: the ones the test contacted, classified). The record's verdict was reached
 * against whichever card was current when its report was read; once a card lists the hosts a test
 * saw, a report read again would find them all listed and call the test as described. So the
 * hosts are checked here, against the card as it was before we ran it, and the record's other
 * findings stand. A host it only loaded pages from is expected when it's a service that serves its
 * own pages (OWN_PAGES). A plugin that didn't start added no hosts to the card: its record stands
 * as written.
 */
export function testedSummary(
  record: SandboxRecord,
  listed: string[],
  hosts: ObservedHost[],
): NonNullable<TrustCard["tested"]> {
  const summary = {
    zotero: record.zotero,
    testedAt: record.testedAt,
    exercised: record.exercised,
    contacted: record.contacted,
  };
  if (!record.loaded) return { ...summary, verdict: record.verdict, unexpected: record.unexpected };
  // What went where, when the record says (sandboxVersion 1.1.0).
  const sentTo = record.contacted.flatMap((host) => {
    const u = record.hostUsage?.[host];
    return u?.usage === "sends-library-data" ? [{ host, sent: u.sent }] : [];
  });
  // The hosts it only loaded pages from, as they count (by the most any of GitHub's names
  // received, and not a usage-tracking service).
  const observed = (raw: string) => hosts.find((o) => o.host === sameHost(raw));
  const fetched = record.contacted.filter((h) => {
    const o = observed(h);
    return o !== undefined && !receivedData(o);
  });
  const ownPage = (raw: string) =>
    fetched.includes(raw) && OWN_PAGES.has(observed(raw)?.category ?? "unknown");
  const unexpected = [
    ...record.contacted
      .filter((h) => !listedOn(h, listed) && !ownPage(h))
      .map((h) => `contacted ${h}, which its card didn't list before we ran it`),
    ...record.unexpected.filter((r) => !NOT_LISTED.test(r)),
  ];
  const verdict =
    record.verdict === "incomplete"
      ? record.verdict
      : unexpected.length
        ? ("unexpected" as const)
        : ("as-described" as const);
  return {
    ...summary,
    ...(sentTo.length ? { sentTo } : {}),
    ...(fetched.length ? { fetched } : {}),
    verdict,
    unexpected,
  };
}
