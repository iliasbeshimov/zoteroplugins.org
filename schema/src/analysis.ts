import { z } from "zod";
import { ArtifactRef, CodeEvidence, IsoDateTime, SchemaVersion, VersionString } from "./common.ts";

/**
 * Output of `atlas analyze` for one .xpi. Deterministic for a given (sha256, analyzerVersion):
 * re-running the same analyzer on the same file must produce the same document (minus analyzedAt).
 * Evidence lists are capped; `occurrences` always carries the true count.
 */

export const EVIDENCE_CAP = 10;

const EvidenceList = z.array(CodeEvidence).max(EVIDENCE_CAP);

// ---------------------------------------------------------------------------
// Coverage: what we actually looked at. Surfaced on the card as "analysis was partial".

export const Coverage = z.object({
  filesTotal: z.int().nonnegative(),
  filesAnalyzed: z.int().nonnegative(),
  filesSkipped: z.array(
    z.object({
      path: z.string(),
      reason: z.enum(["binary", "too-large", "not-code", "unsupported-type"]),
    }),
  ),
  parseFailures: z.array(
    z.object({
      path: z.string(),
      error: z.string().max(300),
      fallback: z.literal("regex").describe("Regex scanning was used instead of the AST walker."),
    }),
  ),
  partial: z
    .boolean()
    .describe("True if any code file was skipped or fell back to regex. The card says so."),
  codeBytes: z.int().nonnegative().optional().describe("Bytes of code and markup files analysed"),
  failedBytes: z
    .int()
    .nonnegative()
    .optional()
    .describe("Bytes of code the parser couldn't read (scanned with the regex fallback)"),
});

// ---------------------------------------------------------------------------
// Code transparency

export const ObfuscationSignal = z.object({
  kind: z.enum([
    "hex-identifiers", // _0x1a2b style names
    "string-array-rotation", // javascript-obfuscator string table + rotate IIFE
    "escape-density", // heavy \x / \u escaping in string literals
    "eval-decoded-string", // eval / Function applied to decoded or computed strings
    "identifier-entropy", // unusually high identifier entropy for the file's size
    "obfuscator-signature", // known tool fingerprints
    "control-flow-flattening", // switch-in-while dispatch loops
    "string-array-accessor", // javascript-obfuscator's decoder: `a = a - 0x1f0; … c[a]`
    "packer", // Dean Edwards' eval(function(p,a,c,k,e,d){…}) packer
  ]),
  file: z.string(),
  score: z.number().min(0).max(1).optional(),
  evidence: EvidenceList,
});

export const SuspiciousUnicode = z.object({
  kind: z.enum([
    "zero-width",
    "bidi-control",
    "variation-selector",
    "private-use",
    "tag-character",
  ]),
  codepoints: z.array(z.string().regex(/^U\+[0-9A-F]{4,6}$/)),
  occurrences: z.int().positive(),
  evidence: EvidenceList,
});

export const VendoredLibrary = z.object({
  name: z.string(),
  version: z.string().optional(),
  files: z.array(z.string()),
  identifiedBy: z
    .enum(["banner", "hash", "file-name", "package-json"])
    .describe(
      "banner: a library licence header; file-name: a known library or release-style file name; package-json: a node_modules path or bundler module marker",
    ),
});

export const Transparency = z.object({
  verdict: z
    .enum(["readable", "minified", "obfuscated", "mixed"])
    .describe("Applies to the plugin's own code; vendored libraries are excluded."),
  obfuscation: z.object({
    detected: z.boolean(),
    confidence: z.enum(["low", "medium", "high"]),
    signals: z.array(ObfuscationSignal),
    libraries: z
      .array(z.string())
      .optional()
      .describe(
        "Set when every signal sits in bundled packages: the obfuscation is theirs (Nutstore's @nutstore/sso-js), the plugin's own code isn't",
      ),
  }),
  minifiedFiles: z.array(z.string()),
  sourceMaps: z.object({
    present: z.boolean(),
    files: z.array(z.string()),
  }),
  suspiciousUnicode: z.array(SuspiciousUnicode),
  vendoredLibraries: z.array(VendoredLibrary),
});

// ---------------------------------------------------------------------------
// Network

