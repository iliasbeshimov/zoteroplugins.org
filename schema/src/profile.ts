import { z } from "zod";
import { Category, IsoDate, IsoDateTime, RepoKey, SchemaVersion, Sha256, Slug } from "./common.ts";
import { DeveloperResponse } from "./plugin.ts";
import { ProvenanceLevel } from "./provenance.ts";
import { PluginContent, Requirements } from "./requirements.ts";
import { TrustCard } from "./trust-card.ts";

/**
 * data/generated/<slug>/profile.json: everything the site, the share card and /api need about one
 * plugin, for its latest release. Written by `atlas profile` from the census, the code analysis
 * and GitHub; nothing here comes from an LLM. `content`, `categories` and reviewed
 * `requirements` stay null until enrichment and review.
 */

export const ListingKind = z.enum([
  "plugin", // Zotero 7+ plugin with an installable .xpi
  "legacy", // install.rdf only: Zotero 6 and earlier
  "no-release", // in a curated list, but no .xpi on GitHub
]);

export const HiddenReason = z.enum(["fork", "legacy", "no-release"]);

/** Script-level language detection; `latin` is Latin-script text that isn't clearly English. */
export const DocLanguage = z.enum(["en", "zh", "ja", "ko", "ru", "latin"]);

const CompatTarget = z.object({
  major: z.int().positive(),
  zoteroVersion: z.string(),
  status: z
    .enum(["compatible", "incompatible", "unknown"])
    .describe(
      "Whether Zotero at exactly zoteroVersion installs and runs one of the release's builds",
    ),
});

