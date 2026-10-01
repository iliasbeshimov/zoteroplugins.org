import { inflateRawSync } from "node:zlib";
import { fetchWithRetry } from "../net/http.ts";

/**
 * Reads manifest.json / install.rdf out of a remote .xpi with HTTP Range requests: the zip
 * central directory from the tail, then just the manifest entry. A few KB per plugin instead of
 * downloading the whole file.
 */

export type RangeReader = (start: number, endInclusive: number) => Promise<Uint8Array>;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const TAIL_BYTES = 65_536 + 22;

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

export async function listZipEntries(read: RangeReader, size: number): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await read(tailStart, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");
  const cd =
    cdOffset >= tailStart
      ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
      : await read(cdOffset, cdOffset + cdSize - 1);

  const entries: ZipEntry[] = [];
  for (let p = 0; p + 46 <= cd.length && u32(cd, p) === CDH_SIG; ) {
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    entries.push({
      method: u16(cd, p + 10),
      compressedSize: u32(cd, p + 20),
      localHeaderOffset: u32(cd, p + 42),
      name: new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readZipEntry(read: RangeReader, entry: ZipEntry): Promise<Uint8Array> {
  // Local headers can carry a different extra field than the central directory, so over-read.
  const start = entry.localHeaderOffset;
  const chunk = await read(start, start + 30 + 1024 + entry.compressedSize - 1);
  if (u32(chunk, 0) !== LFH_SIG) throw new Error(`bad local header for ${entry.name}`);
  const dataStart = 30 + u16(chunk, 26) + u16(chunk, 28);
  const data = chunk.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return new Uint8Array(inflateRawSync(data));
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

export function httpRangeReader(url: string, userAgent: string): RangeReader {
  return async (start, end) => {
    const res = await fetchWithRetry(url, {
      headers: { range: `bytes=${start}-${end}`, "user-agent": userAgent },
    });
    const body = new Uint8Array(await res.arrayBuffer());
    if (res.status === 206) return body;
    if (res.status === 200) return body.subarray(start, end + 1); // server ignored the range
    throw new Error(`range request failed: HTTP ${res.status}`);
  };
}

// ---------------------------------------------------------------------------
// Manifest parsing

export const ZOTERO_APP_IDS = ["zotero@chnm.gmu.edu", "juris-m@juris-m.github.io"];
const FIREFOX_APP_ID = "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}";
/** Application IDs that can appear in install.rdf but are never the add-on's own ID. */
const APP_IDS = new Set([
  ...ZOTERO_APP_IDS,
  FIREFOX_APP_ID,
  "{3550f703-e582-4d05-9a08-453d09bdfdc6}", // Thunderbird
  "{92650c4d-4b8e-4d2a-b7eb-24ecf4f6b63a}", // SeaMonkey
]);

export interface XpiManifest {
  format: "manifest.json" | "install.rdf";
  target: "zotero" | "firefox" | "unknown";
  addonId: string | null;
  name: string | null;
  version: string | null;
  description: string | null;
  homepageUrl: string | null;
  updateUrl: string | null;
  minVersion: string | null;
  maxVersion: string | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseManifestJson(text: string): XpiManifest {
  const m = JSON.parse(text.replace(/^﻿/, "")) as Json;
  const apps = obj(m.applications);
  const bss = obj(m.browser_specific_settings);
  const zotero = obj(apps?.zotero) ?? obj(bss?.zotero);
  const gecko = obj(apps?.gecko) ?? obj(bss?.gecko);
  const target = zotero ? "zotero" : gecko ? "firefox" : "unknown";
  const app = zotero ?? gecko;
  return {
    format: "manifest.json",
    target,
    addonId: str(app?.id),
    name: str(m.name),
    version: str(m.version),
    description: str(m.description),
    homepageUrl: str(m.homepage_url),
    updateUrl: str(app?.update_url),
    minVersion: str(app?.strict_min_version),
    maxVersion: str(app?.strict_max_version),
  };
}

function rdfField(block: string, name: string): string | null {
  const el = block.match(new RegExp(`<em:${name}>\\s*([^<]*?)\\s*</em:${name}>`));
  if (el?.[1]) return el[1];
  const attr = block.match(new RegExp(`em:${name}\\s*=\\s*"([^"]*)"`));
  return attr?.[1] ?? null;
}

export function parseInstallRdf(raw: string): XpiManifest {
  // Commented-out fields aren't there (zotero-redownloader keeps an old updateURL in a comment).
  const xml = raw.replace(/<!--[\s\S]*?-->/g, "");
  // A target application can also sit in its own Description, referenced by
  // `<em:targetApplication RDF:resource="rdf:#$x61SL3"/>` (zotupdate).
  const referenced = [
    ...xml.matchAll(/<em:targetApplication\b[^>]*\bresource\s*=\s*"([^"]+)"[^>]*\/>/g),
  ].map((m) => {
    const about = (m[1] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `<(?:\\w+:)?Description\\b[^>]*\\babout\\s*=\\s*"${about}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/(?:\\w+:)?Description>)`,
    );
  });
  const targets = [
    ...[...xml.matchAll(/<em:targetApplication[^>/]*>([\s\S]*?)<\/em:targetApplication>/g)].map(
      (t) => t[1] ?? "",
    ),
    ...referenced.map((re) => xml.match(re)?.[0] ?? ""),
  ];
  const zoteroTarget = targets.find((block) =>
    ZOTERO_APP_IDS.includes(rdfField(block, "id") ?? ""),
  );
  const firefoxTarget = targets.some((t) => rdfField(t, "id") === FIREFOX_APP_ID);
  // Blocks that describe other add-ons (the Zotero it targets, dependencies) aren't this one's
  // fields: an <em:requires> block carries Zotero's own homepage.
  let own = xml
    .replace(/<em:targetApplication\b[^>]*\/>/g, "")
    .replace(/<em:(targetApplication|requires)[\s\S]*?<\/em:\1>/g, "");
  for (const re of referenced) own = own.replace(re, "");
  // Some Zotero 5-era files describe target applications outside <em:targetApplication>, so
  // take the first em:id that isn't an application's.
  const ownId = [...own.matchAll(/<em:id>\s*([^<]*?)\s*<\/em:id>|em:id\s*=\s*"([^"]*)"/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .find((id) => id && !APP_IDS.has(id));
  return {
    format: "install.rdf",
    target: zoteroTarget ? "zotero" : firefoxTarget ? "firefox" : "unknown",
    addonId: ownId ?? null,
    name: rdfField(own, "name"),
    version: rdfField(own, "version"),
    description: rdfField(own, "description"),
    homepageUrl: rdfField(own, "homepageURL"),
    updateUrl: rdfField(own, "updateURL"),
    minVersion: zoteroTarget ? rdfField(zoteroTarget, "minVersion") : null,
    maxVersion: zoteroTarget ? rdfField(zoteroTarget, "maxVersion") : null,
  };
}

/** Both manifests when present (hybrid Zotero 6/7 plugins ship both). */
export async function readXpiManifests(read: RangeReader, size: number): Promise<XpiManifest[]> {
  const entries = await listZipEntries(read, size);
  const out: XpiManifest[] = [];
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const json = entries.find((e) => e.name === "manifest.json");
  if (json) out.push(parseManifestJson(decode(await readZipEntry(read, json))));
  const rdf = entries.find((e) => e.name === "install.rdf");
  if (rdf) out.push(parseInstallRdf(decode(await readZipEntry(read, rdf))));
  return out;
}
