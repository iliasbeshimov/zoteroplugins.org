import { createHash } from "node:crypto";
import type {
  Analysis,
  CapabilityId,
  Concern,
  DataSharingValue,
  HostFinding,
  Provenance,
  SandboxRecord,
  TrustCard,
} from "@atlas/schema";
import { compareVersions, type InstallProblem } from "../census/compat.ts";
import { FORCES_AUTO_UPDATE } from "../scan/analyze.ts";
import {
  installRouteConcern,
  insufficientCoverage,
  type Preview,
  partialNote,
  preview,
  settingsChangeConcern,
  unencryptedConcern,
} from "../scan/preview.ts";
import type { DownloadReview } from "./reviews.ts";
import { type ObservedHost, testedSummary, withObserved } from "./sandbox.ts";

/**
 * Builds the Trust Card from the rule table in this file. Deterministic: the same inputs give
 * the same card, and `inputs.inputHash` says when anything changed.
 *
 * Preview rules: the overall label ignores "source match not checked yet", because that is
 * a gap in our checks rather than something the plugin did. The facet still says it.
 */
export const RULES_VERSION = "0.6.1-preview";

const RANK: Record<Concern, number> = { none: 0, low: 1, unknown: 2, medium: 2, high: 3 };
const worst = (cs: Concern[]): Concern =>
  cs.reduce<Concern>((w, c) => (RANK[c] > RANK[w] ? c : w), "none");

export const DATA_SHARING_LABEL: Record<DataSharingValue, string> = {
  "no-network-found": "No web requests found",
  "user-configured-only": "Only contacts servers you set up",
  "named-third-parties": "Only contacts services we could identify",
  "developer-servers": "Contacts a developer's servers",
  "unknown-endpoints": "Contacts servers we couldn't identify",
  "bundled-library-only": "Network code only in bundled libraries",
  "not-analyzed": "Not analyzed",
};

export const CAPABILITY_LABEL: Record<string, string> = {
  "remote-code": "Downloads and runs code",
  "remote-code-ai": "Runs the AI model's replies as code",
  "db-write-zotero": "Writes to Zotero's database directly",
  "sqlite-direct": "Opens Zotero's database file directly",
  "db-write": "Keeps its own tables in Zotero's database",
  "process-launch": "Launches programs on your computer",
  "process-launch-openers": "Opens files or links with your system's own apps",
  "native-code": "Loads native code",
  "network-intercept": "Watches Zotero's network traffic",
  filesystem: "Works with files on your computer",
  "credential-storage": "Stores API keys or passwords",
  "login-manager": "Uses Zotero's password manager",
  clipboard: "Uses the clipboard",
  "dynamic-code": "Runs code it assembles while running",
  "local-http-server": "Lets programs on this computer connect through Zotero's built-in server",
  "local-http-server-web-read":
    "Lets web pages you visit read your library through Zotero's built-in server",
  "local-http-server-open-web":
    "Lets any website use Zotero's built-in server, including other plugins' endpoints",
  "local-http-server-open-listed":
    "Lets the websites it names use Zotero's built-in server, including other plugins' endpoints",
  "local-http-server-open-approved":
    "Lets websites you approve use Zotero's built-in server, including other plugins' endpoints",
  "server-edits-library": "Other programs on this computer can change your library through it",
  "server-edits-library-web": "Any website you visit can change your library through it",
  "server-edits-library-web-key":
    "A website that knows an item's key could change your library through it",
  "server-edits-library-listed": "The websites it names can change your library through it",
  "server-edits-library-approved": "Websites you approve can change your library through it",
  "own-server": "Runs its own server for programs on this computer",
  "own-server-network": "Runs a server other computers on your network can reach",
  "own-server-setting": "Runs a local server; a setting (off by default) opens it to your network",
  "own-server-web": "Runs a local server that any web page you visit can talk to",
  "own-server-acts":
    "Any website you visit can make it act through its local server: it doesn't check where requests come from",
  "own-server-acts-key":
    "A website that knows an item's key could make it change your library through its local server",
  "own-server-web-connector":
    "Lets any web page you visit call its endpoints on Zotero's built-in server",
  "own-database": "Keeps its own database file",
  "enables-local-api":
    "Turns on Zotero's local API, so programs on this computer can read your library",
  "runs-sent-code": "Runs code other programs on this computer send it",
  "runs-sent-code-web": "Runs code web pages send it",
  "runs-sent-code-ai": "Runs code its AI assistant writes, with full access to Zotero",
  "runs-sent-code-ai-shell":
    "Runs commands its AI assistant writes, with full access to your computer",
  "runs-sent-code-debugger": "Lets debugging tools on this computer run code in Zotero",
  "remote-script": "Its pages ask for web scripts, which Zotero blocks",
  "remote-script-output": "Pages it creates load scripts from the web",
  "installs-addons": "Installs other add-ons",
  "download-exec": "Downloads a program and runs it",
  "download-exec-pinned": "Downloads a program checked against a fixed fingerprint, and runs it",
  "download-exec-told": "Downloads and runs a program it tells you about",
  "download-exec-http": "Downloads a program over unencrypted http and runs it unchecked",
  "borrowed-identity": "Signs in using another app's identity",
  "browser-credentials": "Reads your web browser's saved cookies or passwords",
  "reused-app-login": "Reuses a sign-in you saved in another program",
  "encrypted-code": "Runs encrypted code we can't read",
  "link-runs-code":
    "A zotero:// link (a web page can open one) can make it run code without asking you",
  "link-runs-code-asks": "A zotero:// link can make it run code if you approve a prompt",
  "link-installs-addons":
    "A zotero:// link (a web page can open one) can make it install add-ons without asking you",
  "disables-security": "Turns off a Zotero security setting",
  "self-installs": "Updates itself outside Zotero's updater",
  "runs-bundled-binary": "Runs a compiled program it ships, which we can't read",
  "package-run": "Installs and runs software packages from npm or PyPI",
  "package-run-unpinned": "Installs and runs npm or PyPI packages without a fixed version",
  "installs-translators": "Adds Zotero translators it downloads",
  "installs-translators-bundled": "Adds Zotero translators it ships",
  "changes-settings": "Changes settings in other programs or on your computer",
  "changes-settings-zotero": "Changes Zotero settings that aren't its own",
  // Followed by " to <hosts>".
  "sends-unencrypted": "Sends your text or keys unencrypted (http://)",
  "sends-unencrypted-lookups": "Sends lookups unencrypted (http://)",
};

type SettingsEntry = NonNullable<
  NonNullable<Analysis["capabilities"][number]["details"]>["settings"]
>[number];

/** Changes inside Zotero itself, as opposed to other programs or the computer. */
const ZOTERO_SETTINGS = new Set([
  "proxy",
  "proxy-exceptions",
  "sync",
  "server",
  "find-pdf",
  "updates",
  "link-prompts",
  "zotero-config",
]);

