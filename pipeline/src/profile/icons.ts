import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { listZipEntries, readZipEntry, type ZipEntry } from "../census/xpi.ts";
import { fetchWithRetry } from "../net/http.ts";
import { paths, repoRoot } from "../paths.ts";

/**
 * Plugin icons: the icon a plugin declares in its own package (manifest.json `icons`, or
 * install.rdf's `iconURL` for Zotero 6), the image Zotero shows in Tools › Plugins, taken from the
 * release file we graded. Each is rendered to site/public/icons/<slug>.png at 96 px on a
 * transparent square, and data/generated/icons.json records the release file it came from, so a
 * plugin is only redone when its release file changes.
 *
 * Left out, with the reason recorded: the plugin template's stock icon (any icon shared by
 * TEMPLATE_SHARE or more plugins), raster images under MIN_SIZE px, and icons that render blank or
 * white (drawn for Zotero's own toolbar colours). SVGs are rasterized here and never served: an SVG
 * can carry script.
 */

export const OUT_DIR = join(repoRoot, "site", "public", "icons");
const INDEX = join(paths.generated, "icons.json");
const SIZE = 96;
export const MIN_SIZE = 48;
/** Forks share their parent's icon; a template's stock icon is shared far more widely. */
export const TEMPLATE_SHARE = 10;
/** zotero-plugin-template's favicon, carried by 114 plugins on 2026-11-09. */
const KNOWN_TEMPLATE = new Set([
  "2fd7c8f97dea9a603d03e9e418a9ae3b58414f8f7c262b982dab7a425b10860b",
]);
/** The colour for Zotero's context-fill and context-stroke, which only Zotero's chrome defines. */
const INK = "#3c4150";

export type IconStatus =
  | "ok"
  | "none"
  | "missing-file"
  | "unsupported"
  | "small"
  | "blank"
  | "white"
  | "template"
  | "unreadable";

export interface IconRecord {
  /** SHA-256 of the release file the icon was taken from. */
  xpi: string;
  status: IconStatus;
  /** The icon's path inside the release file. */
  src?: string;
  /** SHA-256 of the icon file as shipped, to spot icons shared by many plugins. */
  srcSha256?: string;
  kind?: string;
  /** Width of a raster icon as shipped. */
  width?: number;
}

interface IconIndex {
  schemaVersion: 1;
  icons: Record<string, IconRecord>;
}

interface CatalogEntry {
  slug: string;
  file: { sha256: string; url: string } | null;
}

/** The icon paths a manifest.json declares, best first: an SVG, then the largest size. */
export function declaredIcons(manifest: unknown): string[] {
  const icons = (manifest as { icons?: Record<string, unknown> } | null)?.icons;
  if (!icons || typeof icons !== "object") return [];
  return Object.entries(icons)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0)
    .map(([k, v]) => ({ size: Number.parseInt(k, 10) || 0, path: v }))
    .sort((a, b) => Number(isSvg(b.path)) - Number(isSvg(a.path)) || b.size - a.size)
    .map((x) => x.path);
}

