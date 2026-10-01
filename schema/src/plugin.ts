import { z } from "zod";
import {
  Category,
  IsoDate,
  IsoDateTime,
  RepoKey,
  SchemaVersion,
  Sha256,
  Slug,
  VersionString,
} from "./common.ts";
import { PluginContent, Requirements } from "./requirements.ts";
import { Review } from "./review.ts";

export const PluginSource = z.enum(["addon-market", "sheet", "topic-search", "manual"]);
export const ListingStatus = z.enum(["listed", "candidate", "excluded"]);
export const MaintenanceStatus = z.enum(["active", "slowing", "dormant", "archived"]);
export const StarterPackId = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .describe("Key into data/starter-packs.yaml");

/**
 * A developer's response to their plugin's card, shown on the page next to the card with our
 * reply. It comes from a public issue ("Respond to a plugin's card"), and only from someone who
 * maintains the plugin's repository. A response never edits the card: a card changes only when
 * the analyzer or the rules change for every plugin.
 */
export const DeveloperResponse = z.object({
  date: IsoDate,
  from: z.string().min(1).describe("GitHub login of a maintainer of the plugin's repository"),
  about: z.enum([
    "source-transparency",
    "data-sharing",
    "capabilities",
    "compatibility",
    "updates",
    "other",
  ]),
  version: VersionString.optional().describe("The version the response is about"),
  text: z.string().min(1).max(2000).describe("The developer's words, published as written"),
  url: z.url().describe("The public issue it came from"),
  status: z
    .enum(["open", "corrected", "finding-stands", "noted"])
    .describe(
      "open: we're checking; corrected: the analyzer or rules changed and the card with them; finding-stands: we kept the finding (see reply); noted: context, not a dispute",
    ),
  reply: z.string().max(2000).optional().describe("What we checked and what changed, if anything"),
  repliedAt: IsoDate.optional(),
});

// ---------------------------------------------------------------------------
// Curated, human-edited: data/plugins/<slug>.yaml
// Anything set here overrides the machine draft of the same field.

export const PluginCurated = z.object({
  schemaVersion: SchemaVersion,
  slug: Slug,
  repo: RepoKey,
  previousSlugs: z.array(Slug).default([]).describe("Old URLs that should redirect here."),
  status: ListingStatus,
  exclusion: z
    .object({
      reason: z.enum([
        "not-a-plugin",
        "duplicate",
        "no-source-repo",
        "spam",
        "requested-by-developer",
        "other",
      ]),
      note: z.string().optional(),
    })
    .optional(),
  content: PluginContent.partial().optional(),
  requirements: Requirements.partial().optional(),
  categories: z
    .object({
      primary: Category,
      secondary: z.array(Category).max(2).default([]),
    })
    .optional(),
  alternatives: z
    .array(z.object({ slug: Slug, difference: z.string().max(200) }))
    .max(4)
    .optional(),
  starterPacks: z.array(StarterPackId).default([]),
  notices: z
    .array(
      z.object({
        kind: z.enum(["legal-risk", "developer-reply", "correction", "info"]),
        text: z.string(),
        date: IsoDate,
        url: z.url().optional(),
      }),
    )
    .default([]),
  reviews: z.array(Review).default([]),
  responses: z.array(DeveloperResponse).default([]),
  internalNotes: z.string().optional().describe("Not published."),
});

// ---------------------------------------------------------------------------
// Machine-generated, repo level: data/generated/<slug>/plugin.json

export const RepoMetadata = z.object({
  fullName: z.string().describe("Owner/name with GitHub's casing"),
  url: z.url(),
  description: z.string().nullable(),
  homepage: z.string().nullable(),
  stars: z.int().nonnegative(),
  forks: z.int().nonnegative(),
  openIssues: z.int().nonnegative(),
  archived: z.boolean(),
  isFork: z.boolean(),
  upstream: RepoKey.nullable(),
  license: z.object({ spdx: z.string().nullable(), name: z.string().nullable() }),
  contributorsCount: z.int().nonnegative().nullable(),
  defaultBranch: z.string(),
  topics: z.array(z.string()),
  createdAt: IsoDateTime,
  pushedAt: IsoDateTime,
  lastCommitAt: IsoDateTime.nullable(),
  lastReleaseAt: IsoDateTime.nullable(),
  readme: z
    .object({
      path: z.string(),
      sha256: Sha256.describe("Hash of the raw README; the text itself lives in .cache/"),
      bytes: z.int().nonnegative(),
    })
    .nullable(),
  fetchedAt: IsoDateTime,
});

