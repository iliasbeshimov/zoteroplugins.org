import { z } from "zod";
import { CapabilityId, HostCategory } from "./analysis.ts";
import {
  ArtifactRef,
  IsoDate,
  IsoDateTime,
  SchemaVersion,
  Sha256,
  VersionString,
} from "./common.ts";
import { MaintenanceStatus } from "./plugin.ts";
import { ProvenanceLevel } from "./provenance.ts";
import { SandboxExercised, SandboxSentKind, SandboxVerdict } from "./sandbox.ts";

/**
 * The per-version Trust Card. Produced by `atlas score` from deterministic, published rules
 * (pipeline/src/profile/score.ts, `rulesVersion`). An LLM never sets any value here.
 *
 * Every facet lists the rule IDs that produced it (`drivers`), and the overall label lists the
 * facets that drove it, so the page can always answer "why does it say that?".
 */

export const Concern = z.enum(["none", "low", "medium", "high", "unknown"]);
export const FacetId = z.enum([
  "sourceTransparency",
  "dataSharing",
  "capabilities",
  "requirements",
  "maintenance",
  "compatibility",
  "reviewStatus",
]);

const RuleIds = z
  .array(z.string())
  .describe("IDs of the rules that fired (the rule table in pipeline/src/profile/score.ts)");

export const DataSharingValue = z.enum([
  "no-network-found",
  "user-configured-only",
  "named-third-parties",
  "developer-servers",
  "unknown-endpoints",
  "bundled-library-only",
  "not-analyzed",
]);

export const CompatibilityStatus = z.enum(["compatible", "incompatible", "unknown"]);
const CompatibilityTarget = z.object({
  zoteroVersion: z.string().describe("e.g. '10.0.3' or '11.0-dev.5'"),
  major: z.int().positive(),
  status: CompatibilityStatus.describe(
    "Whether Zotero at exactly zoteroVersion installs and runs it: every part of the version is compared, as Zotero does",
  ),
});

