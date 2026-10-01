import { analyzeXpi, type XpiEntry } from "../../src/scan/analyze.ts";
import { type HostTable, loadHostTable } from "../../src/scan/hosts.ts";
import { preview } from "../../src/scan/preview.ts";

/** Synthetic plugins for analyzer tests: a Zotero 7+ manifest.json plus the given files. */

let table: HostTable | null = null;
export async function hostTable(): Promise<HostTable> {
  table ??= await loadHostTable();
  return table;
}

const enc = new TextEncoder();
export const manifestJson = (
  extra: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
) =>
  JSON.stringify({
    manifest_version: 2,
    name: "Fixture",
    version: "1.0.0",
    ...top,
    applications: {
      zotero: {
        id: "fixture@example.org",
        strict_min_version: "6.999",
        strict_max_version: "10.*",
        ...extra,
      },
    },
  });

export interface ScanOptions {
  manifest?: Record<string, unknown>;
  /** Replace the default manifest.json (or pass null for none). */
  rawManifest?: string | null;
  repo?: string;
  addonId?: string;
}

export async function scanFiles(
  files: Record<string, string | Uint8Array>,
  opts: ScanOptions = {},
) {
  const { developerHints } = await import("../../src/scan/analyze.ts");
  const entries: XpiEntry[] = [
    ...(opts.rawManifest === null
      ? []
      : [
          {
            path: "manifest.json",
            data: enc.encode(opts.rawManifest ?? manifestJson(opts.manifest)),
          },
        ]),
    ...Object.entries(files).map(([path, text]) => ({
      path,
      data: typeof text === "string" ? enc.encode(text) : text,
    })),
  ];
  const result = analyzeXpi({
    slug: "fixture",
    sha256: "a".repeat(64),
    entries,
    table: await hostTable(),
    analyzedAt: "2026-09-25T00:00:00Z",
    ...(opts.repo ? { developer: developerHints(opts.repo, opts.addonId ?? null, null) } : {}),
  });
  return { ...result, card: preview(result.analysis, result.updateHost) };
}

export type ScanOutput = Awaited<ReturnType<typeof scanFiles>>;
export const hostIn = (r: ScanOutput, name: string) =>
  r.analysis.network.hosts.find((h) => h.host === name);
export const capIn = (r: ScanOutput, id: string) =>
  r.analysis.capabilities.find((c) => c.id === id);
