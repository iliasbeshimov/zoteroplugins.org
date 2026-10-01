import type { Analysis, Provenance } from "@atlas/schema";
import { compareVersions } from "../census/compat.ts";
import type { GitHub } from "../net/github.ts";
import { type DeveloperHints, isDeveloperHost } from "../scan/analyze.ts";
import { classifyHost, type HostTable, hostOf } from "../scan/hosts.ts";

// ----------------------------------------------------------------------------------------------
// Zotero's official blocklist (github.com/zotero/plugin-blocklist)

export const BLOCKLIST_SOURCE = "https://github.com/zotero/plugin-blocklist";

export interface Blocklist {
  version: number;
  blockedPlugins: {
    id: string;
    versionRanges: { minVersion?: string; maxVersion?: string }[];
    reason: string;
  }[];
}

export async function fetchBlocklist(gh: GitHub): Promise<Blocklist> {
  const res = await gh.rest<{ content: string }>(
    "/repos/zotero/plugin-blocklist/contents/blocked-plugins.json",
  );
  if (res.status !== 200 || !res.data) throw new Error(`blocklist: HTTP ${res.status}`);
  return JSON.parse(Buffer.from(res.data.content, "base64").toString("utf8")) as Blocklist;
}

export function blockedBy(
  list: Blocklist,
  addonId: string | null,
  version: string | null,
): { reason: string; source: string } | null {
  if (!addonId || !version) return null;
  const entry = list.blockedPlugins.find((p) => p.id.toLowerCase() === addonId.toLowerCase());
  if (!entry) return null;
  const hit = entry.versionRanges.some(
    (r) =>
      (!r.minVersion || compareVersions(version, r.minVersion) >= 0) &&
      (!r.maxVersion || compareVersions(version, r.maxVersion) <= 0),
  );
  return hit ? { reason: entry.reason, source: BLOCKLIST_SOURCE } : null;
}

// ----------------------------------------------------------------------------------------------
// Hosts: re-applying a newer hosts.yaml to a stored analysis, so classifying a host never needs
// the .xpi again. Mirrors the classification inside analyzeXpi.

export function reclassifyHosts(
  analysis: Analysis,
  table: HostTable,
  developer: DeveloperHints,
): Analysis {
  if (analysis.network.hostsTableVersion === table.version) return analysis;
  const hosts: Analysis["network"]["hosts"] = [];
  for (const h of analysis.network.hosts) {
    const found = classifyHost(table, h.host);
    if (!found) continue; // now on the ignore list
    const dev =
      found.category === "unknown" &&
      !found.flags.includes("ip-literal") &&
      isDeveloperHost(h.host, developer);
    const { provider: _old, ...rest } = h;
    hosts.push({
      ...rest,
      category: dev ? "developer-server" : found.category,
      // Flags the analysis found in the code stay with it.
      flags: dev
        ? []
        : [
            ...found.flags,
            ...h.flags.filter(
              (f) => f === "encrypted-upload" && found.flags.includes("public-relay"),
            ),
          ],
      ...(dev
        ? { provider: "Plugin developer (name match)" }
        : found.provider
          ? { provider: found.provider }
          : {}),
    });
  }
  return {
    ...analysis,
    network: { ...analysis.network, hosts, hostsTableVersion: table.version },
  };
}

/** The manifest's update host, classified the same way analyzeXpi does. */
export function updateHostOf(
  updateUrl: string | null | undefined,
  table: HostTable,
  developer: DeveloperHints,
): { host: string; category: string } | null {
  if (!updateUrl) return null;
  const h = hostOf(updateUrl);
  const cls = h ? classifyHost(table, h.host) : null;
  if (!h || !cls) return null;
  const dev = cls.category === "unknown" && isDeveloperHost(h.host, developer);
  return { host: h.host, category: dev ? "developer-server" : cls.category };
}

// ----------------------------------------------------------------------------------------------
// Where updates come from (review K3). Zotero replaces the installed file with whatever the
// manifest's update address points at, so that address decides which code users end up running.

export type UpdateKind =
  | "this-project"
  | "other-listed-project"
  | "other-repository"
  | "unclaimed-namespace"
  | "other-host"
  | "none";

export interface UpdateSource {
  kind: UpdateKind;
  url: string | null;
  /** `owner/name` when the address is on a code host. */
  repo: string | null;
  /** The listed project the address belongs to, for other-listed-project. */
  project: string | null;
  label: string;
}

export const CODE_HOSTS: Record<string, string> = {
  github: "GitHub",
  gitee: "Gitee",
  gitlab: "GitLab",
};