/** What each settings change does, in the badge's words, with the programs or schemes it names. */
const SETTINGS_TEXT: Record<SettingsEntry["change"], (targets: string[]) => string> = {
  proxy: () => "changes Zotero's proxy settings",
  "proxy-exceptions": () => "adds servers to Zotero's proxy exceptions",
  sync: () => "changes where Zotero syncs your library or files",
  server: () => "turns Zotero's built-in server back on if you've turned it off",
  "find-pdf": () => "adds sources to Zotero's Find Available PDF",
  updates: () => "turns off Zotero's own updates",
  "link-prompts": (t) =>
    `stops Zotero asking before it opens ${t.length ? `${names(t.map((x) => `${x}://`))} links` : "links"} in other apps`,
  "zotero-config": () => "changes the server addresses built into Zotero",
  certificate: (t) =>
    `adds a certificate to ${t.length === 1 && t[0] === "macOS" ? "your Mac's" : t.length === 1 && t[0] === "Windows" ? "Windows'" : "your computer's"} trusted certificates`,
  "agent-permissions": (t) =>
    `loosens ${t.length ? names(t) : "another program"}'s permission prompts`,
  autostart: (t) => `sets a program to start by itself${t.length ? ` (${names(t)})` : ""}`,
  "program-install": (t) => `copies a program into ${t[0] ?? "your applications"}`,
  "office-macros": (t) =>
    `adds macros or add-ins that ${t.length ? names(t) : "Office"} ${t.length > 1 ? "run" : "runs"}`,
  "mcp-config": (t) =>
    `adds an MCP server to ${t.length ? `the settings of ${names(t)}` : "another program's settings"}`,
  "app-config": (t) => `changes the settings of ${t.length ? names(t) : "another program"}`,
  shell: (t) =>
    t.includes("Windows")
      ? "adds a folder to your PATH"
      : "adds lines to your shell's startup files",
  "global-install": (t) =>
    `installs ${t.length ? names(t) : "command-line tools"} as command-line tools on your computer`,
  skills: (t) => `adds skill files for ${t.length ? names(t) : "AI coding tools"}`,
};

/**
 * The settings badge's line: each change, the worst first, with whether it asks, a setting it
 * waits for, and whether it lasts. Entries of one kind are said once, their targets together.
 */
function settingsDetail(entries: SettingsEntry[]): string | undefined {
  const groups = new Map<string, SettingsEntry[]>();
  // The worst first, and of two alike the one that doesn't ask.
  const ranked = [...entries].sort(
    (x, y) =>
      RANK[settingsChangeConcern(y)] - RANK[settingsChangeConcern(x)] ||
      Number(y.asks === "none") - Number(x.asks === "none"),
  );
  for (const e of ranked) groups.set(e.change, [...(groups.get(e.change) ?? []), e]);
  const clauses = [...groups].map(([change, es]) => {
    const targets = [...new Set(es.flatMap((e) => (e.target ? [e.target] : [])))];
    // The worst way that doesn't ask speaks for them; a setting only when it's that way's, or
    // every way's ("only while").
    const silent = es.find((e) => e.asks === "none");
    const set = silent ? silent.setting : es.every((e) => e.setting) ? es[0]?.setting : undefined;
    const quals = [
      silent
        ? silent.auto
          ? "at startup, without asking"
          : silent.asDefault
            ? ""
            : "without asking"
        : es.every((e) => e.asks === "confirm")
          ? "after asking you"
          : "",
      es.every((e) => e.optIn) ? "when you turn it on" : "",
      set
        ? `${es.every((e) => e.setting) ? "only " : ""}while its "${settingName(set)}" setting is on (it's off by default)`
        : "",
      es.every((e) => e.whileInstalled) ? "only while it's running" : "",
      es.every((e) => e.asDefault) ? "as a default your own setting overrides" : "",
    ].filter(Boolean);
    return [SETTINGS_TEXT[change as SettingsEntry["change"]](targets), ...quals].join(", ");
  });
  if (!clauses.length) return undefined;
  const shown = clauses.slice(0, 3);
  if (clauses.length > 3)
    shown.push(`and ${clauses.length - 3} more change${clauses.length > 4 ? "s" : ""}`);
  return upperFirst(shown.join("; "));
}

/** What each Gecko setting a plugin turns off protects, in plain words. */
const SECURITY_EFFECT: [RegExp, string][] = [
  [/^security\.disallow_privileged/, "lets its pages load scripts from the web"],
  [/^xpinstall\.signatures\.required$/, "allows add-ons that aren't signed"],
  [/^extensions\.checkCompatibility/, "turns off Zotero's add-on compatibility check"],
  [/^devtools\.debugger\.remote-enabled$/, "turns on remote debugging"],
  [/^devtools\.debugger\.prompt-connection$/, "stops Zotero asking before a debugger connects"],
  [/^devtools\.chrome\.enabled$/, "turns on developer tools for Zotero itself"],
  [/^security\.fileuri\.strict_origin_policy$/, "lets local files read other local files"],
  [/^security\.allow_eval|^security\.allow_unsafe/, "allows code that Zotero normally blocks"],
];

const list = (xs: string[], max = 3) =>
  xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;
const upperFirst = (x: string) => x.replace(/^./, (c) => c.toUpperCase());

/** How an AI coding agent is started, after "runs Claude Code …". */
const AGENT_MODE_TEXT: Record<string, string> = {
  "accept-edits": "with file edits accepted automatically",
  sandboxed: "without asking for approval, inside its sandbox",
  "full-bypass": "with every approval prompt turned off",
};

type InstallRoute = NonNullable<
  NonNullable<Analysis["capabilities"][number]["details"]>["installs"]
>[number];

/** A setting by its last name, or its last two when the last says nothing (`eval.enabled`). */
const settingName = (key: string) => {
  const parts = key.split(".");
  return /^(enabled?|on|active)$/i.test(parts.at(-1) ?? "") && parts.length > 1
    ? parts.slice(-2).join(".")
    : (parts.at(-1) ?? key);
};

/** Where an add-on install's file comes from, in the words the badge uses. */
function installSource(r: InstallRoute): string {
  const at = r.hosts?.length ? ` at ${list(r.hosts)}` : "";
  const via = r.via?.length ? ` via ${list(r.via)}` : "";
  switch (r.from) {
    case "file":
      return "from an add-on file you choose";
    case "backup":
      return r.asks === "none"
        ? "every add-on in a backup in your Zotero library"
        : "every add-on in a backup file you pick";
    case "library":
      return "every add-on file it finds in your Zotero library";
    case "fixed":
      return `from a fixed address${at}`;
    case "hidden":
      return `from an address hidden in its code${r.hosts?.length ? ` (${list(r.hosts)})` : ""}`;
    case "catalogue":
      return r.hosts?.length
        ? `from its catalogue${at}${via}`
        : `from a catalogue it downloads${via}`;
    case "feed":
      return `from its own update feed${at}${via}`;
    case "page":
      return `from a file it finds on a web page${at}`;
    case "link":
      return "from an address a zotero:// link supplies";
    case "message":
      return "from an address another program or an AI tool sends";
    case "link-source":
      return "a zotero:// link can change where it installs from";
  }
}

