import type { Analysis, Concern, DataSharingValue } from "@atlas/schema";
import { touchesZoteroTables } from "./analyze.ts";

/**
 * Preview of the Trust Card facets that static analysis alone can fill, using the draft rule
 * table in ../profile/score.ts. Provenance isn't checked yet, so it is left out of the overall label
 * (the full card would otherwise mark every plugin "review the details").
 */

export type PreviewLabel = "low-concern" | "review-details" | "high-concern" | "insufficient-data";

export interface Preview {
  dataSharing: DataSharingValue;
  hostsByCategory: Record<string, string[]>;
  obfuscated: boolean;
  /** One structural signal, or dense escapes alone: worth a look, not called obfuscation. */
  possiblyObfuscated: boolean;
  suspiciousUnicode: boolean;
  /** A destination is a shadow library (Sci-Hub, LibGen…): the card shows a legal notice. */
  legalRisk: boolean;
  /** `libraries`: set when every use sits in bundled libraries, which the card names. */
  capabilities: { id: string; concern: Concern; libraries?: string[] }[];
  label: PreviewLabel;
  drivers: string[];
}

const RANK: Record<Concern, number> = { none: 0, low: 1, unknown: 2, medium: 2, high: 3 };
const ONE_STEP_DOWN: Record<Concern, Concern> = {
  high: "medium",
  medium: "low",
  low: "none",
  none: "none",
  unknown: "unknown",
};

type InstallRoute = NonNullable<
  NonNullable<Analysis["capabilities"][number]["details"]>["installs"]
>[number];

/**
 * Add-on installs, by where the file comes from and whether each install waits for the user
 * (asked: a confirm dialog, or a click in the plugin; silent: neither). A silent install from the
 * network is like Zotero's own updater when the file is checked against a hash, over https, with
 * no third-party mirror or proxy in between; otherwise whoever holds the address, or a mirror on
 * the way, decides what gets installed. Behind a setting that's off by default, one step lower
 * (the badge names the setting).
 */
const INSTALL_CONCERN: Record<string, Concern> = {
  // An add-on file the user picks or drops, a backup they restore, files in their own library.
  "local:asked": "low",
  // …installed by itself, without asking (zotero-tara restores at startup).
  "local:silent": "medium",
  // Its own update after a click, checked against a hash from its own release (confucius).
  "self:asked:checked": "low",
  // A fixed address, a catalogue, a web page or its own update feed, after a click or a confirm.
  "network:asked": "medium",
  // Silent, but checked against a hash over https with nothing in between (Zotero's own way).
  "network:silent:checked": "medium",
  // Silent, through third-party mirrors, plain http or with no hash (paper-chat).
  "network:silent": "high",
  // An address a zotero:// link or another program supplies, shown and confirmed first.
  "link:asked": "medium",
  // …installed as it arrives; or a link that changes where it installs from (zotero-addons).
  "link:silent": "high",
  // An address hidden in its code (base64: zotero-style).
  hidden: "high",
};
const INSTALL_RULE = {
  "installs-addons": ["CAP-INSTALLS-ADDONS", "CAP-INSTALLS-ADDONS-UNASKED"],
  "self-installs": ["CAP-SELF-UPDATE", "CAP-SELF-UPDATE-UNASKED"],
} as const;

function installKey(r: InstallRoute, self: boolean): string {
  const asked = r.asks !== "none";
  if (r.from === "hidden") return "hidden";
  if (["file", "backup", "library"].includes(r.from)) return asked ? "local:asked" : "local:silent";
  if (["link", "message", "link-source"].includes(r.from))
    return r.asks === "confirm" ? "link:asked" : "link:silent";
  if (asked) return self && r.hash ? "self:asked:checked" : "network:asked";
  return r.hash && r.https !== false && !r.via?.length
    ? "network:silent:checked"
    : "network:silent";
}

/** How one way of installing add-ons is rated. */
export function installRouteConcern(r: InstallRoute, self: boolean): Concern {
  const concern = INSTALL_CONCERN[installKey(r, self)] ?? "medium";
  return r.setting ? ONE_STEP_DOWN[concern] : concern;
}