export const TrustCard = z.object({
  schemaVersion: SchemaVersion,
  rulesVersion: z.string(),
  computedAt: IsoDateTime,
  appliesTo: ArtifactRef,
  inputs: z.object({
    analyzerVersion: z.string().nullable(),
    provenanceCheckerVersion: z.string().nullable(),
    hostsTableVersion: z.string().nullable(),
    currentZotero: z.string(),
    inputHash: Sha256.describe("Hash of every input above; unchanged hash means unchanged card"),
  }),
  facets: z.object({
    sourceTransparency: z.object({
      provenance: ProvenanceLevel,
      obfuscated: z.union([z.boolean(), z.literal("unknown")]),
      suspiciousUnicode: z.boolean(),
      sourceMaps: z.boolean(),
      assetReplaced: z
        .boolean()
        .describe("The file behind this release tag changed after it was first published"),
      assetReplacedDetail: z
        .string()
        .optional()
        .describe(
          "How we know it changed: our own earlier copy, or the fingerprint the project's own update manifest gives for this version",
        ),
      updates: z
        .object({
          kind: z.string(),
          label: z.string(),
          check: z
            .string()
            .optional()
            .describe("What the update address offers today, e.g. a different file and its label"),
          note: z
            .string()
            .optional()
            .describe(
              "What the plugin does to its own updates, e.g. turning Zotero's automatic updates on",
            ),
        })
        .optional()
        .describe(
          "Where updates come from; a template namespace the developer doesn't control is a concern",
        ),
      partialAnalysis: z
        .string()
        .nullable()
        .optional()
        .describe("Set when part of the code was skipped or only scanned for known patterns"),
      concern: Concern,
      label: z.string(),
      drivers: RuleIds,
    }),
    dataSharing: z.object({
      value: DataSharingValue,
      hosts: z.array(
        z.object({
          category: HostCategory,
          hosts: z.array(z.string()),
          unconfirmed: z
            .array(z.string())
            .optional()
            .describe(
              "Hosts in this group we found in the code but didn't trace to a request (shown as 'named in its code')",
            ),
          unencrypted: z
            .array(z.string())
            .optional()
            .describe(
              "Hosts in this group a request reaches over plain http:// (shown as 'unencrypted'): anyone on the network in between can read or change what's sent",
            ),
          observed: z
            .array(z.string())
            .optional()
            .describe(
              "Hosts in this group the plugin contacted when we ran this exact file in Zotero (shown as 'seen when we ran it'), whether or not we found them in its code; they count as traced requests",
            ),
        }),
      ),
      concern: Concern,
      label: z.string(),
      legalRisk: z
        .boolean()
        .optional()
        .describe(
          "A destination is a shadow library such as Sci-Hub: shown as a neutral legal notice",
        ),
      drivers: RuleIds,
    }),
    capabilities: z.object({
      badges: z.array(
        z.object({
          id: CapabilityId,
          label: z
            .string()
            .describe("Plain language, e.g. 'Writes to the Zotero database directly'"),
          concern: Concern,
          libraries: z
            .array(z.string())
            .optional()
            .describe(
              "Set when every use sits in bundled libraries: the card names them, e.g. 'from zotero-plugin-toolkit'",
            ),
          detail: z
            .string()
            .optional()
            .describe(
              "What, where from or which setting, e.g. 'From astral.sh; not checked against a fixed fingerprint'",
            ),
        }),
      ),
      concern: Concern,
      drivers: RuleIds,
    }),
    requirements: z.object({
      badges: z.array(
        z.object({
          id: z.enum(["api-key", "account", "paid", "companion-app"]),
          label: z.string(),
          detail: z.string().optional(),
        }),
      ),
      reviewed: z.boolean().describe("False while any requirement is still an unreviewed draft"),
    }),
    maintenance: z.object({
      status: MaintenanceStatus,
      lastReleaseAt: IsoDateTime.nullable(),
      lastCommitAt: IsoDateTime.nullable(),
      concern: Concern,
    }),
    compatibility: z.object({
      current: CompatibilityTarget,
      previous: CompatibilityTarget.nullable(),
      next: CompatibilityTarget.nullable().describe("Next major on the beta/dev channel, if any"),
      blockedByZotero: z
        .object({ reason: z.string(), source: z.url() })
        .nullable()
        .describe("This version is on Zotero's official plugin blocklist"),
      installProblem: z
        .enum(["invalid-id", "no-update-url", "no-max-version"])
        .optional()
        .describe(
          "Zotero won't install this manifest.json file at all, so it works with no Zotero version: an add-on ID missing or not in the form Firefox accepts (a GUID in braces, or name@domain in letters, digits, - . _), no update address (applications.zotero.update_url) or no maximum version (strict_max_version)",
        ),
      label: z
        .string()
        .optional()
        .describe("One line shown next to the overall label: whether it runs on current Zotero"),
      concern: Concern,
    }),
    reviewStatus: z.object({
      state: z.enum(["automated-only", "human-reviewed"]),
      reviewer: z.string().optional(),
      reviewedAt: IsoDate.optional(),
      reviewedVersion: VersionString.optional(),
      stale: z
        .boolean()
        .describe("A newer version with material changes has appeared since the review"),
    }),
  }),
  overall: z.object({
    label: z.enum(["low-concern", "review-details", "high-concern", "insufficient-data"]),
    ruleId: z.string(),
    drivers: z.array(FacetId).describe("Facets that determined the label, shown next to it"),
    reasons: z
      .array(z.string())
      .optional()
      .describe("The findings that set the label, most important first: the 'because' line"),
  }),
  tested: z
    .object({
      zotero: z.string().describe("The Zotero version it ran in"),
      testedAt: IsoDateTime,
      verdict: SandboxVerdict,
      exercised: SandboxExercised,
      contacted: z.array(z.string()).describe("Hosts it contacted during the test"),
      sentTo: z
        .array(z.object({ host: z.string(), sent: z.array(SandboxSentKind) }))
        .optional()
        .describe(
          "Hosts that received the test library's own text during the test, and which kinds, e.g. api.crossref.org: identifiers, titles (the items' DOIs and titles); absent when none did, or when the record doesn't say",
        ),
      fetched: z
        .array(z.string())
        .optional()
        .describe(
          "Hosts it only loaded pages from during the test (plain GET or HEAD requests, nothing sent): listed, but not counted as data sharing; absent when there were none, or when the record doesn't say",
        ),
      unexpected: z
        .array(z.string())
        .describe("What it did that its card didn't say before the test, in plain English"),
    })
    .optional()
    .describe(
      "What this exact file did when we ran it in a throwaway Zotero (data/sandbox/<slug>.json); absent when this file hasn't been tested",
    ),
});

export type TrustCard = z.infer<typeof TrustCard>;
export type Concern = z.infer<typeof Concern>;
export type DataSharingValue = z.infer<typeof DataSharingValue>;