/** The repository an address on GitHub, Gitee or GitLab belongs to. */
export function codeHostRepo(u: URL): { host: string; repo: string; path: string[] } | null {
  const h = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const repo = (a?: string, b?: string) => (a && b ? `${a}/${b.replace(/@.*$/, "")}` : null);
  let r: string | null = null;
  let host = "github";
  if (h === "github.com" || h === "www.github.com" || h === "raw.githubusercontent.com")
    r = repo(parts[0], parts[1]);
  else if (h.endsWith(".github.io")) {
    const owner = h.slice(0, -".github.io".length);
    r = parts.length >= 2 ? repo(owner, parts[0]) : `${owner}/${owner}.github.io`;
  } else if (h === "cdn.jsdelivr.net" && parts[0] === "gh") r = repo(parts[1], parts[2]);
  else if (h === "raw.giteeusercontent.com") {
    host = "gitee";
    r = repo(parts[0], parts[1]);
  } else if (h === "gitee.com" || h === "gitlab.com") {
    host = h.split(".")[0] as string;
    r = repo(parts[0], parts[1]);
  }
  return r ? { host, repo: r, path: parts } : null;
}

/** Owner names and domains from templates, which anyone can register. */
const UNCLAIMED_OWNER =
  /^(your[-_]?(user(name)?|name|github[-_]?(user(name)?|id)?|org(anization)?|account)?|user(name)?|example|owner|author|me|github[-_]?user(name)?)$/i;
const UNCLAIMED_DOMAIN =
  /^(www\.)?(your|my)[-a-z0-9]*\.(com|net|org|io|dev|app)$|(^|\.)not-yet-setup\.com$/i;

/**
 * The update line when the address names a GitHub account or repository that isn't there: nobody
 * holds an account name, so anyone could register it; a missing repository under an existing
 * account can only be created by that account's owner.
 */
export function unclaimedLabel(url: string, missing?: "account" | "repository"): string {
  let code: ReturnType<typeof codeHostRepo> = null;
  try {
    code = codeHostRepo(new URL(url));
  } catch {}
  const repo = code?.repo ?? url;
  const owner = repo.split("/")[0] ?? repo;
  if (missing === "account")
    return `Updates are set to come from "${owner}" on GitHub, an account that doesn't exist: anyone who registers that name could publish an update Zotero would install`;
  if (missing === "repository")
    return `Updates are set to come from ${repo} on GitHub, which doesn't exist or isn't public: if the owner of "${owner}" published an update there, Zotero would install it`;
  return `Updates are set to come from ${repo} on GitHub, which the developer doesn't hold: whoever controls it could publish an update Zotero would install`;
}