/** The worst way it installs add-ons; medium when an older analysis doesn't say. */
function installConcern(c: Analysis["capabilities"][number]): Concern {
  const routes = c.details?.installs ?? [];
  if (!routes.length) return "medium";
  return routes
    .map((r) => installRouteConcern(r, c.id === "self-installs"))
    .reduce((w, x) => (RANK[x] > RANK[w] ? x : w), "none");
}

type SettingsEntry = NonNullable<
  NonNullable<Analysis["capabilities"][number]["details"]>["settings"]
>[number];

/**
 * Settings that aren't its own, by what each change does (C33). High: it leaves the computer or
 * another program less protected, or sets a program to run later without asking. Medium: it makes
 * another program run something, rewrites another program's settings, or changes how Zotero
 * connects, syncs or finds PDFs for the whole app. Low: narrow changes. A switch the user flips
 * (or a setting that's off by default) is a step lower, and so is a change that lasts only while
 * the plugin runs (or a default the user's own value overrides).
 */
const SETTINGS_CONCERN: Record<string, Concern> = {
  // A certificate the system trusts: whoever holds its key can pose as any website.
  certificate: "high",
  // Another program's permission prompts loosened (Claude Code's permissions.allow).
  "agent-permissions": "high",
  // Zotero's own updates turned off (from a checkbox the user ticks: a step lower).
  updates: "high",
  // A program set to start by itself, or copied in to run later: without asking; after a click.
  "autostart:silent": "high",
  "autostart:asked": "medium",
  "program-install:silent": "high",
  "program-install:asked": "medium",
  // Another program made to run something: Word macros, MCP servers, command-line tools.
  "office-macros": "medium",
  "mcp-config": "medium",
  "global-install": "medium",
  // Another program's own settings rewritten (garden-for-zotero's Claude Code endpoint and key).
  "app-config": "medium",
  // How Zotero connects, syncs or finds PDFs, for the whole app.
  proxy: "medium",
  sync: "medium",
  "find-pdf": "medium",
  "zotero-config": "medium",
  // Zotero's built-in server turned back on: by itself; after a click.
  "server:silent": "medium",
  "server:asked": "low",
  // Zotero's question before it opens a link in another app, turned off (zotlite).
  "link-prompts": "medium",
  // Narrow: servers kept off Zotero's proxy, the PATH after a click, skill files.
  "proxy-exceptions": "low",
  "shell:silent": "medium",
  "shell:asked": "low",
  skills: "low",
};

/** How one settings change is rated. */
export function settingsChangeConcern(s: SettingsEntry): Concern {
  const way = s.asks === "none" ? "silent" : "asked";
  let concern = SETTINGS_CONCERN[`${s.change}:${way}`] ?? SETTINGS_CONCERN[s.change] ?? "medium";
  if (s.optIn || s.setting) concern = ONE_STEP_DOWN[concern];
  if (s.whileInstalled || s.asDefault) concern = ONE_STEP_DOWN[concern];
  return concern;
}

type UnencryptedEntry = NonNullable<
  NonNullable<Analysis["capabilities"][number]["details"]>["unencrypted"]
>[number];

/**
 * The user's data sent over plain http:// to a host beyond this computer's network (cleartext-http
 * sweep): anyone on the network in between (public Wi-Fi, a campus or company network) can read it
 * and change the reply. Rated by what goes out. A fallback after https servers counts the same:
 * someone on the network can make those unreachable.
 */
const UNENCRYPTED_CONCERN: Record<string, Concern> = {
  // Text the user works with: a selection, PDF text, a question, abstracts, a collection's name.
  content: "medium",
  // An API key, token, licence code or account ID.
  credentials: "medium",
  // Only public identifiers, titles or search terms sent to a catalogue (a DOI, an ISBN).
  identifiers: "low",
  // …only when the https servers listed before it can't be reached (zotero-reference's licence).
  "content:fallback": "medium",
  "credentials:fallback": "medium",
  "identifiers:fallback": "low",
};

/** How what one host is sent over plain http is rated: the worst of what goes there. */
export function unencryptedConcern(e: UnencryptedEntry): Concern {
  return e.sends
    .map(
      (s) =>
        UNENCRYPTED_CONCERN[e.fallback ? `${s}:fallback` : s] ?? UNENCRYPTED_CONCERN[s] ?? "medium",
    )
    .reduce<Concern>((w, x) => (RANK[x] > RANK[w] ? x : w), "none");
}

