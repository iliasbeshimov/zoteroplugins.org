import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../paths.ts";

/**
 * A reviewed "Downloads a program and runs it" finding, one file per plugin in
 * data/reviews/download-exec/<slug>.json. The scanner can see that a plugin downloads something and
 * runs it, but not what it is, whether the plugin tells you, or where it comes from; a review
 * establishes that from the release file and its README, and sets the finding's level:
 * - low: you're told first (README, or a button or prompt that says it downloads) and it comes from
 *   the program's own publisher over https;
 * - medium: anything else we could identify;
 * - high: it comes over unencrypted http with no check, so someone on the network can swap it.
 * A review names the exact release files by SHA-256, so a new release goes back to the scanner's
 * verdict until it's reviewed again.
 */

const DIR = join(paths.root, "data", "reviews", "download-exec");

export const DownloadReview = z.object({
  schemaVersion: z.literal(1),
  slug: z.string(),
  version: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reviewedAt: z.string(),
  method: z.string(),
  /** false: the scanner misread the code, and the finding is dropped. */
  real: z.boolean(),
  concern: z.enum(["low", "medium", "high"]),
  rule: z.string(),
  /** The badge's second line: what, when, whether you're told, whether it's checked. */
  summary: z.string(),
  facts: z.record(z.string(), z.unknown()),
  contentChecked: z.string().optional(),
  /** Other releases with the same download code, compared by hand with the reviewed one. */
  alsoAppliesTo: z
    .array(
      z.object({
        version: z.string(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        how: z.string(),
      }),
    )
    .optional(),
});
export type DownloadReview = z.infer<typeof DownloadReview>;

/** data/reviews/download-exec/<slug>.json, when there is one that validates. */
export async function readDownloadReview(slug: string, dir = DIR): Promise<DownloadReview | null> {
  let text: string;
  try {
    text = await readFile(join(dir, `${slug}.json`), "utf8");
  } catch {
    return null;
  }
  const parsed = DownloadReview.safeParse(JSON.parse(text));
  return parsed.success && parsed.data.slug === slug ? parsed.data : null;
}

/** The SHA-256 of every release file a review covers. */
export function reviewedFiles(r: DownloadReview): string[] {
  return [r.sha256, ...(r.alsoAppliesTo ?? []).map((x) => x.sha256)];
}