export function classifyUpdateSource(
  updateUrl: string | null | undefined,
  own: { repo: string; addonIdSharedWith: string[] },
  projects: Map<string, { slug: string; name: string }>,
): UpdateSource {
  const none = (why: string, url: string | null = updateUrl ?? null): UpdateSource => ({
    kind: "none",
    url,
    repo: null,
    project: null,
    label: `Doesn't update automatically${why}`,
  });
  if (!updateUrl) return none("", null);
  let u: URL;
  try {
    u = new URL(updateUrl);
  } catch {
    return none(": the update address is broken");
  }
  const host = u.hostname.toLowerCase();
  if (
    /__|\{\{|\$\{|%s/.test(updateUrl) ||
    !/^https?:$/.test(u.protocol) ||
    /(^|\.)(invalid|test|example|localhost|local)$|(^|\.)example\.(com|org|net)$/.test(host) ||
    !host.includes(".")
  )
    return none(": the update address is a placeholder");
  // Copied from Zotero's sample plugin (make-it-red) or pointing at zotero.org itself: Zotero
  // serves no updates for this add-on there.
  if (/(^|\.)zotero\.org$/.test(host)) return none(": the update address points at zotero.org");
  // This computer, a private network or a name no public DNS answers: nothing to update from.
  if (
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[?::1\]?$)/.test(host) ||
    /\.(plugin|lan|internal|home|localhost|local)$/.test(host)
  )
    return none(": the update address is a placeholder");
  // Zotero's sample plugin (make-it-red) uploads to Zotero's own bucket: a copied template address.
  if (host === "zotero-download.s3.amazonaws.com")
    return none(": the update address is copied from Zotero's sample plugin");
  const code = codeHostRepo(u);
  if (!code) {
    if (UNCLAIMED_DOMAIN.test(host))
      return {
        kind: "unclaimed-namespace",
        url: updateUrl,
        repo: null,
        project: null,
        label: `The update address is on ${host}, a template domain the developer doesn't control`,
      };
    return {
      kind: "other-host",
      url: updateUrl,
      repo: null,
      project: null,
      label: `Updates come from ${host}`,
    };
  }
  // A file's page on GitHub (`/blob/main/update.json`) is HTML, not the update file itself.
  if (code.host === "github" && /^(www\.)?github\.com$/.test(host) && code.path[2] === "blob")
    return none(": the update address is a web page, not an update file");
  const [owner = ""] = code.repo.split("/");
  const where = CODE_HOSTS[code.host] ?? code.host;
  // GitHub names are letters, digits and single hyphens: `YOUR_USERNAME` can never be registered,
  // so nobody can serve updates from it (review: zotero-rsvp). It simply doesn't work.
  if (code.host === "github" && !/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(owner))
    return none(": the update address uses a placeholder name nobody can register");
  if (UNCLAIMED_OWNER.test(owner))
    return {
      kind: "unclaimed-namespace",
      url: updateUrl,
      repo: code.repo,
      project: null,
      label: `The update address is under "${owner}" on ${where}, a template name the developer doesn't control`,
    };
  const key = code.repo.toLowerCase();
  if (code.host === "github" && key === own.repo.toLowerCase()) {
    // A repo page or README instead of an update manifest never updates anything.
    const file = code.path.at(-1) ?? "";
    if (!/\.(json|rdf)$/i.test(file)) return none(": the update address isn't an update file");
    return {
      kind: "this-project",
      url: updateUrl,
      repo: code.repo,
      project: null,
      label: "Updates come from this project's GitHub repository",
    };
  }
  const listed = code.host === "github" ? projects.get(key) : undefined;
  if (listed)
    return {
      kind: "other-listed-project",
      url: updateUrl,
      repo: code.repo,
      project: listed.slug,
      // By repository: the other listing often has the same title as this one (forks).
      label: own.addonIdSharedWith.includes(listed.slug)
        ? `Updates come from ${code.repo}, another listed project with the same add-on ID`
        : `Updates come from ${code.repo}, another listed project`,
    };
  return {
    kind: "other-repository",
    url: updateUrl,
    repo: code.repo,
    project: null,
    label: `Updates come from ${code.repo} on ${where}`,
  };
}

// ----------------------------------------------------------------------------------------------
// Provenance, first pass: who uploaded the release file, and whether GitHub holds a build
// attestation for it. Rebuilding from source and comparing comes later.

export const PROVENANCE_CHECKER_VERSION = "lite-0.4";
export const ACTIONS_BOT = "github-actions[bot]";

export interface Attestation {
  present: boolean;
  workflow?: string;
}

export async function fetchAttestation(
  gh: GitHub,
  repo: string,
  sha256: string,
): Promise<Attestation> {
  const res = await gh.rest<{
    attestations?: { bundle?: { dsseEnvelope?: { payload?: string } } }[];
  }>(`/repos/${repo}/attestations/sha256:${sha256}`);
  const list = res.status === 200 ? (res.data?.attestations ?? []) : [];
  if (!list.length) return { present: false };
  const workflow = list
    .map((a) => {
      try {
        const statement = JSON.parse(
          Buffer.from(a.bundle?.dsseEnvelope?.payload ?? "", "base64").toString("utf8"),
        ) as {
          predicate?: {
            buildDefinition?: { externalParameters?: { workflow?: { path?: string } } };
          };
        };
        return statement.predicate?.buildDefinition?.externalParameters?.workflow?.path;
      } catch {
        return undefined;
      }
    })
    .find(Boolean);
  return workflow ? { present: true, workflow } : { present: true };
}

export function provenanceLite(input: {
  uploader: string | null;
  /** Who created the release, which can be a workflow when a person uploaded the file. */
  releaseAuthor?: string | null;
  attestation: Attestation;
  obfuscated: boolean;
  checkedAt: string;
}): Provenance {
  const ci = input.uploader === ACTIONS_BOT;
  const attested = input.attestation.present;
  const plausible = (ci || attested) && !input.obfuscated;
  const bot = (login: string | null | undefined) => Boolean(login && /\[bot\]$/i.test(login));
  const parts: string[] = [];
  if (ci) {
    parts.push("The release file was uploaded by the project's automated GitHub build.");
  } else if (input.uploader && !bot(input.uploader) && bot(input.releaseAuthor)) {
    // A workflow made the release and this file came from a person's account afterwards (ccf-rank:
    // its CI build was deleted and a hand-built one uploaded in its place). Not necessarily by hand:
    // zotero-bookmark-editor's three files arrived from the developer's account in the same second.
    parts.push(
      `The release was created by an automated GitHub workflow, but this file was uploaded afterwards from the ${input.uploader} account.`,
    );
  } else if (input.uploader) {
    parts.push(`The developer uploaded the release file from the ${input.uploader} account.`);
  }
  if (attested) {
    parts.push(
      "GitHub holds a build attestation for this exact file; we haven't checked its signature.",
    );
  }
  if ((ci || attested) && input.obfuscated) {
    parts.push("The code is obfuscated, so it can't be compared with the source.");
  }
  parts.push(
    plausible
      ? "We haven't yet rebuilt it from the source to compare."
      : "We haven't yet checked whether this file matches the public source code.",
  );
  return {
    schemaVersion: 1,
    checkerVersion: PROVENANCE_CHECKER_VERSION,
    checkedAt: input.checkedAt,
    level: plausible ? "plausible" : "not-checked",
    method: "none",
    tag: null,
    build: null,
    diff: null,
    attestation: {
      present: attested,
      verified: false,
      ...(input.attestation.workflow ? { workflow: input.attestation.workflow } : {}),
    },
    explanation: parts.join(" "),
  };
}
