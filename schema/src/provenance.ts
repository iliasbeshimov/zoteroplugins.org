import { z } from "zod";
import { CodeEvidence, IsoDateTime, SchemaVersion } from "./common.ts";

/**
 * "Does the code you download match the public source code?"
 * Levels are ordered from strongest to weakest claim; `not-checked` means the check hasn't run.
 */
export const ProvenanceLevel = z.enum([
  "reproduced", // rebuilt from the tagged source; normalised output matched
  "matches-source", // no build step; files identical to the tagged source
  "plausible", // build step exists, not reproduced, no red flags
  "mismatch", // release contains substantial code not present in the tagged source
  "no-source", // no public source, or it is inaccessible
  "not-checked", // the check has not run for this version (yet)
]);

export const Provenance = z.object({
  schemaVersion: SchemaVersion,
  checkerVersion: z.string(),
  checkedAt: IsoDateTime,
  level: ProvenanceLevel,
  method: z.enum(["direct-diff", "rebuild", "none"]),
  tag: z
    .object({
      name: z.string(),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      commitDate: IsoDateTime,
      matchedBy: z.enum(["exact", "v-prefix", "version-in-name", "release-target-commitish"]),
      stale: z
        .boolean()
        .describe(
          "Tag commit changes only docs and lags far behind while the .xpi contains new code.",
        ),
    })
    .nullable(),
  build: z
    .object({
      attempted: z.boolean(),
      succeeded: z.boolean(),
      timedOut: z.boolean(),
      nodeVersion: z.string().optional(),
      command: z.string().optional(),
      durationMs: z.int().nonnegative().optional(),
      logExcerpt: z.string().max(2000).optional(),
    })
    .nullable(),
  diff: z
    .object({
      identical: z.int().nonnegative(),
      differing: z.int().nonnegative(),
      onlyInRelease: z.array(z.string()),
      onlyInSource: z.int().nonnegative(),
      unexplained: z
        .array(
          z.object({
            path: z.string(),
            bytes: z.int().nonnegative(),
            evidence: z.array(CodeEvidence).max(5),
          }),
        )
        .describe("Substantial release code with no counterpart in the source. Drives `mismatch`."),
    })
    .nullable(),
  attestation: z.object({
    present: z.boolean(),
    verified: z.boolean(),
    workflow: z.string().optional(),
  }),
  explanation: z.string().describe("Template-generated, factual sentence shown under the level."),
});

export type ProvenanceLevel = z.infer<typeof ProvenanceLevel>;
export type Provenance = z.infer<typeof Provenance>;
