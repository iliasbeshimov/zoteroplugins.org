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

/**
 * A reviewed "Uses the network; we couldn't tell where" finding, one file per plugin in
 * data/reviews/network/<slug>.json. The scanner can see network code but not where its address
 * comes from; a review reads the code and settles it one of two ways:
 * - no-requests: the code never sends anything, as the plugin sets it up (a helper nothing calls,
 *   a request that needs a setting the plugin never fills in);
 * - hosts: it sends to the hosts the review names, which then count like hosts the code names.
 * A review names the exact release files by SHA-256, so a new release goes back to the scanner's
 * verdict until it's reviewed again.
 */

const NETWORK_DIR = join(paths.root, "data", "reviews", "network");

export const NetworkReview = z
  .object({
    schemaVersion: z.literal(1),
    slug: z.string(),
    version: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    reviewedAt: z.string(),
    method: z.string(),
    /** The scanner rule the review settles. */
    rule: z.literal("DS-UNKNOWN-DESTINATION"),
    /** no-requests: the code we couldn't trace never sends anything, as the plugin sets it up; hosts: it sends to these. */
    outcome: z.enum(["no-requests", "hosts"]),
    hosts: z.array(z.string()).optional(),
    /** One or two sentences: what the untraced code is and why it does or doesn't send. Shown on the card. */
    summary: z.string(),
    facts: z.record(z.string(), z.unknown()),
    /** Other releases with the same network code, compared by hand with the reviewed one. */
    alsoAppliesTo: z
      .array(
        z.object({
          version: z.string(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          how: z.string(),
        }),
      )
      .optional(),
  })
  .superRefine((r, ctx) => {
    if (r.outcome === "hosts" && !r.hosts?.length)
      ctx.addIssue({ code: "custom", path: ["hosts"], message: "outcome hosts needs hosts" });
  });
export type NetworkReview = z.infer<typeof NetworkReview>;

/** data/reviews/network/<slug>.json, when there is one that validates. */
export async function readNetworkReview(
  slug: string,
  dir = NETWORK_DIR,
): Promise<NetworkReview | null> {
  let text: string;
  try {
    text = await readFile(join(dir, `${slug}.json`), "utf8");
  } catch {
    return null;
  }
  const parsed = NetworkReview.safeParse(JSON.parse(text));
  return parsed.success && parsed.data.slug === slug ? parsed.data : null;
}

/** The SHA-256 of every release file a network review covers. */
export function reviewedNetworkFiles(r: NetworkReview): string[] {
  return [r.sha256, ...(r.alsoAppliesTo ?? []).map((x) => x.sha256)];
}