export const NetworkApi = z
  .enum([
    "fetch",
    "xhr",
    "zotero-http",
    "websocket",
    "eventsource",
    "send-beacon",
    "nsi-channel",
    "netutil",
    "zotero-lookup",
    "remote-page",
    "download",
  ])
  .describe(
    "zotero-lookup: Zotero's translators and full-text finders, which contact the services Zotero is set up with; remote-page: a web page loaded into a browser or frame the plugin created; download: Firefox's download manager (Downloads.createDownload, Downloads.fetch)",
  );

/** Classification comes from pipeline/data/hosts.yaml, versioned separately from the analyzer. */
export const HostCategory = z.enum([
  "llm-provider",
  "translation",
  "scholarly-api",
  "zotero", // zotero.org services
  "code-hosting", // github.com, raw.githubusercontent.com, gitee.com (updates, assets)
  "integration", // third-party apps and services the user connects: Notion, Readwise, Feishu...
  "telemetry",
  "cloud-function", // tencentscf, aliyun fc, workers.dev, vercel.app ...
  "developer-server", // a host run by the plugin's own author
  "localhost",
  "cdn",
  "documentation", // help/docs sites that normally appear only as links
  "unknown",
]);

export const UrlUsage = z
  .enum(["request", "link", "unknown"])
  .describe(
    "request: the literal reaches a network API in the same expression or via a simple constant. link: it only reaches openURL/launchURL/href. unknown: we couldn't tell.",
  );

export const HostFinding = z.object({
  host: z.string(),
  port: z.int().positive().optional(),
  category: HostCategory,
  provider: z.string().optional().describe("e.g. 'OpenAI', 'DeepL', 'Crossref'"),
  flags: z
    .array(
      z.enum([
        "legal-risk",
        "china-only",
        "blocked-in-mainland-china",
        "ip-literal",
        "public-relay",
        "account-oauth",
        "encrypted-upload",
        "fixed-account",
        "unencrypted",
      ]),
    )
    .default([])
    .describe(
      "ip-literal: a bare IP address, which hosts.yaml can never classify by name; public-relay: an anonymous file drop or open proxy; account-oauth: another app's sign-in service; encrypted-upload: what the code sends there is encrypted to the developer's public key first (JWE), so the drop's other visitors can't read it; fixed-account: the address in the code carries an account or token of its own (a flomo, Slack, Discord or Telegram webhook), so data goes into the developer's account; unencrypted: a request we traced reaches it over plain http:// or ws://, which anyone on the network in between can read or change",
    ),
  usage: UrlUsage,
  inVendoredCode: z.boolean(),
  libraries: z
    .array(z.string())
    .optional()
    .describe("Bundled libraries (package or file names) that some of these uses sit in"),
  occurrences: z.int().positive(),
  evidence: EvidenceList,
});

export const Network = z.object({
  apis: z.array(
    z.object({
      api: NetworkApi,
      occurrences: z.int().positive(),
      inVendoredCodeOnly: z
        .boolean()
        .optional()
        .describe("Every use is inside a bundled library, none in the plugin's own code"),
      libraries: z
        .array(z.string())
        .optional()
        .describe("Bundled libraries (package or file names) that some of these uses sit in"),
      evidence: EvidenceList,
    }),
  ),
  hosts: z.array(HostFinding),
  dynamicUrls: z.array(
    z.object({
      pattern: z
        .string()
        .max(200)
        .describe("Reconstructed shape, e.g. `<base>/v1/chat/completions`"),
      evidence: EvidenceList,
    }),
  ),
  configurableEndpoints: z.array(
    z.object({
      prefKey: z.string().optional(),
      defaultValue: z.string().optional(),
      evidence: EvidenceList,
    }),
  ),
  programs: z
    .array(
      z.object({
        program: z.string().describe("e.g. 'Claude Code', 'Codex CLI', 'edge-tts'"),
        provider: z
          .string()
          .describe("Who the program sends your data to, e.g. 'Anthropic'; empty when unknown"),
        category: HostCategory.optional().describe(
          "Where the card lists it (llm-provider when absent); unknown: a companion whose destination we can't check",
        ),
        documents: z
          .boolean()
          .optional()
          .describe(
            "The code that hands it data works with PDF files or their text (a file path, full text, a selection)",
          ),
        automatic: z
          .boolean()
          .optional()
          .describe(
            "It's handed data without a click: from Zotero's startup, a timer, or Zotero's notice of a new or changed item",
          ),
        evidence: EvidenceList,
      }),
    )
    .optional()
    .describe(
      "Programs the plugin runs and companions on this computer it hands data to (AI command-line tools, edge-tts, a local translation app), which send it on to their provider",
    ),
  hostsTableVersion: z.string(),
});