export const PluginProfile = z.object({
  schemaVersion: SchemaVersion,
  profilerVersion: z.string(),
  generatedAt: IsoDateTime.describe("When this profile last changed, not when it was last checked"),
  slug: Slug,
  repo: RepoKey,
  repoName: z.string().describe("owner/name with GitHub's casing"),
  name: z.string(),
  listing: z.object({
    kind: ListingKind,
    hiddenByDefault: z.boolean(),
    hiddenReason: HiddenReason.nullable(),
  }),
  links: z.object({
    repo: z.url(),
    homepage: z.string().nullable(),
    issues: z.url(),
    releases: z.url(),
  }),
  author: z.object({ login: z.string(), url: z.url() }),
  license: z.string().nullable(),
  sources: z.array(z.string()).describe("Where the census found it (curated lists, searches)"),

  about: z.object({
    githubDescription: z.string().nullable(),
    manifestDescription: z.string().nullable(),
    topics: z.array(z.string()),
    categoryHint: z
      .string()
      .nullable()
      .describe("The research sheet's Workflow Part, until enrichment assigns categories"),
  }),
  languages: z.object({
    docs: z.array(DocLanguage).describe("Languages the README is written in, by share of text"),
    docsAlternates: z
      .array(z.string())
      .describe("Languages of other READMEs the README links to, e.g. 'en' for README_EN.md"),
    ui: z.array(z.string()).describe("Locale folders shipped in the .xpi (BCP 47 tags)"),
    chineseOnlyDocs: z.boolean().describe("README in Chinese only, with no linked translation"),
    chineseOnlyUi: z.boolean().describe("The only interface locales shipped are Chinese"),
  }),

  popularity: z.object({
    stars: z.int().nonnegative().nullable(),
    forks: z.int().nonnegative().nullable(),
    contributors: z.int().nonnegative().nullable(),
    downloads: z.int().nonnegative().nullable().describe("All-time GitHub .xpi downloads"),
    latestDownloads: z.int().nonnegative().nullable(),
    releaseCount: z.int().nonnegative().nullable(),
    createdAt: IsoDateTime.nullable(),
  }),
  maintenance: z.object({
    status: z.enum(["active", "slowing", "dormant", "archived", "unknown"]),
    lastReleaseAt: IsoDateTime.nullable(),
    lastCommitAt: IsoDateTime.nullable(),
    lastActivityAt: IsoDateTime.nullable(),
  }),
  compatibility: z.object({
    supports: z
      .array(z.int().positive())
      .describe("Zotero majors the manifest range covers; none for a file Zotero won't install"),
    minVersion: z.string().nullable(),
    maxVersion: z.string().nullable(),
    current: CompatTarget.nullable(),
    previous: CompatTarget.nullable(),
    next: CompatTarget.nullable().describe("Next major on the beta/dev channel"),
    blockedByZotero: z
      .object({ reason: z.string(), source: z.url() })
      .nullable()
      .describe("This version is on Zotero's official plugin blocklist"),
  }),
  install: z
    .object({
      version: z.string(),
      tag: z.string(),
      publishedAt: IsoDateTime.nullable(),
      prerelease: z.boolean(),
      asset: z.object({
        name: z.string(),
        url: z.url(),
        size: z.int().nonnegative(),
        sha256: Sha256.nullable(),
      }),
      otherAssets: z.array(z.object({ name: z.string(), url: z.url() })),
      autoUpdates: z
        .boolean()
        .describe("The manifest has a working update address, so Zotero updates the plugin"),
      builds: z
        .array(
          z.object({
            asset: z.string(),
            version: z.string(),
            supports: z.array(z.int()).describe("Zotero majors this build declares"),
            label: z
              .enum(["low-concern", "review-details", "high-concern", "insufficient-data"])
              .nullable(),
            releaseFile: z.string(),
          }),
        )
        .optional()
        .describe("The release's other analysed builds, e.g. for older Zotero or another OS"),
      updates: z
        .object({
          kind: z.enum([
            "this-project",
            "other-listed-project",
            "other-repository",
            "unclaimed-namespace",
            "other-host",
            "none",
          ]),
          url: z.string().nullable(),
          repo: z.string().nullable().describe("owner/name when the address is on a code host"),
          project: Slug.nullable().describe("The listed project updates come from"),
          label: z.string(),
          check: z
            .object({
              checkedAt: IsoDateTime,
              status: z.int().describe("HTTP status of the update address; 0 when unreachable"),
              result: z
                .enum([
                  "same-file",
                  "different-file",
                  "not-analysed",
                  "not-newer",
                  "no-update-for-current",
                  "not-listed",
                  "unreachable",
                ])
                .describe(
                  "What Zotero would install from it today: this file, a different one, nothing",
                ),
              version: z.string().nullable(),
              link: z.string().nullable(),
              finalUrl: z
                .string()
                .optional()
                .describe("Where the update address redirected, e.g. a renamed repository"),
              ownerMissing: z
                .boolean()
                .optional()
                .describe(
                  "The GitHub account or repository the address names doesn't exist or isn't public",
                ),
              missing: z
                .enum(["account", "repository"])
                .optional()
                .describe(
                  "account: nobody holds the name, so anyone could register it; repository: the account exists, so only its owner could publish there",
                ),
              zoteroVersion: z
                .string()
                .optional()
                .describe(
                  "The Zotero version the address was checked for: current Zotero, or the newest one this build supports",
                ),
              sha256: Sha256.nullable().describe("The file the update installs, once downloaded"),
              statedHash: z
                .string()
                .optional()
                .describe(
                  "The hash the update address gives for that file (update_hash), e.g. 'sha512:…'",
                ),
              hashMatches: z
                .boolean()
                .optional()
                .describe(
                  "Whether the file behind the link has the stated hash; when it doesn't, Zotero refuses the update",
                ),
              manifestModifiedAt: IsoDateTime.optional().describe(
                "When the update address's file last changed (its Last-Modified), set when the hash doesn't match: a release file uploaded after it isn't the file it was written for",
              ),
              label: z
                .enum(["low-concern", "review-details", "high-concern", "insufficient-data"])
                .nullable()
                .describe("Overall label of that file when it differs from this one"),
              releaseFile: z.string().nullable(),
              error: z.string().optional().describe("Why the offered file couldn't be analysed"),
              note: z.string().describe("One line for the card's update line"),
            })
            .optional()
            .describe("The update address fetched and followed to the file it offers"),
        })
        .optional()
        .describe("Where Zotero gets updates for this build, which replace the analysed file"),
      releaseFile: z
        .string()
        .nullable()
        .describe("Path of the per-version analysis document, relative to data/generated/"),
    })
    .nullable(),

  fork: z
    .object({ of: z.string(), ofSlug: Slug.nullable() })
    .nullable()
    .describe("Set when the repo is a GitHub fork of another listed plugin"),
  forks: z.array(Slug).describe("Listed forks of this plugin"),
  addonId: z.string().nullable(),
  addonIdSharedWith: z
    .array(Slug)
    .describe("Other listed plugins shipping the same add-on ID; Zotero can only install one"),

  trust: TrustCard.nullable(),
  provenance: z
    .object({
      level: ProvenanceLevel,
      attestation: z.boolean(),
      explanation: z.string(),
    })
    .nullable()
    .describe("Does the file match its public source? Full details in the release file."),
  scan: z.object({
    status: z.enum(["analyzed", "not-analyzed"]),
    reason: z.string().nullable(),
  }),
  requirementsHints: z
    .object({
      aiServices: z.array(z.string()).describe("AI providers the code contacts"),
      otherServices: z.array(z.string()).describe("Other named services the code contacts"),
      storesCredentials: z.boolean().describe("Keeps an API key, token or password in settings"),
      localModels: z.boolean().describe("Talks to a model or server on this computer"),
      launchesPrograms: z.boolean(),
    })
    .nullable()
    .describe("Detected from the code. Not reviewed: enrichment and review confirm them."),
  integrityEvents: z.array(
    z.object({
      kind: z
        .enum(["asset-replaced", "asset-added"])
        .describe("asset-added: a new build appeared under a release tag we had already seen"),
      tag: z.string(),
      asset: z.string().optional().describe("The build's file name, for asset-added"),
      detectedAt: IsoDateTime,
      before: z.object({ sha256: Sha256.nullable(), uploadedAt: IsoDateTime.nullable() }),
      after: z.object({ sha256: Sha256.nullable(), uploadedAt: IsoDateTime.nullable() }),
    }),
  ),

  responses: z
    .array(DeveloperResponse)
    .optional()
    .describe("Developers' responses to the card, with our replies (data/plugins/<slug>.yaml)"),
  notices: z
    .array(
      z.object({
        kind: z.enum(["legal-risk", "developer-reply", "correction", "info"]),
        text: z.string(),
        date: IsoDate,
        url: z.url().optional(),
      }),
    )
    .optional()
    .describe("Notices we add to the page by hand"),
  content: PluginContent.nullable(),
  categories: z.object({ primary: Category, secondary: z.array(Category).max(2) }).nullable(),
  requirements: Requirements.nullable(),
});

/** data/generated/index.json: one compact row per profile, for browse, search and the census. */
export const ProfileIndexEntry = z.object({
  slug: Slug,
  repo: RepoKey,
  name: z.string(),
  description: z.string().nullable(),
  kind: ListingKind,
  hidden: z.boolean(),
  label: TrustCard.shape.overall.shape.label.nullable(),
  dataSharing: z.string().nullable(),
  supports: z.array(z.int().positive()),
  worksWithCurrent: z.boolean(),
  stars: z.int().nonnegative().nullable(),
  downloads: z.int().nonnegative().nullable(),
  maintenance: z.string(),
  lastActivityAt: IsoDateTime.nullable(),
  docs: z.array(DocLanguage),
  chineseOnlyDocs: z.boolean(),
  aiServices: z.array(z.string()),
  categoryHint: z.string().nullable(),
});

export type PluginProfile = z.infer<typeof PluginProfile>;
export type ProfileIndexEntry = z.infer<typeof ProfileIndexEntry>;
export type DocLanguage = z.infer<typeof DocLanguage>;
export type ListingKind = z.infer<typeof ListingKind>;