/**
 * CAP-MINOR's capabilities: code it builds at runtime, files, stored keys, the
 * clipboard, its own database file, its own local server, a connector endpoint on Zotero's server,
 * Zotero's local API turned on, and web scripts in pages it shows or writes.
 */
const CAP_MINOR = new Set([
  "dynamic-code",
  "filesystem",
  "credential-storage",
  "login-manager",
  "clipboard",
  "own-database",
  "own-server",
  "local-http-server",
  "enables-local-api",
  "remote-script",
  "remote-script-output",
]);

const COUNT_WHEN_UNSURE = new Set([
  "llm-provider",
  "translation",
  "scholarly-api",
  "zotero",
  "integration",
  "telemetry",
  "cloud-function",
  "developer-server",
  "localhost",
]);

/**
 * Too little of the code was read to give a label: no code at all, any file skipped
 * for size, or more than 20% of the code bytes only scanned by the regex fallback. Older analyses
 * without byte counts use the share of files.
 */
export function insufficientCoverage(a: Analysis): boolean {
  const c = a.coverage;
  if (c.filesAnalyzed === 0) return true;
  if (c.filesSkipped.some((s) => s.reason === "too-large")) return true;
  if (c.codeBytes !== undefined && c.failedBytes !== undefined)
    return c.failedBytes / Math.max(1, c.codeBytes) > 0.2;
  return c.parseFailures.length / c.filesAnalyzed > 0.2;
}

/** What the card says when part of the code was skipped or only scanned roughly. */
export function partialNote(a: Analysis): string | null {
  const c = a.coverage;
  const big = c.filesSkipped.filter((s) => s.reason === "too-large").length;
  if (big) return `${big} code file${big > 1 ? "s were" : " was"} too large to analyse`;
  const failed = c.parseFailures.length;
  if (failed)
    return `${failed} code file${failed > 1 ? "s" : ""} couldn't be parsed and ${failed > 1 ? "were" : "was"} only scanned for known patterns`;
  return null;
}

/**
 * Bundled packages that send requests for the plugin: API clients, HTTP clients, WebDAV and cloud
 * SDKs, and retorquere's zotero-plugin debug-log sender. Network code inside them is the plugin's
 * own network use, unlike pdf.js or a Markdown renderer (review P7).
 */
export const REQUEST_PACKAGES =
  /^(openai|@anthropic-ai\/|@google\/(genai|generative-ai)|@mistralai\/|groq-sdk|cohere-ai|ollama|@ai-sdk\/|ai$|langchain|@langchain\/|@huggingface\/|replicate|axios|ky$|ofetch|node-fetch|cross-fetch|isomorphic-fetch|whatwg-fetch|undici|got$|superagent|webdav|rmapi-js|zotero-plugin$|@notionhq\/|@octokit\/|octokit|@supabase\/|firebase|@firebase\/|@aws-sdk\/|googleapis|@azure\/)/;
const SERVICES = new Set([
  "llm-provider",
  "translation",
  "scholarly-api",
  "integration",
  "zotero",
  "telemetry",
]);
const inRequestPackage = (libs: string[] | undefined) =>
  !!libs?.length && libs.every((l) => REQUEST_PACKAGES.test(l));