// ---------------------------------------------------------------------------
// Powerful capabilities

export const CapabilityId = z.enum([
  "filesystem",
  "process-launch",
  "native-code", // js-ctypes
  "db-write", // Zotero.DB.query(Async) with INSERT/UPDATE/DELETE/ALTER/CREATE/DROP
  "sqlite-direct", // opens zotero.sqlite outside Zotero.DB
  "remote-code", // loads code from http(s): loadSubScript, import(), script injection
  "dynamic-code", // eval / new Function on non-literal input
  "credential-storage", // secret-looking prefs
  "login-manager", // nsILoginManager
  "clipboard",
  "local-http-server", // Zotero.Server.Endpoints
  "network-intercept", // http-on-* observers
  "ui-injection",
  "self-update", // manifest update_url
  "remote-script", // a web script loaded into one of the plugin's own pages
  "remote-script-output", // pages the plugin generates load scripts from the web
  "installs-addons", // AddonManager installs
  "download-exec", // downloads a program, makes it executable and runs it
  "borrowed-identity", // signs in with another app's OAuth client ID
  "encrypted-code", // decrypts code shipped in the package and runs it
  "link-runs-code", // a zotero:// link handler that runs code from the link
  "link-installs-addons", // a zotero:// link handler that installs an add-on from the link
  "disables-security", // sets a Gecko security preference (remote script blocks, eval, signing)
  "own-server", // runs its own server (nsIServerSocket, httpd.js, a Node or Python program it runs), not a Zotero connector endpoint
  "self-installs", // installs its own new versions itself, outside Zotero's updater
  "runs-bundled-binary", // runs a compiled program shipped in the package, which we can't read
  "package-run", // installs or runs packages from npm or PyPI at run time (npx, pip, uv)
  "installs-translators", // writes Zotero translators into Zotero's store (downloaded or bundled)
  "own-database", // keeps its own SQLite file through Zotero.DBConnection
  "runs-sent-code", // runs code a local endpoint or an AI agent's tool call hands it
  "enables-local-api", // turns on Zotero's local API, so programs on this computer can read the library (its server turned back on is changes-settings)
  "server-edits-library", // an endpoint on Zotero's built-in server changes the library
  "browser-credentials", // reads a web browser's cookie or password store
  "reused-app-login", // reuses another program's saved sign-in (reads its credential file)
  "changes-settings", // changes settings that aren't its own: Zotero's proxy or sync, other programs' config, autostart, certificates
  "sends-unencrypted", // sends the user's text, keys or identifiers over plain http:// to a host beyond this computer's network
]);

/** What a settings change touches (C33). */
export const SettingsChange = z
  .enum([
    "proxy",
    "proxy-exceptions",
    "sync",
    "server",
    "find-pdf",
    "updates",
    "link-prompts",
    "zotero-config",
    "certificate",
    "agent-permissions",
    "autostart",
    "program-install",
    "office-macros",
    "mcp-config",
    "app-config",
    "shell",
    "global-install",
    "skills",
  ])
  .describe(
    "proxy: Zotero's proxy; proxy-exceptions: servers kept off it; sync: where Zotero syncs; server: Zotero's built-in server turned back on; find-pdf: sources for Find Available PDF; updates: Zotero's own updates turned off; link-prompts: Zotero's question before opening a link in another app; zotero-config: Zotero's built-in service addresses (ZOTERO_CONFIG); certificate: a certificate the system trusts; agent-permissions: an AI coding tool's permission prompts; autostart: a program set to start by itself; program-install: a program copied in to run later; office-macros: macros or add-ins Word or WPS load; mcp-config: an MCP server added to another program; app-config: another program's settings; shell: the PATH or shell startup files; global-install: command-line tools installed for the whole computer; skills: skill files for AI coding tools",
  );

