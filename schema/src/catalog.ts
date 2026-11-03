import { z } from "zod";
import { IsoDateTime, Sha256, Slug } from "./common.ts";

/**
 * data/generated/catalog.json: what the Zotero Atlas plugin reads, one row per listed plugin
 * with a release. Written by `atlas profile` (and `atlas catalog`), fetched by the plugin from
 * GitHub once a day. Everything here comes from the profiles; nothing is written by hand or by
 * an LLM except the summaries the site already shows.
 */

export const CatalogGrade = z.enum(["A+", "A", "B", "C", "–"]);

export const CatalogBuild = z.object({
  name: z.string().describe("The release file's name"),
  url: z.url().describe("The GitHub release asset"),
  sha256: Sha256.nullable().describe(
    "The file we analysed; the plugin installs only a file with this hash",
  ),
  supports: z.array(z.int().positive()).describe("Zotero majors its manifest range covers"),
  min: z.string().nullable().describe("strict_min_version, compared the way Zotero does"),
  max: z.string().nullable().describe("strict_max_version"),
});

export const CatalogEntry = z.object({
  slug: Slug,
  name: z.string(),
  id: z.string().nullable().describe("The add-on ID Zotero knows the plugin by"),
  repo: z.url(),
  page: z.url().describe("The plugin's page on the site, with the full card"),
  summary: z.string().nullable(),
  jobs: z.array(z.string()).describe("The site's job slugs (reading, citing, ai, …)"),
  grade: CatalogGrade,
  because: z.string().describe("The card's 'because …' line, without 'because'"),
  version: z.string(),
  publishedAt: IsoDateTime.nullable(),
  supports: z
    .array(z.int().positive())
    .describe("Zotero majors the release works with; empty when Zotero won't install it"),
  current: z
    .object({
      zotero: z.string(),
      status: z.enum(["compatible", "incompatible", "unknown"]),
    })
    .nullable()
    .describe(
      "Whether the Zotero version current when the catalogue was written installs and runs it",
    ),
  file: CatalogBuild.nullable().describe("The build current Zotero installs"),
  builds: z.array(CatalogBuild).describe("The release's other builds, e.g. for an older Zotero"),
  update: z
    .object({ version: z.string().nullable(), grade: CatalogGrade })
    .nullable()
    .describe(
      "What the plugin's own update address offers today, when it's a different file from this one",
    ),
  blocked: z.string().nullable().describe("Why Zotero's official blocklist blocks this version"),
  tested: z
    .object({ zotero: z.string(), verdict: z.string() })
    .nullable()
    .describe("Our live test of this exact file"),
  needs: z.object({
    apiKey: z.enum(["none", "optional", "required", "unknown"]),
    services: z.array(z.string()).describe("AI services it can use"),
    localModel: z.boolean().describe("Can use a model on this computer"),
    launchesPrograms: z.boolean(),
  }),
  downloads: z.int().nonnegative().nullable(),
  stars: z.int().nonnegative().nullable(),
  maintenance: z.string(),
  lastReleaseAt: IsoDateTime.nullable(),
  docsChineseOnly: z.boolean(),
});

export const Catalog = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoDateTime,
  currentZotero: z
    .string()
    .describe("The Zotero version the grades and 'current' were computed for"),
  rulesVersion: z.string().nullable(),
  site: z.url(),
  plugins: z.array(CatalogEntry),
});

export type Catalog = z.infer<typeof Catalog>;
export type CatalogEntry = z.infer<typeof CatalogEntry>;
export type CatalogBuild = z.infer<typeof CatalogBuild>;
export type CatalogGrade = z.infer<typeof CatalogGrade>;
