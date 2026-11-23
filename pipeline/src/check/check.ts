import { createHash } from "node:crypto";
import {
  type Analysis,
  becauseOf,
  type Grade,
  gradeOf,
  type PluginProfile,
  type TrustCard,
} from "@atlas/schema";
import {
  installProblem,
  newestRelease,
  supportedMajors,
  supportsVersion,
} from "../census/compat.ts";
import { parseInstallRdf, parseManifestJson, type XpiManifest } from "../census/xpi.ts";
import {
  classifyUpdateSource,
  codeHostRepo,
  provenanceLite,
  updateHostOf,
} from "../profile/checks.ts";
import { findingReviewsForScore, networkReviewForScore } from "../profile/reviews.ts";
import { RULES_VERSION, score } from "../profile/score.ts";
import { ANALYZER_VERSION, analyzeXpi, developerHints, pickManifest } from "../scan/analyze.ts";
import { unzip } from "../scan/unzip.ts";
import type { CheckData } from "./data.ts";

/**
 * What the catalogue's code checks say about one built .xpi, before it is released. It runs the
 * same analyzer and the same scoring as a listed plugin's card (profile/score.ts) on the file
 * alone. The facts a release adds (who uploaded the file, whether it changed afterwards, what the
 * update address serves, our live test in Zotero) are unknown here and left out, never guessed.
 */

export interface CheckOptions {
  /** `owner/name` of the repository, for the hints that tell the developer's own servers apart. */
  repo?: string;
  now?: Date;
}

/** The grade the code alone can earn: A+ also needs the live test in Zotero. */
export type CheckGrade = Exclude<Grade, "A+">;

/** A+ is the site's grade for low-concern code plus a passing live test; code alone is capped at A. */
export const capGrade = (g: Grade): CheckGrade => (g === "A+" ? "A" : g);

export interface CheckResult {
  file: string;
  sha256: string;
  size: number;
  name: string;
  version: string;
  addonId: string | null;
  updateUrl: string | null;
  /**
   * A warning about the update address that needs no network: it names a GitHub repository other
   * than this one, or a template name nobody controls. The catalogue drops the grade to B when
   * that account or repository doesn't exist, which only a network call shows, so this never
   * changes the grade here.
   */
  updateWarning: string | null;
  grade: CheckGrade;
  because: string;
  card: TrustCard;
  analysis: Analysis;
  /** Who runs each host the card lists: the host's provider, when the table names one. */
  providers: Record<string, string>;
  /** The listed plugin whose hand reviews were looked up (by repository, or by this exact file). */
  reviewedAs: string | null;
  /** The capabilities whose hand review applied to this code, and by what (the file or its code). */
  reviewsApplied: { capability: string; how: "file" | "code" }[];
  networkReviewApplied: boolean;
}

/** The warning for an update address that points somewhere other than this repository. */
function updateWarningOf(
  updateUrl: string | null,
  updates: ReturnType<typeof classifyUpdateSource>,
  repo: string | undefined,
): string | null {
  if (!updateUrl) return null;
  const risk =
    "If that account or repository doesn't exist, anyone who registers it could serve updates to your users, and the published grade drops to B.";
  let code: ReturnType<typeof codeHostRepo> = null;
  try {
    code = codeHostRepo(new URL(updateUrl));
  } catch {}
  if (code?.host !== "github") return null;
  // A template name (your-username, example) is a name nobody controls, known without the repository.
  if (updates.kind === "unclaimed-namespace")
    return `Your update address is under "${code.repo.split("/")[0]}", a template name. ${risk}`;
  if (!repo || updates.kind === "none") return null;
  if (code.repo.toLowerCase() === repo.toLowerCase()) return null;
  return `Your update address points to github.com/${code.repo}, not this repository (${repo}). ${risk}`;
}

