import { createHash } from "node:crypto";
import { compareVersions } from "../census/compat.ts";
import { type DiskCache, fetchWithRetry } from "../net/http.ts";

/**
 * Update manifests: the file behind a plugin's `update_url` tells Zotero which build to install
 * next. When it points somewhere other than the release file we analysed, everyone who installed
 * the plugin ends up running that other file, so we follow it.
 */

export interface UpdateEntry {
  version: string;
  link: string | null;
  /** `sha512:…` (or another algorithm) as the manifest states it. */
  hash: string | null;
  min: string | null;
  max: string | null;
}

export interface UpdateFeed {
  url: string;
  /** HTTP status of the last check; 0 when the request failed. */
  status: number;
  checkedAt: string;
  /** Entries for this add-on ID; null when the file isn't a readable updates.json for it. */
  entries: UpdateEntry[] | null;
}

interface CachedFeed {
  etag: string | null;
  lastModified: string | null;
  status: number;
  text: string | null;
  finalUrl?: string;
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

/**
 * GET with ETag / Last-Modified revalidation. A 304, or a failed request with something cached,
 * serves the cached copy.
 */
export async function fetchUpdateText(
  url: string,
  cache: DiskCache,
  userAgent: string,
): Promise<{
  status: number;
  text: string | null;
  finalUrl: string;
  /** The file's Last-Modified, as an ISO time, when the server gives one. */
  modifiedAt: string | null;
}> {
  const key = `update-manifest:${url}`;
  const cached = await cache.get<CachedFeed>(key);
  const fromCache = (c: CachedFeed) => ({
    status: c.status,
    text: c.text,
    finalUrl: c.finalUrl ?? url,
    modifiedAt: isoTime(c.lastModified),
  });
  const headers: Record<string, string> = { "user-agent": userAgent, accept: "application/json" };
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
  let res: Response;
  try {
    res = await fetchWithRetry(url, { headers, redirect: "follow" }, 2);
  } catch {
    return cached ? fromCache(cached) : { status: 0, text: null, finalUrl: url, modifiedAt: null };
  }
  if (res.status === 304 && cached) {
    await res.body?.cancel();
    return fromCache(cached);
  }
  let text: string | null = null;
  if (res.ok) {
    const buf = new Uint8Array(await res.arrayBuffer());
    text = buf.length <= MAX_MANIFEST_BYTES ? new TextDecoder().decode(buf) : null;
  } else {
    await res.body?.cancel();
  }
  const lastModified = res.headers.get("last-modified");
  await cache.set<CachedFeed>(key, {
    etag: res.headers.get("etag"),
    lastModified,
    status: res.status,
    text,
    finalUrl: res.url || url,
  });
  return { status: res.status, text, finalUrl: res.url || url, modifiedAt: isoTime(lastModified) };
}

/** The update address's file as we last fetched it, without a request (offline rebuilds). */
export async function cachedUpdateText(
  url: string,
  cache: DiskCache,
): Promise<{ text: string; modifiedAt: string | null } | null> {
  const cached = await cache.get<CachedFeed>(`update-manifest:${url}`);
  return cached?.text ? { text: cached.text, modifiedAt: isoTime(cached.lastModified) } : null;
}

/** An HTTP date as an ISO time; null when absent or unreadable. */
export function isoTime(v: string | null | undefined): string | null {
  const t = v ? Date.parse(v) : Number.NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** An RDF field written as an element (`<em:version>1</em:version>`) or an attribute. */
function rdfValue(block: string, name: string): string | null {
  const el = block.match(new RegExp(`<em:${name}>\\s*([^<]*?)\\s*</em:${name}>`));
  if (el?.[1]) return el[1];
  return block.match(new RegExp(`em:${name}\\s*=\\s*"([^"]*)"`))?.[1] ?? null;
}

const ZOTERO_IDS = ["zotero@chnm.gmu.edu", "juris-m@juris-m.github.io"];

/**
 * The entries for `addonId` in an update.rdf (Zotero 5 and 6): one `<RDF:li>` per version, each
 * with a Zotero target that carries the range, link and hash.
 */
function parseUpdateRdf(text: string, addonId: string): UpdateEntry[] | null {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const about = `urn:mozilla:extension:${addonId}`.toLowerCase();
  const start = xml.toLowerCase().indexOf(`"${about}"`);
  if (start < 0) return null;
  const rest = xml.slice(start);
  const end = rest.search(/<\/(?:\w+:)?updates>/);
  const block = end > 0 ? rest.slice(0, end) : rest;
  const items = block.split(/<(?:\w+:)?li\b/).slice(1);
  return items.flatMap((li): UpdateEntry[] => {
    const version = rdfValue(li, "version");
    if (!version) return [];
    const targets = li.split(/<em:targetApplication\b/).slice(1);
    const zotero = targets.find((t) => ZOTERO_IDS.includes(rdfValue(t, "id") ?? "")) ?? null;
    if (!zotero) return [];
    return [
      {
        version,
        link: rdfValue(zotero, "updateLink"),
        hash: rdfValue(zotero, "updateHash"),
        min: rdfValue(zotero, "minVersion"),
        max: rdfValue(zotero, "maxVersion"),
      },
    ];
  });
}

/** The entries for `addonId` in an updates.json (Zotero 7+) or an update.rdf (Zotero 5 and 6). */
export function parseUpdateManifest(text: string, addonId: string): UpdateEntry[] | null {
  if (/^\s*(?:\uFEFF)?</.test(text)) return parseUpdateRdf(text, addonId);
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  const addons = (json as { addons?: Record<string, unknown> })?.addons;
  if (!addons || typeof addons !== "object") return null;
  const id = Object.keys(addons).find((k) => k.toLowerCase() === addonId.toLowerCase());
  const updates = id ? (addons[id] as { updates?: unknown })?.updates : undefined;
  if (!Array.isArray(updates)) return null;
  return updates.flatMap((u): UpdateEntry[] => {
    if (!u || typeof u !== "object") return [];
    const o = u as Record<string, unknown>;
    const version = str(o.version);
    if (!version) return [];
    const apps = (o.applications ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const target = apps.zotero ?? apps.gecko ?? {};
    return [
      {
        version,
        link: str(o.update_link),
        hash: str(o.update_hash),
        min: str(target.strict_min_version),
        max: str(target.strict_max_version),
      },
    ];
  });
}

/** The entry Zotero `zoteroVersion` would update to: the newest version whose range covers it. */
export function pickUpdate(entries: UpdateEntry[], zoteroVersion: string): UpdateEntry | null {
  const fits = entries.filter(
    (e) =>
      e.link &&
      (!e.min || compareVersions(e.min, zoteroVersion) <= 0) &&
      (!e.max || compareVersions(e.max, zoteroVersion) >= 0),
  );
  return fits.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

/** The hash algorithms Zotero checks an update's file with, and their lengths in hex. */
const HASH_HEX = { sha1: 40, sha256: 64, sha384: 96, sha512: 128 } as const;
export type HashAlgorithm = keyof typeof HASH_HEX;

/**
 * The hash an update entry gives for its file, as Zotero reads `update_hash` (`algorithm:hex`,
 * either case). Zotero hashes the download with that algorithm and refuses the update when the two
 * differ (AddonManager's ERROR_INCORRECT_HASH), so a hash of the wrong length is still a stated
 * hash: nothing matches it.
 */
export function statedHash(e: UpdateEntry): { algorithm: HashAlgorithm; hex: string } | null {
  const m = e.hash?.trim().match(/^(sha1|sha256|sha384|sha512):([0-9a-f]+)$/i);
  if (!m) return null;
  return {
    algorithm: (m[1] as string).toLowerCase() as HashAlgorithm,
    hex: (m[2] as string).toLowerCase(),
  };
}

/** The SHA-256 an update entry states, if it states one. */
export function statedSha256(e: UpdateEntry): string | null {
  const h = statedHash(e);
  return h?.algorithm === "sha256" && h.hex.length === HASH_HEX.sha256 ? h.hex : null;
}

/** Whether a file has the hash an update entry states for it. */
export function matchesStatedHash(
  stated: { algorithm: HashAlgorithm; hex: string },
  bytes: Uint8Array,
): boolean {
  return createHash(stated.algorithm).update(bytes).digest("hex") === stated.hex;
}
