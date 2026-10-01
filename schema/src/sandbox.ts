import { z } from "zod";
import { IsoDateTime, SchemaVersion, Sha256, Slug } from "./common.ts";

/**
 * data/sandbox/<slug>.json: what a plugin's current release did when we ran it in a throwaway
 * Zotero (sandbox/README.md), written by sandbox/export.py from the run's report. It names the
 * exact release file it ran by SHA-256, so it applies to that file's card only: a new release is
 * untested until it's tested again. Request addresses keep their host and path; query strings and
 * bodies stay in the raw run.
 */

export const SandboxVerdict = z
  .enum(["as-described", "unexpected", "not-loaded", "incomplete"])
  .describe(
    "as-described: it loaded, and everything it did beyond what Zotero does by itself is something its card says; unexpected: something it did isn't (the reasons are listed); not-loaded: it didn't start; incomplete: the test didn't finish",
  );

export const SandboxExercised = z
  .object({
    itemsSelected: z.int().nonnegative(),
    readerOpened: z.boolean().describe("A PDF was opened in Zotero's reader"),
    settingsPane: z.boolean().describe("Zotero's settings opened at the plugin's own pane"),
    menuItems: z.int().nonnegative().describe("Menu items the plugin added that the test clicked"),
    dialogs: z.int().nonnegative().describe("Dialogs and prompts the test answered"),
  })
  .describe("How much of the plugin the test reached");

export const SandboxSentKind = z
  .enum([
    "titles",
    "identifiers",
    "authors",
    "abstract",
    "notes",
    "pdf-text",
    "pdf-file",
    "tags",
    "collections",
  ])
  .describe(
    "A kind of the test library's own text found in a request: its items' titles, identifiers (DOI, ISBN), authors, abstract, note, the PDF's text, the PDF file itself, tags or collection name",
  );

export const SandboxHostUsage = z
  .object({
    usage: z
      .enum(["sends-library-data", "sends-data", "fetches"])
      .describe(
        "sends-library-data: a request carried the test library's own text; sends-data: a request body or query string without it; fetches: only plain page loads (GET or HEAD, no query string or body)",
      ),
    sent: z
      .array(SandboxSentKind)
      .describe("The kinds of library text found; empty unless sends-library-data"),
  })
  .describe("What the plugin's requests to one host carried");

export const SandboxRecord = z.object({
  schemaVersion: SchemaVersion,
  sandboxVersion: z.string(),
  slug: Slug,
  sha256: Sha256.describe("The exact release file tested"),
  addonId: z.string().nullable(),
  zotero: z.string().describe("The Zotero version it ran in, e.g. '10.0.3'"),
  testedAt: IsoDateTime,
  seconds: z.number().nonnegative().nullable(),
  verdict: SandboxVerdict,
  loaded: z.boolean(),
  cutShort: z.boolean().describe("The run hit its time limit"),
  exercised: SandboxExercised,
  contacted: z
    .array(z.string())
    .describe("Hosts it reached through the proxy, beyond those Zotero reaches by itself"),
  hostUsage: z
    .record(z.string(), SandboxHostUsage)
    .optional()
    .describe(
      "Per contacted host, what its requests carried (sandboxVersion 1.1.0); absent from older records, which can't tell a page load from a request that sends data",
    ),
  requests: z.array(z.object({ method: z.string(), host: z.string(), path: z.string() })),
  refused: z
    .array(z.string())
    .describe(
      "Addresses on this computer or a private network it tried to reach, which the proxy refused",
    ),
  programs: z.array(z.string()).describe("Programs started while it ran"),
  servers: z.array(z.string()).describe("Sockets it opened for listening"),
  settings: z.array(z.string()).describe("Settings it changed that aren't its own"),
  files: z.array(z.string()).describe("Files it wrote or removed outside Zotero's folders"),
  databaseStructureChanged: z.boolean(),
  unexpected: z
    .array(z.string())
    .describe("What it did that its card didn't say, in plain English; empty when as-described"),
});

export type SandboxRecord = z.infer<typeof SandboxRecord>;
export type SandboxVerdict = z.infer<typeof SandboxVerdict>;
export type SandboxHostUsage = z.infer<typeof SandboxHostUsage>;
export type SandboxSentKind = z.infer<typeof SandboxSentKind>;