/**
 * The install badge's line: each place its add-ons come from, the worst first, with whether it
 * asks, a setting it waits for, and what's checked. Ways sharing a source are said once.
 */
function installDetail(routes: InstallRoute[], self: boolean): string | undefined {
  const groups = new Map<string, InstallRoute[]>();
  const ranked = [...routes].sort(
    (x, y) => RANK[installRouteConcern(y, self)] - RANK[installRouteConcern(x, self)],
  );
  for (const r of ranked)
    groups.set(installSource(r), [...(groups.get(installSource(r)) ?? []), r]);
  const clauses = [...groups].map(([source, rs]) => {
    const silent = rs.find((r) => r.asks === "none");
    const network = rs.some((r) => r.hash !== undefined);
    // "only while" when every way from here waits for the setting; the catalogue a user installs
    // from by hand also updates add-ons by itself "while" its setting is on (zotero-addons).
    const setting = silent?.setting
      ? `${rs.every((r) => r.setting) ? ", only" : ""} while its "${settingName(silent.setting)}" setting is on (it's off by default)`
      : "";
    const quals = [
      silent
        ? `${silent.auto ? "by itself" : "without asking"}${setting}`
        : rs.every((r) => r.asks === "confirm")
          ? "after asking you"
          : "",
      rs.every((r) => r.hash)
        ? "checked against a hash"
        : silent && network
          ? "not checked against a hash"
          : "",
      rs.some((r) => r.https === false) ? "plain http addresses accepted" : "",
    ].filter(Boolean);
    return [source, ...quals].join(", ");
  });
  if (!clauses.length) return undefined;
  const shown = clauses.slice(0, 3);
  if (clauses.length > 3)
    shown.push(`and ${clauses.length - 3} more way${clauses.length > 4 ? "s" : ""}`);
  return upperFirst(shown.join("; "));
}

type UnencryptedEntry = NonNullable<
  NonNullable<Analysis["capabilities"][number]["details"]>["unencrypted"]
>[number];

/** The hosts the unencrypted badge names: those rated at its level (the lookups when all are). */
function unencryptedHosts(entries: UnencryptedEntry[]): string[] {
  const top = Math.max(0, ...entries.map((e) => RANK[unencryptedConcern(e)]));
  return entries.filter((e) => RANK[unencryptedConcern(e)] === top).map((e) => e.host);
}

/**
 * The unencrypted badge's line: which hosts get it only when the https servers fail, lookups sent
 * alongside, and what plain http means.
 */
function unencryptedDetail(entries: UnencryptedEntry[]): string | undefined {
  if (!entries.length) return undefined;
  const lookups = (e: UnencryptedEntry) => RANK[unencryptedConcern(e)] < RANK.medium;
  const allLookups = entries.every(lookups);
  const fallback = entries.filter((e) => e.fallback && !lookups(e)).map((e) => e.host);
  const alongside = allLookups ? [] : entries.filter(lookups).map((e) => e.host);
  const parts = [
    allLookups ? "only public identifiers, titles or search terms, such as a DOI or an ISBN" : "",
    fallback.length
      ? `to ${names(fallback)} only if ${fallback.length > 1 ? "their" : "its"} https servers can't be reached, which someone on your network can arrange`
      : "",
    alongside.length ? `only lookups, such as a DOI, to ${names(alongside)}` : "",
    "anyone on the network in between can read it",
  ].filter(Boolean);
  return upperFirst(parts.join("; "));
}

/**
 * A review replaces the scanner's verdict on "Downloads a program and runs it": it
 * drops the finding when the scanner misread the code, or sets its level and rule.
 */
function applyDownloadReview(p: Preview, review: NonNullable<ScoreInput["downloadReview"]>): void {
  const i = p.capabilities.findIndex((c) => c.id === "download-exec");
  if (i < 0) return;
  p.drivers = p.drivers.filter((d) => !d.startsWith("CAP-DOWNLOAD-EXEC"));
  if (!review.real) {
    p.capabilities.splice(i, 1);
    return;
  }
  p.capabilities[i] = {
    ...(p.capabilities[i] as Preview["capabilities"][number]),
    concern: review.concern,
  };
  p.drivers.push(review.rule);
}