export const ReleaseSummary = z.object({
  tag: z.string(),
  name: z.string().nullable(),
  publishedAt: IsoDateTime,
  prerelease: z.boolean(),
  xpiAssets: z.array(
    z.object({
      name: z.string(),
      url: z.url(),
      size: z.int().nonnegative(),
      digest: z.string().nullable().describe("GitHub-reported asset digest, when available"),
      githubAssetId: z.int().positive(),
      uploadedAt: IsoDateTime,
    }),
  ),
  /** Filled once the artifact is fetched and parsed. */
  version: VersionString.nullable(),
});

export const PluginRecord = z.object({
  schemaVersion: SchemaVersion,
  slug: Slug,
  repo: RepoKey,
  redirectedFrom: z.array(RepoKey).describe("Old owner/name pairs GitHub redirected from"),
  sources: z.array(PluginSource).min(1),
  seed: z.object({
    addonMarket: z
      .object({
        name: z.string(),
        description: z.string().nullable(),
        tags: z.array(z.string()),
        recommended: z.boolean(),
      })
      .nullable(),
    sheet: z
      .object({
        name: z.string(),
        summary: z.string().nullable(),
        keyValue: z.string().nullable(),
        workflowPart: z.string().nullable(),
        toolType: z.string().nullable(),
        pricing: z.string().nullable(),
      })
      .nullable(),
  }),
  name: z.string(),
  author: z.object({
    login: z.string(),
    name: z.string().nullable(),
    url: z.url(),
    avatarUrl: z.url().nullable(),
  }),
  github: RepoMetadata.nullable(),
  maintenance: z
    .object({ status: MaintenanceStatus, basis: IsoDateTime.nullable(), computedAt: IsoDateTime })
    .nullable(),
  addonIds: z.array(z.string()),
  addonIdConflicts: z
    .array(z.object({ addonId: z.string(), otherRepos: z.array(RepoKey).min(1) }))
    .describe("Same add-on ID shipped from another repo: surfaced as a red flag."),
  releases: z.array(ReleaseSummary),
  integrityEvents: z
    .array(
      z.object({
        kind: z.enum(["asset-replaced", "tag-moved", "release-deleted", "tag-version-mismatch"]),
        tag: z.string(),
        detectedAt: IsoDateTime,
        before: z
          .object({ sha256: Sha256.nullable(), uploadedAt: IsoDateTime.nullable() })
          .nullable(),
        after: z
          .object({ sha256: Sha256.nullable(), uploadedAt: IsoDateTime.nullable() })
          .nullable(),
        note: z.string().optional(),
      }),
    )
    .describe("Changes to already-published releases, detected by comparing nightly snapshots"),
  zoteroBlocklist: z
    .array(z.object({ addonId: z.string(), versionRange: z.string(), reason: z.string() }))
    .describe("Entries from github.com/zotero/plugin-blocklist that match this plugin"),
  drafts: z
    .object({
      inputHash: Sha256,
      model: z.string(),
      promptVersion: z.string(),
      generatedAt: IsoDateTime,
      content: PluginContent.nullable(),
      requirements: Requirements.nullable(),
      categories: z.object({ primary: Category, secondary: z.array(Category).max(2) }).nullable(),
    })
    .nullable()
    .describe("LLM drafts; the inputHash doubles as the cache key so re-runs are free."),
});

export type PluginCurated = z.infer<typeof PluginCurated>;
export type PluginRecord = z.infer<typeof PluginRecord>;
export type RepoMetadata = z.infer<typeof RepoMetadata>;
export type MaintenanceStatus = z.infer<typeof MaintenanceStatus>;
