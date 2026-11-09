import { z } from "zod";
import { IsoDateTime, Slug } from "./common.ts";

/**
 * data/advisories.json: known security problems in plugin releases, written by hand when one is
 * confirmed. Zotero Atlas fetches it every few hours (more often than the catalogue) and warns
 * people who have an affected version, holding updates to one. Short on purpose: an advisory is
 * for a problem serious enough to interrupt someone, not for a grade's ordinary findings.
 */
export const Advisory = z.object({
  id: z
    .string()
    .regex(/^ZPA-\d{4}-\d{3}$/)
    .describe("ZPA-<year>-<number>, never reused"),
  addon: z.string().min(1).describe("The add-on ID Zotero knows the plugin by"),
  slug: Slug.nullable().describe("Its page on zoteroplugins.org, when it's listed"),
  name: z.string().min(1),
  affects: z
    .object({
      min: z.string().nullable().describe("The first affected version, or null for all before max"),
      max: z.string().nullable().describe("The last affected version, or null for every later one"),
    })
    .describe("Inclusive, compared the way Zotero compares versions"),
  severity: z
    .enum(["critical", "important"])
    .describe(
      "critical: a bar above the library until dealt with; important: one notice and the red dot",
    ),
  title: z.string().min(1).describe("One line: what's wrong, e.g. 'uploads your library'"),
  text: z.string().min(1).describe("What happens and what to do, in a sentence or two"),
  fixedIn: z.string().nullable().describe("The first version without the problem, if any"),
  url: z.url().describe("Where to read more: the plugin's card, or the developer's notice"),
  publishedAt: IsoDateTime,
});

export const Advisories = z.object({
  schemaVersion: z.literal(1),
  updatedAt: IsoDateTime,
  advisories: z.array(Advisory),
});

export type Advisory = z.infer<typeof Advisory>;
export type Advisories = z.infer<typeof Advisories>;
