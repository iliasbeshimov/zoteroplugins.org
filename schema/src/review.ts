import { z } from "zod";
import { IsoDate, Sha256, VersionString } from "./common.ts";

/**
 * A human review, written by `atlas review <slug>` into data/plugins/<slug>.yaml.
 * Approved/edited values live next to it in the YAML; this record says who decided what, and
 * against which version and analysis, so the site can show "reviewed for v1.4.2" and flag a
 * review as stale when a newer version has material changes.
 */
export const Review = z.object({
  reviewer: z.object({
    name: z.string().min(1),
    github: z.string().optional(),
  }),
  reviewedAt: IsoDate,
  version: VersionString,
  analysisSha256: Sha256.optional().describe("SHA-256 of the analysis document the reviewer saw."),
  fields: z
    .array(
      z.object({
        path: z
          .string()
          .describe("Dotted field path, e.g. 'requirements.apiKey' or 'content.oneLiner'"),
        decision: z.enum(["approved", "edited", "rejected"]),
        note: z.string().optional(),
      }),
    )
    .min(1),
  summary: z.string().optional(),
});

export type Review = z.infer<typeof Review>;
