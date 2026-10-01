import { z } from "zod";
import { Analysis } from "./analysis.ts";
import { IsoDateTime, RepoKey, SchemaVersion, Sha256, Slug, VersionString } from "./common.ts";
import { Provenance } from "./provenance.ts";
import { DataFlowStatement } from "./requirements.ts";
import { TrustCard } from "./trust-card.ts";

/** Parsed from manifest.json (Zotero 7+) or install.rdf (legacy Zotero 6). */
export const Manifest = z.object({
  format: z.enum(["manifest.json", "install.rdf"]),
  legacy: z.boolean().describe("True for install.rdf-based (Zotero 6 era) add-ons."),
  addonId: z.string().min(1),
  name: z.string(),
  version: VersionString,
  description: z.string().optional(),
  author: z.string().optional(),
  homepageUrl: z.string().optional(),
  updateUrl: z.string().optional(),
  strictMinVersion: z.string().optional(),
  strictMaxVersion: z.string().optional(),
});

export const XpiFile = z.object({
  path: z.string(),
  size: z.int().nonnegative(),
  sha256: Sha256,
});

/**
 * data/generated/<slug>/<version>.json: everything we know about one released .xpi.
 * Identity is the file's SHA-256. `version` is the manifest's version, which can differ from the
 * git tag and even from the release title; if two different files claim the same manifest version,
 * the second is stored as `<version>+<sha8>.json`.
 * `analysis` and `provenance` are immutable for a given (sha256, tool version).
 * `trustCard` is recomputed by `atlas score` because maintenance and compatibility change over time.
 */
export const Release = z.object({
  schemaVersion: SchemaVersion,
  slug: Slug,
  repo: RepoKey,
  version: VersionString,
  source: z
    .enum(["release", "update-feed"])
    .optional()
    .describe("update-feed: the file a plugin's update address offers, not a GitHub release file"),
  tag: z.string().nullable(),
  releaseAuthor: z
    .string()
    .nullable()
    .optional()
    .describe(
      "GitHub login that created the release; a [bot] login means a workflow did, whoever uploaded the file",
    ),
  publishedAt: IsoDateTime,
  prerelease: z.boolean(),
  asset: z.object({
    name: z.string(),
    url: z.url(),
    size: z.int().nonnegative(),
    sha256: Sha256,
    githubAssetId: z.int().positive().nullable(),
    uploader: z
      .string()
      .nullable()
      .optional()
      .describe("GitHub login that uploaded the file; github-actions[bot] means a workflow did"),
    uploadedAt: IsoDateTime.nullable().describe(
      "GitHub asset updated_at; later than publishedAt means it was replaced",
    ),
    fetchedAt: IsoDateTime,
  }),
  manifest: Manifest,
  files: z.array(XpiFile),
  analysis: Analysis.nullable(),
  provenance: Provenance.nullable(),
  dataFlow: z
    .object({
      inputHash: Sha256,
      statements: z.array(DataFlowStatement),
    })
    .nullable(),
  trustCard: TrustCard.nullable(),
});

export type Manifest = z.infer<typeof Manifest>;
export type Release = z.infer<typeof Release>;