/** The badge's second line: what, from where, which setting, drawn from the analysis. */
function badgeDetail(
  id: string,
  c: Analysis["capabilities"][number] | undefined,
): string | undefined {
  const d = c?.details;
  if (!d) return undefined;
  switch (id) {
    case "download-exec": {
      const src = d.sources ?? [];
      const pinned = d.apis?.length === 1 && d.apis[0] === "pinned to a SHA-256";
      const sameSource = !pinned && !!d.apis?.includes("checksum from the same source");
      const plain = src.some((x) => x.endsWith("(http)"));
      const from = src.length ? `From ${list(src.map((x) => x.replace(" (http)", "")))}` : "";
      const parts = [
        from,
        plain ? "over unencrypted HTTP" : "",
        pinned
          ? "checked against a fingerprint written into the plugin"
          : sameSource
            ? "checked only against a checksum from the same place, which catches a broken download but not a replaced one"
            : "not checked against a fingerprint written into the plugin",
      ].filter(Boolean);
      return parts.length ? parts.join("; ").replace(/^./, (x) => x.toUpperCase()) : undefined;
    }
    case "process-launch": {
      const modes = d.agentModes ?? [];
      // Settings that drop every prompt, one clause for all the agents they apply to.
      const unasked = [
        ...new Set(
          modes.filter((m) => !m.byDefault && m.mode === "full-bypass").map((m) => m.program),
        ),
      ];
      const parts = [
        d.programs?.length ? `Programs it names include ${list(d.programs, 5)}` : "",
        ...modes
          .filter((m) => m.byDefault)
          .map((m) => `runs ${m.program} ${AGENT_MODE_TEXT[m.mode]}`),
        unasked.length ? `a setting lets ${names(unasked)} run without asking` : "",
      ].filter(Boolean);
      return parts.length ? upperFirst(parts.join("; ")) : undefined;
    }
    case "package-run": {
      const pkgs = d.packages ?? [];
      const many = pkgs.length !== 1;
      const how =
        d.pinning === "unpinned"
          ? pkgs.length
            ? // Behind an "already installed" check it installs once, not on every run
              // (paperviewzoteroplugin's venv).
              d.once
              ? `${list(pkgs)}: installs whatever version is newest when it installs them`
              : `${list(pkgs)}: installs the newest version each time`
            : "installs packages without a fixed version"
          : d.pinning === "top-level"
            ? pkgs.length
              ? `${list(pkgs)}: installs a fixed version${many ? " of each" : ""}; ${many ? "their" : "its"} own dependencies can still change`
              : "installs fixed versions; their own dependencies can still change"
            : d.pinning === "locked"
              ? "installs a locked set of packages"
              : "";
      const text = [how, d.atStartup ? "at startup, without asking" : ""]
        .filter(Boolean)
        .join(", ");
      // A package's name keeps its own case.
      return !text ? undefined : pkgs.length && d.pinning !== "locked" ? text : upperFirst(text);
    }
    case "runs-sent-code":
      return d.approval === "none"
        ? "It can run without showing you the code first"
        : d.approval === "each-run"
          ? "It shows you the code and asks before each run"
          : d.approval === "code-switch"
            ? "Only after you turn on its setting for running code"
            : undefined;
    case "own-server": {
      // What any website can make its server do (web any), and the setting that waits for.
      const acts = d.web === "any" ? (d.serverActions ?? []) : [];
      const apis = d.apis ?? [];
      // A socket listening on every interface unless a setting stops it.
      const wideByDefault =
        apis.includes("listens beyond this computer by default (a setting)") &&
        !apis.includes("listens beyond this computer");
      if (!acts.length) return wideByDefault ? "It listens on your network by default" : undefined;
      const said = acts.map((a) => SERVER_ACTION_TEXT[a]);
      const text = `A website can make it ${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0]}`;
      // `write.enabled` rather than just "enabled".
      const parts = d.setting?.split(".") ?? [];
      const name = parts
        .slice(/^(enabled?|on|allowed|active)$/i.test(parts.at(-1) ?? "") ? -2 : -1)
        .join(".");
      // A level (`writeLevel`, default "readonly") allows rather than turns on.
      const gate = !d.setting
        ? ""
        : /level|mode/i.test(name)
          ? `, only when its "${name}" setting allows it (it doesn't by default)`
          : `, only while its "${name}" setting is on (it's off by default)`;
      // Its changes reach only items whose key the website already knows.
      const key = !d.needsKey
        ? ""
        : `${gate ? " and" : ", but"} only if it knows an item's key (the ID Zotero gives each item)`;
      // What the label no longer says: it listens beyond this computer, or pages can read replies.
      const also = apis.includes("listens beyond this computer")
        ? "; other computers on your network can reach it too"
        : wideByDefault
          ? "; it listens on your network by default"
          : apis.includes("can listen beyond this computer (a setting)")
            ? "; a setting can also open it to your network"
            : apis.includes("web pages can call it")
              ? "; web pages can also read its answers"
              : "";
      return `${text}${gate}${key}${also}`;
    }
    case "server-edits-library": {
      const gate = !d.setting
        ? undefined
        : d.setting === "httpServer.localAPI.enabled"
          ? "Only while Zotero's local API is turned on (it's off by default)"
          : `Only while its "${d.setting.split(".").at(-1)}" setting is on (it's off by default)`;
      // Every change a website can make through it needs an item's key.
      const key =
        "a website would need to know an item's key (the ID Zotero gives each item) to change it";
      return !d.needsKey ? gate : gate ? `${gate}, and ${key}` : upperFirst(key);
    }
    case "local-http-server":
      return d.apis?.includes("every endpoint, for websites you approve")
        ? "It asks once per website; a site you approve can use every endpoint, including those that save items to your library"
        : undefined;
    case "borrowed-identity":
      return d.apis?.length ? `Signs in as ${list(d.apis)}` : undefined;
    case "installs-addons":
    case "self-installs":
      return installDetail(d.installs ?? [], id === "self-installs");
    case "browser-credentials":
      // Copied into a profile of a browser it starts, the cookies sign that browser in as you
      // (zotero-pdf-hand-catcher's Edge); read, they're the plugin's to use or send.
      return d.apis?.length && d.copiedToBrowser
        ? `Copies your ${list(d.apis)} sign-in cookies into a browser it controls, which is then signed into every site you're signed into there`
        : d.apis?.length
          ? `Reads the sign-in cookies saved in ${list(d.apis)}, which cover every site you're signed into there`
          : "Reads the cookies or passwords your web browser has saved";
    case "reused-app-login":
      return d.apis?.length ? `Reuses the sign-in you saved in ${list(d.apis)}` : undefined;
    case "disables-security": {
      const effects = [
        ...new Set(
          (d.apis ?? []).map(
            (k) => SECURITY_EFFECT.find(([re]) => re.test(k))?.[1] ?? `changes ${k}`,
          ),
        ),
      ];
      return effects.length ? `It ${list(effects)}` : undefined;
    }
    case "changes-settings":
      return settingsDetail(d.settings ?? []);
    case "sends-unencrypted":
      return unencryptedDetail(d.unencrypted ?? []);
    case "runs-bundled-binary":
      return d.apis?.length ? list(d.apis.map((x) => x.split("/").at(-1) ?? x)) : undefined;
    case "db-write": {
      const named = (d.sqlTables ?? []).filter((t) => !t.startsWith("("));
      return named.length ? `Tables: ${list(named, 5)}` : undefined;
    }
    case "encrypted-code":
      return d.apis?.length ? `Encrypted file: ${list(d.apis)}` : undefined;
    case "link-runs-code":
    case "link-installs-addons": {
      // "(asks first)" only matters when some handlers ask and others don't.
      const apis = d.apis ?? [];
      const mixed =
        apis.some((x) => x.endsWith("(asks first)")) &&
        apis.some((x) => !x.endsWith("(asks first)"));
      return apis.length
        ? list(mixed ? apis : apis.map((x) => x.replace(" (asks first)", "")))
        : undefined;
    }
    default:
      return undefined;
  }
}

/** What any website can make a plugin's own server do, as the badge's detail says it. */
const SERVER_ACTION_TEXT: Record<string, string> = {
  "changes-library": "change your library",
  "runs-code": "run code the site sends",
  "sends-keys": "send your saved API key to an address the website picks",
};

/** Every data-sharing rule preview.ts fires, with its concern (a test checks none is missing). */
export const DS_CONCERN: Record<string, Concern> = {
  "DS-NONE": "none",
  "DS-USER-CONFIGURED": "none",
  "DS-NAMED": "low",
  "DS-UNKNOWN": "medium",
  "DS-UNKNOWN-HANDOFF": "medium",
  "DS-UNKNOWN-DESTINATION": "medium",
  "DS-LIBRARY-ONLY": "low",
  "DS-DEVELOPER": "medium",
  "DS-TELEMETRY": "medium",
  "DS-PUBLIC-RELAY": "medium",
  "DS-OBFUSCATED": "unknown",
  // Hosts it sent data to when we ran it count as traced requests for the rules above, and one it
  // only loaded pages from is marked seen; it adds no concern.
  "DS-OBSERVED": "none",
};

/** The local-http-server badge: every endpoint opened to web pages, library content read, or plain. */
function serverVariant(apis: string[]): string {
  if (apis.includes("every endpoint, for any website")) return "local-http-server-open-web";
  if (apis.includes("every endpoint, for the websites it names"))
    return "local-http-server-open-listed";
  if (apis.includes("every endpoint, for websites you approve"))
    return "local-http-server-open-approved";
  if (apis.includes("web pages can read the library")) return "local-http-server-web-read";
  return "local-http-server";
}

/** Capabilities every plugin has or that are shown elsewhere on the page. */
const NOT_BADGED = new Set(["ui-injection", "self-update"]);

