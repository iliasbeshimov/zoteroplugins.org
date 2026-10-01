import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostFinding } from "@atlas/schema";
import { parse } from "yaml";
import { paths } from "../paths.ts";

export type HostCategory = HostFinding["category"];
export type HostFlag = HostFinding["flags"][number];

interface Rule {
  pattern: string;
  category: HostCategory;
  provider?: string;
  flags: HostFlag[];
}

export interface HostTable {
  version: string;
  exact: Map<string, Rule>;
  wildcards: Rule[];
  ignore: Set<string>;
}

export interface HostClass {
  category: HostCategory;
  provider?: string;
  flags: HostFlag[];
}

export async function loadHostTable(
  file = join(paths.pipelineData, "hosts.yaml"),
): Promise<HostTable> {
  const doc = parse(await readFile(file, "utf8")) as {
    version: string;
    categories: Record<string, { host: string; provider?: string; flags?: HostFlag[] }[]>;
    ignore: string[];
  };
  const exact = new Map<string, Rule>();
  const wildcards: Rule[] = [];
  for (const [category, entries] of Object.entries(doc.categories)) {
    for (const e of entries) {
      const rule: Rule = {
        pattern: e.host.toLowerCase().replace(/^\[|\]$/g, ""),
        category: category as HostCategory,
        flags: e.flags ?? [],
        ...(e.provider ? { provider: e.provider } : {}),
      };
      if (rule.pattern.startsWith("*")) wildcards.push(rule);
      else if (!exact.has(rule.pattern)) exact.set(rule.pattern, rule);
    }
  }
  return {
    version: doc.version,
    exact,
    wildcards,
    ignore: new Set(doc.ignore.map((h) => h.toLowerCase())),
  };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Loopback, private, link-local and carrier-grade NAT ranges, IPv4 and IPv6. */
function isPrivateIp(host: string): boolean {
  if (host.includes(":")) return /^(::1?|f[cd][0-9a-f]{0,2}:.*|fe[89ab][0-9a-f]?:.*)$/i.test(host);
  const m = host.match(IPV4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Returns null for hosts that never mean network access (namespaces, placeholders). */
export function classifyHost(table: HostTable, rawHost: string): HostClass | null {
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  if (table.ignore.has(host)) return null;
  const hit = table.exact.get(host);
  if (hit)
    return {
      category: hit.category,
      flags: hit.flags,
      ...(hit.provider ? { provider: hit.provider } : {}),
    };
  for (const rule of table.wildcards) {
    const suffix = rule.pattern.slice(1); // "*.x.com" -> ".x.com", "*-a.b.com" -> "-a.b.com"
    if (host.endsWith(suffix) || (suffix.startsWith(".") && host === suffix.slice(1))) {
      return {
        category: rule.category,
        flags: rule.flags,
        ...(rule.provider ? { provider: rule.provider } : {}),
      };
    }
  }
  // www.x and x are one host (doaj.org, zdic.net).
  const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  const same = table.exact.get(twin);
  if (same)
    return {
      category: same.category,
      flags: same.flags,
      ...(same.provider ? { provider: same.provider } : {}),
    };
  // Sci-Hub moves between domains: sci-hub under any ending is Sci-Hub.
  if (/(^|\.)sci-hub\.[a-z0-9-]+$/.test(host))
    return { category: "scholarly-api", provider: "Sci-Hub", flags: ["legal-risk"] };
  if (IPV4.test(host) || host.includes(":")) {
    return isPrivateIp(host)
      ? { category: "localhost", provider: "Local network", flags: ["ip-literal"] }
      : { category: "unknown", flags: ["ip-literal"] };
  }
  return { category: "unknown", flags: [] };
}

/**
 * Documentation placeholders: example.com and friends, and `your-…` names such as
 * your-custom-domain.com. Update addresses are classified separately, where a placeholder is a
 * finding rather than noise.
 */
const PLACEHOLDER_HOST =
  /(^|\.)example\.(com|org|net)$|^(www\.|api\.)?your-[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]+$|^(www\.|api\.)?your(domain|server|site|website|host|api|company|name|app|url|endpoint)s?\.[a-z]+$/i;

/** Host (and port) from a URL-ish string, or null if it isn't a usable absolute URL. */
export function hostOf(url: string): { host: string; port?: number } | null {
  try {
    const u = new URL(url);
    if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return null;
    // A trailing dot is the same host ("libretranslate.com." at the end of a sentence).
    const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    // Template placeholders and junk: require a dot, "localhost", or an IPv6 literal.
    if (
      !host ||
      /[{}$<>%]/.test(host) ||
      !(host.includes(".") || host === "localhost" || host.includes(":"))
    ) {
      return null;
    }
    if (!/^[a-z0-9.:-]+$/i.test(host) || /\.\.|^\.|^-/.test(host)) return null;
    // Reserved names (RFC 2606/6761) are placeholders, not destinations.
    if (/\.(invalid|test|example|local|lan|internal|home|plugin)$/i.test(host)) return null;
    if (PLACEHOLDER_HOST.test(host)) return null;
    // "100.x.x.x", "192.168.x.x": an address pattern in help text.
    if (/^(\d{1,3}|x+|\*)(\.(\d{1,3}|x+|\*)){3}$/i.test(host) && /x|\*/i.test(host)) return null;
    // A dotted quad cut short ("http://127.", "http://192.168.") is a prefix check in the code,
    // which the URL parser would otherwise turn into an address. Decimal and hex forms stay.
    const raw = url.match(/^[a-z]+:\/\/(?:[^@/?#]*@)?([^/?#:]*)/i)?.[1] ?? "";
    if (/^\d{1,3}(\.\d{1,3}){0,2}\.?$/.test(raw) && raw.includes(".")) return null;
    return u.port ? { host, port: Number(u.port) } : { host };
  } catch {
    return null;
  }
}
