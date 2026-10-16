import { z } from "zod";

/** The facts a download review records (reviews.ts), the ones the level is computed from. */
export const DownloadFacts = z
  .object({
    /** official: the program's own maker; developer-own: this plugin's developer; third-party: anyone else. */
    source: z.enum(["official", "developer-own", "third-party"]),
    /** Who controls the file, as a reader would say it ("Astral, who make uv"). Needed unless developer-own. */
    publisher: z.string().min(1).optional(),
    transport: z.enum(["https", "http"]),
    /** pinned: a hash written into the plugin; same-source-checksum: a hash fetched from the same place. */
    integrity: z.enum(["pinned", "same-source-checksum", "none"]),
    trigger: z.enum(["automatic", "automatic-on-feature-use", "user-clicks-install", "asks-first"]),
    toldInReadme: z.enum(["yes", "partly", "no"]),
  })
  .passthrough()
  .superRefine((f, ctx) => {
    if (f.source !== "developer-own" && !f.publisher)
      ctx.addIssue({ code: "custom", path: ["publisher"], message: "needed unless developer-own" });
  });
export type DownloadFacts = z.infer<typeof DownloadFacts>;

/** The scanner's and the review's wording for a download checked against a hash written into the plugin. */
export const FIXED_WHY =
  "It checks the download against a fingerprint written into the plugin, so only a new version of the plugin can change what runs.";

export type DownloadKind = "http" | "fixed" | "maker" | "maker-untold" | "developer" | "other";

type Concern = "low" | "medium" | "high";

/** The scanner's and the review's wording for a download over http that nothing checks. */
export const HTTP_WHY =
  "It downloads over unencrypted http and nothing checks the file, so anyone on the same network, such as public Wi-Fi, could swap in a program of their own.";

/**
 * A downloaded program runs with your rights, outside the plugin we checked, so what matters is who
 * can change it and whether anything checks it. A plugin's own developer adds no one new to trust,
 * but can change what runs without a new version; the program's own maker over https is the same
 * as installing it yourself.
 */
export function classifyDownload(
  f: DownloadFacts,
  contentChecked: boolean,
): { kind: DownloadKind; concern: Concern; rule: string } {
  if (f.transport === "http" && f.integrity !== "pinned")
    return { kind: "http", concern: "high", rule: "CAP-DOWNLOAD-EXEC-HTTP" };
  if (f.integrity === "pinned")
    return {
      kind: "fixed",
      concern: f.source === "official" || contentChecked ? "low" : "medium",
      rule: "CAP-DOWNLOAD-EXEC-FIXED",
    };
  if (f.source === "official") {
    const told =
      f.toldInReadme !== "no" || f.trigger === "user-clicks-install" || f.trigger === "asks-first";
    return told
      ? { kind: "maker", concern: "low", rule: "CAP-DOWNLOAD-EXEC-MAKER" }
      : { kind: "maker-untold", concern: "medium", rule: "CAP-DOWNLOAD-EXEC-UNTOLD" };
  }
  if (f.source === "developer-own")
    return { kind: "developer", concern: "medium", rule: "CAP-DOWNLOAD-EXEC-DEVELOPER" };
  return { kind: "other", concern: "medium", rule: "CAP-DOWNLOAD-EXEC-OTHER" };
}

/** The opening of a download review's card note: why it's rated the way it is. */
export function downloadWhy(kind: DownloadKind, f: DownloadFacts, contentChecked: boolean): string {
  const P = f.publisher;
  const check =
    f.integrity === "none"
      ? ", and nothing checks it before it runs"
      : f.integrity === "same-source-checksum"
        ? ", and the only check is a checksum from the same place, which a replaced file passes too"
        : "";
  switch (kind) {
    case "http":
      return HTTP_WHY;
    case "fixed":
      return `${FIXED_WHY}${
        f.source === "official"
          ? ` The download comes from ${P}.`
          : !contentChecked
            ? " We haven't checked what's inside it."
            : ""
      }`;
    case "maker":
      return `It comes straight from ${P}, over an encrypted connection, as it would if you installed it yourself.`;
    case "maker-untold":
      return `It comes straight from ${P}, over an encrypted connection, but nothing tells you before it installs it.`;
    case "developer":
      return `Its developer can replace the file at any time without releasing a new version${check}, so our check of the plugin doesn't cover what runs.`;
    case "other":
      return `The file belongs to ${P}, not this plugin's developer: they can replace it at any time${check}, and what they put there runs on your computer.`;
  }
}

/** What a reviewed download badge's label ends with. */
export function downloadLabelEnd(kind: DownloadKind, concern: Concern): string {
  switch (kind) {
    case "http":
      return "; it comes over plain http, so anyone on your network could swap it";
    case "developer":
      return "; its developer can change what runs at any time";
    case "other":
      return "; someone other than its developer can change what runs at any time";
    case "maker-untold":
      return "; it doesn't tell you first";
    case "fixed":
      return concern === "medium" ? "; we haven't checked what's inside it" : "";
    default:
      return "";
  }
}
