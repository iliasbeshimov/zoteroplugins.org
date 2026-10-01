import type { XpiManifest } from "./xpi.ts";

/**
 * Which Zotero majors a plugin release supports, from its manifest's min/max version, judged
 * against the versions Zotero actually shipped. A literal reading isn't enough: "7.9.9" as a
 * minimum technically admits a Zotero 7 that never existed, and in practice means "8 and up".
 * Whether it runs on a given Zotero, such as the current 10.0.4, compares the exact version, and
 * a file Zotero won't install at all runs on none.
 */

/** Mozilla toolkit-style comparison, simplified: numeric parts, "*" as infinity, pre-release < release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.split(".").map((part) => {
      if (part === "*") return { n: Number.POSITIVE_INFINITY, pre: false };
      const m = part.match(/^(\d*)(.*)$/);
      return { n: m?.[1] ? Number(m[1]) : 0, pre: Boolean(m?.[2]) };
    });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? { n: 0, pre: false };
    const y = pb[i] ?? { n: 0, pre: false };
    if (x.n !== y.n) return x.n < y.n ? -1 : 1;
    if (x.pre !== y.pre) return x.pre ? -1 : 1;
  }
  return 0;
}

export interface ZoteroVersions {
  /** Latest stable version per platform family, e.g. { mac: "10.0.4", "win-x64": "10.0.3" }. */
  release: Record<string, string>;
  beta: Record<string, string>;
  dev: Record<string, string>;
  currentMajor: number;
  nextMajor: number | null;
  /** Highest stable tag per major, from github.com/zotero/zotero tags. */
  lastTagPerMajor: Record<number, string>;
}

export const MAJORS = [6, 7, 8, 9, 10, 11] as const;
export type Major = (typeof MAJORS)[number];

/** The newest stable release of a major (its highest tag): the version a card names and checks. */
export function newestRelease(major: number, zv: ZoteroVersions): string {
  return zv.lastTagPerMajor[major] ?? `${major}.0`;
}

function lastReal(major: number, zv: ZoteroVersions): string {
  // Current and future majors still get point releases, so leave them open.
  if (major >= zv.currentMajor) return `${major}.99999`;
  return zv.lastTagPerMajor[major] ?? `${major}.99999`;
}

/** Why Zotero won't install a file at all, whatever its version range. */
export type InstallProblem = "invalid-id" | "no-update-url" | "no-max-version";

/**
 * Add-on IDs in the form Firefox, and so Zotero, accepts (gIDTest in its XPIProvider): a GUID in
 * braces, or name@domain.
 */
const ADDON_ID =
  /^(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[a-z0-9-._]*@[a-z0-9-._]+)$/i;

/**
 * What stops Zotero 7 and later from installing a manifest.json file. Zotero reads
 * applications.zotero and refuses a file without its id, update_url or strict_max_version ("...
 * not provided", in its Extension.sys.mjs), and it only loads an add-on whose ID is in the form
 * above. Installed in a real Zotero 9.0.6 and 10.0.3 (sandbox/README.md), such files never
 * reached the add-on list: an ID with no @, a second @ or a `+` (zotero-better-popups,
 * `zotero-skills@leike0813@gmail.com`, obsidian-zot), no update address or an empty one (zone),
 * and no maximum version (sovena, which has no update address either). Zotero's old application
 * ID, zotero@chnm.gmu.edu, is in that form and nothing in Zotero refuses it: zotero-validate, which
 * uses it, fails for its missing manifest_version and update address. install.rdf files follow
 * Zotero 6's rules, which ask for none of this.
 */
function refusal(m: XpiManifest): InstallProblem | null {
  if (m.target !== "zotero" || m.format !== "manifest.json") return null;
  if (!ADDON_ID.test(m.addonId ?? "")) return "invalid-id";
  if (!m.updateUrl) return "no-update-url";
  if (!m.maxVersion) return "no-max-version";
  return null;
}

// install.rdf plugins stopped loading in Zotero 7; manifest.json plugins need 7+.
const formatFits = (m: XpiManifest, major: number) =>
  m.target === "zotero" &&
  !(m.format === "install.rdf" && major > 6) &&
  !(m.format === "manifest.json" && major < 7);

/** The range covers some release of this major that Zotero shipped or still will (lastReal). */
function declaresMajor(m: XpiManifest, major: number, zv: ZoteroVersions): boolean {
  if (!formatFits(m, major)) return false;
  const min = m.minVersion ?? "0";
  const max = m.maxVersion ?? "*";
  return compareVersions(min, lastReal(major, zv)) <= 0 && compareVersions(max, `${major}.0`) >= 0;
}

/**
 * The install problem a card names. A file made for no Zotero version at all has none: Zotero was
 * never going to install onedict's Firefox build (strict_min_version 109.0).
 */
export function installProblem(m: XpiManifest, zv: ZoteroVersions): InstallProblem | null {
  const problem = refusal(m);
  return problem && MAJORS.some((major) => declaresMajor(m, major, zv)) ? problem : null;
}

export function supportsMajor(m: XpiManifest, major: number, zv: ZoteroVersions): boolean {
  return declaresMajor(m, major, zv) && !refusal(m);
}

/**
 * Whether Zotero at exactly this version installs and runs the file. Every part of the version
 * counts, as in Zotero's own check: missing parts are 0 and "*" matches anything, so a maximum of
 * "10.0.2", or "10.0" (10.0.0), stops before 10.0.4, while "10.0.*" and "10.*" cover it. A dev
 * build comes before its release: "11.0-dev.5" is below a minimum of "11.0".
 */
export function supportsVersion(m: XpiManifest, version: string): boolean {
  if (!formatFits(m, Number.parseInt(version, 10)) || refusal(m)) return false;
  const min = m.minVersion ?? "0";
  const max = m.maxVersion ?? "*";
  return compareVersions(min, version) <= 0 && compareVersions(max, version) >= 0;
}

export function supportedMajors(manifests: XpiManifest[], zv: ZoteroVersions): number[] {
  const upTo = zv.nextMajor ?? zv.currentMajor;
  return MAJORS.filter(
    (major) => major <= upTo && manifests.some((m) => supportsMajor(m, major, zv)),
  );
}