export interface ScoreInput {
  analysis: Analysis;
  /** `owner/name` of the listed repository: a host carrying either is this developer's own. */
  repo?: string;
  /** A fork (or a copy sharing another listing's add-on ID) kept the original's repository name. */
  fork?: boolean;
  updateHost: { host: string; category: string } | null;
  /** Where updates come from (see classifyUpdateSource), and what the address offers today. */
  updateSource?: {
    kind: string;
    label: string;
    check?: {
      result: string;
      note: string;
      targetLabel: TrustCard["overall"]["label"] | null;
      /** The file doesn't match the hash its entry gives, so Zotero won't install it. */
      refused?: boolean;
    };
  };
  provenance: Provenance;
  /** Our own snapshots saw the file behind this release tag change. */
  assetReplaced: boolean;
  /**
   * The project's own update manifest gives this version, at this file's address, a hash the file
   * doesn't have, and the file was uploaded after the manifest last changed and after publication
   * (see writtenForAnotherFile in run.ts).
   */
  manifestMismatch?: boolean;
  maintenance: {
    status: "active" | "slowing" | "dormant" | "archived" | "unknown";
    lastReleaseAt: string | null;
    lastCommitAt: string | null;
  };
  compatibility: {
    current: { major: number; zoteroVersion: string; status: CompatStatus };
    previous: { major: number; zoteroVersion: string; status: CompatStatus } | null;
    next: { major: number; zoteroVersion: string; status: CompatStatus } | null;
    blockedByZotero: { reason: string; source: string } | null;
    /** Every Zotero major the build declares support for, to name them ("made for Zotero 7"). */
    supported?: number[];
    /** Zotero won't install the file at all, so it works with no version (census/compat.ts). */
    installProblem?: InstallProblem;
    /**
     * The build's declared range, when it runs on another release of the current major but not
     * the current one, to say where it stops ("it stops at Zotero 10.0.2").
     */
    range?: { min: string | null; max: string | null };
  };
  currentZotero: string;
  computedAt: string;
  /**
   * The plugin sandbox's run (data/sandbox/<slug>.json) and the hosts it contacted, classified like
   * the code's (observedHosts). Used only when it ran this exact file.
   */
  tested?: { record: SandboxRecord; hosts: ObservedHost[] };
  /**
   * A reviewed "Downloads a program and runs it" finding (reviews.ts): its level and
   * what it is. Used only for the exact file it reviewed.
   */
  downloadReview?: Pick<DownloadReview, "real" | "concern" | "rule" | "summary"> & {
    files: string[];
  };
}

type CompatStatus = "compatible" | "incompatible" | "unknown";

const INSTALL_PROBLEM: Record<InstallProblem, string> = {
  "invalid-id": "its add-on ID isn't in a form Zotero accepts",
  "no-update-url": "its manifest has no update address, which Zotero requires",
  "no-max-version": "its manifest has no maximum Zotero version, which Zotero requires",
};

/**
 * The compatibility line shown next to the overall label. Compatibility doesn't feed the label
 * "Few concerns found" is about the code, and this line says whether it runs.
 */
export function compatibilityLabel(c: ScoreInput["compatibility"]): string {
  if (c.blockedByZotero) return `Blocked by Zotero: ${c.blockedByZotero.reason}`;
  if (c.installProblem)
    return `Zotero won't install this file: ${INSTALL_PROBLEM[c.installProblem]}`;
  const cur = c.current;
  if (cur.status === "unknown") return "We couldn't tell which Zotero versions it works with";
  if (cur.status === "compatible") return `Works with Zotero ${cur.major}`;
  // It runs on another release of the current major, just not the current one: name the version.
  const now = (c.supported ?? []).includes(cur.major) ? cur.zoteroVersion : String(cur.major);
  if (c.previous?.status === "compatible")
    return `Doesn't work with Zotero ${now}; works with Zotero ${c.previous.major}`;
  // Made for the next major, even when a minimum of "11.0" is past its dev build (11.0-dev.5).
  if (c.next && (c.next.status === "compatible" || (c.supported ?? []).includes(c.next.major)))
    return `Doesn't work with Zotero ${now}; made for Zotero ${c.next.major} (in development)`;
  const { min, max } = c.range ?? {};
  if (max && compareVersions(max, cur.zoteroVersion) < 0)
    return `Doesn't work with Zotero ${now}; it stops at Zotero ${max}`;
  if (min && compareVersions(min, cur.zoteroVersion) > 0)
    return `Doesn't work with Zotero ${now}; it needs Zotero ${min} or later`;
  const older = (c.supported ?? []).filter((m) => m < cur.major).sort((x, y) => x - y);
  if (older.length) {
    const lo = older[0] as number;
    const hi = older.at(-1) as number;
    return `Doesn't work with Zotero ${now}; made for Zotero ${lo === hi ? lo : `${lo}–${hi}`}`;
  }
  return `Doesn't work with Zotero ${now}; made for older Zotero versions`;
}