export async function checkXpi(
  file: string,
  bytes: Uint8Array,
  data: CheckData,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const now = (opts.now ?? new Date()).toISOString();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let entries: Awaited<ReturnType<typeof unzip>>;
  try {
    entries = await unzip(bytes);
  } catch (e) {
    throw new Error(`${file} is not a readable .xpi (a zip file): ${(e as Error).message}`);
  }
  // The manifest first: its add-on ID names the developer's own domain, which the analyzer needs.
  const decoder = new TextDecoder();
  const manifests: XpiManifest[] = [];
  for (const e of entries) {
    if (e.path !== "manifest.json" && e.path !== "install.rdf") continue;
    try {
      const text = decoder.decode(e.data);
      manifests.push(e.path === "manifest.json" ? parseManifestJson(text) : parseInstallRdf(text));
    } catch {
      // the analyzer reports an unreadable manifest itself
    }
  }
  const manifest = pickManifest(manifests);
  if (!manifest)
    throw new Error(`${file} has no readable manifest.json or install.rdf: not a Zotero plugin`);
  const developer = developerHints(opts.repo ?? "", manifest.addonId, null);
  const { analysis } = analyzeXpi({
    slug: "check",
    sha256,
    entries,
    table: data.table,
    analyzedAt: now,
    developer,
    libraries: data.libraries,
  });

  const slug =
    (opts.repo ? data.reviews.slugs[opts.repo.toLowerCase()] : undefined) ??
    data.slugBySha.get(sha256) ??
    null;
  const findingReviews = slug ? data.reviews.findings[slug] : undefined;
  const networkReview = slug ? data.reviews.network[slug] : undefined;
  // The reviews the scorer will apply: the same two tests as its own (the exact file, or the same
  // code behind the finding).
  const reviewsApplied: CheckResult["reviewsApplied"] = [];
  for (const r of findingReviews ?? []) {
    if (reviewsApplied.some((x) => x.capability === r.capability)) continue;
    const codeKey = analysis.capabilities.find((c) => c.id === r.capability)?.codeKey;
    if ([r.sha256, ...(r.alsoAppliesTo ?? []).map((x) => x.sha256)].includes(sha256))
      reviewsApplied.push({ capability: r.capability, how: "file" });
    else if (r.codeKey && codeKey === r.codeKey)
      reviewsApplied.push({ capability: r.capability, how: "code" });
  }
  const networkReviewApplied = Boolean(
    networkReview &&
      [networkReview.sha256, ...(networkReview.alsoAppliesTo ?? []).map((x) => x.sha256)].includes(
        sha256,
      ),
  );

  const zv = data.zoteroVersions;
  const at = (major: number, version: string) => ({
    major,
    zoteroVersion: version,
    status: supportsVersion(manifest, version)
      ? ("compatible" as const)
      : ("incompatible" as const),
  });
  const devVersion = Object.values(zv.dev)[0];
  const current = at(zv.currentMajor, newestRelease(zv.currentMajor, zv));
  const supported = supportedMajors([manifest], zv);
  const problem = installProblem(manifest, zv);
  const compatibility = {
    current,
    previous: at(zv.currentMajor - 1, newestRelease(zv.currentMajor - 1, zv)),
    next: zv.nextMajor && devVersion ? at(zv.nextMajor, devVersion) : null,
    supported,
    blockedByZotero: null,
    ...(problem ? { installProblem: problem } : {}),
    ...(current.status === "incompatible" && supported.includes(zv.currentMajor)
      ? { range: { min: manifest.minVersion, max: manifest.maxVersion } }
      : {}),
  };

  const obfuscated =
    analysis.transparency.obfuscation.detected &&
    analysis.transparency.obfuscation.confidence !== "low";
  const updateUrl = manifest.updateUrl ?? null;
  const updates = classifyUpdateSource(
    updateUrl,
    { repo: opts.repo ?? "", addonIdSharedWith: [] },
    new Map(),
  );
  const updateWarning = updateWarningOf(updateUrl, updates, opts.repo);
  const card = score({
    analysis,
    ...(opts.repo ? { repo: opts.repo } : {}),
    updateHost: updateHostOf(updateUrl, data.table, developer),
    updateSource: { kind: updates.kind, label: updates.label },
    provenance: provenanceLite({
      uploader: null,
      attestation: { present: false },
      obfuscated,
      checkedAt: now,
    }),
    assetReplaced: false,
    maintenance: { status: "unknown", lastReleaseAt: null, lastCommitAt: null },
    compatibility,
    currentZotero: current.zoteroVersion,
    computedAt: now,
    ...findingReviewsForScore(findingReviews),
    ...networkReviewForScore(networkReview, data.table, developer),
  });

  // The card as the site grades it. There is no live test here, so it can't reach A+; the cap
  // is stated anyway so a change in the rules can't lift it.
  const profile = { trust: card, scan: { status: "analyzed", reason: null } } as PluginProfile;
  const grade = capGrade(gradeOf(profile));
  const providers: Record<string, string> = {};
  for (const h of analysis.network.hosts) if (h.provider) providers[h.host] = h.provider;

  return {
    file,
    sha256,
    size: bytes.length,
    name: manifest.name || file,
    version: manifest.version ?? analysis.input.version,
    addonId: manifest.addonId,
    updateUrl,
    updateWarning,
    grade,
    because: becauseOf(profile, grade),
    card,
    analysis,
    providers,
    reviewedAs: slug,
    reviewsApplied,
    networkReviewApplied,
  };
}

export { ANALYZER_VERSION, RULES_VERSION };
