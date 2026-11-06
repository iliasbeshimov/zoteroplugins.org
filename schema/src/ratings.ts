import { z } from "zod";
import { IsoDateTime } from "./common.ts";

/**
 * data/generated/ratings.json: the published ratings, as zoteroatlas.com/api/v1/ratings.json serves
 * them (zotero-atlas/server/lib.js, publicRatings), fetched nightly by `atlas ratings`.
 * Ratings come from Zotero Atlas (no account) and zoteroplugins.org (a confirmed email address);
 * each is checked before it's published. They never change a grade.
 */

export const RatingSummary = z.object({
  count: z.int().nonnegative(),
  average: z.number().min(1).max(5).nullable(),
  stars: z
    .array(z.int().nonnegative())
    .length(5)
    .describe("How many 1-, 2-, 3-, 4- and 5-star ratings, in that order"),
});

export const PublicReview = z.object({
  stars: z.int().min(1).max(5),
  version: z.string(),
  text: z.string(),
  by: z.string().describe('"Zotero Atlas user", the name a website reviewer chose, or "Anonymous"'),
  from: z.enum(["zotero-atlas", "website"]),
  zotero: z.string().nullable().describe("The Zotero version, for ratings from Zotero Atlas"),
  usedDays: z
    .int()
    .nonnegative()
    .nullable()
    .describe("How long that install had the plugin when it rated, from its plugin lists"),
  posted: z.string().describe("YYYY-MM-DD"),
});

export const PluginRatings = z.object({
  all: RatingSummary,
  versions: z.record(z.string(), RatingSummary),
  reviews: z.array(PublicReview).describe("Reviews with text, newest first"),
});

export const PublicRatings = z.object({
  generatedAt: IsoDateTime,
  plugins: z.record(z.string(), PluginRatings).describe("By the plugin's slug"),
});

export type RatingSummary = z.infer<typeof RatingSummary>;
export type PublicReview = z.infer<typeof PublicReview>;
export type PluginRatings = z.infer<typeof PluginRatings>;
export type PublicRatings = z.infer<typeof PublicRatings>;