export function score(input: ScoreInput): TrustCard {
  // A test applies to the file it ran: a new release is untested until it's tested again.
  const tested =
    input.tested?.record.sha256 === input.analysis.input.sha256 ? input.tested : undefined;
  // The hosts it sent data to when we ran it count as traced requests (DS-OBSERVED).
  const { analysis: a, seen } = tested
    ? withObserved(input.analysis, tested.hosts)
    : { analysis: input.analysis, seen: new Set<string>() };
  const p = preview(a, input.updateHost);
  const review = input.downloadReview?.files.includes(a.input.sha256)
    ? input.downloadReview
    : undefined;
  if (review) applyDownloadReview(p, review);

  // It turns Zotero's automatic updates on for itself at every start (literature-review-with-llm).
  const forcesAutoUpdate = a.capabilities.some(
    (c) => c.id === "self-update" && c.details?.apis?.includes(FORCES_AUTO_UPDATE),
  );

  // Source transparency
  const stDrivers: string[] = [];
  const stConcerns: Concern[] = [];
  const st = (rule: string, c: Concern) => {
    stDrivers.push(rule);
    stConcerns.push(c);
  };
  if (p.obfuscated) st("ST-OBFUSCATED", "high");
  else if (p.possiblyObfuscated) st("ST-OBFUSCATION-POSSIBLE", "medium");
  if (p.suspiciousUnicode) st("ST-UNICODE", "high");
  // The file behind the release tag changed after publication: our own earlier copy differs, or
  // the project's update manifest was written for another file (ccf-rank: its CI build, swapped
  // for a hand-built one six minutes later).
  const replaced = input.assetReplaced || Boolean(input.manifestMismatch);
  if (replaced) st("ST-ASSET-REPLACED", "medium");
  // Whoever registers the template namespace can serve an update for this add-on ID.
  if (input.updateSource?.kind === "unclaimed-namespace") st("ST-UPDATE-UNCLAIMED", "medium");
  // Zotero installs whatever the update address offers, so a different file there is what users
  // end up running (zotero-style's release is 6.0.8; its update address offers 6.0.86 from Gitee).
  const check = input.updateSource?.check;
  // A file Zotero refuses (its hash doesn't match) isn't what users end up running.
  const targetConcern: Concern | null =
    check?.result !== "different-file" || check.refused
      ? null
      : check.targetLabel === "high-concern"
        ? "high"
        : check.targetLabel === "review-details"
          ? "medium"
          : check.targetLabel === "insufficient-data"
            ? "unknown"
            : null;
  // Only when it's worse than this file: the project's next release with the same
  // findings isn't a second problem (zotero-babeldoc 0.1.9 → 0.1.11).
  const ownConcern = worst([
    ...stConcerns,
    worst(p.drivers.filter((d) => d.startsWith("DS-")).map((d) => DS_CONCERN[d] ?? "unknown")),
    worst(p.capabilities.map((c) => c.concern)),
  ]);
  const targetFires = targetConcern !== null && RANK[targetConcern] > RANK[ownConcern];
  if (targetFires) st("ST-UPDATE-TARGET", targetConcern);
  const level = input.provenance.level;
  if (level === "plausible") st("ST-PLAUSIBLE", "low");
  else if (level === "not-checked") st("ST-NOT-CHECKED", "unknown");
  const stConcern = worst(stConcerns);
  const stForOverall = worst(stConcerns.filter((_, i) => stDrivers[i] !== "ST-NOT-CHECKED"));

  // Data sharing: DS-OBSERVED when the test marks a host the card lists (a page load from a host
  // the code names but the card doesn't count marks nothing).
  const observedOnCard = Object.values(p.hostsByCategory).some((hs) => hs.some((h) => seen.has(h)));
  const dsDrivers = [
    ...p.drivers.filter((d) => d.startsWith("DS-")),
    ...(observedOnCard ? ["DS-OBSERVED"] : []),
  ];
  const dsConcern = worst(dsDrivers.map((d) => DS_CONCERN[d] ?? "unknown"));

  // Capabilities
  const capDrivers = p.drivers.filter((d) => d.startsWith("CAP-"));
  const badges = p.capabilities
    .filter((c) => !NOT_BADGED.has(c.id))
    .map((c) => {
      const found = a.capabilities.find((x) => x.id === c.id);
      const apis = found?.details?.apis ?? [];
      const variant =
        c.id === "db-write" && c.concern === "high"
          ? "db-write-zotero"
          : c.id === "link-runs-code" && c.concern === "medium"
            ? "link-runs-code-asks"
            : c.id === "process-launch" && c.concern === "low"
              ? "process-launch-openers"
              : c.id === "download-exec" && review
                ? {
                    low: "download-exec-told",
                    medium: "download-exec",
                    high: "download-exec-http",
                  }[review.concern]
                : c.id === "download-exec" && c.concern === "medium"
                  ? "download-exec-pinned"
                  : c.id === "own-server" &&
                      found?.details?.web === "any" &&
                      (found.details.serverActions?.length ?? 0) > 0
                    ? found.details.needsKey
                      ? "own-server-acts-key"
                      : "own-server-acts"
                    : c.id === "own-server" && c.concern === "medium"
                      ? apis.includes("web pages can call it")
                        ? apis.some((x) =>
                            /nsIServerSocket|httpd|debugging server|program it runs/.test(x),
                          )
                          ? "own-server-web"
                          : "own-server-web-connector"
                        : apis.includes("listens beyond this computer") ||
                            apis.includes("listens beyond this computer by default (a setting)")
                          ? "own-server-network"
                          : "own-server-setting"
                      : c.id === "installs-translators" && c.concern === "low"
                        ? "installs-translators-bundled"
                        : c.id === "remote-code" &&
                            apis.length > 0 &&
                            apis.every((x) => x === "an AI model's reply")
                          ? "remote-code-ai"
                          : c.id === "runs-sent-code" && apis.includes("AI shell tool")
                            ? "runs-sent-code-ai-shell"
                            : c.id === "runs-sent-code" && apis.includes("AI tool")
                              ? "runs-sent-code-ai"
                              : c.id === "runs-sent-code" &&
                                  apis.every((x) => x === "debugger clients")
                                ? "runs-sent-code-debugger"
                                : c.id === "runs-sent-code" && apis.includes("web pages")
                                  ? "runs-sent-code-web"
                                  : c.id === "server-edits-library" && found?.details?.web
                                    ? `server-edits-library-${found.details.web === "any" ? "web" : found.details.web}${found.details.needsKey && found.details.web === "any" ? "-key" : ""}`
                                    : c.id === "local-http-server"
                                      ? serverVariant(apis)
                                      : c.id === "changes-settings" &&
                                          found?.details?.settings?.every((e) =>
                                            ZOTERO_SETTINGS.has(e.change),
                                          )
                                        ? "changes-settings-zotero"
                                        : c.id === "sends-unencrypted" && c.concern === "low"
                                          ? "sends-unencrypted-lookups"
                                          : c.id === "package-run" && c.concern === "high"
                                            ? "package-run-unpinned"
                                            : (c.id as string);
      const detail = c.id === "download-exec" && review ? review.summary : badgeDetail(c.id, found);
      // The unencrypted badge names where the data goes.
      const to =
        c.id === "sends-unencrypted" && found?.details?.unencrypted?.length
          ? ` to ${names(unencryptedHosts(found.details.unencrypted))}`
          : "";
      return {
        id: c.id as CapabilityId,
        label: `${CAPABILITY_LABEL[variant] ?? c.id}${to}`,
        concern: c.concern,
        ...(c.libraries ? { libraries: c.libraries } : {}),
        ...(detail ? { detail } : {}),
      };
    })
    .sort((x, y) => RANK[y.concern] - RANK[x.concern] || x.id.localeCompare(y.id, "en"));
  const capConcern = worst(p.capabilities.map((c) => c.concern));

  // Overall
  const insufficient = insufficientCoverage(a);
  const facets = {
    sourceTransparency: stForOverall,
    dataSharing: dsConcern,
    capabilities: capConcern,
  } as const;
  const top = worst(Object.values(facets));
  const overall: TrustCard["overall"] = insufficient
    ? { label: "insufficient-data", ruleId: "OV-INSUFFICIENT", drivers: [] }
    : {
        label: RANK[top] >= 3 ? "high-concern" : RANK[top] >= 2 ? "review-details" : "low-concern",
        ruleId: RANK[top] >= 3 ? "OV-HIGH" : RANK[top] >= 2 ? "OV-REVIEW" : "OV-LOW",
        drivers:
          RANK[top] >= 2
            ? (Object.entries(facets) as [keyof typeof facets, Concern][])
                .filter(([, c]) => RANK[c] === RANK[top])
                .map(([f]) => f)
            : [],
      };

  const found = new Set(a.network.hosts.map((h) => h.host));
  // A host seen when we ran it was contacted, even when all it did was load a page.
  const requested = new Set([
    ...a.network.hosts.filter((h) => h.usage === "request").map((h) => h.host),
    ...seen,
  ]);
  // Hosts a request reaches over plain http.
  const plain = new Set(
    a.network.hosts.filter((h) => h.flags.includes("unencrypted")).map((h) => h.host),
  );
  const stLabel = transparencyLabel(
    a,
    p.obfuscated,
    p.suspiciousUnicode,
    replaced,
    level,
    targetFires ? targetConcern : null,
    input.updateSource?.kind === "unclaimed-namespace",
  );
  const dsLabel = dataSharingLabel(
    a,
    p.dataSharing,
    dsDrivers,
    p.hostsByCategory,
    requested,
    input.repo,
    input.fork,
  );
  // The "because" line: every finding at the level that set the label.
  if (overall.label === "high-concern" || overall.label === "review-details") {
    const reasons: string[] = [];
    if (RANK[stForOverall] === RANK[top]) reasons.push(stLabel);
    if (RANK[dsConcern] === RANK[top]) reasons.push(dsLabel);
    for (const b of badges)
      if (RANK[b.concern] === RANK[top])
        reasons.push(b.libraries ? `${b.label} (from ${b.libraries.join(", ")})` : b.label);
    overall.reasons = reasons;
  }

  // The test is judged against the card without it: a host it contacted isn't "described" because
  // the test put it on the card.
  const testedCard = tested
    ? testedSummary(
        tested.record,
        Object.values(preview(input.analysis, input.updateHost).hostsByCategory).flat(),
        tested.hosts,
      )
    : undefined;

  const m = input.maintenance;
  const maintenanceStatus = m.status === "unknown" ? "dormant" : m.status;
  const compat = input.compatibility;

  const inputs = {
    analyzerVersion: a.analyzerVersion,
    provenanceCheckerVersion: input.provenance.checkerVersion,
    hostsTableVersion: a.network.hostsTableVersion,
    currentZotero: input.currentZotero,
  };
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        RULES_VERSION,
        inputs,
        sha: a.input.sha256,
        updateHost: input.updateHost,
        updateSource: input.updateSource ?? null,
        provenance: [level, input.provenance.attestation.present],
        assetReplaced: input.assetReplaced,
        maintenance: [maintenanceStatus, m.lastReleaseAt, m.lastCommitAt],
        compat,
        ...(input.manifestMismatch ? { manifestMismatch: true } : {}),
        ...(tested ? { tested: [testedCard, tested.hosts] } : {}),
        ...(review ? { downloadReview: { ...review, files: undefined } } : {}),
      }),
    )
    .digest("hex");

  return {
    schemaVersion: 1,
    rulesVersion: RULES_VERSION,
    computedAt: input.computedAt,
    appliesTo: a.input,
    inputs: { ...inputs, inputHash },
    facets: {
      sourceTransparency: {
        provenance: level,
        obfuscated: p.obfuscated,
        suspiciousUnicode: p.suspiciousUnicode,
        sourceMaps: a.transparency.sourceMaps.present,
        assetReplaced: replaced,
        ...(input.assetReplaced
          ? {
              assetReplacedDetail:
                "The file differs from the one we saw under this release tag before",
            }
          : input.manifestMismatch
            ? {
                assetReplacedDetail:
                  "The file doesn't match the fingerprint its own update manifest gives for this version",
              }
            : {}),
        ...(input.updateSource
          ? {
              updates: {
                kind: input.updateSource.kind,
                label: input.updateSource.label,
                ...(check ? { check: check.note } : {}),
                ...(forcesAutoUpdate
                  ? {
                      note: "It turns Zotero's automatic updates on for itself at every start, even if you turned them off",
                    }
                  : {}),
              },
            }
          : {}),
        partialAnalysis: partialNote(a),
        concern: stConcern,
        label: stLabel,
        drivers: stDrivers,
      },
      dataSharing: {
        value: p.dataSharing,
        hosts: Object.entries(p.hostsByCategory)
          .map(([category, hosts]) => {
            const unique = [...new Set(hosts)].sort();
            const unconfirmed = unique.filter((h) => found.has(h) && !requested.has(h));
            const unencrypted = unique.filter((h) => plain.has(h));
            const observed = unique.filter((h) => seen.has(h));
            return {
              category: category as HostFinding["category"],
              hosts: unique,
              ...(unconfirmed.length ? { unconfirmed } : {}),
              ...(unencrypted.length ? { unencrypted } : {}),
              ...(observed.length ? { observed } : {}),
            };
          })
          .sort((x, y) => x.category.localeCompare(y.category, "en")),
        concern: dsConcern,
        label: dsLabel,
        legalRisk: p.legalRisk,
        drivers: dsDrivers,
      },
      capabilities: { badges, concern: capConcern, drivers: capDrivers },
      requirements: { badges: [], reviewed: false },
      maintenance: {
        status: maintenanceStatus,
        lastReleaseAt: m.lastReleaseAt,
        lastCommitAt: m.lastCommitAt,
        concern:
          m.status === "active"
            ? "none"
            : m.status === "slowing"
              ? "low"
              : m.status === "unknown"
                ? "unknown"
                : "medium",
      },
      compatibility: {
        current: compat.current,
        previous: compat.previous,
        next: compat.next,
        blockedByZotero: compat.blockedByZotero,
        ...(compat.installProblem ? { installProblem: compat.installProblem } : {}),
        label: compatibilityLabel(compat),
        concern: compat.blockedByZotero
          ? "high"
          : compat.current.status === "compatible"
            ? "none"
            : compat.current.status === "incompatible"
              ? "high"
              : "unknown",
      },
      reviewStatus: { state: "automated-only", stale: false },
    },
    overall,
    ...(testedCard ? { tested: testedCard } : {}),
  };
}

