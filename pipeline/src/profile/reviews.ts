import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityId } from "@atlas/schema";
import { z } from "zod";
import { paths } from "../paths.ts";
import { classifyDownload, DownloadFacts, downloadLabelEnd, downloadWhy } from "./download.ts";

/**
 * A hand review of one finding in one plugin, a file per plugin in
 * data/reviews/<capability-id>/<slug>.json. The scanner can see that a plugin has a capability but
 * not always what it is, whether the plugin tells you, or where it comes from; a review
 * establishes that from the release file and its README, and sets the finding's level. A download
 * review's level and rule are computed from its facts by classifyDownload (download.ts), and the
 * file must state the same level and rule.
 * A review names the exact release files by SHA-256 and, when it has one, the capability's codeKey:
 * a later release whose code behind the finding has the same codeKey is covered too (a rebuild that
 * only renamed things), and any other release goes back to the scanner's verdict until it's
 * reviewed again. data/reviews/network/ is a different kind of review (NetworkReview, below).
 */

const REVIEWS_DIR = join(paths.root, "data", "reviews");

export const FindingReviewFile = z.object({
  schemaVersion: z.literal(1),
  slug: z.string(),
  version: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The reviewed release's codeKey for this capability (analysis.ts). */
  codeKey: z.string().optional(),
  reviewedAt: z.string(),
  method: z.string(),
  /** false: the scanner misread the code, and the finding is dropped. */
  real: z.boolean(),
  concern: z.enum(["low", "medium", "high"]),
  rule: z.string(),
  /** A short badge label written by the reviewer, replacing the generic one. */
  label: z.string().optional(),
  /** The badge's second line: what, when, whether you're told, whether it's checked. */
  summary: z.string(),
  facts: z.record(z.string(), z.unknown()),
  contentChecked: z.string().optional(),
  /** Other releases with the same code, compared by hand with the reviewed one. */
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
/** A review as read: the capability is the name of the directory it sits in. */
export type FindingReview = z.infer<typeof FindingReviewFile> & {
  capability: CapabilityId;
  /** A download review's reason for its level, computed from its facts. */
  why?: string;
  /** What a download review's badge label ends with, computed from its facts. */
  labelEnd?: string;
};

/** data/reviews/<capability>/<slug>.json, when there is one that validates. */
export async function readFindingReview(
  capability: CapabilityId,
  slug: string,
  root = REVIEWS_DIR,
): Promise<FindingReview | null> {
  let text: string;
  try {
    text = await readFile(join(root, capability, `${slug}.json`), "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = FindingReviewFile.safeParse(json);
  if (!parsed.success || parsed.data.slug !== slug) return null;
  const review = parsed.data;
  if (capability === "download-exec" && review.real) {
    const facts = DownloadFacts.safeParse(review.facts);
    if (!facts.success) return null;
    const contentChecked = Boolean(review.contentChecked);
    const got = classifyDownload(facts.data, contentChecked);
    if (review.concern !== got.concern || review.rule !== got.rule) return null;
    return {
      ...review,
      capability,
      why: downloadWhy(got.kind, facts.data, contentChecked),
      labelEnd: downloadLabelEnd(got.kind, got.concern),
    };
  }
  return { ...review, capability };
}

/** Every review of a plugin, from every capability directory. */
export async function readFindingReviews(
  slug: string,
  root = REVIEWS_DIR,
): Promise<FindingReview[]> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  const out: FindingReview[] = [];
  for (const dir of dirs.sort()) {
    const id = CapabilityId.safeParse(dir);
    if (!id.success) continue;
    const review = await readFindingReview(id.data, slug, root);
    if (review) out.push(review);
  }
  return out;
}

/** The SHA-256 of every release file a review covers. */
export function reviewedFiles(r: Pick<FindingReview, "sha256" | "alsoAppliesTo">): string[] {
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