export function preview(
  a: Analysis,
  updateHost: { host: string; category: string } | null,
): Preview {
  const drivers: string[] = [];
  const concerns: Concern[] = [];
  const fire = (rule: string, concern: Concern) => {
    drivers.push(rule);
    concerns.push(concern);
  };

  const t = a.transparency;
  const obfuscated = t.obfuscation.detected && t.obfuscation.confidence !== "low";
  // Which hosts count as destinations: requests we traced, plus classified services, bare IPs
  // and the self-update host when it isn't ordinary code hosting.
  const counted = a.network.hosts.filter((h) => {
    if (h.usage === "link") return false;
    // A URL in text or a link template isn't data sharing when nothing in the file can send it
    // (review P5): `https://doi.org/${doi}` in a plugin with no network code at all.
    if (h.usage !== "request" && a.network.apis.length === 0) return false;
    // Inside a bundled library a URL is usually documentation, except a service address in an API
    // client the plugin uses (the OpenAI SDK's api.openai.com).
    if (h.inVendoredCode && h.usage !== "request")
      return inRequestPackage(h.libraries) && SERVICES.has(h.category);
    if (h.usage === "request") return true;
    // A name-matched developer host (usually the project's homepage) counts only when requested,
    // or when obfuscation hides the requests (doc2x's v2c.doc2x.noedgeai.com API).
    if (h.provider === "Plugin developer (name match)") return obfuscated;
    if (h.flags.includes("ip-literal") && h.category === "unknown") return true;
    // Obfuscation hides which named servers it contacts: an unknown one in its own code counts.
    if (obfuscated && h.category === "unknown" && !h.inVendoredCode) return true;
    return COUNT_WHEN_UNSURE.has(h.category);
  });
  const hostsByCategory: Record<string, string[]> = {};
  const add = (category: string, host: string) => {
    hostsByCategory[category] = [...(hostsByCategory[category] ?? []), host];
  };
  // Data sent into an account written into the code goes to whoever holds it: the developer's.
  for (const h of counted)
    add(h.flags.includes("fixed-account") ? "developer-server" : h.category, h.host);
  // The update address isn't data sharing: the card's update line says where updates come from
  // (review K3). `updateHost` is kept for callers that still pass it.
  void updateHost;
  // Zotero's translators and full-text finders go to the services Zotero itself is set up with.
  if (a.network.apis.some((x) => x.api === "zotero-lookup"))
    add("zotero", "Zotero lookup services");
  // Programs it runs or hands data to (AI command-line tools, edge-tts, a local translation app)
  // send it on to their provider; one whose destination we can't check counts as unknown.
  for (const p of a.network.programs ?? [])
    add(
      p.category ?? "llm-provider",
      p.provider && p.provider !== p.program ? `${p.program} (${p.provider})` : p.program,
    );
  const cats = new Set(Object.keys(hostsByCategory));
  const external = [...cats].filter((c) => c !== "localhost");

  let dataSharing: DataSharingValue;
  if (a.network.apis.length === 0 && cats.size === 0) {
    dataSharing = "no-network-found";
    fire("DS-NONE", "none");
  } else if (cats.has("unknown")) {
    dataSharing = "unknown-endpoints";
    // Only a program it hands data to is unknown (a companion app on this computer): it may send
    // them anywhere, like a server we couldn't identify.
    const servers = hostsByCategory.unknown?.some((h) => a.network.hosts.some((x) => x.host === h));
    if (servers) fire("DS-UNKNOWN", "medium");
    else fire("DS-UNKNOWN-HANDOFF", "medium");
  } else if (cats.has("developer-server") || cats.has("cloud-function")) {
    dataSharing = "developer-servers";
    fire("DS-DEVELOPER", "medium");
  } else if (external.length > 0) {
    dataSharing = "named-third-parties";
    fire("DS-NAMED", "low");
  } else if (
    (cats.has("localhost") || a.network.configurableEndpoints.length > 0) &&
    // Not while the plugin's own code names a developer or hosting-platform server we couldn't
    // trace (review K5: the-cite-shop's hard-coded API base behind a debug setting).
    !a.network.hosts.some(
      (h) =>
        !counted.includes(h) &&
        h.usage !== "link" &&
        !h.inVendoredCode &&
        ["developer-server", "cloud-function"].includes(h.category) &&
        h.provider !== "Plugin developer (name match)",
    )
  ) {
    dataSharing = "user-configured-only";
    fire("DS-USER-CONFIGURED", "none");
  } else if (
    a.network.apis.every((x) => x.inVendoredCodeOnly) &&
    !a.network.apis.some((x) => x.libraries?.some((l) => REQUEST_PACKAGES.test(l)))
  ) {
    // pdf.js can fetch a PDF by URL, but the plugin itself sends nothing (review P7).
    dataSharing = "bundled-library-only";
    fire("DS-LIBRARY-ONLY", "low");
  } else {
    // Network code present, but no destination we could name.
    dataSharing = "unknown-endpoints";
    fire("DS-UNKNOWN-DESTINATION", "medium");
  }
  // Obfuscated code can hide where it sends data: a clean result there isn't one we can vouch for.
  if (
    obfuscated &&
    [
      "no-network-found",
      "user-configured-only",
      "named-third-parties",
      "bundled-library-only",
    ].includes(dataSharing)
  )
    fire("DS-OBFUSCATED", "unknown");
  if (cats.has("telemetry")) fire("DS-TELEMETRY", "medium");
  // Named, but anyone can read what's uploaded to a public file drop or change what passes
  // through an open proxy.
  // Only a relay a request reaches: one named in dead code or a test page isn't used.
  if (
    counted.some(
      (h) =>
        h.flags.includes("public-relay") &&
        !h.flags.includes("encrypted-upload") &&
        h.usage === "request",
    )
  )
    fire("DS-PUBLIC-RELAY", "medium");

  if (obfuscated) fire("ST-OBFUSCATED", "high");
  const possiblyObfuscated = t.obfuscation.detected && t.obfuscation.confidence === "low";
  if (possiblyObfuscated) fire("ST-OBFUSCATION-POSSIBLE", "medium");
  const suspiciousUnicode = t.suspiciousUnicode.some(
    (u) => u.kind !== "private-use" && u.evidence.some((e) => !e.inVendoredCode),
  );
  if (suspiciousUnicode) fire("ST-UNICODE", "high");

  const capabilities: Preview["capabilities"] = [];
  for (const c of a.capabilities) {
    let concern: Concern = "none";
    let rule: string | null = null;
    if (c.id === "remote-code") [concern, rule] = ["high", "CAP-REMOTE-CODE"];
    // A program we never saw runs with the user's rights, like downloaded code.
    // …unless every download is checked against a SHA-256 written into the code: then only that
    // exact file runs, which is closer to shipping it in the package.
    else if (c.id === "download-exec")
      [concern, rule] =
        c.details?.apis?.length === 1 && c.details.apis[0] === "pinned to a SHA-256"
          ? ["medium", "CAP-DOWNLOAD-EXEC-PINNED"]
          : ["high", "CAP-DOWNLOAD-EXEC"];
    // Zotero may block these loads, but the page asks for code we can't review (review P11).
    // A real Zotero 9 test: every privileged page blocks web scripts before any request
    // (security.disallow_privileged_https_script_loads), so these are dead code or a broken
    // feature. Code that turns that block off is what matters (disables-security).
    else if (c.id === "remote-script") concern = "low";
    else if (c.id === "disables-security") [concern, rule] = ["high", "CAP-DISABLES-SECURITY"];
    // Its own server: other programs on this computer can talk to the plugin; listening on every
    // interface lets other computers on the network do so too. Nothing like Zotero's checks stands
    // in front of it: when its code doesn't turn web pages away either, any website the user
    // visits can make it change the library, run the code the site sends or hand a stored key to
    // an address of the page's choosing (one step lower behind a setting that's off by default,
    // named; one step lower when all it can do is change an item whose key the site must already
    // know).
    else if (c.id === "own-server") {
      const open = c.details?.apis?.some((x) =>
        [
          "listens beyond this computer",
          "listens beyond this computer by default (a setting)",
          "can listen beyond this computer (a setting)",
          "web pages can call it",
        ].includes(x),
      );
      let acts: Concern = "none";
      if (c.details?.web === "any" && c.details.serverActions?.length) {
        acts = "high";
        if (c.details.setting) acts = ONE_STEP_DOWN[acts];
        if (c.details.needsKey) acts = ONE_STEP_DOWN[acts];
      }
      [concern, rule] =
        RANK[acts] >= RANK.medium
          ? [acts, "CAP-OWN-SERVER-WEB"]
          : open
            ? ["medium", "CAP-OPEN-SERVER"]
            : ["low", null];
    }
    // Code it didn't ship runs with full rights: whatever a local program, or the AI model's tool
    // call, sends. The plugin (or the user, turning the agent on) chose to allow it.
    // Its own AI assistant's code, once the feature is on, runs without the user seeing it unless
    // each run shows the code and asks, or the only switch is one named for running code.
    else if (
      c.id === "runs-sent-code" &&
      c.details?.apis?.some((x) => x === "AI tool" || x === "AI shell tool") &&
      c.details.approval === "none"
    )
      [concern, rule] = ["high", "CAP-SENT-CODE-UNASKED"];
    // …and a web page that can reach the endpoint needs no program on the computer at all.
    else if (c.id === "runs-sent-code" && c.details?.apis?.includes("web pages"))
      [concern, rule] = ["high", "CAP-SENT-CODE-WEB"];
    else if (c.id === "runs-sent-code") [concern, rule] = ["medium", "CAP-SENT-CODE"];
    // An endpoint on Zotero's built-in server that changes the library. Other programs on the
    // computer can already change it, so a local-only one adds little; one web pages can use
    // needs nothing installed, and one the sites the user approves in a prompt, a step less.
    // Behind a setting that's off by default, one step lower (the badge names the setting); so
    // is one where every change needs the key of an item the site must already know.
    else if (c.id === "server-edits-library") {
      [concern, rule] =
        c.details?.web === "any" || c.details?.web === "listed"
          ? ["high", "CAP-SERVER-EDITS-WEB"]
          : c.details?.web === "approved"
            ? ["medium", "CAP-SERVER-EDITS-APPROVED"]
            : ["low", null];
      if (c.details?.setting) concern = ONE_STEP_DOWN[concern];
      if (c.details?.needsKey) concern = ONE_STEP_DOWN[concern];
      if (RANK[concern] < RANK.medium) rule = null;
    }
    // Zotero's server itself opened: every endpoint on it (Zotero's own save endpoints, other
    // plugins') to any website, or to the websites the user approves; or library content handed
    // to web pages without a token.
    else if (c.id === "local-http-server")
      [concern, rule] = c.details?.apis?.includes("every endpoint, for any website")
        ? ["high", "CAP-SERVER-OPEN-WEB"]
        : c.details?.apis?.some((x) => x.startsWith("every endpoint, for"))
          ? ["medium", "CAP-SERVER-OPEN"]
          : c.details?.apis?.includes("web pages can read the library")
            ? ["low", null]
            : ["none", null];
    else if (c.id === "own-database" || c.id === "enables-local-api") concern = "low";
    // Installs other add-ons, or replaces Zotero's updater for itself: new code arrives from
    // wherever the plugin's own logic fetches it, whatever the user's update setting. Rated by
    // where the file comes from and whether each install is asked (INSTALL_CONCERN).
    else if (c.id === "installs-addons" || c.id === "self-installs") {
      concern = installConcern(c);
      const [asked, unasked] = INSTALL_RULE[c.id];
      rule = concern === "high" ? unasked : RANK[concern] >= RANK.medium ? asked : null;
    }
    // Settings that aren't its own: the worst change (SETTINGS_CONCERN).
    else if (c.id === "changes-settings") {
      const entries = c.details?.settings ?? [];
      concern = entries.length
        ? entries.map(settingsChangeConcern).reduce((w, x) => (RANK[x] > RANK[w] ? x : w), "none")
        : "medium";
      rule =
        concern === "high"
          ? "CAP-CHANGES-SETTINGS-HIGH"
          : concern === "medium"
            ? "CAP-CHANGES-SETTINGS"
            : null;
    }
    // The user's text, keys or identifiers over plain http: the worst host (UNENCRYPTED_CONCERN).
    else if (c.id === "sends-unencrypted") {
      const entries = c.details?.unencrypted ?? [];
      concern = entries.length
        ? entries.map(unencryptedConcern).reduce((w, x) => (RANK[x] > RANK[w] ? x : w), "none")
        : "medium";
      rule = RANK[concern] >= RANK.medium ? "CAP-SENDS-UNENCRYPTED" : null;
    }
    // Machine code runs with the user's rights and can't be reviewed: like launching programs.
    else if (c.id === "runs-bundled-binary") [concern, rule] = ["medium", "CAP-BUNDLED-BINARY"];
    // npx/pip/uv fetch the code at run time: nothing we analysed is what runs. With no fixed
    // version it's whatever the registry serves that day, like an unchecked download; a fixed
    // version or a locked set it ships is closer to shipping the code.
    else if (c.id === "package-run" && c.details?.pinning === "unpinned")
      [concern, rule] = ["high", "CAP-PACKAGE-UNPINNED"];
    else if (c.id === "package-run") [concern, rule] = ["medium", "CAP-PACKAGE-RUN"];
    // Translators run in Zotero's translator sandbox on the pages they match: fetched from the web
    // they're code nobody reviewed here; shipped in the package they're part of what we read.
    else if (c.id === "installs-translators")
      [concern, rule] = c.details?.apis?.includes("downloaded")
        ? ["medium", "CAP-TRANSLATORS"]
        : ["low", null];
    // Holds account-level tokens obtained as Codex CLI, Copilot, Claude Code… (review P13).
    else if (c.id === "borrowed-identity") [concern, rule] = ["medium", "CAP-BORROWED-IDENTITY"];
    // Reads a browser's cookie or password store: it opens every site the user is signed into there.
    else if (c.id === "browser-credentials") [concern, rule] = ["high", "CAP-BROWSER-CREDENTIALS"];
    // Reuses the sign-in the user saved in another program (its credential file).
    else if (c.id === "reused-app-login") [concern, rule] = ["medium", "CAP-REUSED-APP-LOGIN"];
    else if (c.id === "remote-script-output") concern = "low";
    // Code nobody can review, decrypted and run with the plugin's rights.
    else if (c.id === "encrypted-code") [concern, rule] = ["high", "CAP-ENCRYPTED-CODE"];
    // A zotero:// link can come from any web page: running code from one is remote code, unless
    // the handler asks first (zotero-plugin-toolkit's debug bridge shows the command, unless a
    // development build turned its prompt off).
    else if (c.id === "link-runs-code")
      [concern, rule] = c.details?.asksFirst
        ? ["medium", "CAP-LINK-CODE"]
        : ["high", "CAP-LINK-CODE"];
    // The toolkit's install link: medium.
    else if (c.id === "link-installs-addons") [concern, rule] = ["medium", "CAP-LINK-INSTALL"];
    else if (
      c.id === "sqlite-direct" ||
      (c.id === "db-write" && touchesZoteroTables(c.details?.sqlTables))
    )
      [concern, rule] = ["high", "CAP-DB-WRITE-ZOTERO"];
    else if (c.id === "db-write") [concern, rule] = ["medium", "CAP-DB-WRITE-OWN"];
    // An AI coding agent started with every prompt and its sandbox off by default acts on the
    // model's word alone; with file edits accepted or no prompts inside its sandbox, or full
    // bypass only through a setting, it's rated like any launch.
    else if (
      c.id === "process-launch" &&
      c.details?.agentModes?.some((m) => m.mode === "full-bypass" && m.byDefault)
    )
      [concern, rule] = ["high", "CAP-AGENT-UNGUARDED"];
    else if (c.id === "process-launch" && c.details?.agentModes?.length)
      [concern, rule] = ["medium", "CAP-AGENT-FEWER-PROMPTS"];
    else if (c.id === "process-launch" && c.details?.apis?.includes("system openers only"))
      concern = "low";
    else if (c.id === "process-launch" || c.id === "native-code")
      [concern, rule] = ["medium", "CAP-PROCESS"];
    else if (c.id === "network-intercept") [concern, rule] = ["medium", "CAP-INTERCEPT"];
    // eval/new Function on computed input is listed but usually a polyfill or template engine.
    else if (
      ["dynamic-code", "filesystem", "credential-storage", "login-manager", "clipboard"].includes(
        c.id,
      )
    )
      concern = "low";
    // The minor capabilities CAP-MINOR lists are recorded like the other facets' low rules.
    if (!rule && CAP_MINOR.has(c.id) && RANK[concern] < RANK.medium) rule = "CAP-MINOR";
    // A library match attributes a finding; it removes only low ones (review P2): a comment line
    // or a lib/ folder must not hide launching programs or writing Zotero's database.
    if (c.inVendoredCodeOnly && RANK[concern] < RANK.medium) continue;
    // CAP-MINOR is one rule however many of its capabilities match.
    if (rule && !(rule === "CAP-MINOR" && drivers.includes(rule))) fire(rule, concern);
    capabilities.push({
      id: c.id,
      concern,
      ...(c.inVendoredCodeOnly && c.libraries?.length ? { libraries: c.libraries } : {}),
    });
  }

  let label: PreviewLabel;
  if (insufficientCoverage(a)) {
    label = "insufficient-data";
    drivers.unshift("OV-INSUFFICIENT");
  } else {
    const worst = Math.max(0, ...concerns.map((c) => RANK[c]));
    label = worst >= 3 ? "high-concern" : worst >= 2 ? "review-details" : "low-concern";
  }
  return {
    dataSharing,
    hostsByCategory,
    obfuscated,
    possiblyObfuscated,
    suspiciousUnicode,
    legalRisk: counted.some((h) => h.flags.includes("legal-risk")),
    capabilities,
    label,
    drivers,
  };
}
