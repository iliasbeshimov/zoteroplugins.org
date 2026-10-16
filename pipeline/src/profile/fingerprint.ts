import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityId } from "@atlas/schema";
import { loadLibraryIndex } from "../libs/index.ts";
import { analyzeXpi, developerHints } from "../scan/analyze.ts";
import { loadHostTable } from "../scan/hosts.ts";
import { unzip } from "../scan/run.ts";
import { FindingReviewFile } from "./reviews.ts";

/**
 * `atlas reviews fingerprint`: writes each review's `codeKey`, the capability's fingerprint in the
 * release it reviewed, so a later release with the same code is covered without a new review.
 */

async function readProfile(
  dataDir: string,
  slug: string,
): Promise<{ repo: string; addonId: string | null } | null> {
  try {
    const p = JSON.parse(await readFile(join(dataDir, "generated", slug, "profile.json"), "utf8"));
    return typeof p.repo === "string" ? { repo: p.repo, addonId: p.addonId ?? null } : null;
  } catch {
    return null;
  }
}

/** `codeKey` goes right after `sha256`; every other key keeps its place. */
function withCodeKey(review: Record<string, unknown>, codeKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(review)) {
    if (k === "codeKey") continue;
    out[k] = v;
    if (k === "sha256") out.codeKey = codeKey;
  }
  return out;
}

export async function fingerprintReviews(opts: {
  reviewsDir: string;
  dataDir: string;
  cacheDir: string;
  force: boolean;
  log?: (line: string) => void;
}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    log(line);
  };
  const table = await loadHostTable();
  const libraries = loadLibraryIndex();
  for (const dir of (await readdir(opts.reviewsDir)).sort()) {
    const id = CapabilityId.safeParse(dir);
    if (!id.success) continue;
    const files = (await readdir(join(opts.reviewsDir, dir))).filter((f) => f.endsWith(".json"));
    for (const file of files.sort()) {
      const path = join(opts.reviewsDir, dir, file);
      const label = `${dir}/${file.replace(/\.json$/, "")}`;
      const text = await readFile(path, "utf8");
      const raw = JSON.parse(text) as Record<string, unknown>;
      const parsed = FindingReviewFile.safeParse(raw);
      if (!parsed.success) {
        say(`${label}: not a valid review`);
        continue;
      }
      const review = parsed.data;
      if (review.codeKey && !opts.force) {
        say(`${label}: unchanged (already has a codeKey)`);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(
          await readFile(
            join(
              opts.cacheDir,
              "blobs",
              "sha256",
              review.sha256.slice(0, 2),
              `${review.sha256}.xpi`,
            ),
          ),
        );
      } catch {
        say(`${label}: xpi not cached (${review.version}, ${review.sha256.slice(0, 12)})`);
        continue;
      }
      const profile = await readProfile(opts.dataDir, review.slug);
      const analysis = analyzeXpi({
        slug: review.slug,
        sha256: review.sha256,
        entries: await unzip(bytes),
        table,
        analyzedAt: "1970-01-01T00:00:00.000Z",
        developer: profile
          ? developerHints(profile.repo, profile.addonId, null)
          : { names: [], domains: [] },
        libraries,
      }).analysis;
      const cap = analysis.capabilities.find((c) => c.id === id.data);
      if (!cap?.codeKey) {
        say(`${label}: capability not found (${review.version})`);
        continue;
      }
      if (review.codeKey === cap.codeKey) {
        say(`${label}: unchanged (${cap.codeKey})`);
        continue;
      }
      await writeFile(
        path,
        `${JSON.stringify(withCodeKey(raw, cap.codeKey), null, 2)}${text.endsWith("\n") ? "\n" : ""}`,
      );
      say(`${label}: written ${cap.codeKey} (${review.version})`);
    }
  }
  return lines;
}
