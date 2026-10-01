import { z } from "zod";

/** Bumped whenever a stored file's shape changes incompatibly. Every persisted document carries it. */
export const SCHEMA_VERSION = 1;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** URL-safe plugin identifier, stable once assigned (e.g. `zotero-pdf-translate`, `zotero-gpt--forkowner`). */
export const Slug = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits and hyphens");

/** Canonical GitHub repository key: lowercase `owner/name`. */
export const RepoKey = z
  .string()
  .regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/, "lowercase owner/name")
  .describe("Canonical GitHub repository key: lowercase owner/name");

export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "lowercase hex SHA-256");

export const IsoDateTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();

/** Plugin version as declared in the manifest. Free-form because plugin authors are. */
export const VersionString = z.string().min(1).max(64);

export const Confidence = z
  .number()
  .min(0)
  .max(1)
  .describe(
    "0 = guess, 1 = certain. LLM-reported confidence is capped when evidence fails verification.",
  );

/**
 * A pointer into the released code. File paths are relative to the .xpi root.
 * Snippets are truncated to keep committed data small and to avoid rehosting code.
 */
export const CodeEvidence = z.object({
  kind: z.literal("code"),
  file: z.string().min(1),
  line: z.int().positive(),
  column: z.int().nonnegative().optional(),
  snippet: z.string().max(300),
  inVendoredCode: z
    .boolean()
    .describe("True when the location falls inside a bundled third-party library we identified."),
});

/** A quote from human-readable material (README, manifest, release notes, sheet, disclosure file). */
export const TextEvidence = z.object({
  kind: z.literal("text"),
  source: z.enum(["readme", "manifest", "release-notes", "sheet", "disclosure", "repo-metadata"]),
  quote: z.string().min(1).max(500),
  url: z.url().optional(),
  verbatim: z
    .boolean()
    .describe(
      "True when the quote was found verbatim (after whitespace normalisation) in the source we gave the model.",
    ),
});

export const Evidence = z.discriminatedUnion("kind", [CodeEvidence, TextEvidence]);

/** Identifies one analysed artifact. */
export const ArtifactRef = z.object({
  slug: Slug,
  version: VersionString,
  sha256: Sha256,
});

/** Fixed category taxonomy, seeded from the research sheet's "Workflow Part" column. */
export const Category = z.enum([
  "organization",
  "ai-llm",
  "pdf-annotation",
  "citation-bibliography",
  "import",
  "export",
  "search-discovery",
  "writing-integration",
  "sync",
  "ui-customization",
  "developer-tool",
  "analytics",
]);

export type CodeEvidence = z.infer<typeof CodeEvidence>;
export type TextEvidence = z.infer<typeof TextEvidence>;
export type Evidence = z.infer<typeof Evidence>;
export type ArtifactRef = z.infer<typeof ArtifactRef>;
export type Category = z.infer<typeof Category>;