export const Capability = z.object({
  id: CapabilityId,
  occurrences: z.int().positive(),
  inVendoredCodeOnly: z.boolean(),
  libraries: z
    .array(z.string())
    .optional()
    .describe("Bundled libraries (package or file names) that some of these uses sit in"),
  evidence: EvidenceList,
  details: z
    .object({
      sqlStatements: z.array(z.string()).optional(),
      sqlTables: z
        .array(z.string())
        .optional()
        .describe("Tables written; separates Zotero's own tables from a plugin's own"),
      endpoints: z.array(z.string()).optional(),
      prefKeys: z.array(z.string()).optional(),
      fsScope: z.enum(["zotero-data-dir", "user-chosen", "arbitrary", "unknown"]).optional(),
      updateUrl: z.string().optional(),
      apis: z.array(z.string()).optional(),
      sources: z
        .array(z.string())
        .optional()
        .describe("Hosts a downloaded program comes from; `(http)` when unencrypted"),
      programs: z
        .array(z.string())
        .optional()
        .describe("Programs named where it launches processes, e.g. `python3`, `qlmanage`"),
      asksFirst: z
        .boolean()
        .optional()
        .describe("A link handler asks the user (or checks a password) before acting"),
      pinning: z
        .enum(["locked", "top-level", "unpinned"])
        .optional()
        .describe(
          "Package installs, the loosest counting: locked (a lockfile it ships, hashes required, or every requirement pinned exactly), top-level (exact versions for the packages it names; their dependencies can change), unpinned (no fixed version we could see)",
        ),
      packages: z
        .array(z.string())
        .optional()
        .describe("Packages it installs by name, with the version when it's fixed"),
      atStartup: z
        .boolean()
        .optional()
        .describe("A package install runs from Zotero's startup, without a click or a prompt"),
      once: z
        .boolean()
        .optional()
        .describe(
          "Every package install without a fixed version waits for an already-installed check (`if (!exists(venv))`): it installs once, not on every run",
        ),
      copiedToBrowser: z
        .boolean()
        .optional()
        .describe(
          "A browser's cookie or password store copied into the profile of a browser it starts, rather than read by the plugin",
        ),
      approval: z
        .enum(["each-run", "code-switch", "none"])
        .optional()
        .describe(
          "Code its AI assistant writes: shown and approved before each run, allowed by a setting named for running code, or run without the user seeing it first",
        ),
      web: z
        .enum(["any", "listed", "approved"])
        .optional()
        .describe(
          "An endpoint on Zotero's built-in server that web pages can use: any website, the websites the plugin names, or websites the user approves in a prompt. On its own server (own-server): any website, because nothing in its request handling turns web pages away",
        ),
      serverActions: z
        .array(z.enum(["changes-library", "runs-code", "sends-keys"]))
        .optional()
        .describe(
          "What any website can make its own server do (own-server, with web any): change the library, run code or commands it's sent, or send a stored API key to an address the request gives",
        ),
      setting: z
        .string()
        .optional()
        .describe(
          "A setting, off by default, that the endpoint waits for (its preference key, or httpServer.localAPI.enabled for Zotero's local API); on its own server, the setting its start or what websites can make it do waits for",
        ),
      needsKey: z
        .boolean()
        .optional()
        .describe(
          "Every change to the library a website can make through it (server-edits-library, or own-server whose only action is changes-library) needs the key of an item already in the library, and nothing a page can read from it or from Zotero's server hands keys out",
        ),
      agentModes: z
        .array(
          z.object({
            program: z.string(),
            mode: z.enum(["accept-edits", "sandboxed", "full-bypass"]),
            byDefault: z.boolean(),
          }),
        )
        .optional()
        .describe(
          "AI coding agents it launches with fewer approval prompts: file edits accepted, no prompts inside the agent's sandbox, or no prompts and no sandbox; by default or through a setting",
        ),
      installs: z
        .array(
          z.object({
            from: z
              .enum([
                "file",
                "backup",
                "library",
                "fixed",
                "hidden",
                "catalogue",
                "feed",
                "page",
                "link",
                "message",
                "link-source",
              ])
              .describe(
                "file: an add-on file the user picks or drops; backup: every add-on in a backup the user restores; library: add-on files kept in the user's Zotero library; fixed: an address written into the code; hidden: one hidden there (base64); catalogue: a list of add-ons it downloads; feed: its own update feed; page: a file name it reads off a web page; link: an address a zotero:// link supplies; message: an address another program or an AI tool sends; link-source: a zotero:// link can change where it installs from",
              ),
            hosts: z.array(z.string()).optional().describe("Where the file or the list comes from"),
            via: z
              .array(z.string())
              .optional()
              .describe("Third-party mirrors or proxies it fetches through"),
            asks: z
              .enum(["confirm", "click", "none"])
              .describe(
                "confirm: a dialog before each install; click: the user starts it from the plugin; none: it installs without either",
              ),
            auto: z.boolean().optional().describe("It starts by itself, at startup or on a timer"),
            hash: z
              .boolean()
              .optional()
              .describe("The file is checked against a hash before it's installed"),
            https: z
              .boolean()
              .optional()
              .describe("true: only https addresses; false: plain http is accepted too"),
            setting: z
              .string()
              .optional()
              .describe("A setting, off by default, that this way of installing waits for"),
          }),
        )
        .optional()
        .describe("Add-on installs: where each file comes from, and whether each install is asked"),
      settings: z
        .array(
          z.object({
            change: SettingsChange,
            target: z
              .string()
              .optional()
              .describe("What it changes: a program, a link scheme, packages, a Zotero field"),
            asks: z
              .enum(["confirm", "click", "none"])
              .describe(
                "confirm: a dialog first; click: the user starts it from the plugin; none: neither",
              ),
            auto: z.boolean().optional().describe("It starts by itself, at startup or on a timer"),
            setting: z
              .string()
              .optional()
              .describe("A setting, off by default, that this change waits for"),
            optIn: z
              .boolean()
              .optional()
              .describe(
                "A switch the user flips: the value follows a checkbox, or the plugin changes it back",
              ),
            whileInstalled: z
              .boolean()
              .optional()
              .describe(
                "Lasts only while the plugin runs: Zotero's code or configuration changed in memory, or changed back when Zotero closes",
              ),
            asDefault: z
              .boolean()
              .optional()
              .describe(
                "A default in its prefs.js: the user's own value wins, and it goes with the plugin",
              ),
          }),
        )
        .optional()
        .describe(
          "Settings that aren't its own it changes, in Zotero or other programs, and whether each is asked",
        ),
      unencrypted: z
        .array(
          z.object({
            host: z.string(),
            sends: z
              .array(z.enum(["content", "credentials", "identifiers"]))
              .describe(
                "content: the user's text or library data (a selection, PDF text, a question, abstracts); credentials: an API key, token, licence code or account ID; identifiers: only public identifiers, titles or search terms sent to a catalogue",
              ),
            fallback: z
              .boolean()
              .optional()
              .describe("Used only when the https servers listed before it can't be reached"),
          }),
        )
        .optional()
        .describe(
          "Hosts beyond this computer's network it sends data to over plain http://, and what goes to each",
        ),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Version diff: always computed between two analyses from the SAME analyzerVersion,
// so an analyzer upgrade never shows up as a plugin change.

export const VersionDiff = z.object({
  from: z.object({ version: VersionString, sha256: z.string() }),
  addedHosts: z.array(z.string()),
  removedHosts: z.array(z.string()),
  addedCapabilities: z.array(CapabilityId),
  removedCapabilities: z.array(CapabilityId),
  transparencyChange: z
    .object({
      from: Transparency.shape.verdict,
      to: Transparency.shape.verdict,
    })
    .nullable(),
  material: z.boolean(),
  reasons: z.array(z.string()).describe("Plain-language lines for the changes feed."),
});

// ---------------------------------------------------------------------------

export const Analysis = z.object({
  schemaVersion: SchemaVersion,
  analyzerVersion: z.string(),
  analyzedAt: IsoDateTime,
  input: ArtifactRef,
  coverage: Coverage,
  transparency: Transparency,
  network: Network,
  capabilities: z.array(Capability),
  diff: VersionDiff.nullable().describe("Null for the first analysed version."),
});

export type Analysis = z.infer<typeof Analysis>;
export type HostFinding = z.infer<typeof HostFinding>;
export type Capability = z.infer<typeof Capability>;
export type CapabilityId = z.infer<typeof CapabilityId>;
export type SettingsChange = z.infer<typeof SettingsChange>;
export type VersionDiff = z.infer<typeof VersionDiff>;