/** Services a plugin could send data to, for "the code mentions …" wording. */
const MENTIONED = new Set([
  "unknown",
  "developer-server",
  "cloud-function",
  "llm-provider",
  "translation",
  "scholarly-api",
  "integration",
  "telemetry",
]);

/** Up to three hosts by name, then "and N more". */
const names = (hosts: string[]) =>
  hosts.length <= 2
    ? hosts.join(" and ")
    : hosts.length === 3
      ? `${hosts[0]}, ${hosts[1]} and ${hosts[2]}`
      : `${hosts.slice(0, 2).join(", ")} and ${hosts.length - 2} more`;

function dataSharingLabel(
  a: Analysis,
  value: DataSharingValue,
  drivers: string[],
  hostsByCategory: Record<string, string[]>,
  requested: Set<string>,
  repo?: string,
  fork?: boolean,
): string {
  // Obfuscated code can hide requests: a clean-looking result isn't one we can vouch for.
  if (drivers.includes("DS-OBFUSCATED"))
    return "We couldn't fully check where it sends data: the code is obfuscated";
  // Network code with no destination we could name is a different finding from a server we saw
  // but couldn't identify, so it gets its own wording.
  if (drivers.includes("DS-UNKNOWN-DESTINATION")) return "Uses the network; we couldn't tell where";
  // Usage data and public relays are what the facet is about when they fire.
  const tel = [...new Set(hostsByCategory.telemetry ?? [])].sort();
  if (drivers.includes("DS-TELEMETRY") && tel.length && value === "named-third-parties")
    return `Sends usage data to ${names(tel)}`;
  const relays = a.network.hosts
    .filter((h) => h.flags.includes("public-relay") && h.usage === "request")
    .map((h) => h.host);
  if (drivers.includes("DS-PUBLIC-RELAY") && relays.length && value === "named-third-parties")
    return `Sends data through a public relay: ${names([...new Set(relays)].sort())}`;
  // "Contacts" only for hosts a traced request reaches; otherwise the address is in the code.
  const verb = (hosts: string[]) =>
    hosts.some((h) => requested.has(h)) ? "Contacts" : "Its code names";
  // Traced hosts first, then production-looking ones, then dev and staging hosts.
  const stage = (h: string) =>
    requested.has(h) ? 0 : /(^|[.-])(dev|staging|stage|beta|test|local)[.-]/.test(h) ? 2 : 1;
  const uniq = (hosts: string[] | undefined) =>
    [...new Set(hosts ?? [])].sort((x, y) => stage(x) - stage(y) || x.localeCompare(y, "en"));
  // A program it hands data to (a companion app on this computer) is an entry, not a host.
  // "Documents" only when the code gives it PDF files or their text (not PicList's image paths),
  // and "automatically" when it does so without a click.
  if (drivers.includes("DS-UNKNOWN-HANDOFF")) {
    const handed = (a.network.programs ?? []).filter((p) => p.category === "unknown");
    const docs = handed.length > 0 && handed.every((p) => p.documents);
    const auto = handed.length > 0 && handed.every((p) => p.automatic);
    return `Hands your ${docs ? "documents" : "data"} to ${names(uniq(hostsByCategory.unknown))}${auto ? " automatically" : ""}; we can't check where ${docs ? "they go" : "it goes"} from there`;
  }
  if (value === "unknown-endpoints") {
    const hosts = uniq(hostsByCategory.unknown).filter((h) =>
      a.network.hosts.some((x) => x.host === h),
    );
    const one = hosts.length === 1;
    return `${verb(hosts)} ${one ? "a server" : "servers"} we couldn't identify: ${names(hosts)}`;
  }
  if (value === "developer-servers") {
    const dev = uniq(hostsByCategory["developer-server"]);
    // A Cloudflare Worker or Supabase function is usually the developer's, but the platform is
    // all we can see (review P9).
    if (!dev.length) {
      const cf = uniq(hostsByCategory["cloud-function"]);
      return `${verb(cf)} ${cf.length === 1 ? "a server" : "servers"} on a hosting platform: ${names(cf)}`;
    }
    // A webhook with its own account in the code (flomo, Slack, Discord, Telegram).
    const fixedAccount = dev.filter((h) =>
      a.network.hosts.find((x) => x.host === h)?.flags.includes("fixed-account"),
    );
    if (fixedAccount.length === dev.length)
      return `Sends data into an account written into its code: ${names(fixedAccount)}`;
    // "the developer's" only when the host carries this plugin's own name; a fork's upstream
    // server (zotfile.com) is another developer's.
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    // A fork's repository name is the original's (zotfile--grayxu): only its owner name counts.
    const repoNames = (repo ?? "")
      .split("/")
      .slice(0, fork ? 1 : 2)
      .map(norm)
      .filter((x) => x.length >= 4);
    const own = dev.every(
      (h) =>
        a.network.hosts.find((x) => x.host === h)?.provider === "Plugin developer (name match)" ||
        h
          .split(".")
          .slice(0, -1)
          .some((label) => repoNames.includes(norm(label))),
    );
    const whose = own ? "the developer's" : dev.length === 1 ? "a developer's" : "developers'";
    return `${verb(dev)} ${whose} ${dev.length === 1 ? "server" : "servers"}: ${names(dev)}`;
  }
  if (value === "named-third-parties") {
    const all = Object.entries(hostsByCategory).filter(([c]) => c !== "localhost");
    const external = all
      .flatMap(([, hs]) => hs)
      .filter((h) => a.network.hosts.some((x) => x.host === h));
    // Programs it runs (Codex CLI) and Zotero's lookups are entries rather than hosts: used.
    const entries = all.flatMap(([, hs]) => hs).length > external.length;
    if (external.length && !entries && verb(external) !== "Contacts")
      return "Its code only names services we could identify";
  }
  if (value === "bundled-library-only") {
    const libs = [...new Set(a.network.apis.flatMap((x) => x.libraries ?? []))].sort();
    return `Network code only in bundled libraries: ${libs.slice(0, 3).join(", ")}`;
  }
  if (value === "no-network-found") {
    // No request we could trace, but the plugin's own code names services: say so rather than
    // claim there is no network access.
    const named = a.network.hosts.filter(
      (h) =>
        h.usage !== "link" &&
        !h.inVendoredCode &&
        MENTIONED.has(h.category) &&
        h.provider !== "Plugin developer (name match)",
    );
    if (named.some((h) => h.category === "unknown"))
      return "No web requests found; its code names servers we couldn't identify";
    if (named.length) return "No web requests found; its code names known services";
  }
  if (value === "user-configured-only") {
    // Only the web addresses saved on the user's own items.
    const endpoints = a.network.configurableEndpoints;
    if (
      endpoints.length > 0 &&
      endpoints.every((e) => e.prefKey === "(the item's own URL)") &&
      !hostsByCategory.localhost
    )
      return "Only visits the web addresses saved in your items";
    if (!endpoints.length && hostsByCategory.localhost)
      return "Only contacts programs on this computer";
  }
  return DATA_SHARING_LABEL[value];
}