/** install.rdf's iconURL, as an element or an attribute. */
export function rdfIcon(rdf: string): string | null {
  return /iconURL\s*(?:>|=\s*["'])\s*([^<"'\s]+)/.exec(rdf)?.[1] ?? null;
}

/** A path inside the package for a declared icon, resolving chrome:// URLs through chrome.manifest. */
export function resolveIconPath(declared: string, chromeManifest: string | null): string {
  const m = /^chrome:\/\/([^/]+)\/(content|skin|locale)\/(.*)$/.exec(declared);
  if (!m) return declared.replace(/^\.?\//, "");
  const [, pkg, kind, rest] = m;
  for (const line of (chromeManifest ?? "").split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    // "content <pkg> <path>" and "skin <pkg> <skin name> <path>"
    if (f[0] === kind && f[1] === pkg) {
      const base = (kind === "content" ? f[2] : f[3]) ?? "";
      return `${base.replace(/^\.?\//, "").replace(/\/?$/, "/")}${rest}`;
    }
  }
  return `chrome/${kind}/${rest}`;
}

const isSvg = (p: string) => /\.svgz?$/i.test(p);

/** The image format from a file's first bytes (and its name for SVG). */
export function imageKind(
  path: string,
  b: Uint8Array,
): "svg" | "png" | "jpeg" | "gif" | "webp" | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (isSvg(path) || /^\s*(<\?xml|<svg)/.test(new TextDecoder().decode(b.subarray(0, 200))))
    return "svg";
  return null;
}

/** A PNG's width from its header. */
export function pngWidth(b: Uint8Array): number | null {
  if (b.length < 24) return null;
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(16);
}

/** Zotero's context-fill and context-stroke only resolve inside Zotero: give them a real colour. */
export function recolorSvg(svg: string): string {
  return svg.replace(/context-(fill|stroke)-opacity/g, "1").replace(/context-(fill|stroke)/g, INK);
}

/**
 * How much of a rendered RGBA square is drawn, and whether what's drawn is nearly white.
 * `light` is only true when the white sits on transparency: a logo on its own white tile is fine.
 */
export function inkStats(rgba: Uint8Array): { coverage: number; light: boolean } {
  let drawn = 0;
  let lum = 0;
  let weight = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const [r = 0, g = 0, b = 0, alpha = 0] = rgba.subarray(i, i + 4);
    const a = alpha / 255;
    if (a > 0.1) drawn++;
    lum += a * ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
    weight += a;
  }
  const coverage = drawn / (rgba.length / 4);
  return { coverage, light: weight > 0 && lum / weight > 0.9 && coverage < 0.9 };
}

/** Renders an icon centred on a transparent SIZE × SIZE square. */
export function renderIcon(bytes: Uint8Array, kind: string): { png: Buffer; rgba: Uint8Array } {
  const data = kind === "svg" ? Buffer.from(recolorSvg(new TextDecoder().decode(bytes))) : bytes;
  const mime = kind === "svg" ? "image/svg+xml" : `image/${kind}`;
  const href = `data:${mime};base64,${Buffer.from(data).toString("base64")}`;
  const frame = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}"><image width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid meet" xlink:href="${href}"/></svg>`;
  const img = new Resvg(frame, { fitTo: { mode: "original" } }).render();
  return { png: img.asPng(), rgba: new Uint8Array(img.pixels) };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The icon a release file declares, rendered, or the reason there isn't one. */
export async function iconFromXpi(
  xpi: Uint8Array,
): Promise<{ record: Omit<IconRecord, "xpi">; png?: Buffer }> {
  const read = async (s: number, e: number) => xpi.subarray(s, Math.min(e + 1, xpi.length));
  let entries: ZipEntry[];
  try {
    entries = await listZipEntries(read, xpi.length);
  } catch {
    return { record: { status: "unreadable" } };
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const text = async (name: string) => {
    const e = byName.get(name);
    return e ? new TextDecoder().decode(await readZipEntry(read, e)).replace(/^﻿/, "") : null;
  };
  let declared: string[] = [];
  const manifest = await text("manifest.json");
  if (manifest) {
    try {
      declared = declaredIcons(JSON.parse(manifest));
    } catch {
      return { record: { status: "unreadable" } };
    }
  } else {
    const rdf = await text("install.rdf");
    const icon = rdf ? rdfIcon(rdf) : null;
    if (icon) declared = [icon];
  }
  if (!declared.length) return { record: { status: "none" } };
  const chrome = await text("chrome.manifest");
  const src = declared.map((d) => resolveIconPath(d, chrome)).find((p) => byName.has(p));
  if (!src) return { record: { status: "missing-file" } };
  const bytes = await readZipEntry(read, byName.get(src) as ZipEntry);
  const kind = imageKind(src, bytes);
  const base = { src, srcSha256: sha256(bytes), kind: kind ?? undefined };
  if (!kind) return { record: { ...base, status: "unsupported" } };
  const width = kind === "png" ? (pngWidth(bytes) ?? undefined) : undefined;
  if (width !== undefined && width < MIN_SIZE)
    return { record: { ...base, width, status: "small" } };
  let out: { png: Buffer; rgba: Uint8Array };
  try {
    out = renderIcon(bytes, kind);
  } catch {
    return { record: { ...base, width, status: "unreadable" } };
  }
  const { coverage, light } = inkStats(out.rgba);
  if (coverage < 0.02) return { record: { ...base, width, status: "blank" } };
  if (light) return { record: { ...base, width, status: "white" } };
  return { record: { ...base, width, status: "ok" }, png: out.png };
}

async function loadIndex(): Promise<IconIndex> {
  try {
    return JSON.parse(await readFile(INDEX, "utf8")) as IconIndex;
  } catch {
    return { schemaVersion: 1, icons: {} };
  }
}

/** The release file's bytes: from the blob cache, or downloaded and checked against its SHA-256. */
async function releaseFile(
  file: { sha256: string; url: string },
  cacheDir: string,
  userAgent: string,
  fetch: boolean,
): Promise<Uint8Array | null> {
  const blob = join(cacheDir, "blobs", "sha256", file.sha256.slice(0, 2), `${file.sha256}.xpi`);
  if (existsSync(blob)) return new Uint8Array(await readFile(blob));
  if (!fetch) return null;
  const res = await fetchWithRetry(file.url, { headers: { "user-agent": userAgent } });
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (sha256(bytes) !== file.sha256) return null;
  await mkdir(dirname(blob), { recursive: true });
  await writeFile(blob, bytes);
  return bytes;
}

/**
 * Brings site/public/icons up to date with the catalogue: plugins whose release file changed (or
 * all, with `force`) are redone; icons of plugins no longer listed are removed.
 */
export async function updateIcons(opts: {
  cacheDir: string;
  userAgent: string;
  fetch?: boolean;
  force?: boolean;
  only?: string;
}): Promise<Record<IconStatus, number>> {
  const catalog = JSON.parse(await readFile(join(paths.generated, "catalog.json"), "utf8")) as {
    plugins: CatalogEntry[];
  };
  const index = await loadIndex();
  await mkdir(OUT_DIR, { recursive: true });
  const listed = new Set(catalog.plugins.map((p) => p.slug));
  for (const p of catalog.plugins) {
    if (!p.file?.sha256 || (opts.only && p.slug !== opts.only)) continue;
    const prev = index.icons[p.slug];
    if (!opts.force && prev?.xpi === p.file.sha256) continue;
    const xpi = await releaseFile(p.file, opts.cacheDir, opts.userAgent, opts.fetch ?? true);
    if (!xpi) continue; // keep what we had until the file can be read
    const { record, png } = await iconFromXpi(xpi);
    index.icons[p.slug] = { xpi: p.file.sha256, ...record };
    const out = join(OUT_DIR, `${p.slug}.png`);
    if (png) await writeFile(out, png);
    else await rm(out, { force: true });
  }
  // Template icons: the known one, and any shared by TEMPLATE_SHARE or more plugins.
  const shares = new Map<string, number>();
  for (const r of Object.values(index.icons))
    if (r.srcSha256) shares.set(r.srcSha256, (shares.get(r.srcSha256) ?? 0) + 1);
  for (const [slug, r] of Object.entries(index.icons)) {
    if (!listed.has(slug)) {
      delete index.icons[slug];
      continue;
    }
    const template =
      r.srcSha256 &&
      (KNOWN_TEMPLATE.has(r.srcSha256) || (shares.get(r.srcSha256) ?? 0) >= TEMPLATE_SHARE);
    if (template) r.status = "template";
  }
  // The folder holds exactly the "ok" icons.
  for (const f of await readdir(OUT_DIR)) {
    const slug = f.replace(/\.png$/, "");
    if (index.icons[slug]?.status !== "ok") await rm(join(OUT_DIR, f), { force: true });
  }
  const sorted = Object.fromEntries(
    Object.entries(index.icons).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(INDEX, `${JSON.stringify({ schemaVersion: 1, icons: sorted }, null, 2)}\n`);
  const counts = {} as Record<IconStatus, number>;
  for (const r of Object.values(sorted)) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}
