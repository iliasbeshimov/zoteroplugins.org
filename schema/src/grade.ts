import type { PluginProfile } from "./profile.ts";

/**
 * The Atlas grade on a plugin's card, and the "because …" line under it. Both follow from the
 * profile alone, so the site, the pipeline's grade log and anything else agree on them.
 * "–" means not graded: no release, code not analysed, or still checking.
 */
export type Grade = "A+" | "A" | "B" | "C" | "–";

export const GRADE_RANK: Record<Grade, number> = { "A+": 4, A: 3, B: 2, C: 1, "–": 0 };

/**
 * A+ needs low concern in the code and an "as described" live test in the current Zotero major;
 * the test belongs to the file it ran, so a new release starts again at A.
 */
export function gradeOf(p: PluginProfile): Grade {
  const t = p.trust;
  if (!t) return "–";
  switch (t.overall.label) {
    case "high-concern":
      return "C";
    case "review-details":
      return "B";
    case "low-concern": {
      const cur = t.inputs.currentZotero.split(".")[0];
      const tested = t.tested;
      return tested?.verdict === "as-described" && tested.zotero.split(".")[0] === cur ? "A+" : "A";
    }
    default:
      return "–";
  }
}

const VERBS = new Set(
  "Launches Contacts Runs Downloads Sends Installs Uses Loads Keeps Changes Signs Hands Reuses Writes Watches Opens Lets Turns Adds Reads Stores Decrypts Borrows Disables Imports Injects Starts Makes Asks Registers".split(
    " ",
  ),
);

/** A card reason ("Launches programs on your computer") as the rest of "because …". */
export function becauseClause(reason: string): string {
  if (/^Obfuscated code/.test(reason))
    return reason.replace(/^Obfuscated code/, "its code is obfuscated");
  if (/^Release file replaced/.test(reason))
    return reason.replace(/^Release file replaced/, "its release file was replaced");
  const first = reason.split(/\s/)[0] ?? "";
  const lower = reason.charAt(0).toLowerCase() + reason.slice(1);
  return VERBS.has(first) ? `it ${lower}` : lower;
}

/** The card's "because …" line, without "because". */
export function becauseOf(p: PluginProfile, grade: Grade = gradeOf(p)): string {
  const t = p.trust;
  const reasons = t?.overall.reasons ?? [];
  if (grade === "A+")
    return "every code check came out low, and our live test in Zotero found nothing unexpected";
  if (grade === "A") return "every code check came out low";
  if (t?.overall.label === "checking")
    return "we're still checking where its network code sends data";
  if (grade === "–")
    return p.scan.reason ? becauseClause(p.scan.reason) : "we couldn't analyse its code yet";
  const first = reasons[0] ? becauseClause(reasons[0]) : "of the findings below";
  return reasons.length > 1
    ? `${first}, and ${reasons.length - 1} more finding${reasons.length > 2 ? "s" : ""}`
    : first;
}