/** The facet's headline: its most serious finding, else how readable the code is. */
function transparencyLabel(
  a: Analysis,
  obfuscated: boolean,
  unicode: boolean,
  replaced: boolean,
  level: Provenance["level"],
  updateTarget: Concern | null,
  unclaimed: boolean,
): string {
  const libs = a.transparency.obfuscation.libraries;
  if (obfuscated && libs?.length)
    return `Obfuscated code in a bundled package (${libs.join(", ")}), not in the plugin's own code`;
  if (obfuscated) return "Obfuscated code: deliberately scrambled, so we couldn't check all of it";
  if (unicode) return "Hidden characters in the code";
  if (updateTarget === "high") return "Updates replace it with a version that has serious concerns";
  if (replaced) return "Release file replaced after publication";
  if (unclaimed) return "Updates are set to come from an address someone else could control";
  if (a.transparency.obfuscation.detected) return "Parts of the code may be obfuscated";
  if (updateTarget === "medium")
    return "Updates replace it with a version that needs a closer look";
  if (updateTarget === "unknown")
    return "Updates replace it with a version we couldn't fully check";
  const code =
    a.transparency.verdict === "readable" ? "Readable code" : "Minified (compressed) code";
  return level === "plausible"
    ? `${code}, uploaded by the project's automated GitHub build`
    : `${code}; not yet checked against the published source`;
}
