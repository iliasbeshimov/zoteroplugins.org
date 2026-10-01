import {
  Analysis,
  type Analysis as AnalysisDoc,
  type CapabilityId,
  type CodeEvidence,
  EVIDENCE_CAP,
} from "@atlas/schema";
import { parse } from "acorn";
import { fullAncestor } from "acorn-walk";
import { parseInstallRdf, parseManifestJson, type XpiManifest } from "../census/xpi.ts";
import {
  classifyHost,
  type HostCategory,
  type HostClass,
  type HostTable,
  hostOf,
} from "./hosts.ts";
import { type LibraryEvidence, SourceFile } from "./text.ts";

/**
 * Static analysis of one .xpi. Deterministic for a given file and ANALYZER_VERSION: the same
 * bytes always produce the same document apart from `analyzedAt`.
 */
export const ANALYZER_VERSION = "0.8.0";
/** The self-update detail saying it turns Zotero's automatic updates on for itself at startup. */
export const FORCES_AUTO_UPDATE = "turns on its automatic updates at startup";

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
type Usage = "request" | "link" | "unknown";
type NetworkApi = AnalysisDoc["network"]["apis"][number]["api"];
type SignalKind = AnalysisDoc["transparency"]["obfuscation"]["signals"][number]["kind"];
type UnicodeKind = AnalysisDoc["transparency"]["suspiciousUnicode"][number]["kind"];

export interface XpiEntry {
  path: string;
  data: Uint8Array;
}

interface Hit {
  file: SourceFile;
  offset: number;
  /** A library recognised from the code where the file's map doesn't say (the toolkit's bridges). */
  library?: string;
}

/**
 * A package command: where it is, its words from the tool on (`npm install -g <expr>`) when we
 * could read them, and the named function it runs in (for what runs at startup).
 */
interface PackageRun extends Hit {
  words?: string[];
  /** It waits for an "already installed" check (`if (!fileExists(envPython))`): it runs once. */
  once?: boolean;
  fn?: string | null;
  /** Where the function around it starts, to see whether it asks first. */
  fnAt?: number;
  /** Its words spread another list (`[...pip, "-r", file]`): checked once that list is known. */
  check?: boolean;
}
/** How package installs are pinned: a lockfile, exact versions for what it names, or neither. */
type Pin = "locked" | "top-level" | "unpinned";
/** What a website can make a plugin's own server do, when nothing turns web pages away. */
type ServerAction = "changes-library" | "runs-code" | "sends-keys";
/**
 * An AI coding agent launched with fewer approval prompts: file edits accepted, no prompts inside
 * its sandbox, or no prompts and no sandbox; always, or when a setting says so.
 */
interface AgentMode {
  program: string;
  mode: "accept-edits" | "sandboxed" | "full-bypass";
  byDefault: boolean;
  hit: Hit;
  /** A settings default, which counts only when a launch passes the setting on. */
  pref?: boolean;
}

/** What an endpoint's class or prototype says about who may call it. */
interface EndpointDecl {
  /** `allowRequestsFromUnsafeWebContent`: set true, set false, or not set here. */
  unsafe: boolean | null;
  /** `supportedMethods` and `supportedDataTypes`, when written out as literals. */
  methods: string[] | null;
  types: string[] | null;
  /** Runs a body field through a schema: a form post, which arrives as flat strings, fails it. */
  schemaField: boolean;
}

/** What the code behind an endpoint does: its handler and the functions it calls. */
interface EndpointCode {
  /** A write to the library (the first one found), and whether it reads library content. */
  edits: Hit | null;
  reads: boolean;
  /**
   * It looks items up by their key, and finds or makes none without one (UNKEYED): then every
   * change it makes needs the key of an item already in the library.
   */
  byKey: boolean;
  unkeyed: boolean;
  /** Needs a header a page can only send after a preflight (`X-…-Token`, Authorization). */
  needsHeader: boolean;
  /** Compares what the caller sends with a token. */
  secret: boolean;
  /** Asks the user first (a website it doesn't know yet). */
  asks: boolean;
  /** Reads the request's Origin header and acts on it (a page's request always carries one). */
  origin: boolean;
  /** Turns away bodies that aren't JSON (415), which a page can only send after a preflight. */
  jsonOnly: boolean;
  /** A setting named for writing (`write.enabled`) it reads: edits wait for it when it's off. */
  writeSetting: Setting | null;
  /** Where the code is, to place other findings (code it runs) inside an endpoint. */
  file: SourceFile;
  ranges: [number, number][];
  /** Functions it calls that its file doesn't define: looked up in the build's other files. */
  calls: string[];
}

/** An endpoint on Zotero's own server (port 23119). */
interface ServerEndpoint {
  hit: Hit;
  path: string | null;
  decl: EndpointDecl;
  code: EndpointCode;
  /** A setting it waits for, with the fallback the code reads it with; or Zotero's local API. */
  setting: { key: string; fallback: string | null } | null;
}

/**
 * A server the plugin opens itself: a server socket, httpd.js, or an HTTP server in a Node or
 * Python program it ships and runs. Zotero's checks don't apply to it: a web page can send it a
 * GET or a text/plain or form POST without a preflight, unless its own code turns pages away.
 */
interface OwnServer {
  hit: Hit;
  kind: "socket" | "httpd" | "node" | "python";
  code: EndpointCode;
  /** A setting, with its fallback, that starting the server waits for. */
  setting: Setting | null;
  /** It answers any web page (`Access-Control-Allow-Origin: *`), so a preflight doesn't stop it. */
  cors?: boolean;
  /** In a Python program: code or a shell command taken from the request, run. */
  runsCode?: boolean;
  /** In a Python program: a stored API key sent to an address the request gives. */
  sendsKeys?: boolean;
  /** A Node or Python program's server takes connections on every network interface. */
  beyond?: boolean;
  /** Its handler only answers with an error (a removed route's "not found"): nothing to reach. */
  refusesOnly?: boolean;
}

/** Where a server the plugin opens hands over its requests, found in the walk. */
interface OwnSite {
  n: AstNode;
  kind: "socket" | "httpd" | "node";
  handlers: AstNode[];
  fns: AstNode[];
  setting: Setting | null;
}

/** A patch to Zotero's request handling that adds CORS headers, opening endpoints to web pages. */
interface ServerPatch {
  hit: Hit;
  /** It checks the path first (its own endpoints), or opens every endpoint on the server. */
  ownPaths: boolean;
  origins: "any" | "listed" | "approved";
  /** Lets a page send Zotero-Allowed-Request, which passes Zotero's browser check anywhere. */
  zoteroHeader: boolean;
}

const CODE_EXT = /\.(m?js|cjs|jsm)$/i;
/** macOS resource forks zipped by accident: `__MACOSX/...` and `._name` files. */
const APPLE_DOUBLE = /(^|\/)(__MACOSX\/|\._[^/]*$)/;
const OWN_DB_CONNECTION =
  /extends\s+Zotero\.DBConnection\b|new\s+Zotero\.DBConnection\s*\(\s*(?!["']zotero["']\s*\))|=\s*Zotero\.DBConnection\b(?!\s*[.(])/;
/**
 * OAuth client IDs of other apps, which let a plugin sign in to the user's account as that app
 * (review P13). Public in those apps' own code; borrowing them is the finding.
 */
const BORROWED_CLIENTS: [string, string][] = [
  ["app_EMoamEEZ73f0CkXaXp7hrann", "Codex CLI"],
  ["Iv1.b507a08c87ecfe98", "GitHub Copilot for VS Code"],
  ["9d1c250a-e61b-44d9-88ed-5944d1962f5e", "Claude Code"],
  ["681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com", "Gemini CLI"],
  ["6A5AA1D4EAFF4E9FB37E23D68491D6F4", "Microsoft Edge read-aloud"],
];
/**
 * Files where a web browser keeps the cookies or passwords that keep you signed in. Reading or
 * copying one hands over every site you're logged into there (review C40). Each pattern is a path
 * segment, so a store name inside prose (a journal title with "Web Data") never matches.
 */
const BROWSER_STORES: RegExp[] = [
  /(^|[/\\])Network[/\\]Cookies(-journal)?$/i, // Chromium cookie store
  /(^|[/\\])Cookies\.binarycookies$/i, // Safari cookies
  /(^|[/\\])Login Data$/, // Chromium saved passwords
  /(^|[/\\])cookies\.sqlite$/i, // Firefox cookies
  /(^|[/\\])key[34]\.db$/i, // Firefox key store (decrypts logins.json)
  /(^|[/\\])logins\.json$/i, // Firefox saved logins
];
/** A browser store's own file name, however the folder before it is built (`${dir}\\Cookies`). */
const BROWSER_STORE_FILE =
  /(^|[/\\])(?:Cookies(?:-journal)?|Cookies\.binarycookies|Login Data|cookies\.sqlite|key[34]\.db|logins\.json)$/;
/** A file copy: `copyFile(…)`, `file.copyTo(…)`, `IOUtils.copy(…)`. */
const COPIES_FILE = /\bcopy(?:File|Sync)?\s*\(|\.copyTo\s*\(|IOUtils\.copy\s*\(/;
/** A browser started on a profile folder of the plugin's choosing. */
const BROWSER_PROFILE_FLAG = /--user-data-dir\b|--profile-directory\b|["'`]-profile["'`]/;
/** SQL on a browser store's own tables: Chromium's `cookies` and `logins`, Firefox's `moz_cookies`. */
const BROWSER_TABLE_SQL = /\b(?:FROM|INTO|UPDATE|TABLE)\s+["'`]?(?:cookies|moz_cookies|logins)\b/i;
/** The browser a store path belongs to, read from a User Data / profile path segment. */
const BROWSER_NAMES: [RegExp, string][] = [
  [/(^|[/\\])Microsoft[/\\]Edge([/\\]|$)/i, "Microsoft Edge"],
  [/(^|[/\\])Google[/\\]Chrome([/\\]|$)/i, "Google Chrome"],
  [/(^|[/\\])BraveSoftware([/\\]|$)/i, "Brave"],
  [/(^|[/\\])Chromium([/\\]|$)/i, "Chromium"],
  [/(^|[/\\])Vivaldi([/\\]|$)/i, "Vivaldi"],
];
/**
 * Another program's saved sign-in, kept in a credential file under its config dir. Reading or
 * copying that file reuses the user's login without their password (review C40). Detection needs
 * a clean path literal (no spaces) both for the dir and for the credential file, so a path written
 * into help text or an error message — prose, with spaces — never counts.
 */
const APP_LOGINS: { program: string; dir: RegExp; file: RegExp }[] = [
  {
    program: "Codex CLI",
    dir: /(^|[/\\])\.codex([/\\]|$)|^CODEX_HOME$/i,
    file: /(^|[/\\])auth\.json$/i,
  },
  {
    program: "Gemini CLI",
    dir: /(^|[/\\])\.gemini([/\\]|$)/i,
    file: /(^|[/\\])(oauth_creds|credentials)\.json$/i,
  },
  { program: "Grok CLI", dir: /(^|[/\\])\.grok([/\\]|$)/i, file: /(^|[/\\])auth\.json$/i },
];
/** A path literal short enough, and free of whitespace, to be a real path rather than prose. */
const isPathToken = (s: string) => s.length > 0 && s.length <= 100 && !/\s/.test(s);
/** `<script src="https://…">` in markup or in HTML a plugin writes. */
const REMOTE_SCRIPT_TAG = /<(?:html:)?script\b[^>]*\bsrc\s*=\s*\\?["']?(https?:\/\/[^"'\s>\\]+)/gi;
/** Methods that run SQL on a Zotero.DBConnection. */
const DB_QUERY =
  /\.(query|queryAsync|queryTx|queryTxAsync|valueQueryAsync|rowQueryAsync|columnQueryAsync)$/;
/** A receiver we couldn't trace still counts when its name says it is a database. */
const DB_LIKE_NAME = /db|database|conn|sql/i;

/**
 * Zotero translators start with a JSON metadata block, which isn't valid JavaScript on its own.
 * Replace it with spaces (keeping line breaks) so the rest of the file parses.
 */
export function blankTranslatorHeader(text: string): string {
  if (!/^\s*\{/.test(text) || !/"translatorID"/.test(text.slice(0, 600))) return text;
  const end = text.search(/\n\}\s*(\n|$)/);
  if (end < 0) return text;
  const stop = end + 2;
  return text.slice(0, stop).replace(/[^\n]/g, " ") + text.slice(stop);
}
const HTML_EXT = /\.(x?html?|xul)$/i;
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|bmp|woff2?|ttf|otf|eot|wasm|mp3|wav|ogg|mp4|zip|gz|xpi|pdf|node|dll|so|dylib|exe)$/i;
// Big enough for any file in a release we download (60 MB); the total guards against zip bombs.
// A file skipped for size makes the card "Not enough data" (review P4): padding a file must never
// lower a label.
const MAX_CODE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_CODE_BYTES = 256 * 1024 * 1024;
// Bracketed IPv6 hosts ("http://[::1]:8080/") and upper-case schemes count too.
// URLs end at CJK and full-width punctuation too ("…/api。然后" in Chinese help text).
const URL_RE =
  /\b(?:https?|wss?):\/\/(?:\[[0-9a-f:.]+\][^\s"'`<>\\)\]}\u3000-\u303f\uff00-\uffef]*|[^\s"'`<>\\)\]}\u3000-\u303f\uff00-\uffef]+)/gi;
const EXPR = "\u0000";

// ----------------------------------------------------------------------------------------------
// AST helpers

const node = (v: unknown): AstNode | undefined =>
  v && typeof v === "object" && typeof (v as AstNode).type === "string"
    ? (v as AstNode)
    : undefined;
const nodes = (v: unknown): AstNode[] =>
  Array.isArray(v) ? v.map(node).filter((n): n is AstNode => n !== undefined) : [];
const str = (n: AstNode | undefined): string | null =>
  n?.type === "Literal" && typeof n.value === "string" ? (n.value as string) : null;

/** Dotted name for member chains: `Zotero.HTTP.request`, `?.fetch` when the base is unknown. */
function chain(n: AstNode | undefined): string | null {
  if (!n) return null;
  switch (n.type) {
    case "Identifier":
      return n.name as string;
    case "ThisExpression":
      return "this";
    case "ChainExpression":
      return chain(node(n.expression));
    case "CallExpression": {
      const c = chain(node(n.callee));
      return c ? `${c}()` : null;
    }
    case "MemberExpression": {
      const prop = node(n.property);
      const name = n.computed
        ? str(prop)
        : prop?.type === "Identifier"
          ? (prop.name as string)
          : null;
      if (!name) return null;
      const base = chain(node(n.object));
      return `${base ?? "?"}.${name}`;
    }
    default:
      return null;
  }
}

/** Literal text of a string or template literal (expressions replaced by a marker). */
function textOf(n: AstNode | undefined): string | null {
  if (!n) return null;
  const s = str(n);
  if (s !== null) return s;
  if (n.type === "TemplateLiteral") {
    return nodes(n.quasis)
      .map(
        (q) =>
          (q.value as { cooked?: string; raw: string }).cooked ?? (q.value as { raw: string }).raw,
      )
      .join(EXPR);
  }
  if (n.type === "BinaryExpression" && n.operator === "+") {
    return `${textOf(node(n.left)) ?? EXPR}${textOf(node(n.right)) ?? EXPR}`;
  }
  return null;
}

function* descendants(n: AstNode): Generator<AstNode> {
  yield n;
  for (const [k, v] of Object.entries(n)) {
    if (k === "type" || k === "start" || k === "end") continue;
    if (Array.isArray(v))
      for (const c of v) {
        const cn = node(c);
        if (cn) yield* descendants(cn);
      }
    else {
      const cn = node(v);
      if (cn) yield* descendants(cn);
    }
  }
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** A member's or property's name: `a.b`, `a["b"]`, `{ b: … }`, `{ "b": … }`; null when computed. */
function nameOf(n: AstNode | undefined): string | null {
  const k = n?.type === "MemberExpression" ? node(n.property) : node(n?.key);
  if (!k) return null;
  return !n?.computed && k.type === "Identifier" ? (k.name as string) : str(k);
}

/** The last name in `X`, `a.b.X` or `(0, a.X)`: what a `new`, an `extends` or a receiver names. */
function lastName(n: AstNode | undefined): string | null {
  const e = n?.type === "SequenceExpression" ? nodes(n.expressions).at(-1) : n;
  return chain(e)?.split(".").at(-1) ?? null;
}

/** `\x41`, `\u0041` and `\u{41}` written out: obfuscators hide names in escapes (zotero-style). */
function unescapeJs(s: string): string {
  if (!s.includes("\\")) return s;
  return s.replace(/\\x([0-9a-f]{2})|\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})/gi, (m, x, c, u) => {
    const cp = Number.parseInt((x ?? c ?? u) as string, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/**
 * Whether a member chain starts at `Services.io`, where Zotero's protocol handler is reached, even
 * with every name after it hidden (`Services['io'][_0x(0x2d0f)]('zotero')[_0x(0x23cb)]…`, zotbox).
 */
function fromServicesIo(n: AstNode | undefined): boolean {
  let prev: AstNode | undefined;
  for (let cur = n, i = 0; cur && i < 12; i++) {
    if (cur.type === "Identifier")
      return cur.name === "Services" && prev?.type === "MemberExpression" && nameOf(prev) === "io";
    prev = cur;
    cur =
      cur.type === "MemberExpression"
        ? node(cur.object)
        : cur.type === "CallExpression"
          ? node(cur.callee)
          : cur.type === "ChainExpression"
            ? node(cur.expression)
            : undefined;
  }
  return false;
}

// ----------------------------------------------------------------------------------------------
// Call classification

/** `fetch` on a window: the global, a window variable, or a call that returns a window. */
const FETCH_CHAIN =
  /^(fetch|(window|globalThis|self|win|w|mainWindow|mainWin|hostWindow|hiddenWindow|platformWindow|targetWindow|_window|ownerGlobal)\.fetch|.*\.(contentWindow|defaultView|ownerGlobal)\.fetch|.*(getMainWindow|domHost|getWindow|getMostRecentWindow)\(\)\.fetch)$/;
/** Zotero's HTTP helpers, also through `zotero.HTTP` or `Z.HTTP` aliases (review P3). */
const ZOTERO_HTTP =
  /(^|\.)HTTP\.(request|doGet|doPost|doHead|doOptions|download|processDocuments|loadDocuments)$|^Zotero\.File\.download$|(^|\.)Attachments\.(importFromURL|downloadFile|addFileFromURLs)$/;
/** Zotero's translators and full-text finders, which contact the services Zotero is set up with. */
const ZOTERO_LOOKUP =
  /(^|\.)Translate\.(Search|Web)$|(^|\.)Attachments\.(addAvailableFile|addAvailablePDF|addAvailablePDFs|downloadFirstAvailableFile|getFileResolvers)$|\.(addAvailablePDF|addAvailablePDFs|downloadFirstAvailableFile)$|(^|\.)RecognizeDocument\.(recognizeItems|recognizeSelected|_recognize|autoRecognizeItems|recognize)$|(^|\.)ZoteroPane\.recognizeSelected$|(^|\.)Internal\.getOpenAccessPDFURLs$/;
/** Webhook addresses that carry their own account or token. */
const WEBHOOK_ACCOUNT =
  /^https?:\/\/(flomoapp\.com\/iwh\/[^/\s]+\/[0-9a-f]{16,}|hooks\.slack\.com\/services\/T\w+\/B\w+\/\w+|(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]{20,}|api\.telegram\.org\/bot\d+:[\w-]{20,})/i;
/** A browser or frame element the plugin controls, loading a page. */
const FRAME_NAME = /(browser|iframe|frame|webview)\w*$/i;

function networkApi(c: string, isNew: boolean): NetworkApi | null {
  if (FETCH_CHAIN.test(c)) return "fetch";
  if (ZOTERO_HTTP.test(c)) return "zotero-http";
  if (ZOTERO_LOOKUP.test(c) && (isNew || !/Translate\./.test(c))) return "zotero-lookup";
  if (
    /\.(loadURI|loadURIString|fixupAndLoadURIString)$/.test(c) &&
    FRAME_NAME.test(c.split(".").at(-2) ?? "")
  )
    return "remote-page";
  if (isNew && /(^|\.)XMLHttpRequest$/.test(c)) return "xhr";
  if (/^axios(\.|$)/.test(c)) return "xhr";
  if (isNew && /(^|\.)WebSocket$/.test(c)) return "websocket";
  if (isNew && /(^|\.)EventSource$/.test(c)) return "eventsource";
  if (/\.sendBeacon$/.test(c)) return "send-beacon";
  if (/\.(newChannel|newChannelFromURI|newChannelFromURIWithLoadInfo)$/.test(c))
    return "nsi-channel";
  // Only NetUtil calls that open a channel; readInputStream and friends work on streams already open.
  if (/^NetUtil\.(asyncFetch|newChannel)$/.test(c)) return "netutil";
  if (/(^|\.)Downloads\.(createDownload|fetch)$/.test(c)) return "download";
  return null;
}

const HTTP_METHOD = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i;

/** Index of the URL argument for a request-making call, or -1 if the call doesn't make requests. */
function requestUrlArg(c: string, isNew: boolean, args: AstNode[]): number {
  const api = networkApi(c, isNew);
  if (api === "zotero-http") return /\.request$/.test(c) ? 1 : 0;
  if (api === "zotero-lookup") return -1;
  if (api === "netutil") return /\.(asyncFetch|newChannel)$/.test(c) ? 0 : -1;
  if (api && api !== "xhr") return 0;
  if (/^axios(\.(get|post|put|delete|patch|head|request))?$/.test(c)) return 0;
  if (isNew && /(^|\.)Request$/.test(c)) return 0;
  if (/(^|\.)(\$|jQuery)\.(ajax|get|post|getJSON)$/.test(c)) return 0;
  // xhr.open("POST", url)
  if (/\.open$/.test(c) && args.length >= 2 && HTTP_METHOD.test(str(args[0]) ?? "")) return 1;
  return -1;
}

const LINK_CALLEE =
  /(^|\.)(launchURL|launchURI|openURL|openUrl|openLink|openLinkInBrowser|loadURI|openInBrowser|openTab|openURI|openWebPage|openTrustedLinkIn|openWebLinkIn)$/;
const isLinkCall = (c: string) => LINK_CALLEE.test(c) || c === "window.open" || c === "open";

const PREF_GET_SET =
  /(^|\.)(Prefs\.(get|set)|getPref|setPref|get(Bool|Int|Char|String)Pref|set(Bool|Int|Char|String)Pref|prefs\.(get|set))$/;
const CREDENTIAL_KEY =
  /(api[-_.]?key|apikey|secret|token|password|passwd|access[-_.]?key|auth[-_.]?key|cookie|session[-_.]?id|credentials?|licen[cs]e[-_.]?key)/i;
/**
 * Settings named after tokens that aren't secrets: `maxTokens`, `token_limit`, `tokenizer`, and a
 * UI's design tokens (`dump-tokens`, `designTokens`).
 */
const NOT_CREDENTIAL_KEY =
  /(max|min|num|total|count|limit|context|output|input|reasoning|dump|design|css|theme|style|color)[-_.]?tokens?|tokens?[-_.]?(count|limit|max|min|num|usage|budget|len|length|per|expires?(at)?|in[-_.]?filename)|tokeni[sz]|[a-z]tokens$/i;
/** A key named after the service it unlocks: `openAlexKey`, `deepl_key`, `mistralKey`. */
const SERVICE_KEY =
  /(?:^|[._-]|[a-z](?=[A-Z]))(?:open[-_.]?alex|openai|anthropic|claude|gemini|google|deepseek|mistral|deepl|semantic[-_.]?scholar|s2|elsevier|scopus|springer|ieee|zhipu|glm|qwen|dashscope|moonshot|kimi|baidu|ernie|doubao|volc(?:engine)?|siliconflow|groq|openrouter|perplexity|cohere|azure|youdao|tencent|niutrans|caiyun|mathpix|doc2x|mineru|llm|gpt|ai)[-_.]?(?:key|secret)s?$/i;
const isCredentialKey = (key: string) =>
  (CREDENTIAL_KEY.test(key) || SERVICE_KEY.test(key)) && !NOT_CREDENTIAL_KEY.test(key);

/**
 * What a request carries of the user's (cleartext-http sweep): their text or library data, a key
 * or account, public identifiers (a DOI, an ISBN, a title), or search terms, which reveal no more
 * than an identifier when they go to a catalogue.
 */
type Sent = "content" | "credentials" | "identifiers" | "search";
/** An account or licence rather than a secret key: `uid`, `deviceId`, an activation code. */
const ACCOUNT_NAME =
  /^(uid|user_?id|device_?id|app_?id|appid|activation_?code|enrol?lment_?tokens?|licen[cs]e_?code)$/i;
/**
 * A site's own anti-forgery token (patent's `__RequestVerificationToken`) or the cookie sandbox a
 * Zotero request runs in, not the user's secrets.
 */
const SITE_TOKEN = /csrf|xsrf|verification|sandbox/i;
const HEADER_CREDENTIAL = /^(x-)?(authorization|api[-_]?key|token|access[-_]?token|secret)$/i;
/** Names for public identifiers or a title: `doi`, `isbn`, `pubT`, `bookTitle`, `cleanId`. */
const PUBLIC_ID =
  /(doi|isbn|issn|arxiv|pmid|pmcid|id_?list|clc|subject|pub_?t|pub_?num|title|patent|journal|identifier)s?$/i;
const ID_SUFFIX = /(^id|_id|[a-z0-9]I[dD])s?$/;
const SEARCH_NAME = /(^q|query|keywords?|terms?|search(word|text|term)?)$/i;
/** Request settings that aren't the user's data: languages, paging, signing, the response format. */
const REQUEST_SETTING =
  /^(lang|langs|lang_?from|lang_?to|from|to|src|tgt|sl|tl|source_?lang(uage)?|target_?lang(uage)?|param|params|salt|sign|signature|nonce|timestamp|ts|time|now|version|v|page|page_?no|page_?size|start|offset|limit|max|max_?results|count|size|rows|sort|sort_?by|sort_?order|order|format|type|action|callback|model|method|mode|locale|region|field|fields|schema|db|platform|product|product_?id|encoding|code_?encoding|detect|trans_?type|request_?id|curtime)$/i;
/** Property names any object holding an address may use, so matching one proves little. */
const ADDRESS_PROP =
  /^(url|uri|href|link|src|source|endpoint|api|base|host|server|address|path|target|location|(base|api|endpoint|server)_?ur[il])$/i;
/** Options of a request call that aren't data sent: `method`, `responseType`, `timeout`… */
const REQUEST_OPTION =
  /^(method|responseType|timeout|mode|credentials|cache|redirect|signal|referrer(Policy)?|dataType|contentType|async|withCredentials|cancellerReceiver|requestObserver|successCodes|errorDelayMax|noCache|dontCache|foreground|logBodyLength|keepalive|integrity|priority|duplex|noRetryOnThrottle)$/i;
/** A key or account passed in an address: `?key=${apiKey}`, `&appid=`. */
const CREDENTIAL_PARAM =
  /[?&](api_?key|apikey|token|access_?token|secret|password|app_?id|appid|uid|user_?id)=$/i;
/** How a name in a request's address or body reads: whose data it is, or none. */
function sentName(name: string): Sent | null {
  if (SITE_TOKEN.test(name) || REQUEST_SETTING.test(name)) return null;
  if (isCredentialKey(name) || ACCOUNT_NAME.test(name)) return "credentials";
  if (PUBLIC_ID.test(name) || ID_SUFFIX.test(name)) return "identifiers";
  if (SEARCH_NAME.test(name)) return "search";
  return "content";
}
/** Zotero's file sync and proxy settings: a plugin that sets them points Zotero at a server. */
const SYNC_PROXY_PREF =
  /(^|\.)(sync\.storage\.url|sync\.server\.url|streaming\.url)$|^network\.proxy\.(http|ssl|socks|autoconfig_url)$/;
/**
 * A setting that holds a server address, judged by the last part of its name (review K5):
 * `extensions.x.apiBase` and `serverUrl` are, `sync.server.username`, `httpServer.port`,
 * `subs.removeURLs` and `showHostName` aren't, and nothing under a `debug` part counts.
 */
function isEndpointKey(key: string): boolean {
  const parts = key.split(".");
  if (parts.some((p) => /^debug/i.test(p))) return false;
  const last = (parts.at(-1) ?? "").toLowerCase();
  if (/^(remove|show|use|enable|disable|is|has)/.test(last)) return false;
  if (/(username|user|port|enabled|filename|displayname|timeout|key|token)$/.test(last))
    return false;
  // `imageApi`, `chatApiUrl`, `baseApi`: an address setting named after the API it points at.
  return /(url|uri|endpoints?|host|hostname|server|apibase|domain|proxy|api)$/.test(last);
}

const CAPABILITY_CHAINS: [RegExp, CapabilityId, string][] = [
  // PathUtils only joins and splits path strings; IOUtils is what touches files.
  [/^IOUtils\./, "filesystem", "IOUtils"],
  [/^OS\.(File|Path)\./, "filesystem", "OS.File"],
  // Not `pathToFile`/`pathToFileURI`: they build an object or address for a path, reading nothing.
  [/^Zotero\.File\.(?!pathToFile(URI)?$)/, "filesystem", "Zotero.File"],
  [/^FileUtils\./, "filesystem", "FileUtils"],
  [/\.nsI(Local)?File$/, "filesystem", "nsIFile"],
  [/\.nsIProcess$/, "process-launch", "nsIProcess"],
  [/^Subprocess\./, "process-launch", "Subprocess"],
  [
    /^Zotero\.Utilities\.Internal\.(exec|subprocess)$/,
    "process-launch",
    "Zotero.Utilities.Internal.exec",
  ],
  [/^Zotero\.launchFileWithApplication$/, "process-launch", "Zotero.launchFileWithApplication"],
  [/^ctypes\./, "native-code", "js-ctypes"],
  [/\.nsILoginManager$|^Services\.logins(\.|$)/, "login-manager", "nsILoginManager"],
  [
    /\.nsIClipboard(Helper)?$|^navigator\.clipboard(\.|$)|copyTextToClipboard$|ClipboardHelper$/,
    "clipboard",
    "clipboard",
  ],
  [/^Zotero\.Server\.Endpoints(\.|$)/, "local-http-server", "Zotero.Server.Endpoints"],
  [/\.nsIServerSocket$/, "own-server", "nsIServerSocket"],
];

const CAPABILITY_STRINGS: [RegExp, CapabilityId, string][] = [
  [/^@mozilla\.org\/process\/util;1$/, "process-launch", "nsIProcess"],
  [/^resource:\/\/gre\/modules\/Subprocess/, "process-launch", "Subprocess"],
  [/^@mozilla\.org\/file\/local;1$/, "filesystem", "nsIFile"],
  [/^resource:\/\/gre\/modules\/osfile/, "filesystem", "OS.File"],
  [/^@mozilla\.org\/login-manager;1$/, "login-manager", "nsILoginManager"],
  [/^@mozilla\.org\/widget\/clipboard(helper)?;1$/, "clipboard", "clipboard"],
  [/^resource:\/\/gre\/modules\/ctypes/, "native-code", "js-ctypes"],
  [/^@mozilla\.org\/network\/server-socket;1$/, "own-server", "nsIServerSocket"],
  // Gecko's httpd.js, also the Remote Agent's copy (`chrome://remote/content/server/httpd.sys.mjs`).
  [
    /^(?:resource:\/\/(?:testing-common|gre\/modules)|chrome:\/\/remote\/content\/server)\/httpd(\.sys\.mjs|\.js)$/,
    "own-server",
    "httpd.js",
  ],
  // Firefox's remote debugging server: a debugger that connects can run any code in Zotero
  // (mcp-server-zotero-dev opens one on port 6100 for AI coding tools).
  [/^devtools\/shared\/security\/socket$/, "own-server", "debugging server"],
  [/^devtools\/shared\/security\/socket$/, "runs-sent-code", "debugger clients"],
];

const ZOTERO_TABLES = new Set(
  "items itemData itemDataValues itemCreators creators collections collectionItems tags itemTags itemAttachments itemNotes itemAnnotations libraries groups settings syncedSettings fields itemTypes itemTypeFields creatorTypes relations itemRelations collectionRelations deletedItems deletedCollections deletedSearches savedSearches savedSearchConditions feeds feedItems users version storageDeleteLog syncDeleteLog syncCache syncQueue retractedItems publicationsItems proxies proxyHosts fulltextItems fulltextWords fulltextItemWords charsets fileTypes fileTypeMimeTypes translatorCache dbDebug1"
    .split(" ")
    .map((t) => t.toLowerCase()),
);
// Leading comments, `IF NOT EXISTS`, a `main.`/`temp.` schema and a computed name (the EXPR
// marker) are all allowed before the table name, so `CREATE TABLE IF NOT EXISTS ${t}` never
// records the table as "IF".
const SQL_WRITE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: \u0000 is the EXPR marker
  /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+(?:(?:TEMP|TEMPORARY|UNIQUE|VIRTUAL)\s+)*(?:TABLE|INDEX|TRIGGER|VIEW)|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW))\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?!IF\s)(?:["`[]?(?:main|temp)["`\]]?\.)?["`[]?(\w+|\u0000)/i;
/** Table name recorded when the SQL builds it at runtime. */
const COMPUTED_TABLE = "(computed)";

// ----------------------------------------------------------------------------------------------
// Collection state for one plugin

/** A class in the build, by the names code outside it can use. */
interface ToolkitClass {
  names: string[];
  /** What it extends, with one alias followed (`var Ku = p4`). */
  supers: string[];
  /** Throws "Prompt is not initialized." when getInstance() has no prompt: PromptManager. */
  promptManager: boolean;
  /** Calls getInstance() for its `debug` option: BasicTool. */
  basicTool: boolean;
  /** Classes built inside it: ZoteroToolkit builds a PromptManager as its `Prompt`. */
  builds: string[];
}

/**
 * zotero-plugin-toolkit registers its zotero:// bridges, zotero://plugin (installs any add-on from
 * the link) and zotero://ztoolkit-debug (runs code from it), the first time
 * ToolkitGlobal.getInstance() runs. Up to 4.1.0 BasicTool's constructor calls it, so any toolkit
 * object does; from 4.1.1 only the `basicOptions.debug` getter, PromptManager's constructor
 * (ZoteroToolkit builds one as its `Prompt`) and the debug link's own handler do. A build that
 * bundles the toolkit but never gets there has no bridge (zotero-addons' toolkit has no Prompt).
 */
class ToolkitSetup {
  /** The bridges found, counted once the whole build is read. */
  bridges: {
    id: "link-runs-code" | "link-installs-addons";
    hit: Hit;
    name: string;
    asks: boolean;
  }[] = [];
  /** Where BasicTool calls getInstance(): in its constructor (up to 4.1.0) or its `debug` getter. */
  eager = false;
  lazy = false;
  /** The plugin reads `basicOptions.debug` or calls ToolkitGlobal.getInstance() itself. */
  called = false;
  classes: ToolkitClass[] = [];
  /** `new X(…)`: the names X may stand for, and the names of the classes the call sits in. */
  news: { names: string[]; inside: string[] }[] = [];
  /** `disableDebugBridgePassword = true`: the shared debug bridge stops asking. */
  promptOff: Hit | null = null;

  /** Whether the build reaches ToolkitGlobal.getInstance(), which registers the bridges. */
  registers(): boolean {
    if (this.called) return true;
    // A class and everything that extends it (`class MyToolkit extends ZoteroToolkit`).
    const withSubclasses = (names: string[]) => {
      const set = new Set(names);
      for (let grew = true; grew; ) {
        grew = false;
        for (const c of this.classes)
          if (
            c.names.length &&
            !c.names.some((n) => set.has(n)) &&
            c.supers.some((s) => set.has(s))
          ) {
            for (const n of c.names) set.add(n);
            grew = true;
          }
      }
      return set;
    };
    const managers = this.classes.filter((c) => c.promptManager).flatMap((c) => c.names);
    const prompting = withSubclasses([
      ...managers,
      ...this.classes
        .filter((c) => c.builds.some((b) => managers.includes(b)))
        .flatMap((c) => c.names),
    ]);
    const tools = this.eager
      ? withSubclasses(this.classes.filter((c) => c.basicTool).flatMap((c) => c.names))
      : new Set<string>();
    // Built from outside those classes: ZoteroToolkit's own `new PromptManager(this)` runs only
    // when something builds a ZoteroToolkit.
    const built = (set: Set<string>) =>
      this.news.some((k) => k.names.some((n) => set.has(n)) && !k.inside.some((n) => set.has(n)));
    return built(prompting) || built(tools);
  }
}

type InstallRoute = NonNullable<
  NonNullable<AnalysisDoc["capabilities"][number]["details"]>["installs"]
>[number];

/** An add-on install call in the plugin's own code. */
interface InstallSite {
  hit: Hit;
  /** getInstallForFile / installTemporaryAddon: a file on this computer. */
  local: boolean;
  /** The address written into the code; hidden when it was base64 behind an atob alias. */
  fixed: string | null;
  hidden: boolean;
  /** A fixed folder whose file name it reads off that folder's web page (zotero-gpt's Garden). */
  page: boolean;
  /** `{ hash: … }` handed to the install, as Zotero's own updater does. */
  hash: boolean;
  /**
   * The named function it runs in and that function's code (file offsets), or the callback it
   * sits in; `context`: the nearest named function around it, whatever calls it, to read what
   * the code is about (tara restores a backup in a `getAddonByID` callback).
   */
  fn: string | null;
  span: [number, number];
  context: [number, number];
  /** In a click handler on a control whose name isn't about installing (`#api-store`). */
  offTopicClick: boolean;
  /** The object of helpers it's a method of, by the name it's held in, and that object's code. */
  holder: { name: string; span: [number, number] } | null;
}

type SettingsEntry = NonNullable<
  NonNullable<AnalysisDoc["capabilities"][number]["details"]>["settings"]
>[number];
type SettingsChange = SettingsEntry["change"];

/** A change to a setting that isn't the plugin's own, in its own code (C33). */
interface SettingsSite {
  hit: Hit;
  change: SettingsChange;
  target?: string;
  /** The value follows a checkbox, or the code changes it back: a switch the user flips. */
  optIn?: boolean;
  /** Zotero's code or configuration changed in memory: gone when the plugin is. */
  whileInstalled?: boolean;
  /** The preference it writes, to find the same key written back when Zotero closes. */
  key?: string;
  /** Another program's file named here: it counts when the code on the way writes a file. */
  file?: boolean;
  /** …and the text naming it (`".zshrc"`, `"settings.json"`), each one in this function. */
  paths?: string[];
  /** A setting an early return above it waits for, in its own function. */
  guard?: Setting | null;
  /** Where the text naming it goes, when a function returns it: shown text doesn't count. */
  ctx?: TextContext;
  /** A command or a script: it changes something only if the plugin runs programs. */
  command?: boolean;
  fn: string | null;
  span: [number, number];
  holder: { name: string; span: [number, number] } | null;
}

/** A call from one of its named functions to another. */
interface CallEdge {
  caller: string;
  file: SourceFile;
  /** The caller's code, and where the call sits in it (file offsets). */
  span: [number, number];
  at: number;
  /** A setting the call waits for: `if (getPref("autoUpdate")) update()`. */
  setting: Setting | null;
  /** The MCP tool whose `case "name":` the call sits in, and where that case starts. */
  tool?: { name: string; at: number };
}

/**
 * A request's address, where it was found: `plain` over http:// or ws:// to a host that isn't on
 * this computer or its network, `sends` what the request carries of the user's (empty: nothing we
 * could see; absent: not traced to a request call), `fallback` an entry after https ones in a list
 * of servers tried in turn.
 */
type HostHit = Hit & { usage: Usage; plain?: boolean; sends?: Sent[]; fallback?: boolean };
type UnencryptedEntry = NonNullable<
  NonNullable<AnalysisDoc["capabilities"][number]["details"]>["unencrypted"]
>[number];

class Collector {
  hosts = new Map<string, { port?: number; cls: HostClass; hits: HostHit[] }>();
  apis = new Map<NetworkApi, Hit[]>();
  dynamicUrls = new Map<string, Hit[]>();
  endpoints = new Map<string, { defaultValue?: string; hits: Hit[] }>();
  caps = new Map<
    CapabilityId,
    {
      hits: Hit[];
      apis: Set<string>;
      sql: Set<string>;
      tables: Set<string>;
      endpoints: Set<string>;
      prefKeys: Set<string>;
      /** Where a downloaded program comes from (`astral.sh`), and the programs it launches. */
      sources?: Set<string>;
      programs?: Set<string>;
      fsScope?: string;
      /** Link handlers: one asks first, one doesn't. */
      asksFirst?: boolean;
      unguarded?: boolean;
      /** Package installs: how they're pinned, what they name, whether they run by themselves. */
      pinning?: Pin;
      packages?: string[];
      atStartup?: boolean;
      /** …and every unpinned one waits for an "already installed" check: it installs once. */
      once?: boolean;
      /** A browser's store copied into the profile of a browser it starts. */
      copiedToBrowser?: boolean;
      /** Code sent to it: whether each run is approved. */
      approval?: "each-run" | "code-switch" | "none";
      /** An endpoint on Zotero's server: which web pages can use it, and a setting it waits for. */
      web?: ServerPatch["origins"];
      setting?: string;
      /** Its own server: what any website can make it do (change the library, run code…). */
      serverActions?: Set<ServerAction>;
      /** …and every change to the library a website can make needs an existing item's key. */
      needsKey?: boolean;
      /** Add-on installs: where each file comes from and whether each install is asked. */
      installs?: InstallRoute[];
      /** Its update address: it turns Zotero's automatic updates on for itself at startup. */
      forcesAutoUpdate?: boolean;
      /** Settings that aren't its own: what each changes and whether it's asked. */
      settings?: SettingsEntry[];
      /** Data sent over plain http: to which host, what, and whether only as a fallback. */
      unencrypted?: UnencryptedEntry[];
    }
  >();
  signals: { kind: SignalKind; file: string; score?: number; hits: Hit[] }[] = [];
  /** Per-file counts behind the obfuscation thresholds, for calibration (not stored). */
  metrics: FileMetrics[] = [];
  unicode = new Map<UnicodeKind, { codepoints: Set<string>; hits: Hit[]; count: number }>();
  vendored = new Map<string, { files: Set<string>; by: LibraryEvidence }>();
  minified = new Set<string>();
  sourceMaps = new Set<string>();
  parseFailures: { path: string; error: string }[] = [];
  /** Bytes of code we couldn't parse, per file (an HTML file can have several failing scripts). */
  failedBytes = new Map<string, number>();
  skipped: { path: string; reason: "binary" | "too-large" | "not-code" | "unsupported-type" }[] =
    [];
  analyzed = 0;
  codeBytes = 0;
  /** The plugin opens a database of its own (a Zotero.DBConnection other than 'zotero'). */
  ownDbConnection = false;
  /** Writes through a receiver other than `Zotero.DB`, resolved once we know about ownDbConnection. */
  otherDbWrites: { hit: Hit; verb: string; table: string }[] = [];
  endpointNames = new Set<string>();
  /** Downloads to a file in the plugin's own code, and whether it makes files executable. */
  downloads: Hit[] = [];
  /** Shell commands that fetch and run a program: `curl … | sh`, `irm … | iex`. */
  /** `pinned`: a shipped script checks the download against a SHA-256 written into it. */
  shellDownloads: (Hit & { pinned?: boolean })[] = [];
  translatorInstalls: Hit[] = [];
  corsHits: Hit[] = [];
  /** Own code handed to eval / new Function / AsyncFunction: the names in that argument. */
  dynamicArgs: { hit: Hit; names: string[] }[] = [];
  scriptDownloads: Hit[] = [];
  /** Own code names a translator file on the web (`…/translators/Foo.js`). */
  translatorUrls = 0;
  /** AI command-line tools the code names as a program to run, and package-manager commands. */
  cliNamed = new Map<string, Hit>();
  /**
   * Programs and companions that pass data on to an online service, by program: `launch` ones
   * count when the plugin launches programs itself, `local` ones (a server on this computer, a
   * browser extension it serves files to) whenever they're found.
   */
  handoffs = new Map<string, { h: Handoff; hit: Hit; via: "launch" | "local" }>();
  packageRuns: PackageRun[] = [];
  /**
   * Constants that can name a package, its version or an argument list, by the name they're
   * bound to, across files: argument lists often take them from another file.
   */
  specValues = new Map<string, string[]>();
  specArrays = new Map<string, string[]>();
  /** Requirements files and Python projects (pyproject.toml) it ships, by path, and a lockfile. */
  reqFiles = new Map<string, string>();
  pyprojects = new Map<string, string>();
  lockFile = false;
  /** Functions defined per name, and who calls each name: to tell what runs at startup. */
  fnDefs = new Map<string, number>();
  calledFrom = new Map<string, Set<string>>();
  /** Approval settings for AI coding agents it launches (Claude Code's `--permission-mode`…). */
  agentModes: AgentMode[] = [];
  /** A launch passes `--permission-mode` on from a setting. */
  agentModeSetting = false;
  /** Its own code reads a model's tool calls: it runs an AI assistant itself. */
  aiLoop = false;
  /** Shell tools defined for an AI model (`name: "run_command"`). */
  shellTools: Hit[] = [];
  installTargets: { hit: Hit; url: string | null }[] = [];
  /** Add-on install calls in its own code, and their routes once every file is read. */
  installSites: InstallSite[] = [];
  /**
   * Its own named functions (their code), the calls between them, and functions handed to a
   * timer: to follow an install back to what starts it (a click, startup, a link, a message).
   */
  fnSpans = new Map<string, { file: SourceFile; span: [number, number] }[]>();
  callEdges = new Map<string, CallEdge[]>();
  edgeCount = 0;
  timerFns = new Set<string>();
  /** Functions Zotero calls when items change: a Notifier observer's `notify`, by file. */
  eventFns = new Set<string>();
  /** Functions handed to Zotero as a hook under its name: `{ onStartup: S7 }` (minified). */
  hookNames = new Map<string, string>();
  /** Its own zotero:// handlers (not the toolkit's bridges). */
  linkSpans: { file: SourceFile; span: [number, number] }[] = [];
  /** A zotero:// handler that changes where it installs add-ons from, without asking. */
  linkSource: Hit | null = null;
  /** Where it turns Zotero's automatic updates on for an add-on, and the function doing it. */
  autoUpdateSets: { hit: Hit; fn: string | null }[] = [];
  /** Changes to settings that aren't its own, and prefs.js defaults for Zotero's (C33). */
  settingsSites: SettingsSite[] = [];
  settingsDefaults: { hit: Hit; change: SettingsChange }[] = [];
  /** Shell scripts it ships, by file name, and the settings changes each makes. */
  scripts = new Map<string, { change: SettingsChange; target?: string }[]>();
  /** Wrappers of Zotero.Server.init that make Zotero's server listen on every interface. */
  serverInitWraps: Hit[] = [];
  /**
   * A server socket's loopbackOnly argument read from a setting: the names it goes by (the value
   * `!remoteAllowed`, then `this.allowRemote()`), a key read there, and how often it's negated.
   */
  listenSettings: { names: string[]; key: string | null; negated: boolean }[] = [];
  /** Endpoints on Zotero's own server, and patches to its request handling that add CORS. */
  serverEndpoints: ServerEndpoint[] = [];
  serverPatches: ServerPatch[] = [];
  /** Servers it opens itself, and servers in the Python programs it ships (read once it runs them). */
  ownServers: OwnServer[] = [];
  pyServers: Hit[] = [];
  /**
   * Functions that register what they're passed as an endpoint (`registerEndpoint(path, h)`), and
   * calls to such names, matched once every file is read: the helper can sit in another file.
   */
  endpointHelpers = new Map<string, { decl: EndpointDecl; code: EndpointCode }>();
  helperCalls: { name: string; ep: ServerEndpoint }[] = [];
  /** Settings defaults from prefs.js, for endpoints that wait for a setting. */
  prefDefaults = new Map<string, string>();
  /** The build makes random values somewhere, which a token it checks can come from. */
  makesSecrets = false;
  /** An endpoint on Zotero's server answers web pages with items' keys, or may (rateServer). */
  pagesSeeKeys = false;
  /** Named functions that write to the library (in files small enough to read that way). */
  libraryWriters = new Map<string, Hit>();
  /** …and named functions that find or make items without a key (findsWithoutKey). */
  unkeyedFns = new Set<string>();
  /** Addresses named functions return, and requests whose address is such a function's result. */
  returnedUrls = new Map<string, string[]>();
  /** Addresses its own code binds to a name (`this.popplerExtractorBaseURL = "http://…"`). */
  namedUrls = new Map<string, string[]>();
  urlCalls: { hit: Hit; fn: string; sends?: () => Sent[] }[] = [];
  scriptCalls: { hit: Hit; fn: string; kind: string }[] = [];
  pySqlite: Hit[] = [];
  pyNamesZoteroDb = false;
  returned(fn: string, urls: string[], _at: Hit) {
    const list = this.returnedUrls.get(fn) ?? [];
    for (const u of urls) if (list.length < 10 && !list.includes(u)) list.push(u);
    this.returnedUrls.set(fn, list);
  }
  /**
   * Whole command lines (`curl … | sh`, `npm i -g …`): only a shell can run one, so they count
   * when the plugin starts a shell with a command (`sh -c`, `cmd /c`, `powershell -Command`).
   */
  commandLines: { hit: PackageRun; kind: "download" | "package"; ctx: TextContext }[] = [];
  shellFlag = false;
  /** Where each named function's result goes: shown, returned from another function, or used. */
  callSites = new Map<string, TextContext[]>();
  /**
   * Package tools named where a command goes (`command: "uv"`), by file, and argument lists: `run`
   * when it's held where a launch takes its arguments (`args: […]`, `const runArgs = […]`, a call).
   */
  packageTools = new Map<string, Set<SourceFile>>();
  argLists: { text: string; words: string[]; hit: Hit; fn: string | null; run: boolean }[] = [];
  /**
   * URLs in shipped scripts in other languages (Python…) that make requests. `compare`: on a line
   * that tests an address rather than sends to it (`startswith("http://…")`); `named`: in Python,
   * an address no request call reaches (an identifier, a link).
   */
  scriptUrls: { url: string; hit: Hit; compare?: boolean; named?: boolean }[] = [];
  /** Compiled programs in the package (PE, ELF, Mach-O), by base name, and those the code names. */
  binaries = new Map<string, string>();
  /** Programs a launch's command resolves to, through names, callers and helpers. */
  launchCommands: { name: string; hit: Hit }[] = [];
  binaryNamed = new Map<string, Hit>();
  /** Packaged files that look encrypted or packed, by base name. */
  opaque = new Map<string, string>();
  /** Opaque files the plugin's own code names, decrypt calls, and whether it builds code. */
  opaqueNamed = new Set<string>();
  decrypts: Hit[] = [];
  buildsCode = false;
  makesExecutable = false;
  /** Files that encrypt to an RSA public key they carry (JWE), like zotero-plugin's log sender. */
  jweFiles = new Set<string>();
  /** Unpacks an archive: `unzipSync(bytes)`, nsIZipReader, `/usr/bin/unzip`, `tar -x`. */
  extractsArchive = false;
  /** Own network calls whose response is written out as bytes, and program addresses named. */
  byteSaves: Hit[] = [];
  programUrls: Hit[] = [];
  toolkit = new ToolkitSetup();

  constructor(
    readonly table: HostTable,
    readonly developer: DeveloperHints,
  ) {}

  cap(id: CapabilityId, hit: Hit, api?: string) {
    let c = this.caps.get(id);
    if (!c) {
      c = {
        hits: [],
        apis: new Set(),
        sql: new Set(),
        tables: new Set(),
        endpoints: new Set(),
        prefKeys: new Set(),
      };
      this.caps.set(id, c);
    }
    c.hits.push(hit);
    if (api) c.apis.add(api);
    return c;
  }

  api(api: NetworkApi, hit: Hit) {
    this.apis.set(api, [...(this.apis.get(api) ?? []), hit]);
  }

  handoff(h: Handoff, hit: Hit, via: "launch" | "local") {
    const seen = this.handoffs.get(h.program);
    if (!seen || (via === "local" && seen.via === "launch"))
      this.handoffs.set(h.program, { h, hit, via });
  }

  url(
    url: string,
    hit: Hit,
    usage: Usage,
    req?: { sends?: Sent[]; fallback?: boolean; loose?: boolean },
  ) {
    // CSL style IDs (`http://www.zotero.org/styles/apa`) are identifiers, not addresses.
    if (/^https?:\/\/(www\.)?zotero\.org\/styles\//i.test(url)) return;
    // Zotero's object URIs (`http://zotero.org/users/123/items/ABC`) name items, not servers.
    if (/^https?:\/\/(www\.)?zotero\.org\/(users|groups)\//i.test(url)) return;
    const h = hostOf(url);
    if (!h) return;
    const found = classifyHost(this.table, h.host);
    if (!found) return;
    const cls: HostClass =
      found.category === "unknown" &&
      !found.flags.includes("ip-literal") &&
      isDeveloperHost(h.host, this.developer)
        ? { category: "developer-server", provider: "Plugin developer (name match)", flags: [] }
        : found;
    // A webhook with an account or token of its own, written into the code (not a setting's
    // default): data goes into whoever's account that is (zotero-mdnotes--edd-gao's flomo hook).
    const fixed =
      WEBHOOK_ACCOUNT.test(url) && !/(^|\/)prefs\.js$|defaults\/preferences\//.test(hit.file.path);
    const key = h.host.toLowerCase();
    const entry = this.hosts.get(key) ?? { cls, hits: [], ...(h.port ? { port: h.port } : {}) };
    if (fixed && !entry.cls.flags.includes("fixed-account"))
      entry.cls = { ...entry.cls, flags: [...entry.cls.flags, "fixed-account"] };
    // Plain http:// to a host beyond this computer and its network: anyone on the way can read it.
    const plain = /^(http|ws):\/\//i.test(url) && cls.category !== "localhost" && !req?.loose;
    // What goes to a catalogue or scholarly service is a lookup of a public work (a search, a
    // title, a record number), no more revealing than an identifier; elsewhere search terms are
    // the user's text (a question to an AI service).
    const lookup = cls.category === "scholarly-api";
    const sends = req?.sends?.map(
      (s): Sent =>
        s === "search" || (lookup && s === "content") ? (lookup ? "identifiers" : "content") : s,
    );
    entry.hits.push({
      ...hit,
      usage,
      ...(plain ? { plain } : {}),
      ...(plain && sends ? { sends: [...new Set(sends)] } : {}),
      ...(plain && req?.fallback ? { fallback: true } : {}),
    });
    this.hosts.set(key, entry);
  }
}

// ----------------------------------------------------------------------------------------------
// Per-file analysis

interface UrlLiteral {
  offset: number;
  urls: string[];
  usage: Usage;
  binding: string | null;
  /** A variable (`const url = …`) or an object property (`{ url: … }`, `this.baseUrl = …`). */
  bindingKind?: "var" | "prop";
  /** The function the literal sits in (null at module level), to match variables by scope. */
  scope?: AstNode | null;
  /** Entry `index` of the array literal bound to `array` (`const $Q = [{ api: "…" }, …]`). */
  array?: string;
  index?: number;
  /** The request call it's the address of, written in place. */
  call?: ReqCall;
  /** A list of servers tried in turn: an entry after https ones, and the same path on each host. */
  fallback?: boolean;
  mirror?: boolean;
}

/** A request call, or a helper's call site handing one its address, whose payload we read. */
interface ReqCall {
  n: AstNode;
  /** The address argument. */
  url: AstNode | undefined;
  fns: AstNode[];
  /** A helper's call site: the helper (`fn`) and the request inside it (`inner`). */
  inner?: ReqCall;
  fn?: AstNode;
}

/**
 * An address in a list of servers tried in turn (zotero-reference's activation endpoints): the
 * same path on two or more hosts (`mirror`), and whether https entries come before it
 * (`fallback`: it's used only when those can't be reached).
 */
function serverList(anc: AstNode[]): { fallback?: boolean; mirror?: boolean } {
  const list = anc.at(-2);
  if (list?.type !== "ArrayExpression") return {};
  const els = nodes(list.elements);
  const texts = els.map((e) => textOf(e));
  const parts = texts.map((t) => t?.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?/i));
  if (els.length < 2 || parts.some((p) => !p)) return {};
  const at = els.indexOf(anc.at(-1) as AstNode);
  const hosts = new Set(parts.map((p) => p?.[2]));
  const mirror = hosts.size === parts.length && new Set(parts.map((p) => p?.[3] ?? "")).size === 1;
  const before = parts.slice(0, at);
  const fallback =
    parts[at]?.[1]?.toLowerCase() === "http" &&
    before.length > 0 &&
    before.every((p) => p?.[1]?.toLowerCase() === "https");
  return { ...(mirror ? { mirror } : {}), ...(fallback ? { fallback } : {}) };
}

/** Which entry of which named array literal a node sits in. */
function arrayEntry(anc: AstNode[]): { array?: string; index?: number } {
  for (let i = anc.length - 2; i >= 1; i--) {
    const a = anc[i] as AstNode;
    if (FUNCTION_TYPES.has(a.type)) return {};
    if (a.type !== "ArrayExpression") continue;
    const decl = anc[i - 1];
    if (decl?.type !== "VariableDeclarator" || node(decl.id)?.type !== "Identifier") return {};
    const index = nodes(a.elements).indexOf(anc[i + 1] as AstNode);
    return index >= 0 ? { array: node(decl.id)?.name as string, index } : {};
  }
  return {};
}

/**
 * What each name is assigned in one file, for one-hop resolution. A variable binding remembers
 * the function it was assigned in, and a lookup from inside a function sees the nearest enclosing
 * function's bindings before the module's (review P1: a file-wide lookup mixed up tables from
 * unrelated functions). Object properties (`this.db = …`, `{ sql: … }`) are file-wide.
 */
class Bindings {
  /**
   * Variables by name, then by the function they're bound in (null: module level). Capped per
   * scope, not per file: a minified bundle rebinds `t` thousands of times, and a file-wide cap
   * lost every binding after the first few dozen (zotero-gpt's link handler).
   */
  private vars = new Map<string, Map<AstNode | null, AstNode[]>>();
  /** Object properties by name, file-wide. */
  private props = new Map<string, AstNode[]>();
  /** Some values per name whatever the scope, for "is this ever fetch?" questions. */
  private any = new Map<string, AstNode[]>();
  /** `for (const sql of STATEMENTS)`: the loop variable and the name of the list. */
  readonly forOf = new Map<string, string>();
  /** Functions and methods that return Zotero.DB (`function getDB() { return Zotero.DB; }`). */
  readonly returnsZoteroDb = new Set<string>();
  /** What small helpers return: `function getApiBase() { return DEFAULT_API_BASE; }`. */
  readonly returns = new Map<string, { v: AstNode; fns: AstNode[] }[]>();

  /** A helper's return value, with the functions around the return for resolving names in it. */
  addReturn(name: string, v: AstNode | undefined, fns: AstNode[]) {
    if (!v) return;
    const list = this.returns.get(name) ?? [];
    if (list.length < 10) list.push({ v, fns });
    this.returns.set(name, list);
  }

  add(name: string | null | undefined, v: AstNode | undefined, fn: AstNode | null, prop = false) {
    if (!name || !v) return;
    if (prop) {
      const list = this.props.get(name) ?? [];
      if (list.length < 50) list.push(v);
      this.props.set(name, list);
    } else {
      let scopes = this.vars.get(name);
      if (!scopes) {
        scopes = new Map();
        this.vars.set(name, scopes);
      }
      const list = scopes.get(fn) ?? [];
      if (list.length < 20) list.push(v);
      scopes.set(fn, list);
    }
    const any = this.any.get(name) ?? [];
    if (any.length < 200) any.push(v);
    this.any.set(name, any);
  }

  /**
   * Values bound to a variable as seen from inside `fns` (enclosing functions, innermost first),
   * or to an object property of that name anywhere in the file. The two never mix: a
   * `{ url: "chrome://…" }` somewhere must not decide what a `url` parameter holds.
   */
  lookup(name: string, fns: AstNode[], kind: "var" | "prop" = "var"): AstNode[] {
    if (kind === "prop") return this.props.get(name) ?? [];
    const scopes = this.vars.get(name);
    if (!scopes) return [];
    for (const f of fns) {
      const inFn = scopes.get(f);
      if (inFn?.length) return inFn;
    }
    return scopes.get(null) ?? [];
  }

  /** Values bound to `name` anywhere in the file, whatever the scope. */
  all(name: string): AstNode[] {
    return this.any.get(name) ?? [];
  }

  /** Every text a string argument can have: literals, names bound to literals, `${NAME}` parts. */
  texts(a: AstNode | undefined, fns: AstNode[], depth = 0): string[] {
    if (!a || depth > 3) return [];
    const name =
      a.type === "Identifier"
        ? (a.name as string)
        : a.type === "MemberExpression" && !a.computed
          ? (node(a.property)?.name as string)
          : null;
    if (name) {
      const out: string[] = [];
      const bound = this.lookup(name, fns, a.type === "Identifier" ? "var" : "prop");
      for (const v of bound) {
        if (v.type === "ArrayExpression")
          for (const el of nodes(v.elements)) out.push(...this.texts(el, fns, depth + 1));
        else out.push(...this.texts(v, fns, depth + 1));
      }
      const list = this.forOf.get(name);
      if (!bound.length && list)
        out.push(...this.texts({ ...a, type: "Identifier", name: list }, fns, depth + 1));
      return out.slice(0, 40);
    }
    if (a.type === "TemplateLiteral") {
      const quasis = nodes(a.quasis).map(
        (q) =>
          (q.value as { cooked?: string; raw: string }).cooked ?? (q.value as { raw: string }).raw,
      );
      let acc = [quasis[0] ?? ""];
      nodes(a.expressions).forEach((e, i) => {
        const v =
          e.type === "Identifier" || (e.type === "MemberExpression" && !e.computed)
            ? this.texts(e, fns, depth + 1).slice(0, 2)
            : [];
        const pieces = v.length ? v : [EXPR];
        acc = acc.flatMap((x) => pieces.map((p) => x + p + (quasis[i + 1] ?? "")));
      });
      return acc.slice(0, 8);
    }
    if (a.type === "ConditionalExpression")
      return [
        ...this.texts(node(a.consequent), fns, depth + 1),
        ...this.texts(node(a.alternate), fns, depth + 1),
      ];
    // `ZOTERO_SCHEME + "://zoteroaddoncollection"`, `API_BASE + "/v1/chat"`
    if (a.type === "BinaryExpression" && a.operator === "+") {
      const l = this.texts(node(a.left), fns, depth + 1).slice(0, 4);
      const r = this.texts(node(a.right), fns, depth + 1).slice(0, 4);
      return (l.length ? l : [EXPR])
        .flatMap((x) => (r.length ? r : [EXPR]).map((y) => x + y))
        .slice(0, 8);
    }
    if (a.type === "CallExpression" && nodes(a.arguments).length === 0) {
      const fn = chain(node(a.callee))?.split(".").at(-1);
      const out: string[] = [];
      for (const r of (fn && this.returns.get(fn)) || [])
        out.push(...this.texts(r.v, r.fns, depth + 1));
      return out.slice(0, 8);
    }
    const t = textOf(a);
    return t === null ? [] : [t];
  }

  /**
   * A value known without running the code, or null: literals, `!x`, comparisons, `&&` and `||`
   * of those, and names bound only to one such value (`const env = "development"`,
   * `data: { env: "development" }`).
   */
  constant(a: AstNode | undefined, fns: AstNode[], depth = 0): { value: unknown } | null {
    if (!a || depth > 4) return null;
    switch (a.type) {
      case "Literal":
        return a.regex ? null : { value: a.value };
      case "TemplateLiteral":
        return nodes(a.expressions).length ? null : { value: textOf(a) };
      // Truthy whatever they hold: `!![]` is true.
      case "ArrayExpression":
      case "ObjectExpression":
        return { value: {} };
      case "UnaryExpression": {
        const v = a.operator === "!" ? this.constant(node(a.argument), fns, depth + 1) : null;
        return v && { value: !v.value };
      }
      case "BinaryExpression": {
        if (!/^[!=]==?$/.test(a.operator as string)) return null;
        const l = this.constant(node(a.left), fns, depth + 1);
        const r = l && this.constant(node(a.right), fns, depth + 1);
        if (!l || !r) return null;
        return { value: (l.value === r.value) === (a.operator as string).startsWith("=") };
      }
      case "LogicalExpression": {
        const l = this.constant(node(a.left), fns, depth + 1);
        if (!l || (a.operator !== "&&" && a.operator !== "||")) return null;
        return Boolean(l.value) === (a.operator === "&&")
          ? this.constant(node(a.right), fns, depth + 1)
          : l;
      }
      case "Identifier":
      case "MemberExpression": {
        const name = a.type === "Identifier" ? (a.name as string) : nameOf(a);
        const bound = name ? this.lookup(name, fns, a.type === "Identifier" ? "var" : "prop") : [];
        const values = bound.map((v) => this.constant(v, fns, depth + 1));
        const first = values[0];
        return first && values.every((v) => v && v.value === first.value) ? first : null;
      }
      default:
        return null;
    }
  }

  /**
   * Whose database a receiver is: Zotero's (`Zotero.DB`, `ports.db ?? this.zotero?.DB`, a
   * function returning Zotero.DB), the plugin's own (`new Zotero.DBConnection(…)` or an alias of
   * it), or unknown.
   */
  dbKind(receiver: AstNode | undefined, fns: AstNode[], depth = 0): "zotero" | "own" | "unknown" {
    if (!receiver || depth > 3) return "unknown";
    const r = receiver.type === "ChainExpression" ? node(receiver.expression) : receiver;
    if (!r) return "unknown";
    const c = chain(r);
    if (c && /(^|\.)zotero\.DB$/i.test(c)) return "zotero";
    if (r.type === "AwaitExpression") return this.dbKind(node(r.argument), fns, depth + 1);
    if (r.type === "LogicalExpression" || r.type === "ConditionalExpression") {
      const kinds = [node(r.left), node(r.right), node(r.consequent), node(r.alternate)]
        .filter((x): x is AstNode => x !== undefined)
        .map((x) => this.dbKind(x, fns, depth + 1));
      return kinds.includes("zotero") ? "zotero" : kinds.includes("own") ? "own" : "unknown";
    }
    if (r.type === "NewExpression") {
      const ctor = chain(node(r.callee));
      if (ctor === "Zotero.DBConnection") return "own";
      if (ctor && !ctor.includes(".")) {
        const alias = this.lookup(ctor, fns).map((v) => chain(v));
        if (alias.includes("Zotero.DBConnection")) return "own";
      }
      return "unknown";
    }
    if (r.type === "CallExpression") {
      const fn = chain(node(r.callee))?.split(".").at(-1);
      return fn && this.returnsZoteroDb.has(fn) ? "zotero" : "unknown";
    }
    const name =
      r.type === "Identifier"
        ? (r.name as string)
        : r.type === "MemberExpression" && !r.computed
          ? (node(r.property)?.name as string)
          : null;
    if (!name) return "unknown";
    const kinds = this.lookup(name, fns, r.type === "Identifier" ? "var" : "prop").map((v) =>
      this.dbKind(v, fns, depth + 1),
    );
    return kinds.includes("zotero") ? "zotero" : kinds.includes("own") ? "own" : "unknown";
  }
}

const fnsIn = (anc: AstNode[]) => anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse();
const classesIn = (anc: AstNode[]) =>
  anc.filter((a) => a.type === "ClassDeclaration" || a.type === "ClassExpression");

/** What ToolkitSetup needs from one file: gathered during the walk, resolved after it. */
class ToolkitFile {
  private classes = new Map<AstNode, ToolkitClass & { fns: AstNode[]; global: boolean }>();
  private news: { name: string; fns: AstNode[]; inside: AstNode[] }[] = [];
  private calls: { receiver: string; fns: AstNode[]; inside: AstNode[]; at: number }[] = [];
  private promptWrites: { value: AstNode; fns: AstNode[]; at: number }[] = [];

  constructor(private readonly tk: ToolkitSetup) {}

  visit(n: AstNode, anc: AstNode[]) {
    switch (n.type) {
      case "ClassDeclaration":
      case "ClassExpression":
        this.facts(n, anc);
        break;
      case "NewExpression": {
        const name = lastName(node(n.callee));
        if (!name) break;
        const inside = classesIn(anc);
        this.news.push({ name, fns: fnsIn(anc), inside });
        const cls = inside.at(-1);
        if (cls) this.facts(cls, anc).builds.push(name);
        break;
      }
      case "CallExpression": {
        const callee = node(n.callee);
        const last = callee?.type === "Identifier" ? callee.name : nameOf(callee);
        if (!/^(getInstance|assign|values|entries|stringify|structuredClone)$/.test(`${last}`))
          break;
        const c = chain(callee)?.split(".") ?? [];
        const args = nodes(n.arguments);
        // Copying or serialising the options runs the getter too.
        if (
          /^(Object\.(assign|values|entries)|JSON\.stringify|structuredClone)$/.test(c.join(".")) &&
          args.some((x) => nameOf(x) === "basicOptions")
        )
          this.tk.called = true;
        if (c.at(-1) !== "getInstance" || c.length < 2 || args.length) break;
        // BasicTool's own call: `debug: G.getInstance()?.debugBridge` in its constructor up to
        // 4.1.0, `get debug() { … G.getInstance() … }` from 4.1.1.
        let crossed = false;
        for (let i = anc.length - 2; i >= 0; i--) {
          const a = anc[i] as AstNode;
          if (a.type === "Property") {
            if (nameOf(a) !== "debug" || (a.kind !== "get" && crossed)) break;
            if (a.kind === "get") this.tk.lazy = true;
            else this.tk.eager = true;
            const cls = classesIn(anc).at(-1);
            if (cls) this.facts(cls, anc).basicTool = true;
            return;
          }
          if (FUNCTION_TYPES.has(a.type)) crossed = true;
        }
        const receiver = c.at(-2) as string;
        this.calls.push({ receiver, fns: fnsIn(anc), inside: classesIn(anc), at: n.start });
        break;
      }
      case "Literal": {
        const mark =
          n.value === "Prompt is not initialized."
            ? "promptManager"
            : n.value === "_toolkitGlobal"
              ? "global"
              : null;
        const cls = mark && classesIn(anc).at(-1);
        if (mark && cls) this.facts(cls, anc)[mark] = true;
        break;
      }
      case "MemberExpression": {
        const name = nameOf(n);
        const obj = node(n.object);
        const up = anc.at(-2);
        if (name === "_toolkitGlobal") {
          const cls = classesIn(anc).at(-1);
          if (cls) this.facts(cls, anc).global = true;
        } else if (
          name === "debug" &&
          (obj?.type === "Identifier" ? obj.name : nameOf(obj)) === "basicOptions" &&
          // Reading the option runs its getter; assigning to it doesn't.
          !(up?.type === "AssignmentExpression" && node(up.left) === n)
        )
          this.tk.called = true;
        break;
      }
      case "SpreadElement":
        if (nameOf(node(n.argument)) === "basicOptions") this.tk.called = true;
        break;
      case "AssignmentExpression":
        if (n.operator === "=" && nameOf(node(n.left)) === "disableDebugBridgePassword")
          this.promptWrites.push({ value: node(n.right) as AstNode, fns: fnsIn(anc), at: n.start });
        break;
    }
  }

  /** A class's facts, named by what holds it: `var X = class …`, `X = class …`, `class X`. */
  private facts(cls: AstNode, anc: AstNode[]) {
    const known = this.classes.get(cls);
    if (known) return known;
    const at = anc.indexOf(cls);
    const parent = anc[at - 1];
    // A class expression's own name is visible only inside it.
    const outer =
      parent?.type === "VariableDeclarator"
        ? lastName(node(parent.id))
        : parent?.type === "AssignmentExpression"
          ? lastName(node(parent.left))
          : parent?.type === "Property" || parent?.type === "PropertyDefinition"
            ? nameOf(parent)
            : null;
    const id = cls.type === "ClassDeclaration" ? lastName(node(cls.id)) : null;
    const sup = lastName(node(cls.superClass));
    const f: ToolkitClass & { fns: AstNode[]; global: boolean } = {
      names: [...new Set([id, outer].filter((x): x is string => !!x))],
      supers: sup ? [sup] : [],
      promptManager: false,
      basicTool: false,
      builds: [],
      fns: fnsIn(anc.slice(0, at)),
      global: false,
    };
    this.classes.set(cls, f);
    return f;
  }

  /**
   * Hands the file's facts to the build's, names followed through one alias (`Ku = p4`, or a
   * CommonJS export `exports.BasicTool = Ze`). The toolkit's own getInstance() calls sit in
   * PromptManager, ToolkitGlobal and the debug link's handler (`handlers`); any other is the
   * plugin setting the toolkit up.
   */
  finish(bindings: Bindings, handlers: [number, number][], hit: (at: number) => Hit) {
    const aliases = (name: string, fns: AstNode[]) => [
      name,
      ...[...bindings.lookup(name, fns), ...bindings.lookup(name, fns, "prop")]
        .filter((v) => v.type === "Identifier")
        .map((v) => v.name as string),
    ];
    const namesOf = (inside: AstNode[]) => inside.flatMap((c) => this.classes.get(c)?.names ?? []);
    for (const f of this.classes.values())
      this.tk.classes.push({
        names: f.names,
        supers: f.supers.flatMap((s) => aliases(s, f.fns)),
        promptManager: f.promptManager,
        basicTool: f.basicTool,
        builds: f.builds,
      });
    const seen = new Set<string>();
    for (const k of this.news) {
      const entry = { names: aliases(k.name, k.fns), inside: namesOf(k.inside) };
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      this.tk.news.push(entry);
    }
    const globals = new Set(
      [...this.classes.values()].filter((f) => f.global).flatMap((f) => f.names),
    );
    for (const c of this.calls) {
      if (handlers.some(([a, b]) => c.at >= a && c.at <= b)) continue;
      const own = c.inside.some((x) => {
        const f = this.classes.get(x);
        return f?.promptManager || f?.global;
      });
      if (!own && aliases(c.receiver, c.fns).some((r) => globals.has(r))) this.tk.called = true;
    }
    for (const w of this.promptWrites)
      if (bindings.constant(w.value, w.fns)?.value) this.tk.promptOff ??= hit(w.at);
  }
}

// ----------------------------------------------------------------------------------------------
// Endpoints on Zotero's own server (port 23119)

/**
 * Writes to the library: saving, erasing or trashing items, collections and notes, adding files,
 * renaming or merging, and SQL writes to Zotero's tables.
 */
const LIBRARY_WRITE =
  /\.(saveTx|eraseTx|trashTx|addToCollection|removeFromCollection)\s*\(|\bZotero\.(?:Items\.(?:trash|trashTx|erase|merge|moveChildItems)|Collections\.erase|Attachments\.(?:import|link)\w*|Tags\.(?:rename|removeFromLibrary)|Annotations\.saveFromJSON|DB\.executeTransaction)\s*\(|\bDB\.queryAsync\s*\(\s*["'`]\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b|\.translate\(\s*\{[^}]*\blibraryID\b(?!\s*:\s*false)/;
/** Library content handed out: notes, annotations, full text, files, exports, citations. */
const LIBRARY_READ =
  /\.(?:getNote|getAnnotations|getFilePathAsync)\s*\(|\.attachmentText\b|\bZotero\.(?:Fulltext|Cite|QuickCopy)\.|\bZotero\.Items\.getAll\s*\(|\bitemToCSLJSON\s*\(|\bnew\s+Zotero\.(?:Search|Translate\.Export)\s*\(/;
/** An item (or collection) looked up by its key, the 8-character ID Zotero makes up for it. */
const KEY_LOOKUP = /\bgetByLibraryAndKey(?:Async)?\s*\(|\bgetIDFromLibraryAndKey\s*\(/;
/**
 * Items found or changed without a key: the selected items or the open reader's, a search or a
 * whole library's items, a new collection, a translation (it saves new items), a change to a tag
 * across the library, or an SQL statement.
 */
const UNKEYED =
  /\bgetSelected\w*\s*\(|\.selectedItems?\b|\bZotero\.Reader\.(?:getByTabID|_readers)\b|\bnew\s+Zotero\.(?:Search|Collection)\b|\bZotero\.(?:Items|Collections|Searches)\.(?:getAll\w*|getByLibrary)\s*\(|\.translate\s*\(|\bZotero\.Tags\.(?:rename|removeFromLibrary)\s*\(|\bDB\.(?:executeTransaction|\w*[qQ]uery\w*)\s*\(/;
/**
 * An item's number taken from an item already found (`note.getAttachments()`, `parent.id`,
 * `note.parentItemID`, not a request's `data.parentItemID`), or looked up by key.
 */
const FROM_ITEM =
  /\.get(?:Attachments|Notes|ChildItems|Annotations|Children)\s*\(|\b\w*(?:item|note|parent|attachment|child|annotation)\w*\.(?:id|parentItemID|parentID)\b|\bgetIDFromLibraryAndKey\s*\(/i;

/**
 * A number from an item already found (FROM_ITEM), written out or through a name bound to one
 * (`for (let childID of note.getAttachments())`).
 */
function fromItem(value: string, text: string): boolean {
  if (FROM_ITEM.test(value)) return true;
  const id = value.trim().match(/^[\w$]+$/)?.[0];
  const bound = id
    ? text.match(
        new RegExp(
          String.raw`(?:let|const|var)\s+${id.replaceAll("$", "\\$")}\s*(?:=|\bof\b)\s*([^;\n]*)`,
        ),
      )?.[1]
    : undefined;
  return !!bound && FROM_ITEM.test(bound);
}

/**
 * Code that finds or makes an item without its key (UNKEYED), makes one with no parent item (a
 * child needs its parent: by key, or by the number of an item already found), or fetches, trashes
 * or erases items or collections by number: numbers count up from 1, so a website can guess them,
 * unless the number comes from an item already found.
 */
function findsWithoutKey(text: string): boolean {
  if (UNKEYED.test(text)) return true;
  for (const m of text.matchAll(
    /\bnew\s+Zotero\.Item\s*\(|\bZotero\.Attachments\.(?:import|link)(?!Mode)\w*\s*\(/g,
  )) {
    const after = text.slice(m.index, m.index + 600);
    if (/\bparent(?:Item)?Key\b/.test(after)) continue;
    // `note.parentItemID = parent.id`, `{ parentItemID: note.id }`, `{ blob, parentItemID }`.
    const parent = after.match(/\bparent(?:Item)?ID\b(?:\s*(?:=(?!=)|:)\s*([^,;\n}]+))?/);
    if (!parent || !fromItem(parent[1] ?? parent[0], text)) return true;
  }
  for (const m of text.matchAll(
    /\bZotero\.(?:Items\.(?:get(?:Async)?|trash(?:Tx)?|erase(?:Tx)?)|Collections\.(?:get(?:Async)?|erase))\s*\(\s*([^)]*)\)/g,
  ))
    if (!fromItem(m[1] as string, text)) return true;
  return false;
}
/** What the caller sends compared with a token (not with null or an empty string). */
const TOKEN_CHECK =
  /(?:token|secret|nonce|api_?key|password|signature)[\w$]*\)?\s*(?:!==?|===?)(?!\s*(?:null|undefined|void\b|""|''|typeof\b))|(?:!==?|===?)\s*[\w$.(]*?(?:token|secret|nonce|api_?key|password|signature)|\b(?:(?:timingSafe|constantTime|secure|safe)Equal\w*|compareDigest|(?:token|secret|api_?key)s?(?:Match|Equal)\w*|(?:is|check|verify|validate)\w*(?:Auth(?!or(?!i[sz]))|Token)\w*)\s*\(/i;
const ASKS_USER = /Services\.prompt\.|\.confirmEx\s*\(|\bconfirm\s*\(/;
/**
 * A call through a table looked up at run time: `handlers[req.method](params)`, or
 * `const handler = handlers[req.method]; … handler(params)`.
 */
const DYNAMIC_CALL =
  /\b[\w$]+(?:\.[\w$]+)*\[[\w$.]+\]\s*\(|(?:const|let|var)\s+([\w$]+)\s*=\s*[\w$]+(?:\.[\w$]+)*\[[\w$.]+\]\s*[;,)][\s\S]{0,600}?\b\1\s*(?:\.call)?\(/;
/** A settings name for a session ID: a credential when a server issues it. */
const SESSION_ID = /session[-_.]?id/gi;
/** A value the code makes up: a random UUID or string, or a uuid helper's. */
const GENERATED_VALUE =
  /\brandomUUID\s*\(|\brandomString\s*\(|\buuid(?:v4|4)?\s*\(|\bgenerate(?:UUID|Uuid|Id|ID|SessionId|Key|ObjectKey)\s*\(|\bnanoid\s*\(|getRandomValues\s*\(|Math\.random\s*\(/;
/** Random values a token can come from. */
const RANDOM_SECRET =
  /getRandomValues|randomUUID|randomBytes|\brandom(?:String|Token|Hex|Bytes)\s*\(|Zotero\.Utilities\.randomString/;
/** A setting read: `getPref("x")`, `Zotero.Prefs.get("x", true)`, `prefs.getBool("x", false)`. */
const PREF_READ = String.raw`(?:[\w$]+\.)*(?:getPref|getBoolPref|getBool|getSetting|[Pp]refs?\.get(?:Bool)?)\s*\(\s*["'\x60]([\w.-]+)["'\x60]\s*(?:,\s*([^)]*))?\)`;
const PREF_TEST = new RegExp(PREF_READ, "i");
/** `if (!getPref("agentEnabled")) return;`: the code after it waits for the setting. */
const PREF_RETURN = new RegExp(
  String.raw`if\s*\(\s*!\s*${PREF_READ}\s*\)\s*(?:\{\s*)?(?:return|throw)\b`,
  "gi",
);
const LOCAL_API_PREF = "httpServer.localAPI.enabled";
/** Types a page can post without a preflight. */
const SIMPLE_TYPES = /^(\*|text\/plain|application\/x-www-form-urlencoded|multipart\/form-data)$/;
/** Method names too common to follow by name: builtins, and what every class has. */
const COMMON_CALLS = new Set(
  "get set has add delete push pop shift unshift map filter forEach reduce find findIndex some every includes indexOf join split slice splice replace replaceAll trim then catch finally bind log debug warn error info test exec match keys values entries parse stringify resolve reject emit on off once init toString".split(
    " ",
  ),
);
/**
 * An MCP tool whose name says it changes the library: a verb and a library noun
 * (`create_note`, `library_update`, `item.trash`), not `create_file` or `resource_link`.
 */
function writesLibraryTool(name: string): boolean {
  const parts = name.toLowerCase().split(/[._]/);
  return (
    parts.length > 1 &&
    // `find_import_collections` finds; it doesn't import.
    !/^(find|get|list|search|read|query|check|count|lookup|fetch|export|describe|show|view|preview|resolve|suggest)$/.test(
      parts[0] ?? "",
    ) &&
    parts.some((p) =>
      /^(create|update|delete|remove|add|set|write|edit|merge|trash|rename|attach|import|move|append|replace|modify|organize|manage|erase|save|apply|restore|tag)$/.test(
        p,
      ),
    ) &&
    parts.some((p) =>
      /^(items?|notes?|annotations?|collections?|tags?|metadata|attachments?|library|highlights?|identifiers?|fields?|creators?|unfiled)$/.test(
        p,
      ),
    )
  );
}
/** Code that changes where add-ons are installed from: `setCustomSourceApi(url)`. */
const SETS_SOURCE =
  /\bset\w*(?:Source|Registry|Mirror|Catalog)\w*\s*\(|\bset(?:Pref|Setting)\s*\(\s*["'`][\w.-]*(?:source|registry|mirror|catalog)/i;
/** An MCP server's request handling: its methods, or its session header. */
const MCP_HINT = /["'`]tools\/(call|list)["'`]|mcp-session-id/i;
/** Node's networking modules, which only a Node program it runs can load, not Zotero's code. */
const NODE_NET_MODULE =
  /\brequire\(\s*["'`](?:node:)?(?:http|https|net)["'`]\s*\)|\bfrom\s+["'`](?:node:)?(?:http|https|net)["'`]/;
/** Tool handlers in an MCP tool definition: `{ name: "create_note", inputSchema, handler }`. */
const TOOL_FN_KEY = /^(handler|execute|run|call|callback|fn|invoke|func|impl|handle)$/;
const TOOL_SPEC_KEY = /^(inputSchema|input_schema|parameters|schema|description|annotations)$/;

/** What an endpoint's class, prototype or object literal says about who may call it. */
function declOf(texts: string[]): EndpointDecl {
  const text = texts.join("\n");
  const unsafe = text.match(/allowRequestsFromUnsafeWebContent["'\]]?\s*[:=]\s*([^,;}\n]+)/);
  const methods = text.match(/supportedMethods["'\]]?\s*[:=]\s*\[([^\]]*)\]/);
  const types = text.match(/supportedDataTypes["'\]]?\s*[:=]\s*(\[[^\]]*\]|["'][^"']*["'])/);
  const quoted = (s: string) => [...s.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1] as string);
  return {
    unsafe: unsafe ? !/^\s*(false|!1|!0x1|0|null|void 0|undefined)\b/.test(unsafe[1] ?? "") : null,
    methods: methods ? quoted(methods[1] ?? "") : null,
    types: types ? quoted(types[1] ?? "") : null,
    // `MetadataSchema.safeParse(metadata)`, not the whole body (`Schema.parse(req.data)`), which a
    // form post of flat fields can pass.
    schemaField: [...text.matchAll(/\w*Schema\w*\.(?:safeParse|parse)\(\s*([\w$.]+)\s*\)/g)].some(
      (m) => !/(^|\.)(data|body|req|request|params)$/.test(m[1] ?? ""),
    ),
  };
}

/**
 * Whether a web page can send the request without a preflight (which Zotero answers without CORS
 * headers, so the browser stops there): a GET, or a body of a type a form or `no-cors` fetch sends.
 */
function pageCanSend(d: EndpointDecl): boolean {
  if (!d.methods || d.methods.includes("GET")) return true;
  if (!d.types) return true;
  const simple = d.types.filter((t) => SIMPLE_TYPES.test(t));
  if (!simple.length) return false;
  // A form post arrives as flat strings: a handler that validates a field as structured data only
  // works with JSON (zotero-syllabus).
  return !(d.schemaField && simple.every((t) => t !== "*" && t !== "text/plain"));
}

/**
 * A header a page can only send after a preflight (`X-…`, Authorization), read and checked:
 * compared, negated, or held in a name that is.
 */
function requiresHeader(text: string): boolean {
  const re =
    /headers\s*(?:\?\.)?(?:\[\s*["'`]|\.get\(\s*["'`]|\.)(x-[\w-]+|authorization)\b|getHeader\([^)]*?["'`](x-[\w-]+|authorization)["'`]/gi;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 200);
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    if (/^[^;\n]{0,80}?(!==?|===?)/.test(after) || /!\s*[\w$.(]*$/.test(before)) return true;
    const held = before.match(/(?:const|let|var)\s+([\w$]+)\s*=[^;=]*$/)?.[1];
    if (
      held &&
      new RegExp(
        String.raw`\b${held.replaceAll("$", "\\$")}\s*(!==?|===?)|!\s*${held.replaceAll("$", "\\$")}\b`,
      ).test(text.slice(end, end + 1500))
    )
      return true;
  }
  return false;
}

/** A check on what a request says about itself: an allow-list, a trust or validity test. */
const CHECK_CALL = String.raw`\b\w*(?:allow|trust|valid|check|verify|permit|reject|forbid)\w*\s*\(`;

/**
 * The request's Origin (or Sec-Fetch-Site) header read and acted on: compared, negated, handed to
 * a check (`allowedOrigin(origin)`), or tested before turning the request away (`if (origin)
 * return reply(403)`). A browser always sends it with a page's request, so a server that acts on
 * it can refuse web pages. Echoing it back in CORS headers isn't a check (it lets every site in).
 */
function checksOrigin(text: string): boolean {
  // Read from the headers, the raw request text (`/^Origin:/im`), or through a helper named for it
  // (`extractOriginHeader(requestText)`, not `getOriginalText`).
  const re =
    /headers\s*(?:\?\.)?(?:\.origin\b|\[\s*["'`]origin["'`]\s*\])|(?:header\w*|\.get)\s*\(\s*(?:[\w$.]+\s*,\s*)?["'`](?:origin|sec-fetch-site)["'`]\s*\)|\/\^?origin:|\b\w*origin(?!al)\w*\s*\(/gi;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 200);
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    if (/^[^;\n]{0,80}?(!==?|===?)/.test(after) || /!\s*[\w$.(]*$/.test(before)) return true;
    if (new RegExp(`${CHECK_CALL}\\s*$`, "i").test(before)) return true;
    const held = before.match(/(?:const|let|var)\s+([\w$]+)\s*=[^;=]*$/)?.[1];
    if (!held) continue;
    const id = held.replaceAll("$", "\\$");
    const rest = text.slice(end, end + 1500);
    if (
      new RegExp(
        String.raw`\b${id}\s*(!==?|===?)|!\s*${id}\b|${CHECK_CALL}\s*${id}\b|if\s*\(\s*${id}\s*\)\s*\{?\s*(?:return|throw)\b[^;\n]{0,80}?(?:403|forbid|reject|deny|refus)`,
        "i",
      ).test(rest)
    )
      return true;
  }
  return false;
}

/**
 * Bodies that aren't JSON turned away (415 Unsupported Media Type, or a negated test of the
 * Content-Type: `if (!contentType.startsWith("application/json")) return 400`): a page can post
 * JSON only after a preflight, which the server doesn't answer with CORS headers.
 */
function refusesNonJson(text: string): boolean {
  if (!/content-?type/i.test(text)) return false;
  if (/\b415\b|Unsupported Media Type/i.test(text)) return true;
  // The type tested where it's read, or through the name it's held in.
  const refused = (id: string) =>
    new RegExp(
      String.raw`!\s*${id}[\w$.[\]"'\x60)]*\s*\.(?:startsWith|includes)\(\s*["'\x60]application\/json|${id}[\w$.[\]"'\x60)]*\s*!==?\s*["'\x60]application\/json`,
      "i",
    );
  if (refused(String.raw`[\w$.[\]"'\x60(-]*content-?type`).test(text)) return true;
  for (const m of text.matchAll(
    /(?:const|let|var)\s+([\w$]+)\s*=[^;\n]{0,120}?content-?type[^;\n]*/gi,
  ))
    if (refused((m[1] as string).replaceAll("$", "\\$")).test(text.slice(m.index, m.index + 1500)))
      return true;
  return false;
}

/** A settings object's read: `MCPSettingsService.get("dangerous.writeLevel") || "readonly"`. */
const SETTINGS_GET =
  /\b[\w$]*(?:setting|pref|config|option)s?[\w$]*\.get\(\s*["'`]([\w.-]+)["'`]\s*\)(?:\s*(?:\|\||\?\?)\s*([^;,)\n]+))?/gi;

/**
 * A setting named for writing (`write.enabled`, `allowWrite`, `dangerous.writeLevel`) the code
 * reads, with its fallback; a read-only fallback (`|| "readonly"`) counts as off.
 */
function writeSettingIn(text: string): Setting | null {
  for (const m of [...text.matchAll(new RegExp(PREF_READ, "gi")), ...text.matchAll(SETTINGS_GET)]) {
    const key = m[1] as string;
    // Not a word that only ends in it (`overwriteExisting`).
    if (!/(?:^|[._-]|allow|enable)(?:write|mutat)/i.test(key.split(".").slice(-2).join(".")))
      continue;
    // `Zotero.Prefs.get(key, true)`: the second argument says the key is global, not a default.
    const fallback = /Zotero\.Prefs\.get/.test(m[0]) ? null : (m[2]?.trim() ?? null);
    return {
      key,
      fallback:
        fallback && /^["'`](?:read[-_]?only|none|off|disabled?)["'`]$/i.test(fallback)
          ? "false"
          : fallback,
    };
  }
  return null;
}

/** A setting an endpoint waits for, and the fallback the code reads it with. */
type Setting = { key: string; fallback: string | null };
/** What guards a call: a setting, or a condition that is never true. */
type Guard = { setting?: Setting; dead?: boolean };

/** The last `if (!getPref("x")) return` in a stretch of code. */
function prefReturn(text: string): Setting | null {
  const m = [...text.matchAll(PREF_RETURN)].at(-1);
  return m ? { key: m[1] as string, fallback: m[2]?.trim() ?? null } : null;
}

/**
 * A setting the code checks around the node at the end of `anc`, in the same function:
 * `if (getPref("mcpEnabled")) { … }`. Early returns (`if (!getPref(…)) return`) are read later.
 */
function settingIf(code: string, anc: AstNode[]): Setting | null {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    if (FUNCTION_TYPES.has(a.type)) return null;
    const t = node(a.test);
    if (a.type !== "IfStatement" || node(a.consequent) !== anc[i + 1] || !t) continue;
    const text = code.slice(t.start, t.end);
    const m = text.match(PREF_TEST);
    if (m && !text.trimStart().startsWith("!"))
      return { key: m[1] as string, fallback: m[2]?.trim() ?? null };
  }
  return null;
}

/**
 * Per-file reading of Zotero's server, once the file's bindings are known: which assignments
 * put an endpoint into Zotero.Server.Endpoints (through names and helpers too), the code behind
 * each endpoint, and patches to Zotero's request handling.
 */
class ServerScan {
  private defs: Map<string, AstNode[]> | null = null;
  private randomKeys = new Map<string, boolean>();
  /** Names the last reach called that this file doesn't define. */
  private elsewhere = new Set<string>();
  /** Helpers found in this file: their calls here are read with the helper's own code. */
  readonly helpers = new Set<string>();

  constructor(
    readonly col: Collector,
    readonly file: SourceFile,
    readonly code: string,
    readonly base: number,
    readonly bindings: Bindings,
    readonly fnNames: Map<AstNode, string>,
    readonly callArgs: Map<string, { args: AstNode[]; fn: AstNode | null }[]>,
    /** What `X.prototype` (or `X.prototype.init`) is given, by how X is written; classes by name. */
    readonly protos: Map<string, AstNode[]>,
    readonly classes: Map<string, AstNode[]>,
    /** MCP tool handlers defined in this file, and the names of tools that change the library. */
    readonly tools: AstNode[],
    readonly writeTools: AstNode[],
    /** Names a `for…of` destructures, with the list it walks and the function it sits in. */
    readonly loops: Map<string, { list: AstNode; fn: AstNode | null }[]>,
  ) {}

  hit(n: AstNode | number): Hit {
    return { file: this.file, offset: this.base + (typeof n === "number" ? n : n.start) };
  }

  /** Functions by the name they're called with: `name`, or `.name` for methods. */
  private byName(): Map<string, AstNode[]> {
    if (this.defs) return this.defs;
    this.defs = new Map();
    for (const [fn, name] of this.fnNames) {
      const list = this.defs.get(name) ?? [];
      if (list.length < 8) list.push(fn);
      this.defs.set(name, list);
    }
    return this.defs;
  }

  /** What a value can be: both sides of `a ?? b` and `c ? a : b`, `a?.b`, `await a`. */
  private values(v: AstNode | undefined, depth = 0): AstNode[] {
    if (!v || depth > 6) return [];
    switch (v.type) {
      case "ChainExpression":
        return this.values(node(v.expression), depth + 1);
      case "AwaitExpression":
        return this.values(node(v.argument), depth + 1);
      case "SequenceExpression":
        return this.values(nodes(v.expressions).at(-1), depth + 1);
      case "LogicalExpression":
        return [...this.values(node(v.left), depth + 1), ...this.values(node(v.right), depth + 1)];
      case "ConditionalExpression":
        return [
          ...this.values(node(v.consequent), depth + 1),
          ...this.values(node(v.alternate), depth + 1),
        ];
      default:
        return [v];
    }
  }

  /** The innermost enclosing function with a parameter of this name, and its index. */
  private param(name: string, fns: AstNode[]): { fn: AstNode; index: number } | null {
    for (const fn of fns) {
      const index = nodes(fn.params).findIndex(
        (p) =>
          (p.type === "Identifier" && p.name === name) ||
          (p.type === "AssignmentPattern" && node(p.left)?.name === name),
      );
      if (index >= 0) return { fn, index };
    }
    return null;
  }

  /** Calls of a function in this file, with the function each call sits in. */
  private callsOf(fn: AstNode): { args: AstNode[]; fn: AstNode | null }[] {
    const name = this.fnNames.get(fn)?.replace(/^\./, "");
    if (!name) return [];
    return [...(this.callArgs.get(name) ?? []), ...(this.callArgs.get(`.${name}`) ?? [])];
  }

  /**
   * What a name holds: its bindings in scope, or what calls in this file pass for it (only near
   * the start of a trail: a minified bundle's parameters fan out fast).
   */
  private bound(name: string, fns: AstNode[], depth: number): { v: AstNode; fns: AstNode[] }[] {
    const own = this.bindings.lookup(name, fns).map((v) => ({ v, fns }));
    if (own.length || depth > 1) return own;
    const p = this.param(name, fns);
    if (!p) return [];
    return this.callsOf(p.fn)
      .slice(0, 8)
      .map((c) => ({ v: c.args[p.index] as AstNode, fns: c.fn ? [c.fn] : [] }))
      .filter((x) => x.v);
  }

  private returned(call: AstNode): { v: AstNode; fns: AstNode[] }[] {
    const name = lastName(node(call.callee));
    return name ? (this.bindings.returns.get(name) ?? []) : [];
  }

  /** Zotero.Server itself, or a name, parameter or helper's result holding it. */
  isServer(v: AstNode | undefined, fns: AstNode[], depth = 0): boolean {
    if (!v || depth > 7) return false;
    return this.values(v).some((u) => {
      if (/(^|\.)Zotero\.Server$/.test(chain(u) ?? "")) return true;
      if (u.type === "Identifier")
        return this.bound(u.name as string, fns, depth).some((x) =>
          this.isServer(x.v, x.fns, depth + 1),
        );
      if (u.type === "CallExpression")
        return this.returned(u).some((r) => this.isServer(r.v, r.fns, depth + 1));
      return false;
    });
  }

  /** Zotero.Server.Endpoints, reached directly or through names and helpers. */
  isTable(v: AstNode | undefined, fns: AstNode[], depth = 0): boolean {
    if (!v || depth > 7) return false;
    return this.values(v).some((u) => {
      if (u.type === "MemberExpression" && nameOf(u) === "Endpoints")
        return this.isServer(node(u.object), fns, depth + 1);
      if (u.type === "Identifier")
        return this.bound(u.name as string, fns, depth).some((x) =>
          this.isTable(x.v, x.fns, depth + 1),
        );
      if (u.type === "CallExpression")
        return this.returned(u).some((r) => this.isTable(r.v, r.fns, depth + 1));
      return false;
    });
  }

  /** Zotero.Server.RequestHandler.prototype (or the old DataListener's), or a name for it. */
  private isHandlerProto(v: AstNode | undefined, fns: AstNode[], depth = 0): boolean {
    if (!v || depth > 3) return false;
    const HANDLER = /(^|\.)Server\.(RequestHandler|DataListener)$/;
    return this.values(v).some((u) => {
      if (u.type === "MemberExpression" && nameOf(u) === "prototype") {
        const o = node(u.object);
        if (HANDLER.test(chain(o) ?? "")) return true;
        return (
          o?.type === "Identifier" &&
          this.bound(o.name as string, fns, depth).some((x) => HANDLER.test(chain(x.v) ?? ""))
        );
      }
      if (u.type === "Identifier")
        return this.bound(u.name as string, fns, depth).some((x) =>
          this.isHandlerProto(x.v, x.fns, depth + 1),
        );
      return false;
    });
  }

  /**
   * The code an endpoint value stands for: a class, function or object literal, what a name is
   * bound to, what `X.prototype` is given, or the function a factory call runs and the functions
   * passed to it.
   */
  roots(v: AstNode | undefined, fns: AstNode[], depth = 0): AstNode[] {
    if (!v || depth > 3) return [];
    const out: AstNode[] = [];
    const protoOf = (name: string) => this.protoRoots(name, fns, depth);
    for (const u of this.values(v)) {
      if (
        FUNCTION_TYPES.has(u.type) ||
        u.type === "ClassExpression" ||
        u.type === "ClassDeclaration" ||
        u.type === "ObjectExpression"
      ) {
        out.push(u);
        const id = node(u.id)?.name as string | undefined;
        if (id) out.push(...protoOf(id));
      } else if (u.type === "Identifier") {
        const name = u.name as string;
        const bound = this.bindings.lookup(name, fns);
        for (const b of bound) out.push(...this.roots(b, fns, depth + 1));
        out.push(...(this.classes.get(name) ?? []), ...protoOf(name));
        if (!bound.length) out.push(...this.fromTable(name, fns));
      } else if (u.type === "MemberExpression" && u.computed) {
        // `epTable[path]`: every endpoint the table holds.
        const obj = node(u.object);
        const tables =
          obj?.type === "Identifier" ? this.bindings.lookup(obj.name as string, fns) : [];
        for (const t of tables)
          if (t.type === "ObjectExpression")
            for (const p of nodes(t.properties).slice(0, 40))
              out.push(...this.roots(node(p.value), fns, depth + 1));
      } else if (
        u.type === "CallExpression" &&
        /^(bind|call)$/.test(nameOf(node(u.callee)) ?? "")
      ) {
        // `this.setup.bind(this)`: the function bound.
        out.push(...this.roots(node(node(u.callee)?.object), fns, depth + 1));
      } else if (u.type === "MemberExpression" && !u.computed) {
        const prop = nameOf(u);
        const obj = node(u.object);
        // `r.handler` in `for (const r of ROUTES)`: the handlers in the table.
        const table =
          obj?.type === "Identifier" && !this.bindings.lookup(obj.name as string, fns).length
            ? this.fromTable(obj.name as string, fns)
            : [];
        out.push(...table);
        if (prop && !table.length)
          for (const b of this.bindings.lookup(prop, fns, "prop").slice(0, 5))
            out.push(...this.roots(b, fns, depth + 1));
        out.push(...protoOf(this.code.slice(u.start, u.end).replace(/\s+/g, "")));
      } else if (u.type === "CallExpression" || u.type === "NewExpression") {
        const name = lastName(node(u.callee));
        const defs = name
          ? [...(this.byName().get(name) ?? []), ...(this.byName().get(`.${name}`) ?? [])]
          : [];
        if (defs.length <= 3) out.push(...defs);
        if (name) out.push(...(this.classes.get(name) ?? []));
        for (const a of nodes(u.arguments))
          if (
            FUNCTION_TYPES.has(a.type) ||
            a.type === "ClassExpression" ||
            a.type === "ObjectExpression"
          )
            out.push(a);
          else if (a.type === "Identifier" || a.type === "MemberExpression")
            out.push(...this.roots(a, fns, depth + 1).filter((r) => FUNCTION_TYPES.has(r.type)));
      }
    }
    return out;
  }

  /**
   * The functions in the table a loop registers from: `for (const [path, methods, fn] of ROUTES)`
   * or `for (const route of ROUTES)`, where ROUTES lists the handlers.
   */
  private fromTable(name: string, fns: AstNode[]): AstNode[] {
    const loop = this.loops.get(name)?.find((l) => l.fn === null || fns.includes(l.fn));
    const list = loop?.list ?? this.bindings.forOf.get(name);
    // `Object.entries(endpoints)`: the object's values.
    const listed =
      typeof list !== "string" &&
      list?.type === "CallExpression" &&
      /^Object\.(entries|values)$/.test(chain(node(list.callee)) ?? "")
        ? node(nodes(list.arguments)[0])
        : list;
    const tables =
      typeof listed === "string"
        ? this.bindings.lookup(listed, fns)
        : listed
          ? listed.type === "Identifier"
            ? this.bindings.lookup(listed.name as string, fns)
            : [listed]
          : [];
    const out: AstNode[] = [];
    for (const t of tables)
      if (t.type === "ObjectExpression")
        for (const p of nodes(t.properties).slice(0, 40))
          out.push(...this.roots(node(p.value), fns, 1));
    for (const t of tables)
      if (t.type === "ArrayExpression")
        for (const d of descendants(t)) {
          if (out.length >= 80) return out;
          if (FUNCTION_TYPES.has(d.type)) out.push(d);
          else if (d.type === "Identifier")
            out.push(
              ...this.bindings
                .lookup(d.name as string, fns)
                .filter((b) => FUNCTION_TYPES.has(b.type)),
            );
        }
    return out;
  }

  /** What `X.prototype` (or `X.prototype.init`) is given. */
  protoRoots(name: string, fns: AstNode[], depth = 0): AstNode[] {
    return (this.protos.get(name) ?? []).flatMap((p) =>
      FUNCTION_TYPES.has(p.type) || p.type === "ObjectExpression"
        ? [p]
        : this.roots(p, fns, depth + 1),
    );
  }

  /**
   * The code behind an endpoint: its handler and the functions it calls by name in this file, a
   * few calls deep, each with how many calls away it is. A name more than three functions share
   * could be any of them, so the trail stops there. An MCP endpoint also reaches the tools defined
   * in the file.
   */
  private reach(roots: AstNode[], path: string | null, maxDepth = 5): Map<AstNode, number> {
    const defs = this.byName();
    const seen = new Map<AstNode, number>();
    for (const r of roots) seen.set(r, 0);
    let frontier = [...seen.keys()];
    let mcp = false;
    let bytes = 0;
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next: AstNode[] = [];
      const take = (f: AstNode, d: number) => {
        if (seen.has(f) || seen.size >= 200) return;
        seen.set(f, d);
        next.push(f);
      };
      for (const r of frontier) {
        bytes += r.end - r.start;
        if (!mcp && (/\/mcp$/.test(path ?? "") || MCP_HINT.test(this.code.slice(r.start, r.end)))) {
          mcp = true;
          for (const t of this.tools) take(t, depth + 1);
        }
        const follow = (name: string | null, member: boolean) => {
          if (!name || COMMON_CALLS.has(name)) return;
          const found = member
            ? [...(defs.get(`.${name}`) ?? []), ...(defs.get(name) ?? [])]
            : (defs.get(name) ?? []);
          if (!found.length && name.length >= 4 && this.elsewhere.size < 200)
            this.elsewhere.add(name);
          if (!found.length || found.length > 3 || (name.length < 3 && found.length > 1)) return;
          for (const f of found) take(f, depth + 1);
        };
        for (const d of descendants(r)) {
          // A function handed over by name runs too: `init: handleMcpRequest`, `.then(onDone)`.
          if (d.type === "Property" && node(d.value)?.type === "Identifier")
            follow(node(d.value)?.name as string, false);
          if (d.type !== "CallExpression") continue;
          const callee = node(d.callee);
          const member = callee?.type === "MemberExpression" && !callee.computed;
          // A method of an instance whose class we know is that class's method, whatever other
          // classes share its name (`addAction.execute(…)`).
          const typed = member ? this.methodOf(node(callee.object), nameOf(callee) ?? "") : [];
          for (const f of typed) take(f, depth + 1);
          if (!typed.length)
            follow(
              callee?.type === "Identifier"
                ? (callee.name as string)
                : member
                  ? nameOf(callee)
                  : null,
              member,
            );
          for (const a of nodes(d.arguments))
            if (a.type === "Identifier") follow(a.name as string, false);
        }
      }
      frontier = bytes > 4_000_000 ? [] : next;
    }
    return seen;
  }

  /**
   * The method a call on an instance runs, when the instance is made with `new` from a class in
   * this file: `addAction.execute()` after `var addAction = new AddAction()`, or
   * `this.mcpServer.handleMCPRequest()` after `this.mcpServer = new StreamableMCPServer()`.
   */
  private methodOf(obj: AstNode | undefined, name: string): AstNode[] {
    if (!obj || !name) return [];
    const held =
      obj.type === "Identifier"
        ? this.bindings.all(obj.name as string)
        : obj.type === "MemberExpression" && !obj.computed
          ? this.bindings.lookup(nameOf(obj) ?? "", [], "prop")
          : [];
    const out: AstNode[] = [];
    for (const v of held.slice(0, 5)) {
      const cls = v.type === "NewExpression" ? lastName(node(v.callee)) : null;
      if (!cls) continue;
      const bodies = [
        ...(this.classes.get(cls) ?? []),
        ...this.bindings.all(cls).filter((b) => b.type === "ClassExpression"),
      ];
      for (const c of bodies.slice(0, 3))
        for (const m of nodes(node(c.body)?.body)) {
          const f = node(m.value);
          if (
            (m.type === "MethodDefinition" || m.type === "PropertyDefinition") &&
            !m.computed &&
            node(m.key)?.name === name &&
            f &&
            FUNCTION_TYPES.has(f.type)
          )
            out.push(f);
        }
    }
    return out;
  }

  /** Endpoints registered, patches and helper calls found in the walk. */
  run(
    assigns: { n: AstNode; fns: AstNode[]; setting: Setting | null; alias: string | null }[],
    patches: { n: AstNode; fns: AstNode[] }[],
    calls: { n: AstNode; name: string; args: AstNode[]; fns: AstNode[]; setting: Setting | null }[],
    own: (offset: number) => boolean,
  ) {
    for (const a of assigns) {
      const left = node(a.n.left);
      if (!left || !this.isTable(node(left.object), a.fns)) continue;
      const cap = this.col.cap("local-http-server", this.hit(a.n), "Zotero.Server.Endpoints");
      const keyNode = left.computed ? node(left.property) : undefined;
      const key = keyNode ? this.pathOf(keyNode, a.fns) : nameOf(left);
      if (key) cap.endpoints.add(key);
      if (!own(this.base + a.n.start)) continue;
      const value = node(a.n.right);
      const fn = a.fns[0];
      // `const E = Zotero.Server.Endpoints[p] = function () {}; E.prototype = {…}`, or the
      // prototype set through the table itself.
      const roots = [
        ...this.roots(value, a.fns),
        ...(a.alias ? this.protoRoots(a.alias, a.fns) : []),
        ...this.protoRoots(this.code.slice(left.start, left.end).replace(/\s+/g, ""), a.fns),
      ];
      const early = fn ? prefReturn(this.code.slice(fn.start, a.n.start)) : null;
      const guard = a.setting || early ? {} : this.guardOf(fn);
      const setting = a.setting ?? early ?? guard.setting ?? null;
      // Built from what its function is passed (`registerEndpoint(path, handler)`): each call is
      // an endpoint, read together with the helper's own code (its auth checks).
      const keyIds = new Set(
        keyNode
          ? [keyNode, ...descendants(keyNode)]
              .filter((d) => d.type === "Identifier")
              .map((d) => d.name as string)
          : [],
      );
      // What the prototype is given counts as the value: `E.prototype = proto`.
      const given = [
        value?.type === "Identifier" ? (value.name as string) : null,
        a.alias,
        this.code.slice(left.start, left.end).replace(/\s+/g, ""),
      ].flatMap((x) => (x ? (this.protos.get(x) ?? []) : []));
      const params = fn && value ? this.paramsUsed(fn, [value, ...roots, ...given], keyIds) : [];
      const name = fn ? this.fnNames.get(fn)?.replace(/^\./, "") : undefined;
      if (fn && name && params.length) {
        this.helpers.add(name);
        this.col.endpointHelpers.set(name, {
          decl: declOf(roots.map((r) => this.code.slice(r.start, r.end))),
          code: this.codeOf(roots, key),
        });
        const keyIndex =
          keyNode?.type === "Identifier"
            ? this.param(keyNode.name as string, [fn])?.index
            : undefined;
        const calls = this.callsOf(fn);
        for (const c of calls.slice(0, 40)) {
          // Each call has its own guard: registerMcpServer() behind a setting, registerEndpoints()
          // behind a condition that is always false.
          const g = setting || !c.fn ? {} : this.guardBefore(c.fn, name);
          const around = g.setting || g.dead ? g : this.guardOf(c.fn);
          if (around.dead) continue;
          const at = c.fn ? [c.fn] : [];
          const extra = params.flatMap((i) => this.roots(c.args[i], at));
          const path =
            keyIndex === undefined
              ? key
              : (this.bindings.texts(c.args[keyIndex], at).find((t) => !t.includes(EXPR)) ?? null);
          if (path) cap.endpoints.add(path);
          this.add(
            this.hit(c.args[0] ?? a.n),
            path,
            [...roots, ...extra],
            setting ?? around.setting ?? null,
          );
        }
        if (!calls.length) this.add(this.hit(a.n), key, roots, setting);
        continue;
      }
      if (guard.dead) continue;
      // A value we can't follow: the function that registers it stands in, when it's small.
      const code = roots.length ? roots : fn && fn.end - fn.start < 30_000 ? [fn] : [];
      this.add(this.hit(a.n), key, code, setting);
    }
    for (const p of patches) {
      const patch = own(this.base + p.n.start) ? this.patch(p.n, p.fns) : null;
      if (patch) this.col.serverPatches.push(patch);
    }
    // Calls that pass a path and a handler to a helper maybe defined in another file, matched
    // once every file is read.
    for (const c of calls) {
      if (this.helpers.has(c.name)) continue;
      const path = this.bindings.texts(c.args[0], c.fns).find((t) => /^\/[\w-]/.test(t));
      if (!path) continue;
      const roots = c.args.slice(1).flatMap((a) => this.roots(a, c.fns));
      if (roots.length)
        this.col.helperCalls.push({
          name: c.name,
          ep: this.endpoint(this.hit(c.n), path.replaceAll(EXPR, "*"), roots, c.setting),
        });
    }
  }

  private add(hit: Hit, path: string | null, roots: AstNode[], setting: Setting | null) {
    this.col.serverEndpoints.push(this.endpoint(hit, path, roots, setting));
  }

  /**
   * A server the plugin opens itself (a server socket's listener, an httpd.js path handler, a Node
   * createServer callback): the code behind it, what that code checks before acting, and a
   * setting its start waits for. The request arrives as raw bytes, which a few helpers read,
   * parse and route before a handler sees it: checks are read two calls further in than for
   * Zotero's endpoints, and the trail runs three calls further.
   */
  ownServer(site: OwnSite): OwnServer {
    const fn = site.fns[0];
    // A socket's listener held in a property (`asyncListen(this.listener)`): the object that has
    // onSocketAccepted, not every property of that name in a bundle (UI event listeners).
    const listeners = (h: AstNode) =>
      site.kind === "socket" && h.type === "MemberExpression" && !h.computed
        ? this.bindings
            .lookup(nameOf(h) ?? "", site.fns, "prop")
            .filter((b) => /\bonSocketAccepted\b/.test(this.code.slice(b.start, b.end)))
            .slice(0, 5)
        : [];
    const roots = site.handlers.flatMap((h) => {
      const own = listeners(h);
      return own.length ? own.flatMap((b) => this.roots(b, site.fns)) : this.roots(h, site.fns);
    });
    // A handler we can't follow: the function that starts the server stands in, when it's small.
    const code = this.codeOf(
      roots.length ? roots : fn && fn.end - fn.start < 30_000 ? [fn] : [],
      null,
      4,
      8,
    );
    const early = fn ? prefReturn(this.code.slice(fn.start, site.n.start)) : null;
    return {
      hit: this.hit(site.n),
      kind: site.kind,
      code,
      setting: site.setting ?? early ?? this.guardOf(fn).setting ?? null,
      ...(roots.length && roots.every(onlyRefuses) ? { refusesOnly: true } : {}),
    };
  }

  private endpoint(
    hit: Hit,
    path: string | null,
    roots: AstNode[],
    setting: Setting | null,
  ): ServerEndpoint {
    const texts = roots.map((r) => this.code.slice(r.start, r.end));
    // Its handler returns early without the setting (`if (!getPref("writebackEnabled")) return
    // deny(403)`), or it is one of Zotero's local API classes, which answer only while the user
    // has the local API on (when they override run(), not init()).
    const inHandler = texts.map((t) => prefReturn(t.slice(0, 20_000))).find(Boolean) ?? null;
    const localApi = texts.some(
      (t) =>
        /extends\s+Zotero\.Server\.LocalAPI\.\w+/.test(t) && !/^\s*(?:async\s+)?init\s*\(/m.test(t),
    );
    return {
      hit,
      path,
      decl: declOf(texts),
      code: this.codeOf(roots, path),
      setting:
        setting ?? inHandler ?? (localApi ? { key: LOCAL_API_PREF, fallback: "false" } : null),
    };
  }

  /**
   * The path an endpoint is registered under, when it's written out: through names in scope, or
   * a name set anywhere in the file (a bundler sets constants inside its module initialisers:
   * `g4 = "/bibgenie/mcp"`, registered as `Endpoints[t.endpointPath]`).
   */
  private pathOf(key: AstNode, fns: AstNode[]): string | null {
    const found = this.bindings.texts(key, fns).find((t) => !t.includes(EXPR));
    if (found) return found;
    const names =
      key.type === "Identifier"
        ? [key]
        : key.type === "MemberExpression" && !key.computed
          ? this.bindings.lookup(nameOf(key) ?? "", fns, "prop")
          : [];
    for (const n of names.slice(0, 5)) {
      if (n.type !== "Identifier") continue;
      const text = this.bindings
        .all(n.name as string)
        .map((v) => str(v))
        .find((t) => t?.startsWith("/"));
      if (text) return text;
    }
    return null;
  }

  /** Parameters of `fn` an endpoint value is built from, by index (not the path's). */
  private paramsUsed(fn: AstNode, scan: AstNode[], exclude: Set<string>): number[] {
    const names = new Map<string, number>();
    nodes(fn.params).forEach((p, i) => {
      const id = p.type === "AssignmentPattern" ? node(p.left) : p;
      if (id?.type === "Identifier" && !exclude.has(id.name as string))
        names.set(id.name as string, i);
    });
    const used = new Set<number>();
    for (const s of scan) {
      if (s.start < fn.start || s.end > fn.end) continue;
      for (const d of [s, ...descendants(s)])
        if (d.type === "Identifier" && names.has(d.name as string))
          used.add(names.get(d.name as string) as number);
    }
    return [...used];
  }

  /**
   * What the code checks before calling `name` inside `caller`: an early return without a setting,
   * an `if` on a setting or on a name holding one (`const mcpKey = getPref("mcpServerEnabled") ?
   * … : ""; if (mcpKey) register()`), or a condition that is always false (`const httpEnabled =
   * … && false`), which leaves the call dead.
   */
  private guardBefore(caller: AstNode, name: string): Guard {
    const at = this.code.indexOf(`${name}(`, caller.start);
    const before = this.code.slice(caller.start, at > 0 && at < caller.end ? at : caller.end);
    const early = prefReturn(before);
    if (early) return { setting: early };
    const cond = before
      .slice(-300)
      .match(/if\s*\(((?:[^()]|\([^()]*\))*)\)\s*\{?\s*(?:[\w$.]+\s*=\s*)?(?:await\s+)?$/)?.[1];
    // Only a condition every part of which must hold.
    if (!cond || cond.includes("||") || cond.trimStart().startsWith("!")) return {};
    const direct = cond.match(PREF_TEST);
    if (direct)
      return { setting: { key: direct[1] as string, fallback: direct[2]?.trim() ?? null } };
    for (const id of new Set(cond.match(/[\w$]+/g) ?? [])) {
      const held = before.match(
        new RegExp(String.raw`\b${id.replaceAll("$", "\\$")}\s*=\s*([^;\n]+)`),
      )?.[1];
      if (!held) continue;
      if (/&&\s*(?:false|!1)\s*$/.test(held.trim())) return { dead: true };
      const m = held.match(PREF_TEST);
      if (m) return { setting: { key: m[1] as string, fallback: m[2]?.trim() ?? null } };
    }
    return {};
  }

  /** The innermost named function around a node. */
  private namedAround(n: AstNode): AstNode | null {
    let best: AstNode | null = null;
    for (const fn of this.fnNames.keys())
      if (fn !== n && fn.start <= n.start && fn.end >= n.end && (!best || fn.start >= best.start))
        best = fn;
    return best;
  }

  /** What guards every call of `fn` in this file, two calls up; one open call leaves it open. */
  private guardOf(fn: AstNode | null | undefined, depth = 0): Guard {
    if (!fn || depth > 1) return {};
    const name = this.fnNames.get(fn)?.replace(/^\./, "");
    const calls = this.callsOf(fn).filter((c) => c.fn);
    if (!name || !calls.length) return {};
    let setting: Setting | undefined;
    let dead = true;
    for (const c of calls.slice(0, 10)) {
      const caller = c.fn as AstNode;
      const direct = this.guardBefore(caller, name);
      // A callback (`.map(([p, h]) => registerEndpoint(p, h))`) is called where its function is.
      const up = this.fnNames.has(caller) ? caller : this.namedAround(caller);
      const g = direct.setting || direct.dead ? direct : this.guardOf(up, depth + 1);
      if (!g.setting && !g.dead) return {};
      if (!g.dead) dead = false;
      setting ??= g.setting;
    }
    return dead ? { dead } : setting ? { setting } : {};
  }

  /** A patch to Zotero's request handling that adds CORS headers, and whom it lets in. */
  private patch(n: AstNode, fns: AstNode[]): ServerPatch | null {
    const left = node(n.left);
    const fn = node(n.right);
    if (
      !left ||
      !fn ||
      !FUNCTION_TYPES.has(fn.type) ||
      !this.isHandlerProto(node(left.object), fns)
    )
      return null;
    const texts = [...this.reach([fn], null).keys()].map((r) => this.code.slice(r.start, r.end));
    // Headers kept in a constant (`aiSummaryCORSHeaders`) are the patch's own.
    const names = new Set(
      [...descendants(fn)].filter((d) => d.type === "Identifier").map((d) => d.name as string),
    );
    for (const name of [...names].slice(0, 200))
      for (const b of this.bindings.lookup(name, fns))
        if (b.type === "ObjectExpression") texts.push(this.code.slice(b.start, b.end));
    const all = texts.join("\n");
    if (!/access-control-allow-origin/i.test(all)) return null;
    const own = this.code.slice(fn.start, fn.end);
    return {
      hit: this.hit(n),
      ownPaths:
        /\b(pathname|path|url)\b[\w$.?]*\.(?:startsWith|indexOf|includes|match)\s*\(|\b(pathname|path)\s*[!=]==?\s*["'`]\//.test(
          own,
        ),
      origins: ASKS_USER.test(all)
        ? "approved"
        : /(?:\.test|\.has|\.includes)\(\s*[\w$.]*origin/i.test(all)
          ? "listed"
          : "any",
      zoteroHeader: /zotero-allowed-request|access-control-request-headers/i.test(all),
    };
  }

  private codeOf(
    roots: AstNode[],
    path: string | null,
    checkDepth = 2,
    maxDepth = 5,
  ): EndpointCode {
    this.elsewhere = new Set();
    const reach = this.reach(roots, path, maxDepth);
    const out: EndpointCode = {
      calls: [...this.elsewhere],
      edits: null,
      reads: false,
      byKey: false,
      unkeyed: false,
      needsHeader: false,
      secret: false,
      asks: false,
      origin: false,
      jsonOnly: false,
      writeSetting: null,
      file: this.file,
      ranges: [...reach.keys()].map((r) => [this.base + r.start, this.base + r.end]),
    };
    // A handler that dispatches through a table filled at run time (`handlers[req.method](…)`,
    // JSON-RPC) can reach any function put in it: in a small file, the whole file counts.
    let dispatch = false;
    for (const [r, depth] of reach) {
      const text = this.code.slice(r.start, r.end);
      dispatch ||= depth <= 2 && DYNAMIC_CALL.test(text);
      const w = out.edits ? null : LIBRARY_WRITE.exec(text);
      if (w) out.edits = this.hit(r.start + w.index);
      out.reads ||= LIBRARY_READ.test(text);
      out.byKey ||= KEY_LOOKUP.test(text);
      out.unkeyed ||= findsWithoutKey(text);
      out.writeSetting ??= writeSettingIn(text);
      // Checks on the request sit in the handler or the helpers it calls first, not in whatever
      // its work leads to (a confirm() in the UI a callback refreshes).
      if (depth > checkDepth) continue;
      out.needsHeader ||= requiresHeader(text);
      out.secret ||= TOKEN_CHECK.test(text) || this.randomKeyLookup(text);
      out.asks ||= ASKS_USER.test(text);
      out.origin ||= checksOrigin(text);
      out.jsonOnly ||= refusesNonJson(text);
    }
    // An MCP server whose tools are handed out through a dispatcher we can't follow: the tools
    // defined in the file say what it offers (`{ name: "create_note", inputSchema }`).
    const mcp =
      /\/mcp$/.test(path ?? "") ||
      [...reach.keys()].some((r) => MCP_HINT.test(this.code.slice(r.start, r.end)));
    // (Their code isn't followed, so nothing says their changes need a key.)
    if (mcp && !out.edits && this.writeTools[0]) {
      out.edits = this.hit(this.writeTools[0]);
      out.unkeyed = true;
    }
    if (dispatch && this.code.length < 300_000) {
      const w = out.edits ? null : LIBRARY_WRITE.exec(this.code);
      if (w) out.edits = this.hit(w.index);
      out.reads ||= LIBRARY_READ.test(this.code);
      out.byKey ||= KEY_LOOKUP.test(this.code);
      out.unkeyed ||= findsWithoutKey(this.code);
      out.ranges.push([this.base, this.base + this.code.length]);
    }
    return out;
  }

  /**
   * An entry looked up by a key the plugin made random (`tasks.get(id)` where tasks are stored
   * under `randomString(12)`): the caller must know a key only the plugin handed out.
   */
  private randomKeyLookup(text: string): boolean {
    for (const m of text.matchAll(/([\w$]+)\.get\(\s*[\w$.]+\s*\)/g)) {
      const map = m[1] as string;
      if (map.length < 3 || COMMON_CALLS.has(map)) continue;
      let random = this.randomKeys.get(map);
      if (random === undefined) {
        const set = new RegExp(String.raw`\b${map.replaceAll("$", "\\$")}\.set\(`).exec(this.code);
        random =
          !!set && RANDOM_SECRET.test(this.code.slice(Math.max(0, set.index - 300), set.index));
        this.randomKeys.set(map, random);
      }
      if (random) return true;
    }
    return false;
  }
}

/** `true`, `false`, `!0` or `!1`; null for anything else. */
function boolLiteral(v: AstNode | undefined): boolean | null {
  if (v?.type === "Literal" && typeof v.value === "boolean") return v.value;
  const inner = v?.type === "UnaryExpression" && v.operator === "!" ? node(v.argument) : undefined;
  return inner?.type === "Literal" && typeof inner.value === "number" ? !inner.value : null;
}

/** Whether one of these functions takes `name` as a parameter (`x`, `x = true`, `{ x }`). */
function takesParam(fns: AstNode[], name: string): boolean {
  const binds = (p: AstNode | undefined): boolean =>
    p?.type === "Identifier"
      ? p.name === name
      : p?.type === "AssignmentPattern"
        ? binds(node(p.left))
        : p?.type === "RestElement"
          ? binds(node(p.argument))
          : p?.type === "ArrayPattern"
            ? nodes(p.elements).some(binds)
            : p?.type === "ObjectPattern" &&
              nodes(p.properties).some((q) =>
                binds(node(q.type === "RestElement" ? q.argument : q.value)),
              );
  return fns.some((f) => nodes(f.params).some(binds));
}

/**
 * A boolean the code always gives: a literal, negated or not, or a name (a variable, or an object
 * property) every value given to which is the same literal. A parameter is whatever its callers
 * pass, whatever its default (`start(port, loopbackOnly = true)`).
 */
function constantBool(v: AstNode, fns: AstNode[], bindings: Bindings): boolean | null {
  let negated = false;
  let at: AstNode | undefined = v;
  while (at?.type === "UnaryExpression" && at.operator === "!" && boolLiteral(at) === null) {
    negated = !negated;
    at = node(at.argument);
  }
  if (!at) return null;
  if (at.type === "Identifier" && takesParam(fns, at.name as string)) return null;
  const direct = boolLiteral(at);
  const name = at.type === "Identifier" ? (at.name as string) : nameOf(at);
  const values =
    direct !== null || !name
      ? []
      : bindings.lookup(name, fns, at.type === "Identifier" ? "var" : "prop").map(boolLiteral);
  const value =
    direct ??
    (values.length && values.every((x) => x !== null && x === values[0]) ? values[0] : null);
  return value === null || value === undefined ? null : value !== negated;
}

/**
 * Where a server socket's loopbackOnly argument comes from: `!remoteAllowed`, bound to
 * `this.allowRemote()`, gives the names remoteAllowed and allowRemote, negated once; a setting
 * read on the way gives its key.
 */
function listenSetting(
  arg: AstNode,
  fns: AstNode[],
  bindings: Bindings,
  code: string,
): Collector["listenSettings"][number] {
  const names: string[] = [];
  let key: string | null = null;
  let negated = false;
  const read = (v: AstNode | undefined, depth: number) => {
    while (v?.type === "UnaryExpression" && v.operator === "!") {
      negated = !negated;
      v = node(v.argument);
    }
    if (!v) return;
    key ??= code.slice(v.start, v.end).match(PREF_TEST)?.[1] ?? null;
    const name =
      v.type === "Identifier"
        ? (v.name as string)
        : v.type === "MemberExpression"
          ? nameOf(v)
          : v.type === "CallExpression"
            ? lastName(node(v.callee))
            : null;
    if (name) names.push(name);
    if (v.type === "Identifier" && depth === 0) {
      const bound = bindings.lookup(v.name as string, fns);
      if (bound.length === 1) read(bound[0], 1);
    }
  };
  read(arg, 0);
  return { names, key, negated };
}

/**
 * A handler whose whole body is one call answering with an error status (`sendError(response,
 * request, 404, "Not found.")`): what httpd.js is left with for a route the plugin removed. The
 * call is named for answering, so a number in that range passed to anything else (a relay's port
 * 443) doesn't count.
 */
function onlyRefuses(fn: AstNode): boolean {
  if (!FUNCTION_TYPES.has(fn.type)) return false;
  const body = node(fn.body);
  const stmts = body?.type === "BlockStatement" ? nodes(body.body) : body ? [body] : [];
  const only = stmts.length === 1 ? (stmts[0] as AstNode) : null;
  const call =
    only?.type === "ExpressionStatement"
      ? node(only.expression)
      : only?.type === "ReturnStatement"
        ? node(only.argument)
        : only;
  return (
    call?.type === "CallExpression" &&
    /send|error|status|respon|reply|refuse|reject|deny|notFound|fail/i.test(
      lastName(node(call.callee)) ?? "",
    ) &&
    nodes(call.arguments).some(
      (a) => a.type === "Literal" && typeof a.value === "number" && a.value >= 400 && a.value < 500,
    )
  );
}

/** How the local-http-server badge names a patch that opens every endpoint, by whom it lets in. */
const OPENS_ALL: Record<ServerPatch["origins"], string> = {
  any: "every endpoint, for any website",
  listed: "every endpoint, for the websites it names",
  approved: "every endpoint, for websites you approve",
};

/**
 * Zotero's own server, once every file is read: helper calls matched to their helpers, who can
 * reach each endpoint, and what that lets them do. Zotero drops a browser's request to an endpoint
 * that doesn't opt in (`allowRequestsFromUnsafeWebContent`) unless it carries Zotero-Allowed-Request,
 * and answers the preflight that header (or a JSON body, or any custom header) needs without CORS
 * headers, so a page gets through only to an endpoint that opts in and takes a simple request, or
 * through a patch that answers preflights (Zotero 9's server.js). Returns the endpoints web pages
 * can use.
 */
function rateServer(col: Collector): ServerEndpoint[] {
  for (const { name, ep } of col.helperCalls) {
    const helper = col.endpointHelpers.get(name);
    if (!helper) continue;
    // The helper's own endpoint class says who may call it, and checks what it checks.
    const d = helper.decl;
    const h = helper.code;
    ep.decl = {
      unsafe: ep.decl.unsafe ?? d.unsafe,
      methods: ep.decl.methods ?? d.methods,
      types: ep.decl.types ?? d.types,
      schemaField: ep.decl.schemaField || d.schemaField,
    };
    ep.code = {
      ...ep.code,
      edits: ep.code.edits ?? h.edits,
      reads: ep.code.reads || h.reads,
      byKey: ep.code.byKey || h.byKey,
      unkeyed: ep.code.unkeyed || h.unkeyed,
      needsHeader: ep.code.needsHeader || h.needsHeader,
      secret: ep.code.secret || h.secret,
      asks: ep.code.asks || h.asks,
      calls: [...ep.code.calls, ...h.calls],
    };
    col.serverEndpoints.push(ep);
    const cap = col.cap("local-http-server", ep.hit, "Zotero.Server.Endpoints");
    if (ep.path) cap.endpoints.add(ep.path);
  }
  // A patch that opens every endpoint to pages sending Zotero-Allowed-Request opens other
  // plugins' endpoints and Zotero's own (/connector/saveItems saves items) too (reference-map).
  for (const p of col.serverPatches)
    if (!p.ownPaths && p.zoteroHeader) col.cap("local-http-server", p.hit, OPENS_ALL[p.origins]);
  const reachedBy = (ep: ServerEndpoint): ServerPatch["origins"] | null => {
    const patch = col.serverPatches.find((p) => p.ownPaths || p.zoteroHeader || ep.decl.unsafe);
    let who: ServerPatch["origins"] | null = patch
      ? patch.origins
      : ep.decl.unsafe && pageCanSend(ep.decl) && !ep.code.needsHeader
        ? "any"
        : null;
    // A token the page can't know stops it; asking the user first leaves the sites they approve.
    if (ep.code.secret && col.makesSecrets) who = null;
    if (who === "any" && ep.code.asks) who = "approved";
    return who;
  };
  const offByDefault = (s: Setting | null): string | null => {
    if (!s) return null;
    // Zotero's local API stays off until the user turns it on, unless this plugin does.
    if (s.key.endsWith(LOCAL_API_PREF))
      return col.caps.get("enables-local-api")?.apis.has(LOCAL_API_PREF) ? null : LOCAL_API_PREF;
    const value =
      col.prefDefaults.get(s.key) ??
      [...col.prefDefaults].find(([k]) => k.endsWith(`.${s.key}`))?.[1] ??
      s.fallback;
    return value && /^(false|!1|!0x1|0)$/.test(value.trim()) ? s.key : null;
  };
  const writers = libraryWriters(col);
  const unkeyed = unkeyedFunctions(col);
  for (const ep of col.serverEndpoints) {
    if (!ep.code.edits) {
      ep.code.edits = writerCalled(col, writers, ep.code);
      // A write in another file: nothing here says it needs a key.
      if (ep.code.edits) ep.code.unkeyed = true;
    }
    if (callsUnkeyed(col, unkeyed, ep.code)) ep.code.unkeyed = true;
  }
  const open: ServerEndpoint[] = [];
  let worst:
    | {
        ep: ServerEndpoint;
        who: ServerPatch["origins"] | null;
        setting: string | null;
        needsKey: boolean;
        rank: number;
      }
    | undefined;
  const reached = col.serverEndpoints.map((ep) => ({
    ep,
    who: reachedBy(ep),
    setting: offByDefault(ep.setting),
  }));
  // Library content handed to web pages, or items found without a key (the selected ones, a
  // search, a number): a page could learn items' keys there.
  const pagesRead = reached.some(
    ({ ep, who, setting }) =>
      (ep.code.reads || ep.code.unkeyed) &&
      !ep.code.edits &&
      (who === "any" || who === "listed") &&
      !setting,
  );
  col.pagesSeeKeys = pagesRead;
  for (const { ep, who, setting } of reached) {
    if (who && !setting) open.push(ep);
    if (ep.code.reads && !ep.code.edits && (who === "any" || who === "listed") && !setting)
      col.cap("local-http-server", ep.hit, "web pages can read the library");
    if (!ep.code.edits) continue;
    // Behind a setting that's off by default it counts one step lower (preview.ts rates it); so
    // does a change a website can make only with the key of an item it already knows.
    const needsKey = !!who && ep.code.byKey && !ep.code.unkeyed && !pagesRead;
    const rank =
      (who === "any" || who === "listed" ? 3 : who === "approved" ? 2 : 1) -
      (setting ? 1 : 0) -
      (needsKey ? 1 : 0);
    if (!worst || rank > worst.rank) worst = { ep, who, setting, needsKey, rank };
  }
  if (worst?.ep.code.edits) {
    const cap = col.cap("server-edits-library", worst.ep.code.edits);
    cap.hits.push(worst.ep.hit);
    if (worst.who) cap.web = worst.who;
    if (worst.setting) cap.setting = worst.setting;
    if (worst.needsKey) cap.needsKey = true;
    for (const ep of col.serverEndpoints) if (ep.code.edits && ep.path) cap.endpoints.add(ep.path);
  }
  return open;
}

/**
 * Functions in other files that write to the library, directly or through the functions they call
 * (by name, a few calls up; a name several functions share stops the trail).
 */
function libraryWriters(col: Collector): Map<string, Hit> {
  const writers = new Map(col.libraryWriters);
  let frontier = [...writers.keys()];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: string[] = [];
    for (const w of frontier) {
      if ((col.fnDefs.get(w) ?? 0) > 3) continue;
      for (const caller of col.calledFrom.get(w) ?? [])
        if (!writers.has(caller)) {
          writers.set(caller, writers.get(w) as Hit);
          next.push(caller);
        }
    }
    frontier = next;
  }
  return writers;
}

/** A write to the library in another file that the code calls by name, if any. */
function writerCalled(col: Collector, writers: Map<string, Hit>, code: EndpointCode): Hit | null {
  for (const name of code.calls) {
    const w = writers.get(name);
    if (w && (col.fnDefs.get(name) ?? 0) <= 3) return w;
  }
  return null;
}

/**
 * Named functions that find or make items without a key, and the functions that call them, a few
 * calls up (a name several functions share stops the trail).
 */
function unkeyedFunctions(col: Collector): Set<string> {
  const out = new Set(col.unkeyedFns);
  let frontier = [...out];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      if ((col.fnDefs.get(f) ?? 0) > 3) continue;
      for (const caller of col.calledFrom.get(f) ?? [])
        if (!out.has(caller)) {
          out.add(caller);
          next.push(caller);
        }
    }
    frontier = next;
  }
  return out;
}

/**
 * The code calls, by name, a function in another file that finds or makes items without a key
 * (an import there, the selected items): its changes don't all need a key, whichever file makes
 * them.
 */
function callsUnkeyed(col: Collector, unkeyed: Set<string>, code: EndpointCode): boolean {
  return code.calls.some((name) => unkeyed.has(name) && (col.fnDefs.get(name) ?? 0) <= 3);
}

/**
 * Servers it opens itself, once every file is read: which ones any website can reach, and what
 * they do for it. Zotero's checks don't stand in front of them. A page can send 127.0.0.1 a GET
 * or a text/plain or form POST without a preflight (it can't read the reply, but the server acts
 * on it) and open a WebSocket, unless the handler reads the Origin header, compares a secret the
 * page can't know, needs a header only a preflight lets it send, or turns away bodies that aren't
 * JSON (with `Access-Control-Allow-Origin: *` the preflight passes too). A Host check doesn't stop
 * it: the page's request names 127.0.0.1 itself. The worst server decides: one that changes the
 * library, runs code it's sent or hands a stored key to an address the request gives; the same
 * behind a setting that's off by default (named, one step lower); or one that does neither.
 */
function rateOwnServers(col: Collector, runner: Hit | null) {
  const cap = col.caps.get("own-server");
  if (!cap || !col.ownServers.length) return;
  const writers = libraryWriters(col);
  const unkeyed = unkeyedFunctions(col);
  const corsAny = cap.apis.has("web pages can call it");
  const launches = launchesOwn(col);
  const counted = col.ownServers.filter(
    (s) => (s.kind !== "node" && s.kind !== "python") || launches,
  );
  const secret = (s: OwnServer) => s.code.secret && (s.kind === "python" || col.makesSecrets);
  const reachable = counted.filter((s) => {
    const c = s.code;
    return !(
      s.refusesOnly ||
      c.origin ||
      secret(s) ||
      c.needsHeader ||
      (c.jsonOnly && !s.cors && !corsAny)
    );
  });
  // Every server it runs wants a secret a page can't know (or only answers "not found"): then
  // `Access-Control-Allow-Origin: *` lets no page talk to it (systematic-reviewer's tokens).
  if (counted.length && counted.every((s) => s.refusesOnly || secret(s)))
    cap.apis.delete("web pages can call it");
  // A page that can read answers (`Access-Control-Allow-Origin: *`) with library content or items
  // found without a key in them, here or from Zotero's server, could learn items' keys there.
  const keysShown =
    reachable.some((s) => (s.cors || corsAny) && (s.code.reads || s.code.unkeyed)) ||
    col.pagesSeeKeys;
  let worst:
    | {
        rank: number;
        actions: Set<ServerAction>;
        setting: string | null;
        needsKey: boolean;
        at: Hit[];
      }
    | undefined;
  let webRuns = false;
  for (const s of reachable) {
    const c = s.code;
    if (!c.edits) {
      c.edits = writerCalled(col, writers, c);
      // A write in another file: nothing here says it needs a key.
      if (c.edits) c.unkeyed = true;
    }
    if (callsUnkeyed(col, unkeyed, c)) c.unkeyed = true;
    // Each thing it does, with the setting (off by default) that it waits for, if any.
    const actions = new Map<ServerAction, string | null>();
    if (c.edits) actions.set("changes-library", settingOffByDefault(col, c.writeSetting));
    const runs =
      s.runsCode ||
      (!!runner &&
        runner.file === c.file &&
        c.ranges.some(([a, b]) => runner.offset >= a && runner.offset < b));
    if (runs) actions.set("runs-code", null);
    if (s.sendsKeys) actions.set("sends-keys", null);
    webRuns ||= runs;
    const gates = [...actions.values()];
    const setting =
      settingOffByDefault(col, s.setting) ??
      (gates.length && gates.every(Boolean) ? (gates[0] as string) : null);
    // Changes a website can make only to an item whose key it already knows: one step lower too.
    const needsKey = actions.size === 1 && !!c.edits && c.byKey && !c.unkeyed && !keysShown;
    const rank = actions.size ? 3 - (setting ? 1 : 0) - (needsKey ? 1 : 0) : 0;
    // Where it does it: the write, the code it runs, the request handling.
    const at = [c.edits, runs && runner && runner.file === c.file ? runner : null, s.hit].filter(
      (h): h is Hit => !!h,
    );
    if (!worst || rank > worst.rank)
      worst = {
        rank,
        actions: new Set(actions.keys()),
        setting: actions.size ? setting : null,
        needsKey,
        at,
      };
  }
  if (!worst) return;
  cap.web = "any";
  if (worst.actions.size) {
    cap.serverActions = worst.actions;
    for (const h of worst.at) if (!cap.hits.includes(h)) cap.hits.push(h);
  }
  if (worst.setting) cap.setting = worst.setting;
  if (worst.needsKey) cap.needsKey = true;
  // …and code it runs for them is code web pages can send.
  if (webRuns) col.caps.get("runs-sent-code")?.apis.add("web pages");
}

/** The innermost function around the node at the end of `anc`, or null at module level. */
/** Calls and properties that show or copy text rather than run it. */
const DISPLAY_CALL =
  /^(alert|confirm|prompt|log|warn|error|info|debug|trace|dump|setText|createTextNode|insertAdjacentHTML|writeText|copyToClipboard|copyText|copy|addNotification|setL10nArgs|t|i18n|localize|getString|formatString|(show|render|make|create|add|build|set)\w*(Message|Text|Hint|Help|Code|Block|Notice|Error|Warning|Label|Tip|Snippet|Instructions?|Toast|Alert|Status|Description))$/;
const DISPLAY_KEY =
  /^(message|msg|text|label|title|hint|help|helpText|description|desc|placeholder|tooltip|tooltiptext|html|innerHTML|textContent|body|detail|note|tip|instructions?|example|snippet|markdown)$/i;
const DISPLAY_PROP =
  /^(textContent|innerHTML|innerText|value|title|placeholder|label|tooltipText)$/;
const DISPLAY_FN =
  /(message|hint|help|instructions?|guide|tip|error|warning|failure|html|markdown|text|label)$|^(describe|format|explain|humanize)[A-Z]/i;
/** Nodes a string passes through while being assembled into a bigger one. */
const ASSEMBLY = new Set([
  "TemplateLiteral",
  "BinaryExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "ArrayExpression",
  "ParenthesizedExpression",
]);

/**
 * Where a string or a call's result goes: "shown" when it is only displayed or copied (an error
 * message, a log line, an alert, a Copy button's code block, a label), `{ fn }` when a function
 * returns it (resolved through that function's call sites after the walk), else "used".
 */
type TextContext = "shown" | "used" | { fn: string };

export function textContext(anc: AstNode[]): TextContext {
  let i = anc.length - 2;
  let child = anc.at(-1);
  while (i >= 0) {
    const a = anc[i] as AstNode;
    const joinCall =
      a.type === "CallExpression" &&
      /\.(join|concat|replace|trim|repeat)$/.test(chain(node(a.callee)) ?? "");
    if (
      ASSEMBLY.has(a.type) ||
      joinCall ||
      (a.type === "MemberExpression" && node(a.object) === child)
    ) {
      child = a;
      i--;
      continue;
    }
    if (a.type === "ThrowStatement") return "shown";
    if (a.type === "NewExpression" && /Error$/.test(chain(node(a.callee)) ?? "")) return "shown";
    if (a.type === "CallExpression" && node(a.callee) !== child) {
      const name = (chain(node(a.callee)) ?? "").split(".").at(-1) ?? "";
      return DISPLAY_CALL.test(name) ? "shown" : "used";
    }
    if (a.type === "Property" && node(a.value) === child)
      return DISPLAY_KEY.test((node(a.key)?.name as string) ?? str(node(a.key)) ?? "")
        ? "shown"
        : "used";
    if (a.type === "AssignmentExpression" && node(a.right) === child) {
      const left = node(a.left);
      // `el.textContent = …`, and text put together in a message: `message += "  pip install …"`.
      return (left?.type === "MemberExpression" &&
        DISPLAY_PROP.test((node(left.property)?.name as string) ?? "")) ||
        (left?.type === "Identifier" && DISPLAY_KEY.test(left.name as string))
        ? "shown"
        : "used";
    }
    if (
      a.type === "ReturnStatement" ||
      (a.type === "ArrowFunctionExpression" && node(a.body) === child)
    ) {
      const at =
        a.type === "ReturnStatement"
          ? anc.slice(0, i).findLastIndex((x) => FUNCTION_TYPES.has(x.type))
          : i;
      const fn = anc[at];
      const name = fn ? functionName(fn, anc[at - 1]) : null;
      if (!name) return "used";
      return DISPLAY_FN.test(name) ? "shown" : { fn: name };
    }
    return "used";
  }
  return "used";
}

/** Follows `{ fn }` through the function's call sites: shown only if every use is shown. */
function resolveContext(col: Collector, ctx: TextContext, depth = 0): "shown" | "used" {
  if (typeof ctx === "string") return ctx;
  const sites = col.callSites.get(ctx.fn);
  if (!sites?.length || depth > 4) return "used";
  return sites.every((s) => resolveContext(col, s, depth + 1) === "shown") ? "shown" : "used";
}

/**
 * Inside an MCP client config (`mcpServers: { x: { command: "npx", … } }`) another app runs,
 * whatever that app calls the key (Continue's `modelContextProtocolServers`).
 */
function inMcpConfig(anc: AstNode[]): boolean {
  return anc.some(
    (a) =>
      a.type === "Property" &&
      /^(mcpServers|mcp_servers|context_servers|mcp)$|mcp_?servers$|^modelContextProtocol/i.test(
        (node(a.key)?.name as string) ?? str(node(a.key)) ?? "",
      ),
  );
}

/**
 * Inside a function that writes instructions or messages (`getInstallInstructions`, `formatHelp`):
 * a command line there is text for the user, wherever the string goes next (a lookup table of
 * hints per platform).
 */
function inDisplayFn(anc: AstNode[]): boolean {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    if (!FUNCTION_TYPES.has(a.type)) continue;
    const name = functionName(a, anc[i - 1]);
    if (name) return DISPLAY_FN.test(name);
  }
  return false;
}

/**
 * The named function code at the end of `anc` runs in, through callbacks that run in the same
 * turn or later by themselves (`.then(…)`, `setTimeout(…)`, `forEach(…)`, `new Promise(…)`); null
 * inside any other callback, like an event handler, which waits for the user.
 */
function callerName(anc: AstNode[]): string | null {
  return callerFn(anc)?.name ?? null;
}

/** The same named function, with its node. */
function callerFn(anc: AstNode[]): { name: string; fn: AstNode } | null {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    if (!FUNCTION_TYPES.has(a.type)) continue;
    const parent = anc[i - 1];
    const name = functionName(a, parent);
    if (name) return { name, fn: a };
    if (parent?.type === "CallExpression" && node(parent.callee) === a) continue;
    const callee = chain(node(parent?.callee)) ?? "";
    if (
      (parent?.type === "CallExpression" &&
        /(^|\.)(then|catch|finally|setTimeout|setInterval|requestIdleCallback|queueMicrotask|forEach|map|flatMap|filter|some|every|reduce|find|enqueue\w*|schedule\w*|defer\w*)$/.test(
          callee,
        )) ||
      (parent?.type === "NewExpression" && /(^|\.)Promise$/.test(callee))
    )
      continue;
    return null;
  }
  return null;
}

/** A test for something being there already: a file, a folder, an installed package. */
const INSTALLED_TEST = /exist|installed|\bisFile\b|\bisDir(?:ectory)?\b/i;

/** A branch that leaves at once: `return`, `throw`, or a block ending with one. */
function leaves(st: AstNode | undefined): boolean {
  if (!st) return false;
  if (st.type === "ReturnStatement" || st.type === "ThrowStatement") return true;
  return st.type === "BlockStatement" && leaves(nodes(st.body).at(-1));
}

/**
 * Whether the code at the end of `anc` runs only when what it installs isn't there yet, in its
 * own function: in the branch of an `if` testing for it missing (`if (!fileExists(envPython)) {
 * … pip install … }`, paperviewzoteroplugin), the `else` of one testing it's there, or after
 * `if (exists(venv)) return;`. Such an install happens once, not on every run.
 */
function installedCheck(code: string, anc: AstNode[]): boolean {
  const tests = (t: AstNode | undefined) => !!t && INSTALLED_TEST.test(code.slice(t.start, t.end));
  const negated = (t: AstNode | undefined) => t?.type === "UnaryExpression" && t.operator === "!";
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    const child = anc[i + 1];
    if (FUNCTION_TYPES.has(a.type)) break;
    if (a.type === "IfStatement" || a.type === "ConditionalExpression") {
      const t = node(a.test);
      if (tests(t) && (negated(t) ? node(a.consequent) : node(a.alternate)) === child) return true;
    }
    if (a.type === "BlockStatement") {
      const body = nodes(a.body);
      for (const st of body.slice(0, body.indexOf(child as AstNode)))
        if (
          st.type === "IfStatement" &&
          tests(node(st.test)) &&
          !negated(node(st.test)) &&
          leaves(node(st.consequent))
        )
          return true;
    }
  }
  return false;
}

/**
 * The check a caller runs before a function that installs: `const depsOk = await
 * this.checkDependencies(py); if (!depsOk) { … this.installDependencies(py) }` (zotero-notebooklm),
 * `if (!(await venvExists())) await setup()`. Read from the caller's code up to the call, with no
 * block closed in between.
 */
const CALLER_INSTALLED_CHECK =
  /\bif\s*\(\s*!\s*\(?\s*(?:await\s+)?(?:this\.)?[\w$.]*(?:Ok|OK|[Ee]xists?|[Ii]nstalled|[Rr]eady|[Aa]vailable|(?:check|has|is)\w*(?:Deps|Dependencies|Env|Venv|Installed|Exists?|Ready))\b(?:\s*\([^()]*\))?\s*\)?\s*\)\s*\{?[^{}]*$/;

/** Every call into the install's function waits for an "already installed" check in its caller. */
function calledOnce(col: Collector, run: PackageRun): boolean {
  if (!run.fn) return false;
  const edges = callersOf(col, run.fn, run.file);
  return (
    edges.length > 0 &&
    edges.every((e) => CALLER_INSTALLED_CHECK.test(e.file.text.slice(e.span[0], e.at)))
  );
}

/** A function that sets something up: installs, updates or prepares an environment. */
const SETUP_STEP = /install|ensure|setup|update|upgrade|bootstrap|prepare|deps|dependenc|env/i;
/** Zotero's startup hooks: the bootstrap's own, and the plugin template's. */
const STARTUP_HOOK = /^(startup|onStartup|onMainWindowLoad)$/;
const SHUTDOWN_HOOK = /^(shutdown|onShutdown|uninstall)$/;

/**
 * Whether a function runs from a startup hook, following calls by name. A name two functions
 * share could be either, so the trail stops there.
 */
function runsAtStartup(col: Collector, fn: string | null | undefined): boolean {
  if (!fn) return false;
  let frontier = [fn];
  const seen = new Set(frontier);
  for (let depth = 0; depth <= 6 && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      if (STARTUP_HOOK.test(f)) return true;
      if ((col.fnDefs.get(f) ?? 0) > 1) continue;
      for (const c of col.calledFrom.get(f) ?? [])
        if (!seen.has(c)) {
          seen.add(c);
          next.push(c);
        }
    }
    frontier = next;
  }
  return false;
}

/**
 * Whether the array at the end of `anc` is held where a launch takes its arguments: a call's
 * argument, an `args` property, or a name like `runArgs`, `cmd` or a tool's (`const pip = […]`).
 */
function launchArgs(anc: AstNode[]): boolean {
  let up = anc.length - 2;
  const wrap = anc[up];
  if (wrap?.type === "CallExpression" && /(^|\.)freeze$/.test(chain(node(wrap.callee)) ?? "")) up--;
  const holder = anc[up];
  if (holder?.type === "CallExpression" || holder?.type === "NewExpression") return true;
  const name =
    holder?.type === "Property"
      ? nameOf(holder)
      : holder?.type === "VariableDeclarator"
        ? nameIn(node(holder.id))
        : holder?.type === "AssignmentExpression"
          ? nameIn(node(holder.left))
          : null;
  return (
    !!name &&
    (/(args?|argv|arguments|cmd|command|params)$/i.test(name) || toolNamedBy(name) !== null)
  );
}

function enclosingFn(anc: AstNode[]): AstNode | null {
  for (let i = anc.length - 2; i >= 0; i--)
    if (FUNCTION_TYPES.has((anc[i] as AstNode).type)) return anc[i] as AstNode;
  return null;
}

/**
 * Two names taken from one entry of a list or map: `for (const [k, v] of saved)`,
 * `for (const [k, v] of Object.entries(saved))`, `saved.forEach((v, k) => …)`.
 */
function sameEntry(a: AstNode | undefined, b: AstNode | undefined, anc: AstNode[]): boolean {
  if (a?.type !== "Identifier" || b?.type !== "Identifier") return false;
  const both = (names: (AstNode | undefined)[]) => {
    const ids = names.map((x) => (x?.type === "Identifier" ? x.name : null));
    return ids.includes(a.name) && ids.includes(b.name);
  };
  for (let i = anc.length - 2; i >= 0; i--) {
    const x = anc[i] as AstNode;
    if (x.type === "ForOfStatement") {
      const l = node(x.left);
      const id = l?.type === "VariableDeclaration" ? node(nodes(l.declarations)[0]?.id) : l;
      if (id?.type === "ArrayPattern" && both(nodes(id.elements))) return true;
    }
    if (FUNCTION_TYPES.has(x.type)) {
      const call = anc[i - 1];
      const callee = call?.type === "CallExpression" ? node(call.callee) : undefined;
      if (
        callee?.type === "MemberExpression" &&
        node(callee.property)?.name === "forEach" &&
        both(nodes(x.params))
      )
        return true;
    }
  }
  return false;
}

/** The code of the nearest function around the node at the end of `anc` that has a name. */
function namedAround(anc: AstNode[], base: number): [number, number] | null {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    if (FUNCTION_TYPES.has(a.type) && functionName(a, anc[i - 1]))
      return [base + a.start, base + a.end];
  }
  return null;
}

/** The `case "tool_name":` the node at the end of `anc` sits in, within its own function. */
function toolCase(anc: AstNode[], base: number): { tool?: { name: string; at: number } } {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    if (FUNCTION_TYPES.has(a.type)) break;
    const name = node(a.test)?.value;
    if (a.type === "SwitchCase" && typeof name === "string")
      return { tool: { name, at: base + a.start } };
  }
  return {};
}

/** The name a function is known by: its own, or the variable, property or method it's put in. */
function functionName(fn: AstNode, parent: AstNode | undefined): string | null {
  const id = node(fn.id);
  if (id?.type === "Identifier") return id.name as string;
  if (!parent) return null;
  if (parent.type === "VariableDeclarator") return (node(parent.id)?.name as string) ?? null;
  if (parent.type === "Property" || parent.type === "MethodDefinition") {
    const k = node(parent.key);
    return k?.type === "Identifier" ? (k.name as string) : str(k);
  }
  if (parent.type === "AssignmentExpression")
    return chain(node(parent.left))?.split(".").at(-1) ?? null;
  return null;
}

function parseJs(code: string): AstNode {
  try {
    return parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowHashBang: true,
      allowReserved: true,
    }) as unknown as AstNode;
  } catch {
    return parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
    }) as unknown as AstNode;
  }
}

/** Old Firefox `for each (x in y)` loops: blank the `each` so the rest parses, offsets unchanged. */
const LEGACY_FOR_EACH = /\bfor(\s+)each(\s*\()/g;

export interface Ranges {
  /** Regular expression literals, where Unicode controls are character-class endpoints. */
  regex: [number, number][];
  /** String and template literal text, where short zero-width runs are data, not hidden code. */
  strings: [number, number][];
}

function analyzeJs(
  col: Collector,
  file: SourceFile,
  code: string,
  base: number,
  ranges: Ranges = { regex: [], strings: [] },
): void {
  const regexRanges = ranges.regex;
  let ast: AstNode;
  try {
    ast = parseJs(code);
  } catch (error) {
    const legacy = code.replace(LEGACY_FOR_EACH, (_m, a: string, b: string) => `for${a}    ${b}`);
    try {
      if (legacy === code) throw error;
      ast = parseJs(legacy);
    } catch (error2) {
      col.parseFailures.push({ path: file.path, error: (error2 as Error).message.slice(0, 300) });
      const bytes = Buffer.byteLength(code);
      col.failedBytes.set(file.path, (col.failedBytes.get(file.path) ?? 0) + bytes);
      regexFallback(col, file, code, base);
      return;
    }
  }

  /** Whether a file offset (not a block offset) is the plugin's own code. */
  const own = (offset: number) => file.libraryAt(offset) === null;
  const hit = (n: AstNode | number): Hit => ({
    file,
    offset: base + (typeof n === "number" ? n : n.start),
  });
  const urlLiterals: UrlLiteral[] = [];
  /** Settings named for a session ID, where they're read or set, and the value set. */
  const sessionKeys: { key: string; hit: Hit; value?: AstNode; fns: AstNode[] }[] = [];
  // Names in request arguments: plain variables (`fetch(url)`) and property names (`fetch(cfg.url)`,
  // `${this.baseUrl}…`). A `{ url: … }` key elsewhere in the file (package.json metadata, a guide
  // link) only matches the second kind (review: github.com from inlined package.json).
  const requestNames = new Set<string>();
  /** The functions each request variable is used in (null at module level). */
  const requestScopes = new Map<string, (AstNode | null)[]>();
  /** The request calls each variable (`name`) or property (`.name`) is in, to read their payload. */
  const requestCalls = new Map<string, ReqCall[]>();
  const reqByNode = new Map<AstNode, ReqCall>();
  /** Its own requests, to find those whose address comes from a list in a loop. */
  const ownCalls: ReqCall[] = [];
  const noteCall = (key: string, req: ReqCall | undefined) => {
    if (!req) return;
    const list = requestCalls.get(key) ?? [];
    if (list.length < 20 && !list.includes(req)) list.push(req);
    requestCalls.set(key, list);
  };
  const noteRequestName = (name: string, fn: AstNode | null, req?: ReqCall) => {
    requestNames.add(name);
    const list = requestScopes.get(name) ?? [];
    if (list.length < 20) list.push(fn);
    requestScopes.set(name, list);
    noteCall(name, req);
  };
  const requestProps = new Set<string>();
  const noteRequestProp = (name: string, req: ReqCall) => {
    requestProps.add(name);
    noteCall(`.${name}`, req);
  };
  // A browser cookie/password store this file reads or copies, and the browsers named on the paths
  // around it; another program's login file it reads, by program (dir marker seen, cred file seen).
  let browserStoreHit: Hit | null = null;
  /** The functions that name a browser's store, to see whether they copy it. */
  const browserStoreFns: AstNode[] = [];
  const browserNames = new Set<string>();
  const appLoginDir = new Map<string, Hit>();
  const appLoginFile = new Set<string>();
  let identifiers = 0;
  let hexIdentifiers = 0;
  let firstHex = -1;
  let rawStringChars = 0;
  let escapeChars = 0;
  let firstEscape = -1;

  const bindings = new Bindings();
  // Names assigned something that mentions fetch (`const f = deps.fetch ?? globalThis.fetch`):
  // calls through them are checked once the bindings are known.
  const fetchAliases = new Set<string>();
  const xhrAliases = new Set<string>();
  const httpAliases = new Set<string>();
  for (const m of code.matchAll(/\b(fetch|XMLHttpRequest|HTTP\.\w+)\b/g)) {
    const at = m.index ?? 0;
    const before = code.slice(Math.max(0, at - 80), at);
    const name = before.match(/([A-Za-z_$][\w$]*)\s*(?:=|\?\?=|\|\|=)[^;\n=]*$/)?.[1];
    if (name)
      (m[1] === "fetch" ? fetchAliases : m[1] === "XMLHttpRequest" ? xhrAliases : httpAliases).add(
        name,
      );
  }
  type Call = { n: AstNode; args: AstNode[]; fns: AstNode[] };
  const dbCalls: (Call & { callee: AstNode })[] = [];
  /** A server socket's `init(port, loopbackOnly, backlog)`, with its loopbackOnly argument. */
  const socketInits: Call[] = [];
  const netCalls: (Call & { api: NetworkApi | null; urlIdx: number })[] = [];
  // For following a parameter to what callers pass: each function's name, and the arguments of
  // every call by the called name's last part.
  const fnNames = new Map<AstNode, string>();
  const frameSrcs: { n: AstNode; value: AstNode | undefined; fns: AstNode[] }[] = [];
  /** `{ fetch: window.fetch.bind(window) }` or `{ http: Zotero.HTTP }` handed to other code. */
  const handedOver: { n: AstNode; key: string; value: AstNode; fns: AstNode[] }[] = [];
  const linkHandlers: {
    n: AstNode;
    key: AstNode | undefined;
    name: string;
    value: AstNode | undefined;
    fns: AstNode[];
  }[] = [];
  // Keys: `name` for plain functions and calls, `.name` for methods and member calls, so a
  // toolkit method called `getIcon` doesn't stand in for the plugin's own `getIcon(src)`.
  const callArgs = new Map<string, { args: AstNode[]; fn: AstNode | null; n?: AstNode }[]>();
  const maybeNet: (Call & { isNew: boolean })[] = [];
  const prefSets: (Call & { key: string })[] = [];
  // Zotero's own settings it writes (C33), the names it reads and clears, and other programs'
  // settings files named here, grouped by the function (or constant) naming them.
  const prefWrites: {
    n: AstNode;
    shape: string;
    key: string;
    change: SettingsChange;
    value: boolean | null;
    anc: AstNode[];
    fn: AstNode | null;
    fns: AstNode[];
  }[] = [];
  /**
   * Its reads of settings, to tell a value saved and put back: the key (named once every binding
   * is known) and what the old value is kept in, a name (`const orig = …`, `this.old = …`) or a
   * snapshot of several keyed by name (`saved.set(key, …)`, `saved[key] = …`).
   */
  const prefReads: {
    shape: string;
    at: number;
    fn: AstNode | undefined;
    arg: AstNode | undefined;
    fns: AstNode[];
    kept: string | null;
    snapshot: boolean;
  }[] = [];
  /** Writes that put a snapshot back entry by entry: `for (const [k, v] of saved) set(k, v)`. */
  const snapshotBacks = new Set<AstNode>();
  const prefClears = new Set<string>();
  const fileMarks = new Map<
    AstNode,
    {
      dirs: Set<number>;
      files: Map<
        string,
        { i: number; at: AstNode; anc: AstNode[]; text: string; ctx: TextContext }
      >;
    }
  >();
  /**
   * The names a preference call can write: a literal, or what a name holds. Several (a loop over
   * schemes) share their common start, with the rest marked computed.
   */
  const prefNames = (a: AstNode | undefined, fns: AstNode[]): string[] => {
    const lit = str(a);
    if (lit !== null) return [lit];
    const texts = [...new Set(bindings.texts(a, fns))];
    if (texts.length > 1) {
      let common = texts[0] as string;
      for (const t of texts) while (!t.startsWith(common)) common = common.slice(0, -1);
      return [...texts, `${common}${EXPR}`];
    }
    return texts.length ? texts : [textOf(a)].filter((t): t is string => !!t);
  };
  const setters = new Set<string>();
  const setterUses: { name: string; edge: CallEdge }[] = [];
  const settingsSeen = new Map<string, SettingsSite>();
  /** A settings change at a node: the named function it runs in, for what starts it. */
  const settingsAt = (
    n: AstNode,
    anc: AstNode[],
    change: SettingsChange,
    extra: Partial<
      Pick<
        SettingsSite,
        "target" | "optIn" | "whileInstalled" | "key" | "file" | "paths" | "ctx" | "command"
      >
    > = {},
  ) => {
    if (col.settingsSites.length >= 400) return;
    // A fallback for when an API is missing, after the code that uses it returns
    // (zotero-obsidian-bridge opens links with launchWithURI, which Zotero always has).
    if (exitAbove(code, anc, API_PRESENT)) return;
    const named = callerFn(anc);
    const inner = enclosingFn(anc);
    // At module level (or a bundle's wrapper, `(() => { … })()`), the constant it's held in:
    // the functions using it lead to it.
    const wrapper = !named && !!inner && wrapperFn(anc, inner);
    const fnNode = wrapper ? null : (named?.fn ?? inner);
    const decl = fnNode ? undefined : anc.findLast((a) => a.type === "VariableDeclarator");
    const id = node(decl?.id);
    // One site per change in a function: `apply()` writing ten proxy settings is one change.
    // Every file it names there is kept: which one a write goes to is read later.
    const { key: _, ctx: __, paths, ...what } = extra;
    const key = JSON.stringify([change, what, fnNode?.start ?? decl?.start ?? n.start]);
    const seen = settingsSeen.get(key);
    if (seen) {
      for (const p of paths ?? [])
        if (!seen.paths?.includes(p)) seen.paths = [...(seen.paths ?? []), p];
      return;
    }
    const site: SettingsSite = {
      hit: hit(n),
      change,
      ...extra,
      guard: guardAbove(code, anc),
      fn: named?.name ?? null,
      span: fnNode ? [base + fnNode.start, base + fnNode.end] : [base + n.start, base + n.start],
      holder: fnNode
        ? holderOf(anc, fnNode, base)
        : decl && id?.type === "Identifier"
          ? { name: id.name as string, span: [base + decl.start, base + decl.end] }
          : null,
    };
    settingsSeen.set(key, site);
    col.settingsSites.push(site);
  };
  /** A settings command: global installs name their packages. */
  const commandAt = (
    s: (typeof SETTINGS_COMMANDS)[number],
    text: string,
    n: AstNode,
    anc: AstNode[],
    ctx: TextContext,
  ) => {
    if (s.change === "global-install" && !s.target)
      for (const p of globalPackages(text))
        settingsAt(n, anc, s.change, { target: p, ctx, command: true });
    else
      settingsAt(n, anc, s.change, {
        ...(s.target ? { target: s.target } : {}),
        ctx,
        command: true,
      });
  };
  /**
   * Text in its own code that changes another program or the computer (C33): a command, a shell
   * script it ships named where it's run, or part of another program's settings file path.
   */
  const noteSettingsText = (text: string, n: AstNode, anc: AstNode[]) => {
    const commands = SETTINGS_HINT.test(text)
      ? SETTINGS_COMMANDS.filter((s) => !s.argsOnly && s.re.test(text))
      : [];
    const scripts = [...col.scripts].filter(
      ([name, changes]) =>
        changes.length &&
        text.includes(name) &&
        new RegExp(String.raw`(?:^|[\s/\\"'])${name.replaceAll(".", "\\.")}(?:$|[\s"';&|])`).test(
          text,
        ),
    );
    const files = isPathToken(text)
      ? SETTINGS_FILES.flatMap((f, i) => (f.file.test(text) || f.dir?.test(text) ? [i] : []))
      : [];
    if (!commands.length && !scripts.length && !files.length) return;
    // Instructions for the user to copy, an error message, a help line; a function's result is
    // judged by where its callers put it, once every file is read.
    const ctx = textContext(anc);
    if (inDisplayFn(anc) || ctx === "shown") return;
    for (const s of commands) commandAt(s, text, n, anc, ctx);
    for (const [, changes] of scripts)
      for (const s of changes)
        settingsAt(n, anc, s.change, {
          ...(s.target ? { target: s.target } : {}),
          ctx,
          command: true,
        });
    if (!files.length) return;
    const fn = enclosingFn(anc);
    const group =
      (fn && !wrapperFn(anc, fn) ? fn : anc.findLast((a) => a.type === "VariableDeclarator")) ??
      anc[0];
    if (!group) return;
    const mark = fileMarks.get(group) ?? { dirs: new Set(), files: new Map() };
    for (const i of files) {
      const f = SETTINGS_FILES[i];
      if (f?.dir?.test(text)) mark.dirs.add(i);
      // Each folder of its own: `.claude/skills` and `.codex/skills` side by side.
      if (f?.file.test(text) && !mark.files.has(`${i}:${text}`))
        mark.files.set(`${i}:${text}`, { i, at: n, anc: [...anc], text, ctx });
    }
    fileMarks.set(group, mark);
  };
  const scriptSrcs: {
    n: AstNode;
    receiver: AstNode | undefined;
    value: AstNode | undefined;
    fns: AstNode[];
  }[] = [];
  const subScripts: { n: AstNode; arg: AstNode; fns: AstNode[] }[] = [];
  let createsScript = false;
  const evalNames: { n: AstNode; name: string; fns: AstNode[]; c: string }[] = [];
  const sqliteOpens: Call[] = [];
  const libInstalls: Hit[] = [];
  const toolkitFile = new ToolkitFile(col.toolkit);
  // Arrays read only at constant indexes (`$Q[1].api`): entries never read are never used.
  const nameRefs = new Map<string, number>();
  const constIndexReads = new Map<string, Set<number>>();
  const constIndexCount = new Map<string, number>();
  const linkCalls: { arg: AstNode; fns: AstNode[] }[] = [];
  const returnIds: { name: string; arg: AstNode; fns: AstNode[] }[] = [];
  let returnsSeen = 0;
  const templates: {
    n: AstNode;
    fns: AstNode[];
    usage: Usage;
    binding: string | null;
    returnFn?: string;
    call?: ReqCall;
    fallback?: boolean;
    mirror?: boolean;
  }[] = [];
  // Zotero's own server, read after the walk (ServerScan): assignments that may put an endpoint
  // into Zotero.Server.Endpoints, prototypes and classes by name, patches to its request handling,
  // MCP tool handlers, and calls that may pass an endpoint to a registering helper.
  const serverFile =
    /Endpoints|RequestHandler|DataListener|server-?socket|nsIServerSocket|registerPathHandler|createServer/.test(
      code,
    );
  // Servers it opens itself: a server socket, httpd.js (Gecko's or the Remote Agent's copy), or an
  // HTTP server in a Node program it ships (Zotero's own code can't load Node's modules).
  const socketFile = /server-socket;1|nsIServerSocket/.test(code);
  const httpdFile = /\bHttpServer\b|httpd(?:\.sys\.mjs|\.js)/.test(code);
  const nodeNetFile = NODE_NET_MODULE.test(code);
  const ownSites: OwnSite[] = [];
  const nodeEvents: AstNode[] = [];
  let nodeListensWide: Hit | null = null;
  // An MCP server's tool dispatch: calls in its `case "tool_name":` branches do what a message asks.
  const mcpFile = MCP_HINT.test(code);
  const serverAssigns: {
    n: AstNode;
    fns: AstNode[];
    setting: Setting | null;
    alias: string | null;
  }[] = [];
  const serverPatchSites: { n: AstNode; fns: AstNode[] }[] = [];
  const protos = new Map<string, AstNode[]>();
  const classes = new Map<string, AstNode[]>();
  const mcpTools: AstNode[] = [];
  const writeTools: AstNode[] = [];
  const loops = new Map<string, { list: AstNode; fn: AstNode | null }[]>();
  const helperSites: {
    n: AstNode;
    name: string;
    args: AstNode[];
    fns: AstNode[];
    setting: Setting | null;
  }[] = [];
  const noteServer = (n: AstNode, anc: AstNode[]) => {
    if (n.type === "AssignmentExpression" && n.operator === "=") {
      const left = node(n.left);
      const right = node(n.right);
      if (left?.type !== "MemberExpression" || !right) return;
      const target = chain(left) ?? "";
      const obj = node(left.object);
      // Only what `new` can build: a function, a class, or a name or call that gives one.
      const buildable =
        FUNCTION_TYPES.has(right.type) ||
        /^(ClassExpression|Identifier|CallExpression|NewExpression|MemberExpression|ChainExpression|LogicalExpression|ConditionalExpression)$/.test(
          right.type,
        );
      if (
        buildable &&
        serverAssigns.length < 20_000 &&
        ((left.computed && obj?.type === "Identifier") || nameOf(obj) === "Endpoints")
      ) {
        const up = anc.at(-2);
        const alias =
          up?.type === "VariableDeclarator"
            ? node(up.id)?.name
            : up?.type === "AssignmentExpression"
              ? node(up.left)?.name
              : null;
        serverAssigns.push({
          n,
          fns: fnsIn(anc),
          setting: settingIf(code, anc),
          alias: typeof alias === "string" ? alias : null,
        });
      }
      if (
        /\.(handleRequest|_generateResponse|_processEndpoint|_bodyData|_requestFinished)$/.test(
          target,
        )
      )
        serverPatchSites.push({ n, fns: fnsIn(anc) });
      // By how it's written: `E.prototype = {…}`, `Zotero.Server.Endpoints[path].prototype = h`.
      const at =
        nameOf(left) === "prototype" ? obj : nameOf(obj) === "prototype" ? node(obj?.object) : null;
      const proto = at && code.slice(at.start, at.end).replace(/\s+/g, "");
      if (proto && (protos.get(proto)?.length ?? 0) < 10)
        protos.set(proto, [...(protos.get(proto) ?? []), right]);
    } else if (n.type === "ForOfStatement" && node(n.left)?.type === "VariableDeclaration") {
      const id = node(nodes(node(n.left)?.declarations)[0]?.id);
      const list = node(n.right);
      if (id && list && id.type !== "Identifier")
        for (const d of descendants(id))
          if (d.type === "Identifier")
            loops.set(d.name as string, [
              ...(loops.get(d.name as string) ?? []).slice(0, 9),
              { list, fn: enclosingFn(anc) },
            ]);
    } else if (n.type === "ClassDeclaration" && node(n.id)?.type === "Identifier") {
      const name = node(n.id)?.name as string;
      classes.set(name, [...(classes.get(name) ?? []), n].slice(0, 5));
    } else if (n.type === "ObjectExpression" && mcpTools.length < 400) {
      // An MCP tool: `{ name: "create_note", inputSchema: {…}, handler(args) {…} }`.
      const props = nodes(n.properties);
      const name = props.find(
        (p) => nameOf(p) === "name" && typeof node(p.value)?.value === "string",
      );
      if (name && props.some((p) => TOOL_SPEC_KEY.test(nameOf(p) ?? ""))) {
        for (const p of props) {
          const v = node(p.value);
          if (v && FUNCTION_TYPES.has(v.type) && TOOL_FN_KEY.test(nameOf(p) ?? ""))
            mcpTools.push(v);
        }
        const value = node(name.value);
        if (value && writesLibraryTool(value.value as string)) writeTools.push(value);
      }
      // …or keyed by its name: `{ "item.create": { fields, description: "Create a Zotero item" } }`.
      for (const p of props.slice(0, 200)) {
        const k = node(p.key);
        const v = node(p.value);
        if (
          k?.type === "Literal" &&
          typeof k.value === "string" &&
          v?.type === "ObjectExpression" &&
          nodes(v.properties).some((q) => TOOL_SPEC_KEY.test(nameOf(q) ?? "")) &&
          writesLibraryTool(k.value)
        )
          writeTools.push(k);
      }
    } else if (n.type === "CallExpression" && mcpTools.length < 400) {
      // `server.registerTool("create_note", schema, async (args) => …)`, or a definition helper
      // given a name, a description and a schema (`def("create_item", "Create…", { title: … })`).
      const args = nodes(n.arguments);
      const first = node(args[0]);
      const last = args.at(-1);
      const tool = /(^|\.)(registerTool|tool|addTool)$/.test(chain(node(n.callee)) ?? "");
      if (tool && typeof first?.value === "string" && last && FUNCTION_TYPES.has(last.type))
        mcpTools.push(last);
      if (
        typeof first?.value === "string" &&
        (tool ||
          (typeof node(args[1])?.value === "string" &&
            args.slice(2).some((a) => a.type === "ObjectExpression"))) &&
        writesLibraryTool(first.value as string)
      )
        writeTools.push(first);
    }
  };

  fullAncestor(ast as never, (raw: unknown, _state: unknown, ancestors: unknown[]) => {
    const n = raw as AstNode;
    const anc = ancestors as AstNode[];
    toolkitFile.visit(n, anc);
    if (serverFile) noteServer(n, anc);
    if (n.type === "Property" && node(n.value) && !n.computed) {
      const key = (node(n.key)?.name as string) ?? str(node(n.key)) ?? "";
      const value = node(n.value);
      if (
        (STARTUP_HOOK.test(key) || SHUTDOWN_HOOK.test(key)) &&
        value?.type === "Identifier" &&
        value.name !== key &&
        own(base + n.start)
      )
        col.hookNames.set(value.name as string, key);
      if (/^(fetch|fetchImpl|fetchFn|http|httpClient|transport|request)$/i.test(key))
        handedOver.push({
          n,
          key,
          value: node(n.value) as AstNode,
          fns: anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
        });
    }
    if (FUNCTION_TYPES.has(n.type)) {
      const parent = anc[anc.length - 2];
      const name = functionName(n, parent);
      const member =
        parent?.type === "Property" ||
        parent?.type === "MethodDefinition" ||
        (parent?.type === "AssignmentExpression" && node(parent.left)?.type === "MemberExpression");
      if (name) fnNames.set(n, member ? `.${name}` : name);
      // A getter is read, never called by name: it doesn't share its name with the setter.
      if (name && own(base + n.start) && parent?.kind !== "get") {
        col.fnDefs.set(name, (col.fnDefs.get(name) ?? 0) + 1);
        const spans = col.fnSpans.get(name) ?? [];
        if (spans.length < 8) spans.push({ file, span: [base + n.start, base + n.end] });
        col.fnSpans.set(name, spans);
        if (parent?.kind === "set") setters.add(name);
      }
    } else if (n.type === "CallExpression") {
      const callee = node(n.callee);
      const last = chain(callee)?.split(".").at(-1);
      if (last) {
        const key = callee?.type === "MemberExpression" ? `.${last}` : last;
        const list = callArgs.get(key) ?? [];
        if (list.length < 50) list.push({ args: nodes(n.arguments), fn: enclosingFn(anc), n });
        callArgs.set(key, list);
      }
      // Who calls each name, to follow a package install back to Zotero's startup hooks.
      if (last && last.length > 2 && own(base + n.start) && col.calledFrom.size < 50000) {
        const from = callerName(anc);
        const set = col.calledFrom.get(last) ?? new Set<string>();
        if (from && from !== last && set.size < 20) set.add(from);
        col.calledFrom.set(last, set);
      }
      // …and where each call sits, to follow an add-on install or a settings change back to
      // what starts it; minified names count too (zotero-prism's `gm()` from onStartup).
      if (last && last.length > 1 && own(base + n.start) && !COMMON_CALLS.has(last)) {
        const from = callerFn(anc);
        const edges = col.callEdges.get(last) ?? [];
        if (from && from.name !== last && edges.length < 20 && col.edgeCount < 200000) {
          edges.push({
            caller: from.name,
            file,
            span: [base + from.fn.start, base + from.fn.end],
            at: base + n.start,
            setting: settingIf(code, anc),
            ...(mcpFile ? toolCase(anc, base) : {}),
          });
          col.callEdges.set(last, edges);
          col.edgeCount++;
        }
      }
      // A function handed to a timer runs by itself: `setTimer(tick, delayMs)`.
      const first = node(nodes(n.arguments)[0]);
      if (
        last &&
        /^set(Timeout|Interval|Timer)$/.test(last) &&
        first?.type === "Identifier" &&
        own(base + n.start)
      )
        col.timerFns.add(`${file.path}\0${first.name as string}`);
      // …and an observer's `notify` runs when Zotero adds or changes items, without a click
      // (zotero-image-uploader uploads each new image annotation).
      if (/(^|\.)Notifier\.registerObserver$/.test(chain(callee) ?? "") && own(base + n.start)) {
        col.eventFns.add(`${file.path}\0notify`);
        const held = node(nodes(first?.properties).find((q) => nameOf(q) === "notify")?.value);
        if (held?.type === "Identifier") col.eventFns.add(`${file.path}\0${held.name as string}`);
      }
    }
    if ((n.type === "VariableDeclarator" || n.type === "Property") && own(base + n.start))
      noteSpecValue(col, n);
    // `addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_ENABLE`, or a helper returning it:
    // it turns Zotero's automatic updates on for an add-on (literature-review-with-llm, for itself
    // at every start). Whether it runs at startup is read once every call is known.
    if (
      n.type === "AssignmentExpression" &&
      nameOf(node(n.left)) === "applyBackgroundUpdates" &&
      own(base + n.start)
    ) {
      const value = node(n.right);
      const helper =
        value?.type === "CallExpression" ? chain(node(value.callee))?.split(".").at(-1) : null;
      const helperCode = helper
        ? code.match(
            new RegExp(String.raw`function\s+${helper.replaceAll("$", "\\$")}\b[^]{0,600}`),
          )
        : null;
      if (
        /AUTOUPDATE_ENABLE|^2$/.test(value ? code.slice(value.start, value.end) : "") ||
        /AUTOUPDATE_ENABLE/.test(helperCode?.[0] ?? "")
      )
        col.autoUpdateSets.push({ hit: hit(n), fn: callerName(anc) });
    }
    // Zotero's configuration or code changed in memory (C33): ZOTERO_CONFIG's service addresses,
    // the resolvers behind Find Available PDF. Putting a saved value back
    // (`= this.originalGetFileResolvers`) is the undo, not a change.
    if (n.type === "AssignmentExpression" && own(base + n.start)) {
      const left = node(n.left);
      const right = node(n.right);
      const owner = left?.type === "MemberExpression" ? chain(node(left.object)) : null;
      const prop = nameOf(left);
      // `this.resolvers = list` calls a setter of that name, if the file defines one (scipdf).
      const from = prop && prop.length > 2 && setterUses.length < 5000 ? callerFn(anc) : null;
      if (prop && from && from.name !== prop)
        setterUses.push({
          name: prop,
          edge: {
            caller: from.name,
            file,
            span: [base + from.fn.start, base + from.fn.end],
            at: base + n.start,
            setting: settingIf(code, anc),
          },
        });
      const restores = /^(orig|old|saved|prev|backup|initial)/i.test(nameIn(right) ?? "");
      if (owner && /(^|\.)ZOTERO_CONFIG$/.test(owner) && !restores)
        settingsAt(n, anc, "zotero-config", {
          ...(prop ? { target: prop } : {}),
          whileInstalled: true,
        });
      else if (
        owner &&
        /(^|\.)Attachments$/.test(owner) &&
        /^(getFileResolvers|getPDFResolvers|downloadFirstAvailableFile)$/.test(prop ?? "") &&
        !restores
      )
        settingsAt(n, anc, "find-pdf", { whileInstalled: true });
      // Zotero's question before opening a link in another app, turned off in its handler store
      // (weavero); left in memory, it covers only the link being opened.
      else if (prop === "alwaysAskBeforeHandling" && truthy(right) === false) {
        const fn = enclosingFn(anc);
        const body = fn ? code.slice(fn.start, fn.end) : "";
        if (/\.store\s*\(/.test(body))
          settingsAt(n, anc, "link-prompts", {
            ...(/alwaysAskBeforeHandling\s*=\s*(?:true|!0)/.test(body) ? { optIn: true } : {}),
          });
      }
    }
    // One-hop bindings (see Bindings)
    if (n.type === "VariableDeclarator" && node(n.id)?.type === "Identifier") {
      bindings.add(node(n.id)?.name as string, node(n.init), enclosingFn(anc));
    } else if (n.type === "AssignmentExpression" && n.operator === "=") {
      const l = node(n.left);
      if (l?.type === "Identifier") bindings.add(l.name as string, node(n.right), enclosingFn(anc));
      else if (l?.type === "MemberExpression" && !l.computed)
        bindings.add(node(l.property)?.name as string, node(n.right), null, true);
    } else if ((n.type === "Property" || n.type === "PropertyDefinition") && !n.computed) {
      const k = node(n.key);
      bindings.add(
        k?.type === "Identifier" ? (k.name as string) : str(k),
        node(n.value),
        null,
        true,
      );
    } else if (n.type === "ForOfStatement") {
      const l = node(n.left);
      const id = l?.type === "VariableDeclaration" ? node(nodes(l.declarations)[0]?.id) : l;
      const r = node(n.right);
      const list =
        r?.type === "Identifier"
          ? (r.name as string)
          : r?.type === "MemberExpression" && !r.computed
            ? (node(r.property)?.name as string)
            : null;
      if (id?.type === "Identifier" && list) bindings.forOf.set(id.name as string, list);
      // `for (const key of ["endpoint", "model", "apiKey"])`: the variable takes each entry.
      if (id?.type === "Identifier" && r?.type === "ArrayExpression")
        for (const el of nodes(r.elements).slice(0, 20))
          bindings.add(id.name as string, el, enclosingFn(anc));
    } else if (n.type === "ReturnStatement" && node(n.argument)) {
      const fn = enclosingFn(anc);
      const name = fn ? functionName(fn, anc[anc.indexOf(fn) - 1]) : null;
      if (name) {
        if (/(^|\.)zotero\.DB$/i.test(chain(node(n.argument)) ?? ""))
          bindings.returnsZoteroDb.add(name);
        bindings.addReturn(
          name,
          node(n.argument),
          anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
        );
      }
    } else if (n.type === "FunctionDeclaration" && node(n.id)?.type === "Identifier") {
      // A local `function fetch` shadows the global one (review P6).
      bindings.add(node(n.id)?.name as string, n, enclosingFn(anc));
    } else if (n.type === "AssignmentPattern" && node(n.left)?.type === "Identifier") {
      // Default parameters: `constructor(settings, fetchImpl = fetch)`.
      bindings.add(node(n.left)?.name as string, node(n.right), enclosingFn(anc));
    }
    // What a named function returns through a variable (`let url = …; return url`), resolved after
    // the walk when every binding is known (zotero-odh's buildScriptURL).
    if (
      n.type === "ReturnStatement" &&
      node(n.argument)?.type === "Identifier" &&
      returnsSeen < 3000
    ) {
      const at = anc.slice(0, -1).findLastIndex((x) => FUNCTION_TYPES.has(x.type));
      const fn = anc[at];
      const name = fn ? functionName(fn, anc[at - 1]) : null;
      if (name && name.length > 2) {
        returnsSeen++;
        returnIds.push({
          name,
          arg: node(n.argument) as AstNode,
          fns: anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
        });
      }
    }
    switch (n.type) {
      case "ArrayExpression": {
        // Arguments kept apart from the program: `{ command: "uv", args: ["run", "--isolated", …] }`.
        const els = (n.elements as AstNode[] | undefined) ?? [];
        const first = str(node(els[0]));
        const list = argText(n);
        const words = els.length >= 2 && els.length <= 40 ? argWords(nodes(els)) : [];
        const at = (): PackageRun => ({
          ...hit(n),
          fn: callerName(anc),
          fnAt: base + (enclosingFn(anc)?.start ?? n.start),
          ...(installedCheck(code, anc) ? { once: true } : {}),
        });
        if (first && list && els.length >= 2 && els.length <= 40 && col.argLists.length < 200)
          col.argLists.push({
            text: list,
            words,
            hit: hit(n),
            fn: callerName(anc),
            run: launchArgs(anc),
          });
        if (els.length >= 2 && els.length <= 40 && own(base + n.start)) {
          // The program first, held in a name: `[paths.npxCliPath, "--yes", "--package", spec]`
          // (zotero-translate runs npx's script with node), `[uvx, "--from", "BabelDOC", …]`.
          const head = node(els[0]);
          const tool = head && str(head) === null ? toolNamedBy(chain(head) ?? "") : null;
          if (tool && installsWith(tool, words.slice(1)))
            col.packageRuns.push({ ...at(), words: [tool, ...words.slice(1)] });
          // A Python interpreter running pip: `runProcess(envPython, ["-m", "pip", "install", …])`,
          // also through conda (`["run", "-n", env, "python", "-m", "pip", "install", …]`).
          else if (PIP_MODULE.test(words.join(" ")) && textContext(anc) !== "shown")
            col.packageRuns.push({ ...at(), words });
          // A settings command whose program is held in a name, first or just before the list:
          // `runCondaCmd(condaBin, ["config", "--set", …])`, `run(npmPath, ["config", "set", …])`.
          const call = anc.at(-2);
          const callArgs = call?.type === "CallExpression" ? nodes(call.arguments) : [];
          const prev = callArgs[callArgs.indexOf(n) - 1];
          const heldBy = (e: AstNode | undefined) =>
            e && str(e) === null ? programNamed(chain(e) ?? "") : null;
          // …or beside it (`{ command: claudePath, arguments: [...] }`), or named first
          // (`["claude", "mcp", "add", …]`).
          const holder = anc.at(-2)?.type === "Property" ? anc.at(-3) : undefined;
          const command = nodes(holder?.properties).find((q) =>
            /^(command|cmd|executable|program)$/.test(nameOf(q) ?? ""),
          );
          const beside = node(command?.value);
          const program =
            heldBy(head) ??
            heldBy(prev) ??
            (beside ? (str(beside)?.split(/[/\\]/).at(-1) ?? heldBy(beside)) : null);
          const line = program
            ? [program, ...(heldBy(head) ? words.slice(1) : words)].join(" ")
            : first
              ? words.join(" ")
              : null;
          const commands = line ? SETTINGS_COMMANDS.filter((s) => s.re.test(line)) : [];
          const ctx = commands.length ? textContext(anc) : "shown";
          if (ctx !== "shown") for (const s of commands) commandAt(s, line as string, n, anc, ctx);
        }
        // A command line assembled from pieces: `[`curl … -o "$f"`, 'bash "$f"'].join(" && ")`
        // (local-immersive-translate), run through a shell like any other command line.
        const up = anc.at(-2);
        if (
          up?.type === "MemberExpression" &&
          (node(up.property)?.name as string) === "join" &&
          own(base + n.start)
        ) {
          const joined = els.map((e) => str(node(e)) ?? textOf(node(e)) ?? EXPR).join("\n");
          if (
            (DOWNLOAD_RUN.test(joined) || DOWNLOAD_TO_FILE_RUN.test(joined)) &&
            joined.split("\n").some((l) => SHELL_COMMAND_START.test(l))
          ) {
            const ctx = textContext(anc);
            if (ctx !== "shown") col.commandLines.push({ hit: hit(n), kind: "download", ctx });
          }
        }
        // …or with the program in a variable: `{ command: pipPath, arguments: ["install", …] }`.
        const prop = anc.at(-2);
        const obj = anc.at(-3);
        if (
          list &&
          prop?.type === "Property" &&
          /^(args|arguments|argv)$/.test((node(prop.key)?.name as string) ?? "") &&
          obj?.type === "ObjectExpression"
        ) {
          const cmd = nodes(obj.properties).find((q) =>
            /^(command|cmd|executable|program)$/.test((node(q.key)?.name as string) ?? ""),
          );
          const tool = cmd ? toolNamedBy(chain(node(cmd.value)) ?? "") : null;
          if (tool && installsWith(tool, words))
            col.packageRuns.push({ ...at(), words: [tool, ...words] });
        }
        break;
      }
      case "Identifier": {
        identifiers++;
        nameRefs.set(n.name as string, (nameRefs.get(n.name as string) ?? 0) + 1);
        if (/^_0x[0-9a-f]{3,}$/i.test(n.name as string)) {
          hexIdentifiers++;
          if (firstHex < 0) firstHex = n.start;
        }
        break;
      }
      case "Literal":
      case "TemplateLiteral": {
        if (n.type === "Literal" && n.regex) regexRanges.push([base + n.start, base + n.end]);
        const text = n.type === "Literal" ? str(n) : textOf(n);
        if (text === null) break;
        if (n.type === "Literal") ranges.strings.push([base + n.start, base + n.end]);
        if (own(base + n.start)) {
          for (const [id, app] of BORROWED_CLIENTS)
            if (text.includes(id)) col.cap("borrowed-identity", hit(n), app);
          // A browser's cookie/password store, or another app's saved-login file, named where the
          // code reads or copies it (not shown to the user).
          if (BROWSER_STORES.some((re) => re.test(text)) && textContext(anc) !== "shown") {
            browserStoreHit ??= hit(n);
            const fn = enclosingFn(anc);
            if (fn) browserStoreFns.push(fn);
            if (/(cookies\.sqlite|key[34]\.db|logins\.json)/i.test(text))
              browserNames.add("Firefox");
          }
          for (const [re, name] of BROWSER_NAMES) if (re.test(text)) browserNames.add(name);
          if (isPathToken(text) && textContext(anc) !== "shown")
            for (const { program, dir, file } of APP_LOGINS) {
              if (dir.test(text) && !appLoginDir.has(program)) appLoginDir.set(program, hit(n));
              if (file.test(text)) appLoginFile.add(program);
            }
          noteSettingsText(text, n, anc);
          if (/<(?:html:)?script\b/i.test(text))
            for (const m of text.replace(/<!--[\s\S]*?-->/g, "").matchAll(REMOTE_SCRIPT_TAG)) {
              // The page loads it wherever it's opened later; the plugin itself sends nothing.
              col.url(m[1] as string, hit(n), "unknown");
              col.cap("remote-script-output", hit(n), hostOf(m[1] as string)?.host ?? "web");
            }
          if (n.type === "Literal" && /^(\/bin\/)?chmod$/.test(text)) col.makesExecutable = true;
          // Gecko's zip reader, created by contract ID: unpacking an archive (zopilot).
          if (n.type === "Literal" && text === "@mozilla.org/libjar/zip-reader;1")
            col.extractsArchive = true;
          // The command itself (`curl … | sh`), not install instructions shown to the user
          // ("Run: curl … | sh", an error message, a Copy button's code block).
          if (
            (DOWNLOAD_RUN.test(text) || DOWNLOAD_TO_FILE_RUN.test(text)) &&
            SHELL_COMMAND_START.test(text)
          ) {
            const ctx = textContext(anc);
            if (ctx !== "shown") col.commandLines.push({ hit: hit(n), kind: "download", ctx });
          }
          // `sh -c`, not a program's own `-c <config>` (zotero-babeldoc runs BabelDOC that way).
          if (
            n.type === "Literal" &&
            SHELL_FLAG.test(text) &&
            SHELL_NAME.test(file.text.slice(Math.max(0, n.start - 300), n.end + 300))
          )
            col.shellFlag = true;
          if (PROGRAM_URL.test(text)) col.programUrls.push(hit(n));
          // Unpacking, including mounting a downloaded disk image (zotero-chatpdf's .dmg).
          if (
            n.type === "Literal" &&
            /^(\/usr)?\/bin\/(unzip|tar|hdiutil)$|^(unzip|tar|hdiutil)$/.test(text)
          )
            col.extractsArchive = true;
          if (col.opaque.size)
            for (const name of col.opaque.keys())
              if (text.includes(name)) col.opaqueNamed.add(name);
          if (col.binaries.size)
            for (const name of col.binaries.keys())
              if (!col.binaryNamed.has(name) && text.includes(name))
                col.binaryNamed.set(name, hit(n));
          // A bare name ("gemini", "claude") is also a model or provider id: it names the tool
          // only where a command goes (`command: "claude"`, `spawn("codex", …)`).
          const parent = anc.at(-2);
          const commandish =
            !/^[\w.-]+$/.test(text) ||
            /\.(exe|cmd|bat)$/i.test(text) ||
            (parent?.type === "Property" &&
              /^(command|cmd|executable|exe|program|binary|bin|cli|cliPath|cliCommand)$/i.test(
                (node(parent.key)?.name as string) ?? str(node(parent.key)) ?? "",
              )) ||
            ((parent?.type === "CallExpression" || parent?.type === "NewExpression") &&
              /(spawn|exec|execFile|call|run|launch|which|findExecutable|resolveExecutable|pathToFile)$/.test(
                chain(node(parent.callee)) ?? "",
              )) ||
            // The fallback for a program's setting: `const agyBin = config.agyPath || "agy"`.
            (parent?.type === "LogicalExpression" &&
              node(parent.right) === n &&
              PROGRAM_HOLDER.test(holderName(anc.at(-3)) ?? ""));
          const cli =
            commandish && textContext(anc) !== "shown"
              ? AI_CLI.find(([re]) => re.test(text))
              : undefined;
          if (cli && !col.cliNamed.has(cli[1])) col.cliNamed.set(cli[1], hit(n));
          // A program that passes what it's given on to an online service (edge-playback), also
          // first in a command line (`pdf2zh_next in.pdf --output …`).
          const first = /^(\S+)\s(?=.*\s--?[a-z])/i.exec(text)?.[1] ?? "";
          const handoff = HANDOFFS.find(
            (h) =>
              (commandish && (h.run?.test(text) || h.run?.test(first))) || h.mention?.test(text),
          );
          if (handoff && textContext(anc) !== "shown") col.handoff(handoff, hit(n), "launch");
          if (n.type === "Literal" && AGENT_WORD.test(text) && textContext(anc) !== "shown")
            noteAgentMode(col, n, text, anc, hit(n));
          if (
            n.type === "Literal" &&
            SHELL_TOOL.test(text) &&
            parent?.type === "Property" &&
            /^(name|id)$/.test(nameOf(parent) ?? "")
          )
            col.shellTools.push(hit(n));
          // A bare `npx` is a command; inside an MCP config it's what another app will run
          // (ai4paper's snippet for Claude Desktop's settings).
          // An embedded Python program that installs packages: `[py, "-m", "pip", "install", …]`
          // (paper-curio writes its bridge script out and runs it).
          if (text.length > 200 && PY_PACKAGE_RUN.test(text))
            for (const m of text.matchAll(new RegExp(PY_PACKAGE_RUN.source, "g")))
              col.packageRuns.push({ ...hit(n), words: pyListWords(text, m.index ?? 0) });
          // …or downloads a program, unpacks it and runs it (paper-curio fetches CPython).
          if (text.length > 200 && PY_DOWNLOAD_RUN.every((re) => re.test(text)))
            col.shellDownloads.push({ ...hit(n), pinned: false });
          const runAt = (words: string[]): PackageRun => ({
            ...hit(n),
            words,
            fn: callerName(anc),
            fnAt: base + (enclosingFn(anc)?.start ?? n.start),
            ...(installedCheck(code, anc) ? { once: true } : {}),
          });
          if (PACKAGE_BARE.test(text)) {
            // Its arguments sit next to it: `{ command: "npx", args: […] }`, `spawn("npx", […])`.
            const obj = parent?.type === "Property" ? anc.at(-3) : undefined;
            const argsNode =
              obj?.type === "ObjectExpression"
                ? node(
                    nodes(obj.properties).find((q) =>
                      /^(args|arguments|argv)$/.test(nameOf(q) ?? ""),
                    )?.value,
                  )
                : parent?.type === "CallExpression" && node(nodes(parent.arguments)[0]) === n
                  ? node(nodes(parent.arguments)[1])
                  : undefined;
            const rest =
              argsNode?.type === "ArrayExpression"
                ? argWords(nodes(argsNode.elements))
                : argsNode
                  ? [nameIn(argsNode) ? SPREAD + nameIn(argsNode) : EXPR]
                  : [];
            if (commandish && !inMcpConfig(anc)) col.packageRuns.push(runAt([text, ...rest]));
          } else if (PACKAGE_RUN.test(text)) {
            const ctx = textContext(anc);
            if (ctx !== "shown" && !inDisplayFn(anc))
              col.commandLines.push({ hit: runAt(commandWords(text)), kind: "package", ctx });
          }
          const tool = text.match(PACKAGE_TOOL)?.[1];
          if (tool && commandish) {
            const name = tool === "pip3" ? "pip" : tool;
            const files = col.packageTools.get(name) ?? new Set<SourceFile>();
            col.packageTools.set(name, files.add(file));
          }
          if (/^https?:\/\/\S*translators?\b/i.test(text)) col.translatorUrls++;
          if (/^access-control-allow-origin$/i.test(text)) col.corsHits.push(hit(n));
          // Addresses hidden in base64 (`atob("aHR0cHM6Ly9hcGku…")`), as zotero-style does.
          if (text.length >= 16 && text.length <= 4096 && BASE64.test(text)) {
            const plain = Buffer.from(text, "base64").toString("latin1");
            if (/^[\x20-\x7e\s]+$/.test(plain)) {
              for (const u of plain.matchAll(URL_RE)) col.url(u[0], hit(n), "unknown");
              // A bare host and path: `api.muisedestiny.xyz/check`.
              if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(plain))
                col.url(`https://${plain}`, hit(n), "unknown");
            }
          }
        } else for (const q of nodes(n.quasis)) ranges.strings.push([base + q.start, base + q.end]);
        if (n.type === "Literal") {
          const rawText = (n.raw as string) ?? "";
          rawStringChars += rawText.length;
          const esc = rawText.match(/\\x[2-7][0-9a-f]|\\u00[2-7][0-9a-f]/gi)?.length ?? 0;
          if (esc) {
            escapeChars += esc * 4;
            if (firstEscape < 0) firstEscape = n.start;
          }
          for (const [re, id, label] of CAPABILITY_STRINGS)
            if (re.test(text)) col.cap(id, hit(n), label);
          if (text === "@mozilla.org/xmlextras/xmlhttprequest;1") col.api("xhr", hit(n));
        }
        if (n.type === "TemplateLiteral" && text.match(/:\/\/([^/]*)/)?.[1]?.includes(EXPR)) {
          // Host built at runtime, e.g. `https://${region}.example.com/…`
          col.dynamicUrls.set(text.replaceAll(EXPR, "<expr>").slice(0, 200), [hit(n)]);
        }
        // A template can get its scheme and host from a constant: `${API_BASE}/v1/chat`.
        if (
          !text.includes("://") &&
          !(n.type === "TemplateLiteral" && text.startsWith(EXPR) && /^.[/:?]/s.test(text))
        )
          break;
        if (n.type === "TemplateLiteral") {
          // Resolved after the walk, when `${NAME}` can be looked up.
          const ctx = textContext(anc);
          templates.push({
            n,
            fns: anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
            ...urlContext(anc),
            ...serverList(anc),
            ...(typeof ctx === "object" ? { returnFn: ctx.fn } : {}),
          });
          break;
        }
        // Code that can't run: `false ? devUrl : prodUrl`, `if (false) {…}` (polarrec's 127.0.0.1).
        if (inDeadBranch(anc)) break;
        // A package.json inlined by the bundler: `repository: { url: "git+https://github.com/…" }`.
        if (/^git\+https?:\/\//i.test(text)) break;
        // Compared or searched for, not requested: `url === "https://old-host/…"`,
        // `href.startsWith("https://…")`, `s.replace("https://…", …)`.
        {
          const p = anc.at(-2);
          if (p?.type === "BinaryExpression" && /^[!=]==?$/.test(p.operator as string)) break;
          if (
            p?.type === "CallExpression" &&
            node(p.callee) !== n &&
            /\.(includes|startsWith|endsWith|indexOf|lastIndexOf|replace|replaceAll|match|split|search)$/.test(
              chain(node(p.callee)) ?? "",
            )
          )
            break;
        }
        // A URL used as a name, not an address: a JWT claim (`payload["https://api.openai.com/auth"]`)
        // or an object key, like an XML namespace; or the namespace a DOM method takes first
        // (`getElementsByTagNameNS("http://arxiv.org/schemas/atom", "doi")`, zotero-validate).
        const up = anc.at(-2);
        if (
          (up?.type === "MemberExpression" && up.computed && node(up.property) === n) ||
          (up?.type === "Property" && node(up.key) === n) ||
          (up?.type === "CallExpression" &&
            nodes(up.arguments)[0] === n &&
            NAMESPACE_CALL.test(chain(node(up.callee))?.split(".").at(-1) ?? ""))
        )
          break;
        // Example text in a settings page, not an address it uses: a field's placeholder
        // (`placeholder: "http://127.0.0.1:8000"`), or a hint or help string
        // (`"prefs.openai.hint": "… https://api.deepseek.com/v1 …"`, zotero-pdf-translate--thejieee).
        if (shownExample(anc)) break;
        // `<a href="https://doi.org/…">` inside a string of HTML is a link wherever the string goes.
        // RDF and SPARQL namespace declarations (`PREFIX np: <http://www.nanopub.org/nschema#>`)
        // name vocabularies, not servers.
        const found = [...text.matchAll(URL_RE)].filter(
          (m) => !isNamespaceDecl(text, m.index ?? 0),
        );
        const links = found.filter((m) =>
          /href\s*=\s*["']?$/i.test(text.slice(Math.max(0, (m.index ?? 0) - 12), m.index)),
        );
        const urls = found.filter((m) => !links.includes(m)).map((m) => m[0]);
        if (links.length)
          urlLiterals.push({
            offset: n.start,
            urls: links.map((m) => m[0]),
            usage: "link",
            binding: null,
          });
        if (urls.length) {
          const { usage, binding, bindingKind, call } = urlContext(anc);
          urlLiterals.push({
            offset: n.start,
            urls,
            usage,
            binding,
            bindingKind,
            scope: enclosingFn(anc),
            ...arrayEntry(anc),
            ...(call ? { call } : {}),
            ...serverList(anc),
          });
          const ctx = textContext(anc);
          if (typeof ctx === "object") col.returned(ctx.fn, urls, hit(n));
        }
        break;
      }
      case "CallExpression":
      case "NewExpression": {
        const isNew = n.type === "NewExpression";
        // `(0, eval)(code)` is an indirect eval.
        const seq =
          node(n.callee)?.type === "SequenceExpression"
            ? nodes(node(n.callee)?.expressions).at(-1)
            : null;
        // `(0, eval)(code)` is an indirect eval; `(0, mainWindow.fetch)(url)` is a plain call.
        const c = seq ? chain(seq) : chain(node(n.callee));
        const args = nodes(n.arguments);
        // A setter behind an obfuscator's lookups, `Zotero[a(0x814)][a(0x568)]("app.update.auto",
        // !on, !![])` (zotbox): one of Zotero's settings with a value and the global flag.
        const hidden = !c && !isNew && args.length === 3 ? str(args[0]) : null;
        const hiddenChange = hidden ? appSetting(hidden) : null;
        if (hidden && hiddenChange && truthy(args[2]) === true && own(base + n.start))
          prefWrites.push({
            n,
            shape: hidden,
            key: hidden,
            change: hiddenChange,
            value: truthy(args[1]),
            anc: [...anc],
            fn: enclosingFn(anc),
            fns: anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
          });
        if (!c) break;
        // Enclosing functions, innermost first; only built for calls we keep.
        const fns = () => anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse();
        // A helper that registers endpoints, maybe defined in another file:
        // `registerEndpoint("/aisummary/note", { init … })`.
        const callName = c.split(".").at(-1) ?? "";
        if (
          !isNew &&
          args.length >= 2 &&
          /regist|endpoint|route/i.test(callName) &&
          own(base + n.start) &&
          helperSites.length < 300
        )
          helperSites.push({ n, name: callName, args, fns: fns(), setting: settingIf(code, anc) });
        const api = networkApi(c, isNew);
        const urlIdx = requestUrlArg(c, isNew, args);
        // The address comes from a helper, maybe in another file: `Zotero.HTTP.request("GET",
        // Core.releaseURL(v, "runtime-manifest.json"))` (zotero-codex), resolved after all files.
        const urlArg = urlIdx >= 0 ? node(args[urlIdx]) : undefined;
        if (urlArg?.type === "CallExpression" && own(base + n.start)) {
          const fn = (chain(node(urlArg.callee)) ?? "").split(".").at(-1) ?? "";
          if (fn.length > 2 && col.urlCalls.length < 500) col.urlCalls.push({ hit: hit(n), fn });
        }
        // Recorded after the walk: a local `function fetch`, a request for the plugin's own
        // files and fetch passed around as a value all need the file's bindings.
        if (api || urlIdx >= 0) netCalls.push({ n, api, urlIdx, args, fns: fns() });
        // Opened in the browser: an address held in a name, or a parameter of a helper
        // (`openExternalUrl(url) { Zotero.launchURL(url) }`), is a link wherever it comes from.
        if (
          isLinkCall(c) &&
          args[0] &&
          args[0].type !== "Literal" &&
          args[0].type !== "TemplateLiteral"
        )
          linkCalls.push({ arg: args[0], fns: fns() });
        else if (
          isNew
            ? xhrAliases.has(c) || node(n.callee)?.type === "CallExpression"
            : /fetch/i.test(c) ||
              fetchAliases.has(c.split(".").at(-1) ?? "") ||
              httpAliases.has(c.split(".")[0] ?? "") ||
              /\.(request|doGet|doPost)$/.test(c) ||
              (node(n.callee)?.type === "CallExpression" &&
                str(nodes(node(n.callee)?.arguments)[0]) === "fetch")
        )
          maybeNet.push({ n, isNew, args, fns: fns() });
        const last = c.split(".").at(-1) ?? c;
        if (!isNew && last.length > 2 && col.callSites.size < 20000) {
          const sites = col.callSites.get(last) ?? [];
          if (sites.length < 20) sites.push(textContext(anc));
          col.callSites.set(last, sites);
        }
        // A package tool run from a path held in a variable: `run(npmState.npmPath, ["install",
        // "-g", pkg])` (iris-zotero), `runCondaCmd(condaPath, ["install", …])`, `run(job, uv,
        // [...pip, "-r", file])` (twintext).
        const at = args.findIndex((_, i) => i < 3 && node(args[i + 1])?.type === "ArrayExpression");
        if (at >= 0 && PROCESS_CALL.test(last)) {
          const tool = toolNamedBy(chain(node(args[at])) ?? "");
          const list = argText(node(args[at + 1]));
          const words = argWords(nodes(node(args[at + 1])?.elements));
          const check = !installsWith(tool ?? "", words) && words.some((w) => w.startsWith(SPREAD));
          if (tool && list && (check || installsWith(tool, words)))
            col.packageRuns.push({
              ...hit(n),
              words: [tool, ...words],
              fn: callerName(anc),
              fnAt: base + (enclosingFn(anc)?.start ?? n.start),
              check,
              ...(installedCheck(code, anc) ? { once: true } : {}),
            });
        }
        if (/^createElement(NS)?$/.test(last) && /^(html:)?script$/i.test(str(args.at(-1)) ?? ""))
          createsScript = true;
        if (
          last === "setAttribute" &&
          str(args[0]) === "src" &&
          !FRAME_NAME.test(c.split(".").at(-2) ?? "")
        )
          scriptSrcs.push({
            n,
            receiver: node(node(n.callee)?.object),
            value: args[1],
            fns: fns(),
          });
        if (
          /(^|\.)(getInstallForURL|getInstallForFile|installTemporaryAddon)$/.test(c) &&
          !own(base + n.start) &&
          [
            ...code
              .slice(Math.max(0, n.start - 20000), n.start)
              .matchAll(/zotero-plugin-toolkit\/dist\/utils\/(\w+)\.js/g),
          ].at(-1)?.[1] === "pluginBridge"
        )
          // Inside zotero-plugin-toolkit's plugin bridge: the zotero://plugin install, counted after
          // the walk if its handler wasn't recognised (an obfuscated key), so a library match never
          // hides it. The toolkit's other copies of an installer are unused.
          libInstalls.push(hit(n));
        if (
          /(^|\.)(getInstallForURL|getInstallForFile|installTemporaryAddon)$/.test(c) &&
          own(base + n.start) &&
          // zotero-plugin-toolkit's installer helper, bundled minified without module markers
          !code.slice(Math.max(0, n.start - 400), n.start).includes("Zotero version between")
        ) {
          // Its own updater (confucius, paper-chat): an install next to update logic and nothing
          // about other add-ons. It replaces Zotero's updater and ignores its update settings.
          const around = code.slice(Math.max(0, n.start - 2000), n.start + 300);
          const selfUpdate =
            /\bupdat(e|es|er|ing)\b|UpdateService|newVersion|latestVersion|checkForUpdate/i.test(
              around,
            ) &&
            !/addon_infos|market|plugin ?list|addons?List|install(Other|Plugin)|restore|backup/i.test(
              around,
            );
          const at = hit(n);
          col.cap(selfUpdate ? "self-installs" : "installs-addons", at, last);
          // The address, even hidden in base64 behind an alias of atob (zotero-style): its own
          // .xpi means it updates itself, decided once the manifest is read.
          if (!selfUpdate) col.installTargets.push({ hit: at, url: installTarget(args[0]) });
          // Where the file comes from and what starts the install, read once every file is in.
          const named = callerFn(anc);
          const inner = enclosingFn(anc);
          const fnNode = named?.fn ?? inner;
          const address = installAddress(args[0], (name) => bindings.lookup(name, fns()));
          const fnText = fnNode ? code.slice(fnNode.start, fnNode.end) : "";
          const folder = address?.folder?.replaceAll("$", "\\$");
          col.installSites.push({
            hit: at,
            local: last !== "getInstallForURL",
            fixed: address?.url ?? null,
            hidden: address?.hidden ?? false,
            // `const j = "https://…/Garden-for-Zotero/"; … await fetch(j) … j + newest.filename`
            page:
              !!folder &&
              new RegExp(
                String.raw`\b(?:fetch|request|doGet)\s*\(\s*(?:["'\x60]GET["'\x60]\s*,\s*)?${folder}\b`,
              ).test(fnText),
            hash: nodes(node(args[1])?.properties).some((p) => nameOf(p) === "hash"),
            fn: named?.name ?? null,
            span: fnNode ? [base + fnNode.start, base + fnNode.end] : [at.offset, at.offset],
            context: namedAround(anc, base) ?? [at.offset, at.offset],
            offTopicClick: !named && !!inner && offTopicClick(code, anc, inner),
            holder: fnNode ? holderOf(anc, fnNode, base) : null,
          });
        }
        // Any receiver: an alias of IOUtils (`createGlobalProxy("IOUtils")`, zopilot) counts too.
        if (/(^|\.)setPermissions$/.test(c) && own(base + n.start)) {
          // 0o755-style modes only; 0o600 on a config file isn't making anything executable.
          const mode = node(args[1])?.value;
          if (typeof mode !== "number" || (mode & 0o111) !== 0) col.makesExecutable = true;
        }
        if (
          /(^|\.)(unzipSync|unzip|extractAll|extractFiles)$|nsIZipReader/.test(c) &&
          own(base + n.start)
        )
          col.extractsArchive = true;
        if (
          /(^|\.)(decrypt|decryptCode|createDecipheriv|unwrapKey)$/.test(c) &&
          own(base + n.start)
        )
          col.decrypts.push(hit(n));
        // Zotero translators it writes into Zotero's store; they then run on matching web pages.
        if (
          /(^|\.)Zotero\.Translators\.(save|reinit|init)$|(^|\.)getTranslatorsDirectory$/.test(c) &&
          own(base + n.start)
        )
          col.translatorInstalls.push(hit(n));
        // nsIServerSocket.init(port, loopbackOnly): `false` listens on every network interface, and a
        // setting there ("allow remote access") can make it do so.
        // Only on a server socket: `pump.init(stream, 0, 0, false)` (an input-stream pump) isn't one
        // (zotero-zotcloud); its second argument is a number, a socket's is loopbackOnly.
        const recv = chain(node(node(n.callee)?.object)) ?? "";
        const secondArg = node(args[1]);
        if (
          last === "init" &&
          secondArg &&
          !(secondArg.type === "Literal" && typeof secondArg.value === "number") &&
          !/pump|stream|reader|timer|converter/i.test(recv) &&
          /server-?socket/i.test(code.slice(Math.max(0, n.start - 3000), n.start)) &&
          own(base + n.start)
        )
          // Read after the walk, once every value given to a name is known.
          socketInits.push({ n, args: [secondArg], fns: fns() });
        // Where a server it opens hands over requests: the listener a server socket is given, an
        // httpd.js path handler, a Node program's createServer callback (and its upgrade and
        // request events), read once the file's names are known (ServerScan.ownServer).
        if (!isNew && ownSites.length < 20 && own(base + n.start)) {
          const kind =
            last === "asyncListen" && socketFile
              ? "socket"
              : /^register(?:Path|Prefix)Handler$/.test(last) &&
                  httpdFile &&
                  // httpd.js's method on a server, not the plugin's own function of that name
                  // (systematic-reviewer's, which files handlers in a table its routes check).
                  node(n.callee)?.type === "MemberExpression"
                ? "httpd"
                : last === "createServer" && nodeNetFile
                  ? "node"
                  : null;
          const handlers =
            kind === "httpd"
              ? args.slice(1, 2)
              : kind === "node"
                ? args.filter((a) => FUNCTION_TYPES.has(a.type) || a.type === "Identifier")
                : args.slice(0, 1);
          if (kind && handlers.length)
            ownSites.push({ n, kind, handlers, fns: fns(), setting: settingIf(code, anc) });
          if (
            nodeNetFile &&
            last === "on" &&
            /^(upgrade|request|connection)$/.test(str(args[0]) ?? "") &&
            args[1]
          )
            nodeEvents.push(args[1]);
          // `server.listen(port)` with no host, or on 0.0.0.0, takes connections on every interface
          // (a server createServer made, not another object's listen method).
          const recv = node(node(n.callee)?.object);
          const made = (v: AstNode | undefined) =>
            v?.type === "CallExpression" && lastName(node(v.callee)) === "createServer";
          if (
            nodeNetFile &&
            last === "listen" &&
            args.length &&
            (made(recv) ||
              (recv?.type === "Identifier" &&
                bindings.lookup(recv.name as string, fns()).some(made)) ||
              (recv?.type === "MemberExpression" &&
                !recv.computed &&
                bindings.lookup(nameOf(recv) ?? "", [], "prop").some(made)))
          ) {
            // The host comes second, or in the options object (`listen({ port, host: "127.0.0.1" })`).
            const opts = node(args[0]);
            const host =
              opts?.type === "ObjectExpression"
                ? node(nodes(opts.properties).find((q) => nameOf(q) === "host")?.value)
                : node(args[1]);
            const text = host ? str(host) : null;
            if (
              !host ||
              FUNCTION_TYPES.has(host.type) ||
              (text !== null && /^(0\.0\.0\.0|::|)$/.test(text))
            )
              nodeListensWide = hit(n);
          }
        }
        // Proxy filters see every connection Zotero makes.
        if (/\.(registerFilter|registerChannelFilter)$/.test(c) && own(base + n.start))
          col.cap("network-intercept", hit(n), "proxy filter");
        if (
          /\.(loadSubScript|loadSubScriptWithOptions)$/.test(c) &&
          args[0] &&
          args[0].type !== "Literal"
        )
          subScripts.push({ n, arg: args[0], fns: fns() });
        // A web page loaded into a browser or frame the plugin created.
        if (
          last === "setAttribute" &&
          str(args[0]) === "src" &&
          FRAME_NAME.test(c.split(".").at(-2) ?? "")
        )
          // The address may be a name: resolved after the walk (zotero-ai-sider's chatgpt.com).
          frameSrcs.push({ n, value: args[1], fns: fns() });

        // eval / Function on computed input
        // `new AsyncFunction("Zotero,window", params.run)`, with AsyncFunction taken from
        // `Object.getPrototypeOf(async () => {}).constructor`.
        // `.constructor` only of a function: `(async () => {}).constructor`,
        // `Object.getPrototypeOf(fn).constructor`, not React's `new nativeEvent.constructor(type)`.
        const ctorOf = (() => {
          const callee = node(n.callee);
          if (callee?.type !== "MemberExpression" || !/\.constructor$/.test(c)) return false;
          const obj = node(callee.object);
          const isFnSource = (x: AstNode | undefined) =>
            !!x &&
            (FUNCTION_TYPES.has(x.type) ||
              (x.type === "CallExpression" && /getPrototypeOf$/.test(chain(node(x.callee)) ?? "")));
          if (isFnSource(obj)) return true;
          return (
            obj?.type === "Identifier" &&
            bindings.lookup(obj.name as string, fns()).some((v) => isFnSource(v))
          );
        })();
        const ctor =
          c === "Function" ||
          /(^|\.)(Async|Generator)?Function$/.test(c) ||
          ctorOf ||
          (isNew &&
            node(n.callee)?.type === "Identifier" &&
            bindings
              .lookup(c, fns())
              .some((v) => /getPrototypeOf.*\.constructor$/.test(code.slice(v.start, v.end))));
        if (
          (c === "eval" || c.endsWith(".eval") || ctor || /(^|\.)evalInSandbox$/.test(c)) &&
          args.length
        ) {
          const code = ctor ? (args.at(-1) as AstNode) : (args[0] as AstNode);
          // A template with nothing interpolated is a constant, like a string literal.
          const constant = code.type === "TemplateLiteral" && nodes(code.expressions).length === 0;
          if (code.type !== "Literal" && !constant) {
            const inner = [...descendants(code)]
              .map((d) => chain(node(d.callee)) ?? chain(d) ?? "")
              .join(" ");
            // Code fetched in an earlier step: `const s = await r.text(); eval(s)`, also inside a
            // template: `window.eval(\`setTimeout(async () => { ${s} })\`)` (zotero-chatpdf).
            if (code.type === "Identifier")
              evalNames.push({ n, name: code.name as string, fns: fns(), c });
            else if (code.type === "TemplateLiteral" || code.type === "BinaryExpression")
              for (const d of descendants(code))
                if (d.type === "Identifier")
                  evalNames.push({ n, name: d.name as string, fns: fns(), c });
            // javascript-obfuscator's global lookup, `Function("return (function() " +
            // '{}.constructor("return this")( )' + ");")`, is the obfuscator's, not the plugin's.
            const built =
              code.type === "BinaryExpression" || code.type === "TemplateLiteral"
                ? (textOf(code) ?? "")
                : "";
            if (/constructor\(\s*["']return this["']\s*\)/.test(built)) break;
            col.cap("dynamic-code", hit(n), c);
            if (own(base + n.start)) {
              col.buildsCode = true;
              col.dynamicArgs.push({
                hit: hit(n),
                names: [...descendants(code)]
                  .map((d) =>
                    d.type === "Identifier" ? (d.name as string) : chain(d)?.split(".").at(-1),
                  )
                  .filter((x): x is string => !!x),
              });
            }
            if (
              /(^|[\s.])(atob|decodeURIComponent|unescape|fromCharCode|escape)\b|Buffer\.from|TextDecoder/.test(
                inner,
              ) &&
              own(base + n.start)
            ) {
              col.signals.push({ kind: "eval-decoded-string", file: file.path, hits: [hit(n)] });
            }
            const src = fromNetwork(code);
            if (src)
              col.cap("remote-code", hit(n), src === "ai" ? AI_REPLY : `${c} on network response`);
          }
        }
        // Remote script loading
        if (
          /\.(loadSubScript|loadSubScriptWithOptions)$/.test(c) &&
          /^https?:/i.test(str(args[0]) ?? "")
        ) {
          col.cap("remote-code", hit(n), "loadSubScript over http(s)");
        }
        // Database: resolved after the walk, once every binding in the file is known.
        if (DB_QUERY.test(c) && args.length) {
          const callee = node(n.callee) as AstNode;
          dbCalls.push({
            n,
            callee,
            args,
            fns: anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
          });
        }
        if (
          /\.(openDatabase|openUnsharedDatabase|openConnection)$/.test(c) &&
          /storage|Sqlite|mozIStorage/i.test(c)
        ) {
          sqliteOpens.push({ n, args, fns: fns() });
        }
        // Network observers that see Zotero's traffic
        if (last === "addObserver" && /^http-on-/.test(str(args[1]) ?? "")) {
          col.cap("network-intercept", hit(n), str(args[1]) ?? "");
        }
        // A setting cleared back to its default: the plugin can undo what it set.
        if (/(^|\.)(clearUserPref|[Pp]refs\.clear)$/.test(c))
          for (const name of prefNames(args[0], fns())) prefClears.add(name);
        // Preferences: credentials and configurable endpoints
        if (PREF_GET_SET.test(c)) {
          // `Zotero.Prefs.get(\`${PREFIX}.endpoint\`)`: the key's fixed end is what names it.
          // A name built on a constant (`var start = "devtools.debugger."; set(start + "x")`).
          const key =
            str(args[0]) ??
            bindings.texts(args[0], fns()).find((t) => t && !t.includes(EXPR)) ??
            textOf(args[0])?.replaceAll(EXPR, "x") ??
            null;
          // Turning off one of Gecko's protections: Zotero blocks web scripts in plugin pages
          // only while `security.disallow_privileged_https_script_loads` is true.
          if (key && /set/i.test(last) && SECURITY_PREF.test(key) && own(base + n.start))
            col.cap("disables-security", hit(n), key);
          // Turning on Zotero's local API opens the library to programs on this computer. (Its
          // server turned back on is a settings change, below.)
          if (
            key &&
            /set/i.test(last) &&
            /(^|\.)httpServer\.localAPI\.enabled$/.test(key) &&
            truthy(node(args[1])) === true &&
            own(base + n.start)
          )
            col.cap("enables-local-api", hit(n), LOCAL_API_PREF);
          // One of Zotero's or Gecko's settings for the whole app (C33): its proxy, where it
          // syncs, Find Available PDF's sources, its updates, its question before opening links.
          // The name keeps what's computed (`"…warn-external." + scheme`), so its family shows.
          const name = prefNames(args[0], fns()).at(-1) ?? null;
          const written = name && own(base + n.start) ? prefWriteKey(c, name, args) : null;
          const change = written ? appSetting(written) : null;
          if (written && name && change)
            prefWrites.push({
              n,
              shape: name,
              key: written,
              change,
              value: truthy(node(args[1])),
              anc: [...anc],
              fn: enclosingFn(anc),
              fns: fns(),
            });
          // Read first, to tell a value saved and put back (zutilo, zotero-multifetcher).
          else if (args[0] && /get/i.test(last)) {
            const up = anc.at(-2);
            const upCallee = up?.type === "CallExpression" ? node(up.callee) : undefined;
            const left = up?.type === "AssignmentExpression" ? node(up.left) : undefined;
            const id = up?.type === "VariableDeclarator" ? node(up.id) : undefined;
            prefReads.push({
              shape: name ?? "",
              at: n.start,
              fn: fns()[0],
              arg: args[0],
              fns: fns(),
              kept:
                id?.type === "Identifier"
                  ? (id.name as string)
                  : left && !left.computed && node(up?.right) === n
                    ? chain(left)
                    : null,
              snapshot:
                (upCallee?.type === "MemberExpression" &&
                  node(upCallee.property)?.name === "set" &&
                  nodes(up?.arguments)[1] === n) ||
                (left?.type === "MemberExpression" && !!left.computed && node(up?.right) === n),
            });
          }
          // Put back from a snapshot: the key and the value come from one entry of a list or map.
          if (/set/i.test(last) && sameEntry(args[0], args[1], anc)) snapshotBacks.add(n);
          if (key && /set/i.test(last) && SYNC_PROXY_PREF.test(key) && args[1])
            prefSets.push({ n, args, fns: fns(), key });
          // Every name the key can take: `PREFIX + name` over `["endpoint", "model", "apiKey"]`
          // (paper-assistant-next).
          // The walk visits a loop's body before the loop, so read an enclosing
          // `for (const k of ["a", "b"])` here.
          const loopKeys: string[] = [];
          const shape = textOf(args[0]);
          if (shape?.includes(EXPR)) {
            const ids = new Set(
              [args[0], ...descendants(args[0] as AstNode)]
                .filter((d) => d?.type === "Identifier")
                .map((d) => d?.name as string),
            );
            for (const a of anc) {
              if (a.type !== "ForOfStatement") continue;
              const l = node(a.left);
              const id = l?.type === "VariableDeclaration" ? node(nodes(l.declarations)[0]?.id) : l;
              const r = node(a.right);
              if (
                id?.type === "Identifier" &&
                ids.has(id.name as string) &&
                r?.type === "ArrayExpression"
              )
                for (const e of nodes(r.elements)) {
                  const v = str(e);
                  if (v) loopKeys.push(shape.replace(EXPR, v));
                }
            }
          }
          const allKeys = key
            ? [
                key,
                ...loopKeys,
                ...bindings.texts(args[0], fns()).filter((t) => t && !t.includes(EXPR)),
              ]
            : [];
          const credKey = allKeys.find((k) => isCredentialKey(k));
          // A session ID the plugin may make up itself is decided once the file is read: its value
          // can be set after the first read (openclaw-zotero-channel's chat session).
          if (credKey && !isCredentialKey(credKey.replace(SESSION_ID, "")))
            sessionKeys.push({
              key: credKey,
              hit: hit(n),
              value: /set/i.test(last) ? node(args[1]) : undefined,
              fns: fns(),
            });
          else if (credKey)
            col.cap("credential-storage", hit(n), "preferences").prefKeys.add(credKey);
          // Settings saved as one JSON value: `Prefs.set(KEY, JSON.stringify({ apiKey, … }))`.
          const stored = node(args[1]);
          if (
            key &&
            /set/i.test(last) &&
            stored?.type === "CallExpression" &&
            chain(node(stored.callee)) === "JSON.stringify"
          ) {
            const v = node(nodes(stored.arguments)[0]);
            const objs =
              v?.type === "Identifier" ? bindings.lookup(v.name as string, fns()) : v ? [v] : [];
            const secret = objs
              .filter((o) => o.type === "ObjectExpression")
              .flatMap((o) => nodes(o.properties))
              .map((q) => (node(q.key)?.name as string) ?? str(node(q.key)) ?? "")
              .find((k) => isCredentialKey(k));
            if (secret)
              col
                .cap("credential-storage", hit(n), "preferences")
                .prefKeys.add(`${key} (${secret})`);
          }
          if (key) noteCliSetting(col, key, hit(n));
          if (key && isEndpointKey(key) && /get/i.test(last)) {
            const parent = anc.at(-2);
            const fallback =
              parent?.type === "LogicalExpression" && node(parent.left) === n
                ? str(node(parent.right))
                : null;
            const e = col.endpoints.get(key) ?? { hits: [] };
            if (fallback && /^https?:/.test(fallback)) {
              // The developer's default is a fixed destination until the user changes it.
              e.defaultValue = fallback;
              col.url(fallback, hit(parent as AstNode), "request");
            }
            e.hits.push(hit(n));
            col.endpoints.set(key, e);
          }
        }
        // Endpoint registration through a helper, e.g. Server.register("/better-bibtex/cayw", H)
        if (
          /^(register|registerEndpoint|addEndpoint)$/.test(last) &&
          /^\/[\w-]+\//.test(str(args[0]) ?? "")
        ) {
          col.endpointNames.add(str(args[0]) as string);
        }
        // Zotero's own bundled converters (`Zotero.Fulltext`'s pdftotext, getPDFConverterExecAndArgs):
        // the program is Zotero's, not one the plugin brings (zotero-paper-summary).
        if (
          /^Zotero\.Utilities\.Internal\.(exec|subprocess)$/.test(c) &&
          /Zotero\.Fulltext\.|getPDFConverterExecAndArgs|pdfConverterPath|pdfInfoPath/.test(
            code.slice(Math.max(0, n.start - 600), n.end),
          )
        )
          break;
        // zotero-plugin-toolkit copies files to the macOS clipboard with a fixed osascript call.
        // Any other AppleScript can run shell commands, so it counts as launching a program.
        if (
          c === "Zotero.Utilities.Internal.exec" &&
          /\/osascript$/.test(textOf(args[0]) ?? "") &&
          node(args[1])?.type === "ArrayExpression" &&
          nodes((args[1] as AstNode).elements).some((e) =>
            /^set the clipboard to /.test(textOf(e) ?? ""),
          )
        ) {
          col.cap("clipboard", hit(n), "osascript (fixed command)");
          break;
        }
        // Zotero's web API client, with the user's sync key: requests to api.zotero.org
        // (zotero-split-view-reader's read-aloud voices). The key itself is in the login manager.
        if (/(^|\.)Sync\.Runner\.getAPIClient$/.test(c)) {
          col.api("zotero-http", hit(n));
          col.url("https://api.zotero.org/", hit(n), "request");
        }
        if (/(^|\.)Sync\.Data\.Local\.getAPIKey$/.test(c))
          col.cap("login-manager", hit(n), "Zotero sync API key");
        // Reading its own packaged files (`Zotero.File.getContentsFromURL(rootURI + "x.csl")`,
        // chrome:// or resource://) isn't working with the user's files.
        const ownRead =
          /^Zotero\.File\.(getContentsFromURL|getContentsFromURLAsync|getResource|getResourceAsync)$/.test(
            c,
          ) &&
          !!args[0] &&
          /rootURI|chrome:\/\/|resource:\/\/|^["'`]\w/.test(
            code.slice(args[0].start, args[0].end),
          ) &&
          !/https?:|file:/.test(code.slice(args[0].start, args[0].end));
        // Capability chains on the callee
        if (!ownRead)
          for (const [re, id, label] of CAPABILITY_CHAINS)
            if (re.test(c)) col.cap(id, hit(n), label);
        if (/FilePicker/.test(c)) fsHint(col, "user-chosen");
        break;
      }
      case "Property": {
        // A launch's program held in a name for a tool's path (`{ command: hermesPath }`).
        if (/^(?:command|cmd|executable|program)$/.test(nameOf(n) ?? "") && own(base + n.start)) {
          const held = (chain(node(n.value)) ?? "").split(".").at(-1) ?? "";
          const tool = /(?:Path|Bin|Exe|Executable)$/.test(held)
            ? held.match(/^[a-z]+/)?.[0]
            : null;
          if (tool) noteProgram(col, tool, hit(n));
        }
        // The walker skips plain keys, but `{ "a​b": 1 }` is string data too.
        const k = node(n.key);
        if (!n.computed && k?.type === "Literal") {
          ranges.strings.push([base + k.start, base + k.end]);
          // `{ "Access-Control-Allow-Origin": "*" }`: the header as a key.
          if (/^access-control-allow-origin$/i.test(str(k) ?? "") && own(base + n.start))
            col.corsHits.push(hit(k));
        }
        break;
      }
      case "ImportExpression": {
        const src = node(n.source);
        if (src && src.type !== "Literal")
          subScripts.push({
            n,
            arg: src,
            fns: anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
          });
        if (/^https?:/i.test(str(node(n.source)) ?? ""))
          col.cap("remote-code", hit(n), "import() over http(s)");
        break;
      }
      case "MemberExpression": {
        {
          const obj = node(n.object);
          const prop = node(n.property);
          if (
            n.computed &&
            obj?.type === "Identifier" &&
            prop?.type === "Literal" &&
            typeof prop.value === "number"
          ) {
            const set = constIndexReads.get(obj.name as string) ?? new Set<number>();
            set.add(prop.value);
            constIndexReads.set(obj.name as string, set);
            constIndexCount.set(
              obj.name as string,
              (constIndexCount.get(obj.name as string) ?? 0) + 1,
            );
          }
        }
        const parent = anc.at(-2);
        if (parent?.type === "MemberExpression" && node(parent.object) === n) break; // outer chain wins
        if (
          parent &&
          (parent.type === "CallExpression" || parent.type === "NewExpression") &&
          node(parent.callee) === n
        )
          break;
        const c = chain(n);
        if (!c) break;
        for (const [re, id, label] of CAPABILITY_CHAINS) if (re.test(c)) col.cap(id, hit(n), label);
        if (/Zotero\.(DataDirectory|Profile)|getZoteroDirectory/.test(c))
          fsHint(col, "zotero-data-dir");
        break;
      }
      case "AssignmentExpression": {
        const left = node(n.left);
        const target = chain(left) ?? "";
        // Zotero's own local server made to listen on every interface (zotero-opds).
        if (
          /(^|\.)bindAllAddr$/.test(target) &&
          node(n.right)?.type === "Literal" &&
          node(n.right)?.value === true &&
          own(base + n.start)
        )
          col.cap("own-server", hit(n), "listens beyond this computer");
        if (
          /(^|\.)Zotero\.Server\.init$/.test(chain(left) ?? "") &&
          /\[\s*[\w$]+\s*,\s*(true|!0)\s*,/.test(
            code.slice(n.start, Math.min(n.end, n.start + 1500)),
          )
        )
          col.serverInitWraps.push(hit(n));
        // `…getProtocolHandler("zotero").wrappedJSObject._extensions["zotero://name"] = handler`
        if (
          left?.type === "MemberExpression" &&
          left.computed &&
          (/(^|\.)_extensions$/.test(chain(node(left.object)) ?? "") ||
            // `…[_0x1(0xd5f)]['_extensions'][key] = h`: the chain before it can't be named.
            (node(left.object)?.type === "MemberExpression" &&
              (str(node(node(left.object)?.property)) ??
                (node(node(left.object)?.property)?.name as string)) === "_extensions") ||
            // …or `_extensions` itself is hidden: `['wrappedJSObject'][zr(0x82a)][key]` (zotmind).
            fromServicesIo(node(left.object)))
        )
          linkHandlers.push({
            n,
            key: node(left.property),
            name: "",
            value: node(n.right),
            fns: anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
          });
        if (
          /\.src$/.test(target) &&
          !FRAME_NAME.test(target.split(".").at(-2) ?? "") &&
          left?.type === "MemberExpression"
        )
          scriptSrcs.push({
            n,
            receiver: node(left.object),
            value: node(n.right),
            fns: anc.filter((a) => FUNCTION_TYPES.has(a.type)).reverse(),
          });
        // `file.permissions = 0o755`
        if (
          /\.permissions$/.test(target) &&
          // 0o755, 0o777, 0o700, 0o711, 0o775, and the same with the regular-file bit (0o100755…)
          [493, 511, 448, 457, 509, 33261, 33279, 33216, 33225, 33277].includes(
            node(n.right)?.value as number,
          ) &&
          own(base + n.start)
        )
          col.makesExecutable = true;
        if (
          /\.src$/.test(target) &&
          FRAME_NAME.test(target.split(".").at(-2) ?? "") &&
          /^https?:/i.test(textOf(node(n.right)) ?? "")
        )
          col.api("remote-page", hit(n));
        break;
      }
    }
  });

  // Network calls, now that local functions, aliases and the plugin's own files are known.
  // A local `function fetch` shadows the global one, unless it is a polyfill that sends the
  // request itself (`fetch = async function (url) { const xhr = new XMLHttpRequest(); … }`).
  const NETWORK_IN_BODY =
    /XMLHttpRequest|\bfetch\s*\(|\bHTTP\.\w+\s*\(|WebSocket|sendBeacon|newChannel/;
  const localFunction = (name: string, fns: AstNode[]) =>
    // A parameter called `fetch` (a cache helper's callback) shadows the global too.
    fns.some((f) => nodes(f.params).some((p) => p.type === "Identifier" && p.name === name)) ||
    bindings.lookup(name, fns).some((v) => {
      if (!FUNCTION_TYPES.has(v.type)) return false;
      const body = node(v.body);
      return !body || !NETWORK_IN_BODY.test(code.slice(body.start, body.end));
    });
  const globalGetter = (v: AstNode, name: string) =>
    /(^|\.)(getGlobal|resolveRuntimeGlobal|getRuntimeGlobal|getGlobalObject)$/.test(
      chain(node(v.callee)) ?? "",
    ) && str(nodes(v.arguments)[0]) === name;
  // `fetch` passed around as a value: `fetchImpl = fetch`, `deps.fetch ?? globalThis.fetch`,
  // `window.fetch.bind(window)`, `ztoolkit.getGlobal("fetch")`. A property literally named
  // `fetch` isn't followed: pdf.js's `xref.fetch(ref)` and caches use that name too.
  const isFetchValue = (v: AstNode | undefined, fns: AstNode[], depth = 0): boolean => {
    if (!v || depth > 4) return false;
    if (v.type === "ChainExpression") return isFetchValue(node(v.expression), fns, depth);
    const c = chain(v);
    if (c && FETCH_CHAIN.test(c)) return !(c === "fetch" && localFunction("fetch", fns));
    if (v.type === "CallExpression") {
      const callee = chain(node(v.callee)) ?? "";
      if (/(^|\.)fetch\.bind$/.test(callee) || globalGetter(v, "fetch")) return true;
      // A helper that picks a fetch: `const doFetch = resolveFetch();`
      const fn = callee.split(".").at(-1) ?? "";
      if (/^(get|resolve|create|make|pick|choose|find)\w*fetch\w*$/i.test(fn)) return true;
      return (bindings.returns.get(fn) ?? []).some((r) => isFetchValue(r.v, r.fns, depth + 1));
    }
    if (v.type === "LogicalExpression" || v.type === "ConditionalExpression")
      return [node(v.left), node(v.right), node(v.consequent), node(v.alternate)].some((x) =>
        isFetchValue(x, fns, depth + 1),
      );
    const name =
      v.type === "Identifier"
        ? (v.name as string)
        : v.type === "MemberExpression" && !v.computed
          ? (node(v.property)?.name as string)
          : null;
    if (!name || name === "fetch") return false;
    return fetchName(name, depth);
  };
  // Per name, not per call: bundles call through the same names thousands of times.
  const fetchNames = new Map<string, boolean>();
  const fetchName = (name: string, depth: number): boolean => {
    const known = fetchNames.get(name);
    if (known !== undefined) return known;
    fetchNames.set(name, false); // cycles
    const yes = bindings.all(name).some((x) => isFetchValue(x, [], depth + 1));
    fetchNames.set(name, yes);
    return yes;
  };
  const xhrNames = new Map<string, boolean>();
  const isXhrValue = (v: AstNode | undefined, fns: AstNode[], depth = 0): boolean => {
    if (!v || depth > 3) return false;
    if (/(^|\.)XMLHttpRequest$/.test(chain(v) ?? "")) return true;
    if (v.type === "CallExpression") return globalGetter(v, "XMLHttpRequest");
    if (v.type !== "Identifier") return false;
    const name = v.name as string;
    const known = xhrNames.get(name);
    if (known !== undefined) return known;
    xhrNames.set(name, false);
    const yes = bindings.all(name).some((x) => isXhrValue(x, fns, depth + 1));
    xhrNames.set(name, yes);
    return yes;
  };
  // `const request = Zotero.HTTP.request; request.call(Zotero.HTTP, "GET", url)`: the index of
  // the URL argument for the helper a name holds, or -1.
  const httpUrlArg = (v: AstNode | undefined, depth = 0): number => {
    if (!v || depth > 3) return -1;
    const c = chain(v) ?? "";
    if (ZOTERO_HTTP.test(c)) return /\.request$/.test(c) ? 1 : 0;
    if (v.type !== "Identifier") return -1;
    for (const x of bindings.all(v.name as string)) {
      const i = httpUrlArg(x, depth + 1);
      if (i >= 0) return i;
    }
    return -1;
  };
  const urlish = (a: AstNode | undefined): boolean => {
    if (!a) return false;
    const t = textOf(a);
    if (t !== null)
      return (
        /:\/\/|^\//.test(t.replaceAll(EXPR, "")) ||
        (a.type === "TemplateLiteral" && t.startsWith(EXPR))
      );
    const name = chain(a)?.split(".").at(-1) ?? "";
    return /(url|uri|endpoint|href)$/i.test(name);
  };
  for (const k of maybeNet) {
    const callee = node(k.n.callee);
    const c = chain(callee) ?? "";
    const direct = callee?.type === "Identifier" ? httpUrlArg(callee) : -1;
    const viaCall =
      callee?.type === "MemberExpression" && /\.call$/.test(c)
        ? httpUrlArg(node(callee.object))
        : -1;
    if (direct >= 0 || viaCall >= 0) {
      netCalls.push({ ...k, api: "zotero-http", urlIdx: direct >= 0 ? direct : viaCall + 1 });
      continue;
    }
    // `this.http.request("GET", url)` where `http: Zotero.HTTP` was passed in (dependency
    // injection, review: zotero-pdf-attachment-downloader, alphapulse).
    if (callee?.type === "MemberExpression" && /\.(request|doGet|doPost)$/.test(c)) {
      const recv = node(callee.object);
      const name =
        recv?.type === "Identifier"
          ? (recv.name as string)
          : recv?.type === "MemberExpression" && !recv.computed
            ? (node(recv.property)?.name as string)
            : "";
      const vals = name
        ? [
            ...bindings.lookup(name, k.fns),
            ...(recv?.type === "MemberExpression" ? bindings.lookup(name, k.fns, "prop") : []),
          ]
        : [];
      if (
        vals.some((v) => /(^|\.)HTTP$/.test(chain(v) ?? "") && /Zotero|^Z\b/.test(chain(v) ?? ""))
      ) {
        netCalls.push({ ...k, api: "zotero-http", urlIdx: /\.request$/.test(c) ? 1 : 0 });
        continue;
      }
      if (!/fetch/i.test(c)) continue;
    }
    if (k.isNew) {
      if (isXhrValue(callee, k.fns)) netCalls.push({ ...k, api: "xhr", urlIdx: -1 });
    } else if (callee?.type === "MemberExpression" && /\.(call|apply)$/.test(c)) {
      // The API clients' `this.fetch.call(undefined, url, init)`
      const target = node(callee.object);
      if (/(^|\.)fetch$/.test(chain(target) ?? "") || isFetchValue(target, k.fns))
        netCalls.push({ ...k, api: "fetch", urlIdx: c.endsWith(".call") ? 1 : -1 });
    } else if (
      isFetchValue(callee, k.fns) ||
      (/\.fetch$/.test(c) && urlish(k.args[0]) && own(base + k.n.start))
    ) {
      // `deps.fetch(\`${base()}/v1/audio\`)`: a fetch method called with something URL-shaped,
      // unlike pdf.js's `xref.fetch(ref)` or KaTeX's `parser.fetch()`.
      netCalls.push({ ...k, api: "fetch", urlIdx: 0 });
    }
  }

  // fetch or Zotero.HTTP handed to other code (a bundled Notion SDK given `window.fetch.bind(window)`):
  // that code sends requests for the plugin.
  for (const h of handedOver) {
    if (!own(base + h.n.start)) continue;
    if (/fetch/i.test(h.key) && isFetchValue(h.value, h.fns)) col.api("fetch", hit(h.n));
    else if (
      /^(http|httpClient|transport)$/i.test(h.key) &&
      /(^|\.)HTTP$/.test(chain(h.value) ?? "")
    )
      col.api("zotero-http", hit(h.n));
  }
  // Pages loaded into the plugin's own browser or frame, by name: `browser.setAttribute("src", url)`.
  for (const f of frameSrcs) {
    const urls = [...new Set(bindings.texts(f.value, f.fns))].filter((u) =>
      /^https?:\/\//i.test(u),
    );
    if (!urls.length) continue;
    col.api("remote-page", hit(f.n));
    for (const u of urls) col.url(u.split(EXPR)[0] as string, hit(f.n), "request");
  }

  // Requests for the plugin's own files can't reach the network (review P6).
  const LOCAL_URL = /^(chrome|resource|file|data|blob|jar|moz-extension|about):/i;
  const isLocalUrl = (a: AstNode | undefined, fns: AstNode[], depth = 0): boolean => {
    if (!a || depth > 3) return false;
    const t = textOf(a);
    if (t !== null && LOCAL_URL.test(t)) return true;
    let first: AstNode | undefined = a;
    while (first?.type === "BinaryExpression" && first.operator === "+") first = node(first.left);
    if (first?.type === "TemplateLiteral" && textOf(first)?.startsWith(EXPR))
      first = nodes(first.expressions)[0];
    const fc = chain(first) ?? "";
    // Names a plugin gives its own package root: `rootURI`, `this._rootURI.spec`, a sandbox's
    // `addonRoot` (rapidocr-for-zotero sets it to rootURI).
    if (
      /^_?rootURI\d*$|(^|\.)_?rootURI(\.spec)?$|^(addonRoot|pluginRoot|addonRootURI|pluginRootURI|ROOT_URI)(\.spec)?$|(^|\.)getResourceURI\(\)(\.spec)?$/i.test(
        fc,
      )
    )
      return true;
    // Canvas and blob contents: `canvas.toDataURL()`, `URL.createObjectURL(blob)`, or a
    // parameter named for them (`copyImage(win, dataURL)`).
    if (/(^|\.)(toDataURL|createObjectURL)\(\)$|^(data|blob|object)ur[il]s?$/i.test(fc))
      return true;
    // `Services.io.newURI(WORKSPACE_URI)`
    if (first?.type === "CallExpression" && /(^|\.)newURI$/.test(chain(node(first.callee)) ?? ""))
      return isLocalUrl(nodes(first.arguments)[0], fns, depth + 1);
    if (first && first !== a) return isLocalUrl(first, fns, depth + 1);
    if (a.type === "ConditionalExpression")
      return (
        isLocalUrl(node(a.consequent), fns, depth + 1) &&
        isLocalUrl(node(a.alternate), fns, depth + 1)
      );
    // `this.pageURL`, set to a chrome:// address elsewhere in the file.
    if (a.type === "MemberExpression" && !a.computed) {
      const vals = bindings.lookup((node(a.property)?.name as string) ?? "", fns, "prop");
      if (vals.length && vals.every((v) => isLocalUrl(v, fns, depth + 1))) return true;
    }
    // A helper that builds a local address: `fetch(bundledResourceURL(name))`, where the helper
    // returns `chrome://${addonRef}/content/${name}`.
    if (a.type === "CallExpression") {
      const rets = bindings.returns.get(chain(node(a.callee))?.split(".").at(-1) ?? "") ?? [];
      return rets.length > 0 && rets.every((r) => isLocalUrl(r.v, r.fns, depth + 1));
    }
    if (a.type !== "Identifier") return false;
    const name = a.name as string;
    const values = bindings.lookup(name, fns);
    if (values.length) return values.every((v) => isLocalUrl(v, fns, depth + 1));
    // A parameter: local when every call of the function in this file passes a local address
    // (`readTextFromURI(uri)` only ever called with `rootURI + "style.css"`).
    for (const f of fns) {
      const i = nodes(f.params).findIndex((p) => {
        const id = p.type === "AssignmentPattern" ? node(p.left) : p;
        return id?.type === "Identifier" && id.name === name;
      });
      if (i < 0) continue;
      const calls = callArgs.get(fnNames.get(f) ?? "") ?? [];
      return (
        calls.length > 0 &&
        calls.every(
          (k) => k.args[i] !== undefined && isLocalUrl(k.args[i], k.fn ? [k.fn] : [], depth + 1),
        )
      );
    }
    return false;
  };

  // An XMLHttpRequest's address is in `xhr.open(method, url)`: when every open() in the file is
  // for the plugin's own files (bundled locale or style sheets), creating one isn't network use.
  const opens = netCalls.filter(
    (k) => k.api === null && k.urlIdx === 1 && /\.open$/.test(chain(node(k.n.callee)) ?? ""),
  );
  const xhrLocalOnly =
    opens.length > 0 && opens.every((k) => k.args[1] && isLocalUrl(k.args[1], k.fns));
  /** Where each request's address is: its argument, or what callers pass a helper (the call). */
  const requestRanges: [number, number, ReqCall][] = [];
  /**
   * Ranges of the arguments callers pass for the parameters an address is built from: the enclosing
   * function's own parameters, directly or through one binding (`const url = BASE + path`), with
   * each caller's call. The function can be one around a callback the request sits in
   * (`translationRequest(task, method, url) { run(() => Zotero.HTTP.request(method, url)) }`).
   */
  const paramCallSites = (
    arg: AstNode,
    fns: AstNode[],
    inner?: ReqCall,
    depth = 0,
  ): [number, number, ReqCall][] => {
    if (depth > 3) return [];
    const names = new Set<string>();
    const collect = (a: AstNode | undefined) => {
      for (const d of a ? [a, ...descendants(a)] : [])
        if (d.type === "Identifier") names.add(d.name as string);
    };
    collect(arg);
    if (arg.type === "Identifier")
      for (const v of bindings.lookup(arg.name as string, fns).slice(0, 5)) collect(v);
    const paramsOf = (f: AstNode) =>
      nodes(f.params).map((p) => (p.type === "AssignmentPattern" ? node(p.left) : p));
    const fn = fns.find((f) =>
      paramsOf(f).some((p) => p?.type === "Identifier" && names.has(p.name as string)),
    );
    const key = fn && fnNames.get(fn);
    if (!fn || !key) return [];
    const out: [number, number, ReqCall][] = [];
    paramsOf(fn).forEach((p, i) => {
      if (p?.type !== "Identifier" || !names.has(p.name as string)) return;
      for (const call of callArgs.get(key) ?? []) {
        const a = call.args[i];
        if (!a || !call.n) continue;
        const site: ReqCall = { n: call.n, url: a, fns: call.fn ? [call.fn] : [], inner, fn };
        out.push([a.start, a.end, site]);
        // …and what a variable passed there holds (`const url = \`https://…\`; fetchText(url)`).
        if (a.type === "Identifier")
          for (const v of bindings.lookup(a.name as string, call.fn ? [call.fn] : []).slice(0, 5))
            out.push([v.start, v.end, site]);
        // A wrapper passing its own parameter on (`_requestJSON(url) { return _requestRaw(url) }`,
        // zotgit): continue to that wrapper's callers.
        if (call.fn && depth < 3) out.push(...paramCallSites(a, [call.fn], site, depth + 1));
      }
    });
    return out.slice(0, 200);
  };
  // What a request carries of the user's, read from its call (cleartext-http sweep): the names in
  // its address after the base (`?q=${encodeURIComponent(text)}`), in its body and options, and
  // credential headers. A name for data we can't tell (`postData`) is followed one binding back.
  const valueNames = (
    e: AstNode | undefined,
    fns: AstNode[],
    out: { names: string[]; cred: boolean },
    hops = 1,
  ): void => {
    if (!e || out.names.length > 40) return;
    const t = e.type;
    if (t === "Identifier") {
      const name = e.name as string;
      // `MAX_RECORDS`, `Date`: the plugin's own constants and classes.
      if (/^[A-Z]/.test(name) || name === "undefined") return;
      if (sentName(name) !== "content" || hops <= 0) {
        out.names.push(name);
        return;
      }
      const values = bindings.lookup(name, fns).slice(0, 3);
      // A constant (`const secret = "…"`) is the plugin's own, not the user's.
      if (values.length && values.every((v) => v.type === "Literal")) return;
      const before = out.names.length;
      for (const v of values) valueNames(v, fns, out, hops - 1);
      if (out.names.length === before) out.names.push(name);
    } else if (t === "MemberExpression") {
      if (e.computed) valueNames(node(e.object), fns, out, hops);
      else out.names.push((node(e.property)?.name as string) ?? "");
    } else if (t === "CallExpression" || t === "NewExpression") {
      const callee = node(e.callee);
      // `text.trim()`, `data.raw.replace(…)`: the value a method is called on; not `JSON.stringify`.
      if (callee?.type === "MemberExpression") {
        const root = chain(node(callee.object))?.split(".")[0] ?? "";
        if (!/^[A-Z]/.test(root)) valueNames(node(callee.object), fns, out, hops);
      }
      for (const a of nodes(e.arguments)) valueNames(a, fns, out, hops);
    } else if (t === "ObjectExpression") {
      for (const p of nodes(e.properties)) {
        if (p.type === "SpreadElement") {
          valueNames(node(p.argument), fns, out, hops);
          continue;
        }
        const key = (node(p.key)?.name as string) ?? str(node(p.key)) ?? "";
        const value = node(p.value);
        if (/^headers$/i.test(key)) {
          // Only a key or token in the headers is the user's; `Content-Type` isn't, nor the
          // cookies a site handed out for its own forms.
          const h = { names: [] as string[], cred: false };
          const props = value?.type === "ObjectExpression" ? nodes(value.properties) : [];
          const keys = props.map((q) => nameOf(q));
          if (props.length)
            for (const q of props) {
              if (!/^cookie$/i.test(nameOf(q) ?? "")) valueNames(node(q.value), fns, h, hops);
            }
          else valueNames(value, fns, h, hops);
          if (
            keys.some((k) => k && HEADER_CREDENTIAL.test(k)) ||
            h.names.some((n) => sentName(n) === "credentials")
          )
            out.cred = true;
        } else if (!REQUEST_OPTION.test(key)) {
          if (sentName(key) === "credentials") out.cred = true;
          valueNames(value, fns, out, hops);
        }
      }
    } else if (t === "TemplateLiteral") {
      for (const x of nodes(e.expressions)) valueNames(x, fns, out, hops);
    } else if (t === "BinaryExpression" || t === "LogicalExpression") {
      valueNames(node(e.left), fns, out, hops);
      valueNames(node(e.right), fns, out, hops);
    } else if (t === "ConditionalExpression") {
      valueNames(node(e.consequent), fns, out, hops);
      valueNames(node(e.alternate), fns, out, hops);
    } else if (t === "ArrayExpression") {
      for (const x of nodes(e.elements)) valueNames(x, fns, out, hops);
    } else if (
      ["AwaitExpression", "UnaryExpression", "SpreadElement", "ChainExpression"].includes(t) ||
      t === "ParenthesizedExpression"
    )
      valueNames(node(e.argument) ?? node(e.expression), fns, out, hops);
  };
  /** The names in an address after its base: `${API}/search?q=${q}` gives `q`. */
  const addressNames = (
    e: AstNode | undefined,
    fns: AstNode[],
    out: { names: string[]; cred: boolean },
    hops = 2,
  ): void => {
    if (!e) return;
    const pieces: AstNode[] = [];
    if (e.type === "TemplateLiteral") {
      const quasis = nodes(e.quasis).map((q) => (q.value as { raw: string }).raw);
      nodes(e.expressions).forEach((x, i) => {
        // `?key=${apiKey}`: a credential passed in the address.
        if (CREDENTIAL_PARAM.test(quasis[i] ?? "")) out.cred = true;
        if (i > 0 || quasis[0] !== "") pieces.push(x);
      });
    } else if (e.type === "BinaryExpression" && e.operator === "+") {
      const flat: AstNode[] = [];
      const walk = (x: AstNode | undefined) => {
        if (x?.type === "BinaryExpression" && x.operator === "+") {
          walk(node(x.left));
          walk(node(x.right));
        } else if (x) flat.push(x);
      };
      walk(e);
      flat.forEach((x, i) => {
        const prev = flat[i - 1];
        if (prev && CREDENTIAL_PARAM.test(str(prev) ?? "")) out.cred = true;
        if (i > 0 || x.type === "Literal" || x.type === "TemplateLiteral") {
          if (x.type === "TemplateLiteral") addressNames(x, fns, out, hops);
          else if (x.type !== "Literal") pieces.push(x);
        }
      });
    } else if (e.type === "Identifier" && hops > 0) {
      for (const v of bindings.lookup(e.name as string, fns).slice(0, 3))
        addressNames(v, fns, out, hops - 1);
    } else if (e.type === "ConditionalExpression" || e.type === "LogicalExpression") {
      addressNames(node(e.consequent) ?? node(e.left), fns, out, hops);
      addressNames(node(e.alternate) ?? node(e.right), fns, out, hops);
    } else if (e.type === "CallExpression") {
      const callee = node(e.callee);
      // `(base || DEFAULT).trim()`; a helper building the address passes what it's built from.
      if (
        callee?.type === "MemberExpression" &&
        /^(trim|replace\w*|concat|toString)$/.test(nameOf(callee) ?? "")
      )
        addressNames(node(callee.object), fns, out, hops);
      else for (const a of nodes(e.arguments)) valueNames(a, fns, out);
    }
    for (const x of pieces) valueNames(x, fns, out);
  };
  const payloadMemo = new Map<ReqCall, { names: string[]; cred: boolean }>();
  const payloadNames = (req: ReqCall, depth = 0): { names: string[]; cred: boolean } => {
    const memo = payloadMemo.get(req);
    if (memo) return memo;
    const out = { names: [] as string[], cred: false };
    payloadMemo.set(req, out);
    const args = nodes(req.n.arguments);
    const at = req.url ? args.indexOf(req.url) : -1;
    addressNames(req.url, req.fns, out);
    if (req.inner && req.fn && depth < 4) {
      // A helper's request: its parameters stand for what this call passes (`request(url, opts)`
      // sends this call's options), unless the parameter's own name already says what it holds.
      const params = nodes(req.fn.params).map((p) =>
        p.type === "AssignmentPattern" ? node(p.left) : p,
      );
      const inner = payloadNames(req.inner, depth + 1);
      if (inner.cred) out.cred = true;
      for (const name of inner.names) {
        const i = params.findIndex((p) => p?.type === "Identifier" && p.name === name);
        if (i >= 0 && i !== at && sentName(name) === "content") valueNames(args[i], req.fns, out);
        else if (i < 0) out.names.push(name);
      }
      return out;
    }
    // The body and options: every argument after the address but callbacks (`fetch(url, init)`,
    // `doPost(url, body)`); an XHR's body is what its `send()` gets.
    for (const a of args.slice(at + 1))
      if (!FUNCTION_TYPES.has(a.type)) valueNames(a, req.fns, out);
    if (/\.open$/.test(chain(node(req.n.callee)) ?? "")) {
      const fn = req.fns[0];
      const rest = code.slice(req.n.end, fn ? fn.end : Math.min(code.length, req.n.end + 2000));
      const sent = rest.match(/\.send\(\s*([^)]+)\)/)?.[1] ?? "";
      for (const m of sent.matchAll(/[A-Za-z_$][\w$]*/g))
        if (!/^(JSON|stringify|encodeURIComponent|null|undefined|String)$/.test(m[0]))
          out.names.push(m[0]);
    }
    return out;
  };
  /** What a set of request calls sends, as kinds: the user's text, keys, identifiers, searches. */
  const payloadOf = (reqs: ReqCall[]): Sent[] => {
    const kinds = new Set<Sent>();
    for (const r of reqs) {
      const p = payloadNames(r);
      if (p.cred) kinds.add("credentials");
      for (const n of p.names) {
        const k = sentName(n);
        if (k) kinds.add(k);
      }
    }
    return [...kinds].sort();
  };
  /** The helper whose result an address starts with, as the address or one binding back. */
  const helperName = (a: AstNode | undefined, fns: AstNode[], hops = 1): string | null => {
    let first = a;
    while (first?.type === "BinaryExpression" && first.operator === "+") first = node(first.left);
    if (first?.type === "TemplateLiteral" && textOf(first)?.startsWith(EXPR))
      first = nodes(first.expressions)[0];
    if (first?.type === "Identifier" && hops > 0) {
      for (const v of bindings.lookup(first.name as string, fns).slice(0, 3)) {
        const h = helperName(v, fns, hops - 1);
        if (h) return h;
      }
      return null;
    }
    if (first?.type !== "CallExpression") return null;
    const callee = node(first.callee);
    // esbuild's and Babel's private methods: `__privateMethod(this, _brand, method).call(this)`.
    const held = callee?.type === "MemberExpression" ? node(callee.object) : undefined;
    if (
      held?.type === "CallExpression" &&
      /^(call|apply)$/.test(nameOf(callee) ?? "") &&
      /^_*(privateMethod|classPrivateMethodGet)$/i.test(chain(node(held.callee)) ?? "")
    ) {
      const m = nodes(held.arguments)[2];
      return m?.type === "Identifier" ? (m.name as string) : null;
    }
    const fn = (chain(callee) ?? "").split(".").at(-1) ?? "";
    return fn.length > 2 ? fn : null;
  };
  /** Zotero's API base: `ZOTERO_CONFIG.API_URL` (or its config held in a name), Sync.Runner's. */
  const zoteroApiBase = (a: AstNode, fns: AstNode[]): boolean => {
    const c = chain(a) ?? "";
    if (/(^|\.)Sync\.Runner\.baseURL$/.test(c)) return true;
    if (a.type !== "MemberExpression" || nameOf(a) !== "API_URL") return false;
    const config = node(a.object);
    const held = (x: AstNode | undefined) =>
      /(^|\.)ZOTERO_CONFIG$|zoteroConfig(\(\))?$/i.test(chain(x) ?? "");
    return (
      held(config) ||
      (config?.type === "Identifier" &&
        bindings.lookup(config.name as string, fns).some((v) => held(v)))
    );
  };
  /** Whether an address starts on Zotero's API base, through `+`, templates, `?:` and names. */
  const onZoteroApi = (a: AstNode | undefined, fns: AstNode[], depth = 0): boolean => {
    if (!a || depth > 4) return false;
    if (a.type === "ConditionalExpression")
      return [node(a.consequent), node(a.alternate)].some((x) => onZoteroApi(x, fns, depth + 1));
    let first: AstNode | undefined = a;
    while (first?.type === "BinaryExpression" && first.operator === "+") first = node(first.left);
    if (first?.type === "TemplateLiteral" && textOf(first)?.startsWith(EXPR))
      first = nodes(first.expressions)[0];
    if (!first) return false;
    if (zoteroApiBase(first, fns)) return true;
    return (
      first.type === "Identifier" &&
      bindings
        .lookup(first.name as string, fns)
        .slice(0, 5)
        .some((v) => onZoteroApi(v, fns, depth + 1))
    );
  };
  const fromList = (arg: AstNode, fns: AstNode[]): boolean => {
    if (arg.type === "MemberExpression" && arg.computed)
      return node(arg.property)?.type !== "Literal";
    if (arg.type !== "Identifier") return false;
    const name = (arg.name as string).replace(/\$/g, "\\$");
    const loop = new RegExp(
      `for\\s*\\(\\s*(?:const|let|var)\\s*(?:\\[[^\\]]*\\b${name}\\b[^\\]]*\\]|${name}\\s)\\s*of\\b`,
    );
    // The loop can be a few functions out: `for (…) { await withDeadline(() => request(url)) }`.
    return fns
      .slice(0, 3)
      .some((f) => f.end - f.start < 200_000 && loop.test(code.slice(f.start, f.end)));
  };
  for (const k of netCalls) {
    const c = chain(node(k.n.callee)) ?? "";
    if (c === "fetch" && localFunction("fetch", k.fns)) continue;
    const arg = k.urlIdx >= 0 ? k.args[k.urlIdx] : undefined;
    if (arg && k.api !== "xhr" && isLocalUrl(arg, k.fns)) continue;
    if (k.api === "xhr" && k.urlIdx < 0 && xhrLocalOnly) continue;
    if (k.api) col.api(k.api, hit(k.n));
    // The address saved on the user's own item (`item.getField("url")`): the destination is the
    // user's library, like a server they set (zotero-date-from-last-modified, zotero-redownloader).
    if (arg && own(base + k.n.start)) {
      const sources = [
        arg,
        ...(arg.type === "Identifier" ? bindings.lookup(arg.name as string, k.fns) : []),
      ];
      if (sources.some((v) => ITEM_URL.test(code.slice(v.start, Math.min(v.end, v.start + 400))))) {
        const e = col.endpoints.get(ITEM_URL_KEY) ?? { hits: [] };
        e.hits.push(hit(k.n));
        col.endpoints.set(ITEM_URL_KEY, e);
      }
    }
    // Only downloads that look like a program: an archive, installer or binary (a Word template
    // next to unrelated program launches isn't one). The address can be in the call or in the
    // names it's built from.
    if (k.api && own(base + k.n.start)) {
      // `Downloads.createDownload({ source: url, target: file })`: the address is a property.
      const addr =
        arg?.type === "ObjectExpression"
          ? node(
              nodes(arg.properties).find((p) =>
                /^(source|url|uri|href)$/.test(
                  (node(p.key)?.name as string) ?? str(node(p.key)) ?? "",
                ),
              )?.value,
            )
          : arg;
      const said = [
        code.slice(k.n.start, k.n.end),
        ...(addr ? bindings.texts(addr, k.fns) : []),
      ].join(" ");
      const savesBytes =
        /arrayBuffer|responseType\s*[:=]\s*["'](arraybuffer|blob)|\.blob\(|IOUtils\.write|writeAtomic|putContentsAsync/i.test(
          code.slice(k.n.start, Math.min(code.length, k.n.end + 600)),
        );
      if (savesBytes) col.byteSaves.push(hit(k.n));
      const explicit = k.api === "download" || /(\.download|downloadFile)$/.test(c);
      if (
        explicit
          ? /zip|tar\b|\.gz|tgz|\.exe|\.dmg|appimage|binar|\bbin\b|archive|release|\.(sh|ps1)\b/i.test(
              said,
            )
          : // A fetch or XHR saved to disk: the address names a program file and the response
            // is written out as bytes.
            /\.(zip|tar|gz|tgz|xz|7z|exe|msi|dmg|pkg|appimage|deb|rpm|sh|ps1)\b|releases\/download\//i.test(
              said,
            ) && savesBytes
      )
        col.downloads.push(hit(k.n));
    }
    if (!arg) continue;
    // Zotero's own web API as the address's base (`${ZOTERO_CONFIG.API_URL}users/…`,
    // `Zotero.Sync.Runner.baseURL`), directly or through the names it's built from: a request to
    // api.zotero.org, usually with the user's sync key (beaver's downloads from Zotero File Storage).
    if (own(base + k.n.start) && onZoteroApi(arg, k.fns))
      col.url("https://api.zotero.org/", hit(k.n), "request");
    const req: ReqCall = { n: k.n, url: arg, fns: k.fns };
    reqByNode.set(k.n, req);
    if (own(base + k.n.start)) ownCalls.push(req);
    // The address is a helper's result, resolved once every file is read: the whole address, its
    // start (`getBase() + "/recommend"`), or one binding back.
    const helper = own(base + k.n.start) ? helperName(arg, k.fns) : null;
    if (helper) {
      const at = base + k.n.start;
      const seen = col.urlCalls.find(
        (u) => u.hit.file === file && u.hit.offset === at && u.fn === helper,
      );
      // Read only if the helper's address turns out to be plain http.
      const sends = () => payloadOf([req]);
      if (seen) seen.sends = sends;
      else if (col.urlCalls.length < 500) col.urlCalls.push({ hit: hit(k.n), fn: helper, sends });
    }
    requestRanges.push([arg.start, arg.end, req]);
    // The address is a parameter of the function making the request (`publicRequest(url) {
    // Zotero.HTTP.request("GET", url) }`, zotero-agent--auince): what each call passes for it is a
    // destination too, in this file.
    for (const at of paramCallSites(arg, k.fns, req)) requestRanges.push(at);
    const propNodes = new Set<AstNode>();
    for (const d of descendants(arg))
      if (d.type === "MemberExpression" && !d.computed) {
        const p = node(d.property);
        if (p?.type === "Identifier") {
          propNodes.add(p);
          if ((p.name as string).length >= 3) noteRequestProp(p.name as string, req);
        }
      }
    for (const d of descendants(arg))
      if (d.type === "Identifier" && !propNodes.has(d) && (d.name as string).length >= 3)
        noteRequestName(d.name as string, k.fns[0] ?? null, req);
    // One more hop: `const url = config.updateJSON; Zotero.HTTP.request("GET", url)`.
    if (arg.type === "Identifier")
      for (const v of bindings.lookup(arg.name as string, k.fns)) {
        if (v.type === "Identifier" && (v.name as string).length >= 3)
          noteRequestName(v.name as string, k.fns[0] ?? null, req);
        const prop =
          v.type === "MemberExpression" && !v.computed ? (node(v.property)?.name as string) : null;
        if (prop && prop.length >= 3) noteRequestProp(prop, req);
      }
    const pattern = textOf(arg);
    if (pattern?.includes(EXPR) || (pattern === null && arg.type !== "Literal")) {
      const shown = (pattern ?? EXPR).replaceAll(EXPR, "<expr>").slice(0, 200);
      if (shown !== "<expr>")
        col.dynamicUrls.set(shown, [...(col.dynamicUrls.get(shown) ?? []), hit(k.n)]);
    }
  }

  // A session ID is a credential unless every value it's set to is one the plugin makes up (a
  // random UUID or string): that names a chat, it doesn't sign anyone in.
  const madeUp = (v: AstNode | undefined, fns: AstNode[], depth = 0): boolean => {
    if (!v || depth > 3) return false;
    if (GENERATED_VALUE.test(code.slice(v.start, v.end))) return true;
    return [v, ...descendants(v)].some(
      (d) =>
        d.type === "Identifier" &&
        bindings
          .lookup(d.name as string, fns)
          .slice(0, 5)
          .some((b) => b !== v && madeUp(b, fns, depth + 1)),
    );
  };
  for (const key of new Set(sessionKeys.map((x) => x.key))) {
    const sites = sessionKeys.filter((x) => x.key === key);
    const sets = sites.filter((x) => x.value);
    if (sets.length && sets.every((x) => madeUp(x.value, x.fns))) continue;
    for (const x of sites) col.cap("credential-storage", x.hit, "preferences").prefKeys.add(key);
  }

  // Pointing Zotero's file sync or proxy at a fixed server makes Zotero send data there (review
  // P8: Nutstore sets sync.storage.url to its WebDAV host).
  for (const k of prefSets) {
    for (const v of new Set(bindings.texts(k.args[1], k.fns))) {
      if (!v || v.includes(EXPR) || !/[a-z0-9]\.[a-z]/i.test(v)) continue;
      col.url(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`, hit(k.n), "request");
    }
  }

  for (const k of evalNames) {
    const srcs = bindings.lookup(k.name, k.fns).map((v) => fromNetwork(v));
    if (srcs.some(Boolean))
      col.cap(
        "remote-code",
        hit(k.n),
        srcs.every((x) => !x || x === "ai") ? AI_REPLY : `${k.c} on network response`,
      );
  }
  /**
   * A storage open on a browser's cookie or password store: its file name, in the argument, the
   * names it's built from, or what callers pass the function's parameter (one hop); or SQL on the
   * store's own tables in the same function.
   */
  const opensBrowserStore = (k: Call): boolean => {
    const arg = k.args[0];
    const fn = k.fns[0];
    if (fn && BROWSER_TABLE_SQL.test(code.slice(fn.start, fn.end))) return true;
    if (!arg) return false;
    const names = new Set<string>();
    const texts: string[] = [];
    for (const a of [arg, ...bindings.lookup(chain(arg) ?? "", k.fns).slice(0, 3)])
      for (const d of [a, ...descendants(a)]) {
        if (d.type === "Identifier") names.add(d.name as string);
        const t = textOf(d);
        if (t) texts.push(t);
      }
    for (const n of [...names])
      for (const v of bindings.lookup(n, k.fns).slice(0, 3)) {
        const t = textOf(v);
        if (t) texts.push(t);
        for (const d of descendants(v)) if (d.type === "Identifier") names.add(d.name as string);
      }
    const params = fn ? nodes(fn.params) : [];
    params.forEach((p, i) => {
      if (p.type !== "Identifier" || !names.has(p.name as string) || !fn) return;
      for (const call of callArgs.get(fnNames.get(fn) ?? "") ?? []) {
        const t = textOf(call.args[i]);
        if (t) texts.push(t);
      }
    });
    return texts.some((t) => BROWSER_STORE_FILE.test(t));
  };
  // Opening zotero.sqlite itself, not some other database file (the audit: any mention of the
  // file name used to make every storage open count).
  for (const k of sqliteOpens) {
    const arg = k.args[0];
    const target = arg ? code.slice(arg.start, arg.end) : "";
    const values = arg ? bindings.texts(arg, k.fns) : [];
    // `openUnsharedDatabase(new FileUtils.File(path))`: what the names in the argument hold.
    const bound = arg
      ? [...descendants(arg)]
          .filter((d) => d.type === "Identifier")
          .flatMap((d) => bindings.lookup(d.name as string, k.fns))
          .map((v) => code.slice(v.start, v.end))
      : [];
    if ([target, ...values, ...bound].some((t) => /zotero\.sqlite|getZoteroDatabase/i.test(t)))
      col.cap("sqlite-direct", hit(k.n), "mozIStorageService");
    // A browser's store it opens (or its copy of one) is the browser's, part of handling its
    // sign-ins: zotero-pdf-hand-catcher deletes Cloudflare cookies from its copy of Edge's.
    else if (browserStoreHit && opensBrowserStore(k)) continue;
    // Any other database file is its own (zotero-agents keeps zotero-agents.db and synthesis.db).
    else if (own(base + k.n.start)) col.cap("own-database", hit(k.n), "mozIStorageService");
  }

  // Scripts the plugin injects from the web: `s = document.createElement("script"); s.src = url`.
  if (createsScript) {
    const isScriptElement = (r: AstNode | undefined, fns: AstNode[]) => {
      const name =
        r?.type === "Identifier"
          ? (r.name as string)
          : r?.type === "MemberExpression" && !r.computed
            ? (node(r.property)?.name as string)
            : null;
      if (!name) return false;
      return bindings
        .lookup(name, fns, r?.type === "Identifier" ? "var" : "prop")
        .some(
          (v) =>
            /(^|\.)createElement(NS)?$/.test(chain(node(v.callee)) ?? "") &&
            /^(html:)?script$/i.test(str(nodes(v.arguments).at(-1)) ?? ""),
        );
    };
    for (const k of scriptSrcs) {
      if (!own(base + k.n.start) || !isScriptElement(k.receiver, k.fns)) continue;
      for (const url of new Set(bindings.texts(k.value, k.fns))) {
        if (!/^https?:\/\//i.test(url)) continue;
        const clean = url.split(EXPR)[0] as string;
        // Zotero blocks the request in privileged pages, so the host isn't a destination.
        col.url(clean, hit(k.n), "unknown");
        col.cap("remote-script", hit(k.n), hostOf(clean)?.host ?? "web");
      }
    }
  }
  for (const r of returnIds) {
    // Two levels deeper than usual: variable → conditional → `BASE + x` → the constant.
    const urls = bindings
      .texts(r.arg, r.fns, -2)
      .filter((t) => /^https?:\/\/[^/\s]+\./i.test(t.split(EXPR)[0] ?? ""))
      .map((t) => t.split(EXPR)[0] as string);
    if (urls.length) col.returned(r.name, urls, hit(r.arg));
  }
  // loadSubScript and import() of an address held in a variable (review P11).
  for (const k of subScripts) {
    // A helper that takes arguments (`this.buildScriptURL(name)`, zotero-odh): its returned address,
    // resolved after every file, like request addresses.
    if (k.arg.type === "CallExpression") {
      const fn = (chain(node(k.arg.callee)) ?? "").split(".").at(-1) ?? "";
      if (fn.length > 2)
        col.scriptCalls.push({
          hit: hit(k.n),
          fn,
          kind: k.n.type === "ImportExpression" ? "import()" : "loadSubScript",
        });
    }
    for (const url of new Set(bindings.texts(k.arg, k.fns))) {
      if (!/^https?:\/\//i.test(url)) continue;
      col.url(url.split(EXPR)[0] as string, hit(k.n), "request");
      col.cap(
        "remote-code",
        hit(k.n),
        k.n.type === "ImportExpression" ? "import() over http(s)" : "loadSubScript over http(s)",
      );
    }
  }

  // Where a server socket listens: `true`, `false`, minified `!0` and `!1`, or a name only ever
  // given one of them (zotero-research-bridge's frozen `BRIDGE_POLICY = { loopbackOnly: true }`),
  // else a setting, matched to its default once every file is read (listenSettings).
  for (const { n, args, fns } of socketInits) {
    const arg = args[0] as AstNode;
    const fixed = constantBool(arg, fns, bindings);
    if (fixed !== true)
      col.cap(
        "own-server",
        hit(n),
        fixed === false
          ? "listens beyond this computer"
          : "can listen beyond this computer (a setting)",
      );
    if (fixed === null) col.listenSettings.push(listenSetting(arg, fns, bindings, code));
  }

  // Database writes: the SQL through one hop of bindings, and whose database the receiver is.
  for (const { n, callee, args, fns } of dbCalls) {
    const receiver =
      callee.type === "ChainExpression"
        ? node(node(callee.expression)?.object)
        : node(callee.object);
    const kind = bindings.dbKind(receiver, fns);
    if (kind === "own") {
      // Its own database file: shown, not counted as Zotero's database.
      if (
        own(base + n.start) &&
        bindings.texts(args[0], fns).some((q) => SQL_WRITE.test(q)) &&
        !col.caps.has("own-database")
      )
        col.cap("own-database", hit(n), "Zotero.DBConnection");
      continue;
    }
    const recvName = chain(receiver)?.split(".").at(-1) ?? "";
    if (kind === "unknown" && !DB_LIKE_NAME.test(recvName)) continue;
    for (const sql of new Set(bindings.texts(args[0], fns))) {
      const m = sql.match(SQL_WRITE);
      if (!m?.[1] || !m[2]) continue;
      // Temporary tables live outside the database file: `CREATE TEMP TABLE`, and dropping the
      // table Zotero.Search.idsToTempTable made (rssrch-for-zotero).
      if (/\bTEMP(ORARY)?\s+TABLE\b/i.test(sql)) continue;
      if (/^DROP\b/i.test(m[1]) && m[2] === EXPR && /idsToTempTable/.test(code)) continue;
      const verb = m[1].split(/\s+/)[0]?.toUpperCase() ?? "";
      // Triggers and indexes write to the table they're defined ON, never their own name; a name
      // shaped like a class (`ConversationRetiredError`, from a wrong binding) isn't a table.
      const indexLike = /INDEX|TRIGGER/i.test(m[1]);
      const on = indexLike ? sql.match(/\bON\s+["`[]?(\w+)/i)?.[1] : null;
      const named = indexLike ? on : m[2] === EXPR ? null : m[2];
      const table = named && !/Error$|^[A-Z][a-z]+[A-Z]/.test(named) ? named : COMPUTED_TABLE;
      if (kind === "zotero") {
        const cap = col.cap("db-write", hit(n), "Zotero.DB");
        cap.sql.add(verb);
        cap.tables.add(table);
      } else {
        col.otherDbWrites.push({ hit: hit(n), verb, table });
      }
    }
  }

  // URLs in template literals, with `${NAME}` filled in when NAME holds a single string.
  for (const t of templates) {
    const quasis = nodes(t.n.quasis).map(
      (q) =>
        (q.value as { cooked?: string; raw: string }).cooked ?? (q.value as { raw: string }).raw,
    );
    const exprs = nodes(t.n.expressions);
    const text = quasis
      .map((q, i) => {
        const e = exprs[i];
        if (!e) return q;
        // A constant or a small helper's return value (`${getApiBase()}/license/validate`).
        const values =
          e.type === "Identifier" || (e.type === "CallExpression" && !nodes(e.arguments).length)
            ? new Set(bindings.texts(e, t.fns))
            : new Set<string>();
        const one = values.size === 1 ? [...values][0] : undefined;
        return q + (one && !one.includes(EXPR) ? one : EXPR);
      })
      .join("");
    const all = templateUrls(text, col.table);
    // `<a href="https://doi.org/${doi}">` in a template of HTML is a link.
    const isLink = (u: string) => {
      const at = text.indexOf(u);
      return at > 0 && /href\s*=\s*["']?$/i.test(text.slice(Math.max(0, at - 12), at));
    };
    const links = all.filter(isLink);
    const urls = all.filter((u) => !isLink(u));
    if (links.length)
      urlLiterals.push({ offset: t.n.start, urls: links, usage: "link", binding: null });
    if (urls.length) {
      urlLiterals.push({
        offset: t.n.start,
        urls,
        usage: t.usage,
        binding: t.binding,
        scope: t.fns[0] ?? null,
        ...(t.call ? { call: t.call } : {}),
        ...(t.fallback ? { fallback: true } : {}),
        ...(t.mirror ? { mirror: true } : {}),
      });
      if (t.returnFn) col.returned(t.returnFn, urls, hit(t.n));
    }
  }

  // zotero:// link handlers: what the handler (and the functions it calls, one hop) does with the
  // link. Any web page can open a zotero:// link, one click on the browser's prompt away.
  // The key can be a name: `const customScheme = ZOTERO_SCHEME + "://zoteroaddoncollection"`.
  const handlerObject = (h: (typeof linkHandlers)[number]) =>
    h.value?.type === "Identifier"
      ? bindings.lookup(h.value.name as string, h.fns).find((v) => v.type === "ObjectExpression")
      : h.value;
  for (const h of linkHandlers) {
    const keys = [textOf(h.key), ...bindings.texts(h.key, h.fns)].filter(
      (k): k is string => typeof k === "string",
    );
    // Only the zotero:// handler has `_extensions`, so a key whose scheme we couldn't resolve
    // is one of its links too.
    const key = keys.find((k) => /^zotero:\/\//.test(k)) ?? keys.find((k) => k.includes("://"));
    h.name = key ? `zotero://${key.split("://")[1] ?? ""}`.replaceAll(EXPR, "*") : "";
    // An obfuscated key, inside zotero-plugin-toolkit's own module (its esbuild key survives:
    // `'node_modules/zotero-plugin-toolkit/dist/utils/pluginBridge.js'(…){`, rockcor).
    if (!h.name) {
      const before = code.slice(Math.max(0, h.n.start - 20000), h.n.start);
      const mod = [
        ...before.matchAll(/zotero-plugin-toolkit\/dist\/utils\/(pluginBridge|debugBridge)\.js/g),
      ].at(-1)?.[1];
      if (mod) h.name = mod === "pluginBridge" ? "zotero://plugin" : "zotero://ztoolkit-debug";
    }
    // …or known by its handler, whose shape the obfuscator left (zotbox, magiczotero): the plugin
    // bridge installs from the link and shows "Plugin Toolkit"; the debug bridge runs the link's
    // code as `AsyncFunction("Zotero,window", …)`.
    const obj = h.name ? undefined : handlerObject(h);
    if (obj) {
      const text = unescapeJs(code.slice(obj.start, obj.end));
      if (
        /getInstallForURL/.test(text) &&
        /Plugin Toolkit|is not available|minVersion/.test(
          text + unescapeJs(code.slice(obj.end, obj.end + 1500)),
        )
      )
        h.name = "zotero://plugin";
      else if (/["']Zotero,window["']/.test(text)) h.name = "zotero://ztoolkit-debug";
    }
  }
  for (let i = linkHandlers.length - 1; i >= 0; i--)
    if (!linkHandlers[i]?.name) linkHandlers.splice(i, 1);
  const handlerObjects = linkHandlers.map(handlerObject);
  // The toolkit's second debug bridge, which asks first, came with its plugin bridge (2.2.8).
  const withPluginBridge =
    libInstalls.length > 0 || linkHandlers.some((h) => h.name === "zotero://plugin");
  // The toolkit's bridges: where they sit, and the toolkit named as their library even where a
  // minified or obfuscated bundle doesn't say so.
  const bridgeRanges: [number, number][] = [];
  const toolkitHit = (n: AstNode): Hit =>
    own(base + n.start) ? { ...hit(n), library: "zotero-plugin-toolkit" } : hit(n);
  for (const [hi, h] of linkHandlers.entries()) {
    const obj = handlerObjects[hi];
    // zotero-plugin-toolkit's own keys, with the handler out of reach (an obfuscated bundle binds
    // it through a parameter, zotmind): its bridge class is defined just before it's registered.
    const toolkitKey = /^zotero:\/\/(plugin|ztoolkit-debug)$/.test(h.name);
    if (!obj && !toolkitKey) continue;
    const range: [number, number] = obj
      ? [obj.start, obj.end]
      : [Math.max(0, h.n.start - 4000), h.n.end];
    if (toolkitKey) bridgeRanges.push(range);
    const parts = [code.slice(...range)];
    // Helpers the handler calls: `this.decryptCode(…)` or `decryptCode(…)`, not `s.split(…)`.
    const called = new Set(
      [...(obj ? descendants(obj) : [])]
        .filter((d) => d.type === "CallExpression")
        .map((d) => {
          const callee = node(d.callee);
          if (callee?.type === "Identifier") return callee.name as string;
          if (callee?.type === "MemberExpression" && node(callee.object)?.type === "ThisExpression")
            return `.${chain(callee)?.split(".").at(-1) ?? ""}`;
          return "";
        })
        .filter((n) => n.replace(/^\./, "").length >= 4),
    );
    let extra = 0;
    if (obj)
      for (const [fn, name] of fnNames) {
        // Methods of this or another handler (`doAction`) are theirs, not helpers.
        if (handlerObjects.some((o) => o && fn.start >= o.start && fn.end <= o.end)) continue;
        if ((called.has(name) || called.has(`.${name.replace(/^\./, "")}`)) && extra++ < 10)
          parts.push(code.slice(fn.start, fn.end));
      }
    // Names an obfuscator wrote as escapes are read written out (zotero-style's install call).
    const texts = parts.map(unescapeJs);
    // Judged per function: the part that runs code (or installs) must itself ask first, so a
    // confirm() on zotero-addons' install route doesn't cover its execJS route.
    // A password check alone isn't asking: in the toolkit's first debug bridge the password pref is
    // unset by default, so `params.password === this.password` is `undefined === undefined`.
    // The toolkit's second debug bridge asks through window.confirm when no password is set; an
    // obfuscator renames the call but keeps its shape (doc2x): `typeof params.password ===
    // "undefined" && typeof this.password === "undefined") allowed = window…(…)`, or at least
    // its prompt's text (zotbox).
    const ASKS =
      /\bconfirm\s*\(|Services\.prompt\.|\.confirmEx\s*\(|typeof\s+[\w$]+(?:\.password|\[['"]password['"]\])\s*===\s*['"]undefined['"]\s*&&\s*typeof\s+this(?:\.password|\[['"]password['"]\])\s*===\s*['"]undefined['"]\s*\)\s*[\w$]+\s*=\s*window|please click Cancel to deny/i;
    const RUNS =
      /\bAsyncFunction\b|\bnew\s+Function\b|\beval\s*\(|loadSubScript|evalInSandbox|\.constructor\s*\(|getPrototypeOf\(\s*async\b/;
    const INSTALLS = /getInstallForURL|getInstallForFile|installTemporaryAddon/;
    if (obj && !toolkitKey) {
      col.linkSpans.push({ file, span: [base + obj.start, base + obj.end] });
      // A link that changes where it installs add-ons from, taking the address from the link
      // without asking (zotero-addons' configSource); it counts if the plugin installs from there.
      if (
        !col.linkSource &&
        texts.some(
          (p) => SETS_SOURCE.test(p) && /decodeURIComponent|\bparams\b/.test(p) && !ASKS.test(p),
        )
      )
        col.linkSource = hit(h.n);
    }
    for (const [id, re] of [
      ["link-runs-code", RUNS],
      ["link-installs-addons", INSTALLS],
    ] as const) {
      // The toolkit's bridges exist to run code and to install; obfuscated, the call can't always
      // be read. Its second debug bridge asks first and says so: `version = 2`, `['version']=0x2`.
      const debugBridge = h.name === "zotero://ztoolkit-debug" && id === "link-runs-code";
      const pluginBridge = h.name === "zotero://plugin" && id === "link-installs-addons";
      // Each bridge does its one thing: the code around a handler out of reach can be the other
      // bridge's (zotmind).
      if (toolkitKey && !debugBridge && !pluginBridge) continue;
      // Readable code is judged by the parts that act; only an unreadable bridge falls back to
      // what the bridge is.
      const readable = texts.filter((p) => re.test(p));
      const hidden = !readable.length && (debugBridge || pluginBridge);
      const acting = hidden ? texts : readable;
      if (!acting.length) continue;
      const around = unescapeJs(code.slice(Math.max(0, h.n.start - 8000), h.n.end + 1500));
      const v2 =
        hidden &&
        (withPluginBridge ||
          /\[['"]version['"]\]\s*=\s*(?:0x2|2)\b|\.version\s*=\s*2\b|static\s+version\s*=\s*2\b/.test(
            around,
          ));
      // The plugin bridge never asks, in any version.
      const asks = !pluginBridge && (v2 || acting.every((p) => ASKS.test(p)));
      if (toolkitKey) {
        // Counted once the whole build is read, if it sets the toolkit up (ToolkitSetup).
        col.toolkit.bridges.push({ id, hit: toolkitHit(h.n), name: h.name, asks });
      } else {
        // Each handler says whether it asks, so the card can tell a plugin's own silent handler
        // from the toolkit's bridge that asks (zotero-addons).
        const cap = col.cap(id, hit(h.n), asks ? `${h.name} (asks first)` : h.name);
        if (asks) cap.asksFirst = true;
        else cap.unguarded = true;
      }
      // The install inside the bridge is the link's, not an installer of its own.
      if (pluginBridge)
        for (const other of ["installs-addons", "self-installs"] as const) {
          const inst = col.caps.get(other);
          if (!inst) continue;
          inst.hits = inst.hits.filter(
            (x) => x.file !== file || x.offset < base + range[0] || x.offset > base + range[1],
          );
          if (other === "installs-addons")
            col.installTargets = col.installTargets.filter((t) => inst.hits.includes(t.hit));
          if (!inst.hits.length) col.caps.delete(other);
        }
    }
  }

  if (
    libInstalls.length &&
    !col.caps.has("link-installs-addons") &&
    !col.toolkit.bridges.some((b) => b.id === "link-installs-addons")
  )
    col.toolkit.bridges.push({
      id: "link-installs-addons",
      hit: libInstalls[0] as Hit,
      name: "zotero://plugin",
      asks: false,
    });
  toolkitFile.finish(bindings, bridgeRanges, hit);

  if (serverAssigns.length || serverPatchSites.length || helperSites.length || ownSites.length) {
    const scan = new ServerScan(
      col,
      file,
      code,
      base,
      bindings,
      fnNames,
      callArgs,
      protos,
      classes,
      mcpTools,
      writeTools,
      loops,
    );
    scan.run(serverAssigns, serverPatchSites, helperSites, own);
    // A Node server's upgrade and request events are its handlers too (a WebSocket bridge).
    const node0 = ownSites.find((s) => s.kind === "node");
    if (node0) node0.handlers.push(...nodeEvents.slice(0, 5));
    for (const site of ownSites) {
      const server = scan.ownServer(site);
      if (site.kind === "node" && nodeListensWide) server.beyond = true;
      col.ownServers.push(server);
    }
  }
  if (RANDOM_SECRET.test(code)) col.makesSecrets = true;
  // Functions that write to the library, by name, for endpoints in other files that call them,
  // and those that find or make items without a key (whether those writes need one).
  if (code.length < 600_000)
    for (const [fn, name] of fnNames) {
      const bare = name.replace(/^\./, "");
      if (!own(base + fn.start)) continue;
      const text = code.slice(fn.start, fn.end);
      if (!col.libraryWriters.has(bare)) {
        const w = LIBRARY_WRITE.exec(text);
        if (w) col.libraryWriters.set(bare, hit(fn.start + w.index));
      }
      if (!col.unkeyedFns.has(bare) && findsWithoutKey(text)) col.unkeyedFns.add(bare);
    }

  // Requests built on a base address held in a name: `${this.baseUrl}${endpoint}`, `API_BASE + p`.
  // Names for an API's base address (`API_BASE`, `apiBaseUrl`, `serverUrl`, `IMA_ORIGIN`), not for
  // pages people open (`apiKeyUrl`, `SUPPORT_PAY_URL`, `docsUrl`).
  const baseName = (n: string | null | undefined) =>
    !!n &&
    /(api|base|endpoint|server|service|backend|gateway|host|origin)s?(_?(url|uri)s?)?$|^(url|uri)$/i.test(
      n,
    ) &&
    !/(key|apply|console|dashboard|pricing|help|doc|error|pay|support|view|explore|setting|nominat|corpus|profile|website|home|regist|sign|login|account|billing|guide|tutorial|faq|terms|privacy|about|feedback|donate|sponsor|star|repo|issue|release|download|update|cover|icon|image|img|avatar|logo|site|github|redirect|callback|purchase)/i.test(
      n,
    );
  // Where a request's address starts: `${BASE}…`, `BASE + …`, `getApiBase() + …`,
  // `${pref("baseUrl")}…`, or a variable holding one of those.
  const startsOnBase = (a: AstNode | undefined, fns: AstNode[], depth = 0): boolean => {
    if (!a || depth > 2) return false;
    let first: AstNode | undefined = a;
    while (first?.type === "BinaryExpression" && first.operator === "+") first = node(first.left);
    if (first?.type === "TemplateLiteral" && textOf(first)?.startsWith(EXPR))
      first = nodes(first.expressions)[0];
    // `f("baseUrl").replace(/\/+$/, "")`: string methods on the base don't change it.
    while (
      first?.type === "CallExpression" &&
      node(first.callee)?.type === "MemberExpression" &&
      /^(replace|replaceAll|trim|trimEnd|toString|concat)$/.test(
        (node(node(first.callee)?.property)?.name as string) ?? "",
      )
    )
      first = node(node(first.callee)?.object);
    if (first && first !== a) {
      if (baseName(chain(first)?.split(".").at(-1)?.replace(/\(\)$/, ""))) return true;
      if (first.type === "CallExpression" && baseName(str(nodes(first.arguments)[0]))) return true;
      return false;
    }
    if (a.type !== "Identifier") return false;
    const name = a.name as string;
    const values = bindings.lookup(name, fns);
    if (values.length) return values.some((v) => startsOnBase(v, fns, depth + 1));
    // A helper's parameter: what its callers pass (`_httpFallback(method, IMA_ORIGIN + path)`).
    for (const f of fns) {
      const i = nodes(f.params).findIndex((p) => p.type === "Identifier" && p.name === name);
      if (i < 0) continue;
      return (callArgs.get(fnNames.get(f) ?? "") ?? []).some((k) =>
        startsOnBase(k.args[i], k.fn ? [k.fn] : [], depth + 1),
      );
    }
    return false;
  };
  const requestsOnBase = netCalls.some((k) => {
    const arg = k.urlIdx >= 0 ? k.args[k.urlIdx] : undefined;
    return !!arg && own(base + k.n.start) && startsOnBase(arg, k.fns);
  });
  // The names requests actually start from (`${this.baseUrl}${path}`, `API_BASE + p`): a
  // base-looking name elsewhere (a response's `apiURL` field) isn't one (zotero-citation-linker).
  const usedBases = new Set<string>();
  // A helper at the start of the address (`${getApiBase()}/api/v1`): the names it returns
  // (`Prefs.get(PREF) || DEFAULT_API_BASE`, sumno-zotero) are bases too.
  const helperReturns = (call: AstNode | undefined): string[] => {
    if (call?.type !== "CallExpression") return [];
    const name = (chain(node(call.callee)) ?? "").split(".").at(-1) ?? "";
    const out: string[] = [];
    for (const [fn, fname] of fnNames) {
      if (fname.replace(/^\./, "") !== name) continue;
      for (const d of descendants(fn))
        if (
          d.type === "ReturnStatement" ||
          (fn.type === "ArrowFunctionExpression" && d === node(fn.body))
        )
          for (const x of [d, ...descendants(d)])
            if (x.type === "Identifier") out.push(x.name as string);
      if (fn.type === "ArrowFunctionExpression" && node(fn.body)?.type !== "BlockStatement")
        for (const x of descendants(fn)) if (x.type === "Identifier") out.push(x.name as string);
    }
    return out.slice(0, 20);
  };
  /** The requests built on each base: a variable (`name`) or a property (`.name`). */
  const callsByBase = new Map<string, ReqCall[]>();
  for (const k of netCalls) {
    const req = reqByNode.get(k.n);
    // A parameter taken out of an object is that object's property: `({ field, base }) => …`.
    const destructured = (b: string) =>
      k.fns
        .slice(0, 3)
        .some((f) =>
          nodes(f.params).some(
            (p) =>
              p.type === "ObjectPattern" &&
              nodes(p.properties).some((q) => q.type === "Property" && nameOf(q) === b),
          ),
        );
    const useBase = (b: string, at?: AstNode) => {
      usedBases.add(b);
      const keys =
        at?.type === "MemberExpression"
          ? [`.${b}`]
          : at?.type === "Identifier" && destructured(b)
            ? [b, `.${b}`]
            : [b];
      for (const key of keys) {
        const list = callsByBase.get(key) ?? [];
        if (req && list.length < 20 && !list.includes(req)) list.push(req);
        callsByBase.set(key, list);
      }
    };
    let first = k.urlIdx >= 0 ? k.args[k.urlIdx] : undefined;
    while (first?.type === "BinaryExpression" && first.operator === "+") first = node(first.left);
    if (first?.type === "TemplateLiteral") first = nodes(first.expressions)[0];
    const name = (chain(first) ?? "").split(".").at(-1);
    if (name) useBase(name, first);
    for (const r of helperReturns(first)) useBase(r);
    if (first?.type === "Identifier")
      for (const v of bindings.lookup(first.name as string, k.fns).slice(0, 5)) {
        let f: AstNode | undefined = v;
        while (f?.type === "BinaryExpression" && f.operator === "+") f = node(f.left);
        if (f?.type === "TemplateLiteral") f = nodes(f.expressions)[0];
        const nm = (chain(f) ?? "").split(".").at(-1);
        if (nm) useBase(nm, f);
        for (const r of helperReturns(f)) useBase(r);
      }
  }
  // Resolve one-hop usage: a URL bound to a name that later feeds a request call, or a base address
  // (`apiBaseUrl: "https://api.beaverapp.ai"`) in a file whose requests are built on one.
  const linkRanges: [number, number][] = [];
  const linkNames = new Set<string>();
  for (const l of linkCalls) {
    for (const [a, b] of paramCallSites(l.arg, l.fns)) linkRanges.push([a, b]);
    for (const d of [l.arg, ...descendants(l.arg)])
      if (d.type === "Identifier") linkNames.add(d.name as string);
    // Both branches of `cond ? EDGE_URL : chromeUrl`.
  }
  // A variable is the same one when the literal is at module level, in the request's function,
  // or in a function around it; a same-named variable elsewhere in the file isn't (review C18).
  // Requests to an address taken from a list in a loop (`for (const url of urls)`, `urls[i]`),
  // looked for once a list of servers turns up.
  let loopCalls: ReqCall[] | null = null;
  const sameScope = (lit: AstNode | null, uses: (AstNode | null)[]) =>
    uses.length > 0 &&
    (lit === null ||
      uses.some((u) => u === lit || (u !== null && u.start >= lit.start && u.end <= lit.end)));
  for (const lit of urlLiterals) {
    // An entry of an array read only at other constant indexes is never used.
    if (lit.array && lit.index !== undefined) {
      const reads = constIndexReads.get(lit.array);
      const onlyConst =
        reads && (nameRefs.get(lit.array) ?? 0) === (constIndexCount.get(lit.array) ?? 0) + 1;
      if (onlyConst && !reads.has(lit.index)) continue;
    }
    // The request calls the literal reaches, by whichever way it reaches one, to read their payload.
    const calls: ReqCall[] = lit.call ? [lit.call] : [];
    for (const [a, b, r] of requestRanges) if (lit.offset >= a && lit.offset < b) calls.push(r);
    const inRequest = calls.length > (lit.call ? 1 : 0);
    const byName =
      !!lit.binding &&
      (lit.bindingKind === "prop"
        ? requestProps.has(lit.binding)
        : sameScope(lit.scope ?? null, requestScopes.get(lit.binding) ?? []));
    // A variable's requests in its scope; a property's anywhere in the file.
    const prop = lit.bindingKind === "prop";
    const scoped = (rs: ReqCall[] | undefined) =>
      (rs ?? []).filter((r) => prop || sameScope(lit.scope ?? null, [r.fns[0] ?? null]));
    if (byName && lit.binding)
      calls.push(...scoped(requestCalls.get(prop ? `.${lit.binding}` : lit.binding)));
    const onBase =
      requestsOnBase &&
      baseName(lit.binding) &&
      own(lit.offset) &&
      (usedBases.size === 0 || usedBases.has(lit.binding as string));
    // Requests built on this very name: a property for a property (`${this.apiBase}/…`).
    const baseCalls =
      onBase && lit.binding ? scoped(callsByBase.get(prop ? `.${lit.binding}` : lit.binding)) : [];
    calls.push(...baseCalls);
    // The same path on several servers, tried in turn by a request in a loop (zotero-reference's
    // activation endpoints).
    if (lit.mirror && !loopCalls)
      loopCalls = ownCalls.filter((r) => r.url && fromList(r.url, r.fns));
    const mirrored = !!lit.mirror && !!loopCalls?.length && own(lit.offset);
    if (mirrored) calls.push(...(loopCalls ?? []));
    const usage =
      lit.usage === "unknown" && (inRequest || byName || onBase || mirrored)
        ? "request"
        : lit.usage;
    // Only opened in the browser, never requested: a link (zotero-ai-sidebar's Chrome download page).
    const linked =
      usage === "unknown" &&
      (linkRanges.some(([a, b]) => lit.offset >= a && lit.offset < b) ||
        (lit.binding !== null &&
          lit.bindingKind !== "prop" &&
          linkNames.has(lit.binding) &&
          !requestNames.has(lit.binding)));
    // What goes out matters only over plain http. A name matched to no request call in its
    // scope, or a common property name (`{ url: … }`) matched anywhere in the file, isn't enough
    // to say this address is sent to (zotero-reference's `reference.url` for a DOI link, zsearch's
    // abstract page address).
    const loose =
      !lit.call &&
      !inRequest &&
      !mirrored &&
      (!calls.length || (prop && !baseCalls.length && ADDRESS_PROP.test(lit.binding ?? "")));
    const plain = usage === "request" && !loose && lit.urls.some((u) => /^(http|ws):\/\//i.test(u));
    const req = plain
      ? { sends: calls.length ? payloadOf([...new Set(calls)]) : undefined, fallback: lit.fallback }
      : loose
        ? { loose }
        : undefined;
    for (const u of lit.urls) col.url(u, hit(lit.offset), linked ? "link" : usage, req);
    if (lit.binding && own(lit.offset) && col.namedUrls.size < 2000) {
      const named = col.namedUrls.get(lit.binding) ?? [];
      for (const u of lit.urls) if (named.length < 10 && !named.includes(u)) named.push(u);
      col.namedUrls.set(lit.binding, named);
    }
  }
  col.metrics.push({
    file: file.path,
    vendored: !own(base),
    identifiers,
    hexIdentifiers,
    rawStringChars,
    escapeChars,
  });
  if (hexIdentifiers >= 50 && hexIdentifiers / Math.max(1, identifiers) >= 0.02) {
    col.signals.push({
      kind: "hex-identifiers",
      file: file.path,
      score: round(hexIdentifiers / identifiers),
      hits: [hit(firstHex)],
    });
  }
  if (rawStringChars >= 2000 && escapeChars / rawStringChars >= 0.3) {
    col.signals.push({
      kind: "escape-density",
      file: file.path,
      score: round(escapeChars / rawStringChars),
      hits: [hit(firstEscape)],
    });
  }
  // Reading a browser's store or another app's login file: the two markers must be in the same
  // file (a config dir and its credential file join into one path there).
  if (browserStoreHit) {
    const cap = col.cap("browser-credentials", browserStoreHit);
    for (const name of browserNames) cap.apis.add(name);
    // Copied into the profile folder of a browser it starts (`--user-data-dir`), the store signs
    // that browser in as the user (zotero-pdf-hand-catcher's Edge), rather than the plugin reading it.
    if (
      browserStoreFns.some((fn) => COPIES_FILE.test(code.slice(fn.start, fn.end))) &&
      BROWSER_PROFILE_FLAG.test(code)
    )
      cap.copiedToBrowser = true;
  }
  for (const { program } of APP_LOGINS) {
    const dirHit = appLoginDir.get(program);
    if (dirHit && appLoginFile.has(program)) col.cap("reused-app-login", dirHit, program);
  }
  /** A list written back with entries only taken out: `JSON.stringify(list.filter(…))`, or "". */
  const removesOnly = (w: (typeof prefWrites)[number]): boolean => {
    const v = node(nodes(w.n.arguments)[1]);
    if (str(v) === "") return true;
    const inner =
      v?.type === "CallExpression" && chain(node(v.callee)) === "JSON.stringify"
        ? node(nodes(v.arguments)[0])
        : v;
    const values =
      inner?.type === "Identifier" ? bindings.lookup(inner.name as string, w.fns) : [inner];
    return (
      values.length > 0 &&
      values.every((x) => !!x && /\.filter\s*\(/.test(code.slice(x.start, x.end)))
    );
  };
  for (const u of setterUses)
    if (setters.has(u.name)) {
      const edges = col.callEdges.get(u.name) ?? [];
      if (edges.length < 20) col.callEdges.set(u.name, [...edges, u.edge]);
    }
  // Zotero's own settings it writes. A value saved, changed and put back on the same path through
  // a function (zutilo swaps Quick Copy's format for one copy) is temporary; a switch that follows
  // a checkbox, or that the plugin clears again, is one the user flips.
  const restored = new Set<(typeof prefWrites)[number]>();
  for (const w of prefWrites)
    for (const v of prefWrites) {
      const back = node(nodes(v.n.arguments)[1]);
      if (
        v === w ||
        v.fn !== w.fn ||
        v.shape !== w.shape ||
        v.n.start <= w.n.start ||
        (back?.type !== "Identifier" && back?.type !== "MemberExpression") ||
        !prefReads.some((r) => r.shape === w.shape && (r.fn ?? null) === w.fn && r.at < w.n.start)
      )
        continue;
      // Set in one branch and put back in the other is a toggle, not a temporary change.
      let i = 0;
      while (w.anc[i] && w.anc[i] === v.anc[i]) i++;
      const split = w.anc[i - 1]?.type;
      if (
        split === "IfStatement" ||
        split === "ConditionalExpression" ||
        split === "SwitchStatement"
      )
        continue;
      restored.add(w);
      restored.add(v);
    }
  // …or put back from another function in this file (object, class or module): the old value kept
  // in a name and written back from it (`this.old = get(k)`, later `set(k, this.old)`), or a
  // snapshot of several written back entry by entry (zotero-multifetcher's SOCKS proxy, switched
  // on for a fetch and restored by `restoreProxy(saved)`).
  const readNames = new Map(
    prefReads.map((r) => [r, new Set([r.shape, ...prefNames(r.arg, r.fns)])] as const),
  );
  const snapshots = snapshotBacks.size ? prefReads.filter((r) => r.snapshot) : [];
  for (const w of prefWrites) {
    if (restored.has(w)) continue;
    // The write that puts the snapshot back.
    if (snapshotBacks.has(w.n) && snapshots.some((r) => readNames.get(r)?.has(w.shape)))
      restored.add(w);
    for (const r of prefReads) {
      if ((r.fn ?? null) !== w.fn || r.at > w.n.start || !readNames.get(r)?.has(w.shape)) continue;
      if (r.snapshot && snapshotBacks.size) restored.add(w);
      const back = r.kept
        ? prefWrites.find(
            (v) =>
              v.fn !== w.fn &&
              v.shape === w.shape &&
              chain(node(nodes(v.n.arguments)[1])) === r.kept,
          )
        : undefined;
      if (back) {
        restored.add(w);
        restored.add(back);
      }
    }
  }
  for (const w of prefWrites) {
    if (restored.has(w)) continue;
    // Taking entries out of Find Available PDF's list (zone drops its own old ones) adds none.
    if (w.change === "find-pdf" && removesOnly(w)) continue;
    // Turning updates back on, or the server off, isn't the change.
    const way = SWITCHES[w.change];
    if (way && w.value === (way === "off")) continue;
    const scheme = w.key.match(/^network\.protocol-handler\.warn-external\.([\w.+-]+)$/)?.[1];
    settingsAt(w.n, w.anc, w.change, {
      key: w.key,
      ...(scheme ? { target: scheme } : {}),
      ...(way && (w.value === null || prefClears.has(w.shape)) ? { optIn: true } : {}),
    });
  }
  // Another program's settings files: every part of the path named in one function or constant.
  for (const mark of fileMarks.values())
    for (const { i, at, anc, text, ctx } of mark.files.values()) {
      const f = SETTINGS_FILES[i] as (typeof SETTINGS_FILES)[number];
      const fn = enclosingFn(anc);
      const body = fn ? code.slice(fn.start, fn.end) : "";
      if (f.dir && !mark.dirs.has(i) && !f.near?.test(body)) continue;
      // In an AI tool's folder under the home folder, not a copy in its own workspace.
      if (f.home && fn && !HOME_DIR.test(body)) continue;
      const tool = f.change === "skills" ? AI_TOOL_DIRS.find(([re]) => re.test(text))?.[1] : null;
      const target = f.target ?? tool;
      settingsAt(at, anc, f.change, {
        file: true,
        paths: [text],
        ...(target ? { target } : {}),
        ctx,
      });
    }
  noteLaunchCommands();
  textSignals(col, file, code, base);

  /**
   * The programs its launches run when the command is a name, however far from the launch the
   * path is written: what the name is bound to, what callers pass for a parameter, what a helper
   * returns (`findEdgePath()` over a list of paths, zotero-pdf-hand-catcher's msedge.exe), a list
   * handed to a PATH search (`findExecutable(["python3", "python"])`, paperviewzoteroplugin), or
   * the file name a path is joined from.
   */
  function noteLaunchCommands() {
    const launches = (col.caps.get("process-launch")?.hits ?? []).filter(
      (h) => h.file === file && own(h.offset) && h.offset >= base && h.offset <= base + code.length,
    );
    if (!launches.length) return;
    const resolve = (a: AstNode | undefined, fns: AstNode[], depth = 0): string[] => {
      if (!a || depth > 12) return [];
      switch (a.type) {
        case "AwaitExpression":
        case "ChainExpression":
          return resolve(node(a.argument) ?? node(a.expression), fns, depth + 1);
        case "ConditionalExpression":
          return [node(a.consequent), node(a.alternate)].flatMap((x) => resolve(x, fns, depth + 1));
        case "LogicalExpression":
          return [node(a.left), node(a.right)].flatMap((x) => resolve(x, fns, depth + 1));
        case "ArrayExpression":
          return nodes(a.elements)
            .slice(0, 10)
            .flatMap((x) => resolve(x, fns, depth + 1));
        case "CallExpression":
        case "NewExpression": {
          const name = chain(node(a.callee))?.split(".").at(-1) ?? "";
          const args = nodes(a.arguments);
          if (PATH_SEARCH.test(name) && args.length)
            return args.flatMap((x) => resolve(x, fns, depth + 1));
          // A path joined from parts ends in the program's file name; a file object made from a
          // path (`createLocalFile(p)`, `new FileUtils.File(p)`) runs that path.
          if (/^join$/.test(name) && args.length > 1) return resolve(args.at(-1), fns, depth + 1);
          if (/^(?:\w*File|pathToFile\w*)$/.test(name)) return resolve(args[0], fns, depth + 1);
          if (args.length || a.type === "NewExpression") return [];
          return (bindings.returns.get(name) ?? []).flatMap((r) => resolve(r.v, r.fns, depth + 1));
        }
        case "Identifier": {
          const name = a.name as string;
          // A loop's variable takes each entry of its list (`for (const c of EDGE_CANDIDATES)`), the
          // loop in its own function: a name another loop or a module constant uses isn't this one.
          const scope = fns[0];
          const loop =
            scope && scope.end - scope.start < 20_000
              ? [...descendants(scope)].find((d) => {
                  if (d.type !== "ForOfStatement") return false;
                  const l = node(d.left);
                  const id =
                    l?.type === "VariableDeclaration" ? node(nodes(l.declarations)[0]?.id) : l;
                  return id?.type === "Identifier" && id.name === name;
                })
              : undefined;
          if (loop) return resolve(node(loop.right), fns, depth + 1);
          const bound = bindings.lookup(name, fns).filter((v) => !FUNCTION_TYPES.has(v.type));
          if (bound.length) return bound.slice(0, 5).flatMap((v) => resolve(v, fns, depth + 1));
          // A parameter: what the function's callers pass for it.
          for (const f of fns) {
            const i = nodes(f.params).findIndex((p) => p.type === "Identifier" && p.name === name);
            if (i < 0) continue;
            return (callArgs.get(fnNames.get(f) ?? "") ?? [])
              .slice(0, 10)
              .flatMap((c) => resolve(c.args[i], c.fn ? fnsAround(c.fn) : [], depth + 1));
          }
          return [];
        }
        default: {
          const t = str(a);
          return t !== null && LAUNCH_PATH.test(t) ? [t] : [];
        }
      }
    };
    // The functions around a node, innermost first (the node itself when it's one), for resolving
    // names from a caller.
    const fnsAround = (fn: AstNode) => [
      fn,
      ...[...fnNames.keys()]
        .filter((f) => f !== fn && f.start <= fn.start && fn.end <= f.end)
        .sort((x, y) => y.start - x.start),
    ];
    const seen = new Set<AstNode>();
    for (const h of launches) {
      // The named function the launch sits in, read whole when it isn't a whole bundle.
      const fn = [...fnNames.keys()]
        .filter((f) => base + f.start <= h.offset && h.offset < base + f.end)
        .sort((x, y) => y.start - x.start)[0];
      if (!fn || seen.has(fn) || fn.end - fn.start > 20_000) continue;
      seen.add(fn);
      const inner = [...descendants(fn)].filter((d) => FUNCTION_TYPES.has(d.type));
      // Every function around a node inside it, innermost first, then those around it.
      const fnsAt = (d: AstNode) => [
        ...inner
          .filter((f) => f.start <= d.start && d.end <= f.end)
          .sort((x, y) => y.start - x.start),
        ...fnsAround(fn).slice(1),
      ];
      for (const d of descendants(fn)) {
        if (d.type !== "CallExpression") continue;
        const c = chain(node(d.callee)) ?? "";
        const args = nodes(d.arguments);
        const fns = fnsAt(d);
        // nsIProcess started on a file: `proc.init(file)`, where proc is an nsIProcess.
        const recv = node(node(d.callee)?.object);
        const startsProcess =
          /\.init$/.test(c) &&
          args.length === 1 &&
          recv?.type === "Identifier" &&
          bindings
            .lookup(recv.name as string, fns)
            .some((v) => /nsIProcess|process\/util/.test(code.slice(v.start, v.end)));
        const command =
          startsProcess || /^Zotero\.Utilities\.Internal\.(exec|subprocess)$/.test(c)
            ? args[0]
            : /(^|\.)launchFileWithApplication$/.test(c)
              ? args[1]
              : /^Subprocess\.call$/.test(c)
                ? node(nodes(args[0]?.properties).find((q) => nameOf(q) === "command")?.value)
                : undefined;
        if (!command || command.type === "Literal") continue;
        // The file an nsIProcess starts gets its path from `file.initWithPath(p)` on that same
        // file, not from other files the function opens (its log files).
        const paths =
          startsProcess && command.type === "Identifier"
            ? [...descendants(fn)].flatMap((x) => {
                const callee = x.type === "CallExpression" ? node(x.callee) : undefined;
                return callee?.type === "MemberExpression" &&
                  nameOf(callee) === "initWithPath" &&
                  node(callee.object)?.type === "Identifier" &&
                  node(callee.object)?.name === command.name
                  ? nodes(x.arguments).slice(0, 1)
                  : [];
              })
            : [];
        for (const t of new Set(
          [command, ...paths].flatMap((x) => resolve(x, fnsAt(x))).slice(0, 8),
        ))
          col.launchCommands.push({ name: t, hit: h });
      }
    }
  }
}

/**
 * URLs in a template's text, where EXPR marks what's computed at runtime (review P5). A URL is
 * cut at its first expression, and kept only when `/ : ? #` ends the host before it:
 * `https://api.openai.com/v1/${path}` keeps api.openai.com, but `https://api.${d}` and
 * `http://127.${o}` would invent a host. An unterminated host counts only when it is an exact
 * hosts.yaml entry (`https://api.openalex.org${p}`).
 */
/** DOM methods whose first argument is an XML namespace, a name rather than an address. */
const NAMESPACE_CALL =
  /^(?:getElementsByTagNameNS|createElementNS|createAttributeNS|getAttributeNS|setAttributeNS|hasAttributeNS|removeAttributeNS|getAttributeNodeNS|lookupPrefix|lookupNamespaceURI|isDefaultNamespace|createDocument)$/;

/** Keys and properties for text a settings page shows as an example: a placeholder, a hint. */
const EXAMPLE_KEY =
  /^(?:placeholder|hint|help|helptext|example|examples|tip|tooltip|tooltiptext)$/i;

/**
 * Whether the string at the end of `anc` is only shown as an example: the value of a placeholder,
 * hint or help key (the last word of `prefs.openai.hint`, `baseUrlPlaceholder`), a placeholder
 * set on an element (`input.placeholder = …`, `setAttribute("placeholder", …)`).
 */
function shownExample(anc: AstNode[]): boolean {
  const n = anc.at(-1);
  const up = anc.at(-2);
  const lastWord = (key: string | null) =>
    key
      ?.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s._-]+/)
      .at(-1) ?? "";
  if (up?.type === "Property" && node(up.value) === n)
    return EXAMPLE_KEY.test(lastWord(nameOf(up)));
  if (up?.type === "AssignmentExpression" && node(up.right) === n)
    return /(^|\.)placeholder$/i.test(chain(node(up.left)) ?? "");
  if (up?.type === "CallExpression" && nodes(up.arguments)[1] === n)
    return (
      /(^|\.)setAttribute$/.test(chain(node(up.callee)) ?? "") &&
      /^placeholder$/i.test(str(nodes(up.arguments)[0]) ?? "")
    );
  return false;
}

/** A namespace declaration: `PREFIX np: <http://…#>`, `@prefix np: <http://…#> .` */
function isNamespaceDecl(text: string, at: number): boolean {
  return /(?:^|\s)(?:PREFIX|@prefix|xmlns(?::\w+)?)\s*[\w-]*:?\s*[<=]\s*["']?$/i.test(
    text.slice(Math.max(0, at - 40), at),
  );
}

export function templateUrls(text: string, table: HostTable): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    if (isNamespaceDecl(text, m.index ?? 0)) continue;
    const u = m[0];
    const at = u.indexOf(EXPR);
    if (at < 0) {
      out.push(u);
      continue;
    }
    const cut = u.slice(0, at);
    const rest = cut.replace(/^[a-z]+:\/\//i, "");
    if (/[/:?#]/.test(rest) || table.exact.has(rest.toLowerCase())) out.push(cut);
  }
  return out;
}

/**
 * Whether code handed to eval comes from a network response: a fetch, Zotero.HTTP.request,
 * `.text()`/`.json()` on a response or an XHR's responseText. A variable that merely happens to be
 * called `text` or `request` doesn't count.
 */
const AI_REPLY = "an AI model's reply";

/** "ai" when the code is an AI model's reply, "network" for any other response, else null. */
function fromNetwork(code: AstNode): "ai" | "network" | null {
  let found: "ai" | "network" | null = null;
  for (const d of descendants(code)) {
    const callee = d.type === "CallExpression" ? (chain(node(d.callee)) ?? "") : "";
    // An AI model's reply: `await OpenAI.getGPTResponse(prompt)`, `chatCompletion(…)`, `.choices`.
    if (
      /(^|\.)(get\w*(GPT|LLM|AI|Chat|Completion)\w*|\w*chatCompletions?|callLLM|askLLM|queryLLM)$/i.test(
        callee,
      ) ||
      (d.type === "MemberExpression" && /\.choices(\.|$)/.test(chain(d) ?? ""))
    )
      return "ai";
    if (
      /(^|\.)(fetch|HTTP\.request|text|json)$/.test(callee) ||
      (d.type === "MemberExpression" && /\.(responseText|response)$/.test(chain(d) ?? ""))
    )
      found = "network";
  }
  return found;
}

/** Inside the branch a constant falsy test never takes: `false ? here : …`, `if (0) { here }`. */
function inDeadBranch(anc: AstNode[]): boolean {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    const child = anc[i + 1];
    if (a.type !== "ConditionalExpression" && a.type !== "IfStatement") continue;
    const t = node(a.test);
    const falsy =
      (t?.type === "Literal" && !t.value) ||
      (t?.type === "UnaryExpression" &&
        t.operator === "!" &&
        node(t.argument)?.type === "Literal" &&
        !!node(t.argument)?.value);
    if (falsy && node(a.consequent) === child) return true;
  }
  return false;
}

function urlContext(anc: AstNode[]): {
  usage: Usage;
  binding: string | null;
  bindingKind?: "var" | "prop";
  call?: ReqCall;
} {
  let binding: string | null = null;
  let bindingKind: "var" | "prop" = "var";
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    const child = anc[i + 1] as AstNode;
    if (FUNCTION_TYPES.has(a.type)) break;
    if (a.type === "CallExpression" || a.type === "NewExpression") {
      if (node(a.callee) === child) continue;
      const c = chain(node(a.callee)) ?? "";
      const args = nodes(a.arguments);
      const idx = requestUrlArg(c, a.type === "NewExpression", args);
      // Only the URL argument is the destination; a Referer header in the options isn't.
      if (idx >= 0 && args[idx] === child) {
        const fns = anc.filter((x) => FUNCTION_TYPES.has(x.type)).reverse();
        return { usage: "request", binding, call: { n: a, url: child, fns } };
      }
      if (idx >= 0) return { usage: "unknown", binding };
      if (isLinkCall(c)) return { usage: "link", binding };
      if (/\.setAttribute$/.test(c) && str(args[0]) === "href") return { usage: "link", binding };
      if (
        /\.setAttribute$/.test(c) &&
        str(args[0]) === "src" &&
        FRAME_NAME.test(c.split(".").at(-2) ?? "")
      )
        return { usage: "request", binding };
    }
    if (!binding) {
      if (a.type === "VariableDeclarator" && node(a.id)?.type === "Identifier")
        binding = node(a.id)?.name as string;
      if (a.type === "Property") {
        const k = node(a.key);
        binding = k?.type === "Identifier" ? (k.name as string) : str(k);
        bindingKind = "prop";
        // A header value (`Referer: "https://fanyi.dict.cn"`) names a page, not a destination.
        if (/^(referer|referrer|origin)$/i.test(binding ?? ""))
          return { usage: "link", binding: null };
        // A `url:` key in a table of things to show (`{ name: "Taobao", url: "https://m.tb.cn/…" }`,
        // zotero-reference's purchase channels) is a link, unless the object also looks like
        // request options.
        const obj = anc[i - 1];
        const keys =
          obj?.type === "ObjectExpression"
            ? nodes(obj.properties).map(
                (q) => (node(q.key)?.name as string) ?? str(node(q.key)) ?? "",
              )
            : [];
        if (
          /^(url|uri|href|link)$/i.test(binding ?? "") &&
          keys.some((k) =>
            /^(name|title|label|text|icon|desc|description|img|image|logo|qr|qrcode)$/i.test(k),
          ) &&
          !keys.some((k) =>
            /^(method|headers|body|data|responseType|timeout|params|query|json|dataType|credentials|mode)$/i.test(
              k,
            ),
          )
        )
          binding = null;
      }
      if (a.type === "AssignmentExpression") {
        const left = node(a.left);
        const c = chain(left) ?? "";
        if (/\.(href|location)$/.test(c) || c === "location")
          return { usage: "link", binding: null };
        if (/\.src$/.test(c) && FRAME_NAME.test(c.split(".").at(-2) ?? ""))
          return { usage: "request", binding: null };
        binding = c.split(".").at(-1) ?? null;
        if (left?.type === "MemberExpression") bindingKind = "prop";
      }
    }
  }
  return {
    usage: "unknown",
    binding: binding && binding.length >= 3 ? binding : null,
    bindingKind,
  };
}

function fsHint(col: Collector, scope: "zotero-data-dir" | "user-chosen") {
  const c = col.caps.get("filesystem");
  if (c && (!c.fsScope || scope === "zotero-data-dir")) c.fsScope = scope;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

const MEDIA_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|bmp|svg|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|webm|pdf|wasm|zip|gz|xpi|jar|node|dll|so|dylib|exe|dat|db|sqlite|mo|icc|traineddata)$/i;

/**
 * AI command-line tools, named as the program to run (`"claude"`, `/usr/local/bin/codex`,
 * `codex exec …`): what the plugin hands them goes to their provider.
 */
const AI_CLI: [RegExp, string, string][] = [
  [
    /^(?:\S*\/)?claude(?:\.exe|\.cmd)?$|^claude\s+(?:-p\b|--print\b|mcp\b)/,
    "Claude Code",
    "Anthropic",
  ],
  [
    /^(?:\S*[/\\])?codex(?:\.exe|\.cmd)?$|^codex\s+(?:exec|app-server|mcp)\b|@openai\/codex\/bin\//,
    "Codex CLI",
    "OpenAI",
  ],
  [/^(?:\S*\/)?gemini(?:\.exe|\.cmd)?$|^gemini\s+-p\b|@google\/gemini-cli/, "Gemini CLI", "Google"],
  [
    /^(?:\S*\/)?opencode(?:\.exe|\.cmd)?$|^opencode-ai$|^opencode\s+acp\b/,
    "OpenCode",
    "the AI provider it's set up with",
  ],
  [/^(?:\S*\/)?qwen(?:\.exe)?$|@qwen-code\/qwen-code/, "Qwen Code", "Alibaba Cloud"],
  // Agent Client Protocol adapters that run the same agents (zotero-skills' presets).
  [/(?:^|\/)codex-acp(?:@|$)/, "Codex CLI", "OpenAI"],
  [/(?:^|\/)claude-(?:agent|code)-acp(?:@|$)/, "Claude Code", "Anthropic"],
  // Google's Antigravity CLI runs as `agy`.
  [/^(?:\S*[/\\])?(?:antigravity|agy)(?:\.exe)?$/, "Antigravity", "Google"],
  // Agents that use whichever model provider they're set up with.
  // Not KaTeX's `\\pi`: a path before it has a folder.
  [
    /^(?:\S*\/|\S+\\)?pi(?:\.exe|\.cmd)?$|^pi-acp$|@mariozechner\/pi-/,
    "Pi",
    "the AI provider it's set up with",
  ],
  [
    /^(?:\S*[/\\])?hermes(?:\.exe)?$|^hermes\s+acp\b/,
    "Hermes Agent",
    "the AI provider it's set up with",
  ],
  [/^(?:\S*[/\\])?openclaw(?:\.exe|\.cmd)?$/, "OpenClaw", "the AI provider it's set up with"],
  [/^(?:\S*[/\\])?goose(?:\.exe)?$/, "Goose", "the AI provider it's set up with"],
];

/**
 * Programs and companions on this computer that pass what the plugin hands them on to an online
 * service (review C39), and who that is. Matched as `run`: the program named where a command goes,
 * in a setting's default or a launch (like AI_CLI); `mention`: a name distinctive enough to count
 * anywhere in the code of a plugin that launches programs; `py` and `pkg`: a package its shipped
 * Python imports, or a requirements file lists; `local`: the code around a request to a companion
 * on this computer; `extension`: the web app a browser extension is for, when the plugin serves it
 * files. An empty provider is a program that sends to whatever the user set up in it, which we
 * can't check. Programs that keep data on the computer (tesseract, pandoc, pdftotext, MinerU,
 * Ollama, LM Studio) aren't listed.
 */
interface Handoff {
  program: string;
  provider: string;
  category: HostCategory;
  run?: RegExp;
  mention?: RegExp;
  py?: RegExp;
  pkg?: RegExp;
  local?: RegExp;
  extension?: RegExp;
}
const HANDOFFS: Handoff[] = [
  // Edge's read-aloud voices, through the edge-tts CLI or a local OpenAI-style speech server given
  // Edge's voice names (openai-edge-tts).
  {
    program: "edge-tts",
    provider: "Microsoft",
    category: "translation",
    run: /^(?:\S*[/\\])?edge-(?:tts|playback)(?:\.exe)?$/,
    mention: /^(?:\S*[/\\])?edge-(?:tts|playback)(?:\.exe)?$/,
    py: /^[ \t]*(?:import|from)\s+edge_tts\b/m,
    pkg: /^[ \t]*edge-tts\b/im,
    local:
      /\bedge[-_ ]?tts\b|\/audio\/speech\b[\s\S]{0,1500}\b[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural\b/i,
  },
  {
    program: "wakatime-cli",
    provider: "WakaTime",
    category: "integration",
    mention: /(?:^|[/\\])wakatime-cli\b/,
    py: /^[ \t]*(?:import|from)\s+wakatime\b/m,
  },
  // PDFMathTranslate 2 uses its free SiliconFlow relay unless it's given another engine.
  {
    program: "pdf2zh-next",
    provider: "SiliconFlow, or the engine it's set up with",
    category: "translation",
    run: /^(?:\S*[/\\])?pdf2zh[_-]next(?:\.exe)?$/,
    mention: /^(?:\S*[/\\])?pdf2zh[_-]next(?:\.exe)?$/,
    py: /^[ \t]*(?:import|from)\s+pdf2zh_next\b/m,
    pkg: /^[ \t]*pdf2zh[-_]next\b/im,
  },
  // PDFMathTranslate 1.x: Google Translate unless it's given another translator.
  {
    program: "pdf2zh",
    provider: "Google Translate, or the translator it's set up with",
    category: "translation",
    run: /^(?:\S*[/\\])?pdf2zh(?:\.exe|\.app)?$/,
    py: /^[ \t]*(?:import|from)\s+pdf2zh\b(?!_)/m,
    pkg: /^[ \t]*pdf2zh(?![-_\w])/im,
  },
  // The pdf2zh server another plugin sets up (`pdf2zh.new_serverip`), with either engine.
  {
    program: "pdf2zh server",
    provider: "the translation service it's set up with",
    category: "translation",
    local: /\bpdf2zh\b[\w.]*server/i,
  },
  {
    program: "BabelDOC",
    provider: "the AI provider it's set up with",
    category: "translation",
    run: /^(?:\S*[/\\])?babeldoc(?:\.exe)?$/i,
    // Its folder or its server's (`joinPath(dir, "BabelDOC")`, `local_babeldoc_server`).
    mention: /^BabelDOC$|[/\\_]babeldoc_\w|[/\\]babeldoc[/\\]/i,
    py: /^[ \t]*(?:import|from)\s+babeldoc\b/m,
    pkg: /^[ \t]*babeldoc\b/im,
  },
  // The desktop app's layout step goes to Baidu's PaddleOCR service, then to a model.
  {
    program: "RetainPDF",
    provider: "Baidu PaddleOCR and the AI provider it's set up with",
    category: "llm-provider",
    run: /(?:^|[/\\])RetainPDF(?:\.exe|\.app)?$/i,
    local: /\bretain_?pdf\b/i,
  },
  {
    program: "Doc2X CLI",
    provider: "NoEdgeAI",
    category: "llm-provider",
    run: /^(?:\S*[/\\])?doc2x(?:\.exe)?$/,
  },
  {
    program: "DeepLX",
    provider: "DeepL",
    category: "translation",
    run: /^(?:\S*[/\\])?deeplx(?:\.exe)?$/i,
    local: /\bdeeplx\b/i,
  },
  // notebooklm-py signs in with the browser's Google cookies and uploads to NotebookLM.
  {
    program: "NotebookLM",
    provider: "Google",
    category: "llm-provider",
    py: /^[ \t]*(?:import|from)\s+notebooklm\b/m,
    pkg: /^[ \t]*notebooklm-py\b/im,
    local: /\bnotebooklm\b|\bNLMClient\b/i,
    extension: /NotebookLM|Gemini Notebook/i,
  },
  // Lilys AI's Readray reader, a browser extension the plugin opens PDFs in.
  { program: "Readray", provider: "Lilys AI", category: "llm-provider", mention: /\breadray\b/i },
  // Note apps whose desktop API writes into their cloud workspace.
  { program: "Tana", provider: "Tana", category: "integration", local: /\bTana(?:Client|Api)?\b/ },
  { program: "Thymer", provider: "Thymer", category: "integration", local: /\bThymer\w*/i },
  // Agents behind a local gateway or bridge, named as AI_CLI names them.
  {
    program: "OpenClaw",
    provider: "the AI provider it's set up with",
    category: "llm-provider",
    local: /\bopenclaw\b/i,
  },
  {
    program: "Hermes Agent",
    provider: "the AI provider it's set up with",
    category: "llm-provider",
    local: /\bhermes\b/i,
  },
  // A bridge that reuses the Codex sign-in (`X-Zotero-Codex-Token`, a codex bridge URL).
  {
    program: "Codex CLI",
    provider: "OpenAI",
    category: "llm-provider",
    local: /codex[-_ ]?(?:bridge|token)|(?:bridge|relay)[-_ ]?codex/i,
  },
  // Image uploaders that send to whichever image host the user set up in them.
  { program: "PicList", provider: "", category: "unknown", local: /\bpiclist\b/i },
  { program: "PicGo", provider: "", category: "unknown", local: /\bpicgo\b/i },
];
/**
 * An AI tool recognised by its own arguments or by a setting for its path, when the program
 * itself is a path the user sets (zotero-codex-chat runs `<codex.binaryPath> app-server`).
 */
const AI_CLI_ARGS: [RegExp, string][] = [
  [
    /(?:^|\s)app-server(?:\s|$)|--skip-git-repo-check|--dangerously-bypass-approvals-and-sandbox/,
    "Codex CLI",
  ],
  [/--permission-mode|--dangerously-skip-permissions|--append-system-prompt/, "Claude Code"],
];
/**
 * Arguments and values that turn an AI coding agent's approval prompts down: Claude Code's
 * acceptEdits applies file edits without asking; bypassPermissions and the "dangerously" flags drop
 * every prompt (Codex's drops its sandbox too); Codex told `approval_policy=never` doesn't ask but
 * stays inside the sandbox it's given.
 */
const AGENT_WORD =
  /^(--permission-mode|--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo|--full-auto|bypassPermissions|:?(?:agent|danger)-full-access|dangerFullAccess|approval_policy=["']?never["']?|never)$/;
const AGENT_MODE_VALUE: Record<string, AgentMode["mode"]> = {
  acceptEdits: "accept-edits",
  bypassPermissions: "full-bypass",
};

/** Whether code at the end of `anc` runs only on some condition inside its function. */
function conditional(anc: AstNode[]): boolean {
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    const child = anc[i + 1];
    if (FUNCTION_TYPES.has(a.type)) return false;
    if ((a.type === "IfStatement" || a.type === "ConditionalExpression") && node(a.test) !== child)
      return true;
    if ((a.type === "LogicalExpression" && node(a.right) === child) || a.type === "SwitchCase")
      return true;
  }
  return false;
}

/**
 * The argument list a literal sits in, as nodes: an array, or a call that adds to one or launches
 * (`args.push(…)`, `spawn(…)`); not a check like `hasArg("--flag")`.
 */
function siblingArgs(anc: AstNode[]): AstNode[] {
  const p = anc.at(-2);
  const callee = (chain(node(p?.callee)) ?? "").split(".").at(-1) ?? "";
  return p?.type === "ArrayExpression"
    ? nodes(p.elements)
    : p?.type === "CallExpression" &&
        (/^(push|unshift|concat|splice)$/.test(callee) || PROCESS_CALL.test(callee))
      ? nodes(p.arguments)
      : [];
}

/** The sandbox given with an approval policy, in the same argument list or request object. */
function sandboxWith(anc: AstNode[]): string | null {
  const list = siblingArgs(anc);
  if (list.length) {
    const words = argWords(list);
    for (let i = 0; i < words.length; i++) {
      const w = words[i] as string;
      if (w === "--sandbox" || w === "-s") return words[i + 1] ?? null;
      const m = w.match(/^sandbox_mode=["']?([\w-]+)/);
      if (m) return m[1] as string;
    }
    return null;
  }
  // `{ approvalPolicy: "never", sandbox: "read-only" }`, `sandboxPolicy: { type: "readOnly" }`,
  // `sandbox: opts.sandbox || "read-only"`.
  const obj = anc.at(-3);
  for (const q of obj?.type === "ObjectExpression" ? nodes(obj.properties) : []) {
    if (!/^sandbox(Policy|Mode|_mode)?$/.test(nameOf(q) ?? "")) continue;
    let v = node(q.value);
    if (v?.type === "LogicalExpression") v = node(v.right);
    if (v?.type === "ObjectExpression")
      v = node(nodes(v.properties).find((x) => nameOf(x) === "type")?.value);
    return str(v);
  }
  return null;
}

/**
 * Records an approval setting for an AI coding agent: a flag in an argument list counts by default
 * unless a condition guards it; a mode it can switch to (`bypassPermissions` in a menu, a YOLO
 * toggle) is a setting.
 */
function noteAgentMode(col: Collector, n: AstNode, text: string, anc: AstNode[], at: Hit) {
  const add = (program: string, mode: AgentMode["mode"], byDefault: boolean) =>
    col.agentModes.push({ program, mode, byDefault, hit: at });
  const list = siblingArgs(anc);
  const i = list.indexOf(n);
  // In a launch's own argument list, or a request sent to the agent (`rpc("thread/start", {…})`).
  const obj = anc.at(-3);
  const inRequest = obj?.type === "ObjectExpression" && anc.at(-4)?.type === "CallExpression";
  const always = (list.length > 0 || inRequest) && !conditional(anc);
  if (text === "--dangerously-skip-permissions") add("Claude Code", "full-bypass", always);
  else if (text === "--dangerously-bypass-approvals-and-sandbox")
    add("Codex CLI", "full-bypass", always);
  // Gemini CLI's and Qwen Code's flag, and Codex CLI's short name for its bypass; which one is
  // read from the tools it names.
  else if (text === "--yolo") add("", "full-bypass", always);
  else if (text === "--full-auto") add("Codex CLI", "sandboxed", always);
  else if (text === "bypassPermissions") add("Claude Code", "full-bypass", false);
  else if (/full-access$|^dangerFullAccess$/.test(text)) add("Codex CLI", "full-bypass", false);
  else if (text === "--permission-mode" && i >= 0) {
    let v = list[i + 1];
    if (v?.type === "LogicalExpression") v = node(v.right);
    const mode = AGENT_MODE_VALUE[str(v) ?? ""];
    if (mode) add("Claude Code", mode, always);
    // Passed on from a setting: its default in prefs.js decides.
    else if (str(v) === null) col.agentModeSetting = true;
  } else {
    // Codex told never to ask: what that allows depends on the sandbox given with it.
    const policy =
      text !== "never" ||
      /^(--ask-for-approval|-a)$/.test(str(list[i - 1]) ?? "") ||
      (anc.at(-2)?.type === "Property" && /^approval_?[pP]olicy$/.test(nameOf(anc.at(-2)) ?? ""));
    const sandbox = policy ? sandboxWith(anc) : null;
    if (sandbox && /^(workspace-write|workspaceWrite)$/.test(sandbox))
      add("Codex CLI", "sandboxed", always);
    else if (sandbox && /^(danger-full-access|dangerFullAccess)$/.test(sandbox))
      add("Codex CLI", "full-bypass", always);
  }
}

/** The approval settings to show, one per agent and mode, a default beating a setting. */
function agentModes(col: Collector) {
  const named = [...col.cliNamed.keys()];
  const out = new Map<string, { program: string; mode: AgentMode["mode"]; byDefault: boolean }>();
  for (const m of col.agentModes) {
    // A settings default counts when a launch passes the setting on.
    if (m.pref && !col.agentModeSetting) continue;
    // With none of them named, we can't say which agent it is.
    const program =
      m.program ||
      named.find((p) => p === "Gemini CLI" || p === "Qwen Code" || p === "Codex CLI") ||
      "an AI coding agent";
    const key = `${program}\u0000${m.mode}`;
    const seen = out.get(key);
    if (!seen || (m.byDefault && !seen.byDefault))
      out.set(key, { program, mode: m.mode, byDefault: m.byDefault });
  }
  return [...out.values()].sort(
    (a, b) => a.program.localeCompare(b.program, "en") || a.mode.localeCompare(b.mode, "en"),
  );
}

const AI_CLI_SETTING: [RegExp, string][] = [
  [
    /codex[._-]?(?:cli)?[._-]?(?:binary|bin|exe|executable|command|cmd)?[._-]?path|codex[._-]?(?:binary|bin|executable|command)$/i,
    "Codex CLI",
  ],
  [
    /claude[._-]?(?:code)?[._-]?(?:cli)?[._-]?(?:binary|bin|exe|executable|command|cmd)?[._-]?path|claude[._-]?(?:code[._-]?)?(?:binary|bin|executable|command)$/i,
    "Claude Code",
  ],
  [
    /gemini[._-]?(?:cli)?[._-]?(?:binary|bin|exe|executable|command|cmd)?[._-]?path|gemini[._-]?cli[._-]?(?:binary|bin|executable|command)$/i,
    "Gemini CLI",
  ],
];
/** Installing or running packages from npm or PyPI: the code is fetched when it runs. */
const PACKAGE_BARE = /^(?:npx|pnpx|bunx|uvx|pipx)$/;
/** The flag that makes a shell run a command line: `sh -c`, `zsh -lc`, `cmd /c`, `pwsh -Command`. */
const SHELL_FLAG = /^(?:-[il]{0,2}c|\/[cCkK]|-Command|-command|-EncodedCommand|-enc)$/;
const PACKAGE_RUN =
  /^(?:npx|pnpx|bunx)\s+(?:-y\s+|--yes\s+)?\S|\bnpm\s+(?:i|install|exec)\s+\S|\bpip3?\s+install\b|^uv\s+(?:run|pip|tool|sync)\b|\buvx\s+\S|\bpipx\s+(?:run|install)\b/;

/** A package tool named on its own, and the arguments that make it fetch and run a package. */
const PACKAGE_TOOL = /^(?:.*[/\\])?(uv|npm|pnpm|pip3?|bun)(?:\.exe)?$/;
/** Near a shell flag: the shell it goes to (a literal, `$SHELL`, a `shellPath` setting). */
const SHELL_NAME =
  /\b(?:\/bin\/(?:ba|z|da)?sh|bash|zsh|sh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|ComSpec|SHELL|shell\w*)\b/i;
/** Callees that start a program with an argument list. */
const PROCESS_CALL =
  /(spawn|exec|execFile|call|run|launch|Command|Cmd|Process|Executable|Subprocess)$/i;
/** Shells, interpreters and AI tools say more about a launch than system utilities do. */
function programRank(name: string): number {
  if (/^(bash|sh|zsh|cmd|powershell|pwsh)$/i.test(name)) return 0;
  if (/^(python3?|node|java|ruby|perl|swift|osascript|deno|bun)$/i.test(name)) return 1;
  if (/^(npx|npm|uvx?|pip3?|pipx|conda|claude|codex|gemini|opencode|qwen)$/i.test(name)) return 2;
  if (
    /^(open|xdg-open|qlmanage|gio|rundll32|explorer|taskkill|tasklist|pgrep|killall|kill|ps|chmod|unzip|tar|which|where|hdiutil)$/i.test(
      name,
    )
  )
    return 4;
  return 3;
}

/** The package tool a variable holds the path of: `npmPath`, `npmState.npmPath`, `uvExe`. */
function toolNamedBy(name: string): string | null {
  const last = name.split(".").at(-1) ?? "";
  const m = last.match(
    /^(npm|pnpm|pip3?|uv|bun|conda|mamba|npx|pnpx|bunx|uvx|pipx)(?:Cli)?(?:Path|Exe|Executable|Bin|Cmd|Command|_path|_exe|_bin)?$/i,
  );
  const tool = m?.[1]?.toLowerCase();
  return tool === "pip3" ? "pip" : tool === "mamba" ? "conda" : (tool ?? null);
}
/** An argument list as text, with computed elements marked; null when it holds no literal. */
function argText(n: AstNode | undefined): string | null {
  const els = nodes(n?.elements);
  if (!els.length || !els.some((e) => str(e) !== null)) return null;
  return els.map((e) => str(e) ?? EXPR).join(" ");
}
const PACKAGE_ARGS: Record<string, RegExp> = {
  conda: /^(?:--?[\w-]+(?:=\S+)?\s+)*(?:install|create)\b/,
  uv: /^(?:--?[\w-]+(?:=\S+)?\s+)*(?:run|tool\s+(?:run|install)|pip\s+install|sync|add)\b/,
  npm: /^(?:--?[\w-]+(?:=\S+)?\s+)*(?:i|install|exec|x)(?:\s+--?[\w-]+)*\s+[^-\s]/,
  pnpm: /^(?:--?[\w-]+(?:=\S+)?\s+)*(?:i|install|add|exec|dlx)\b/,
  pip: /^(?:--?[\w-]+(?:=\S+)?\s+)*install\b/,
  bun: /^(?:--?[\w-]+(?:=\S+)?\s+)*(?:x|add|install)\b/,
};
/** Package runners: whatever package they're given is fetched and run (`npx pkg`, `uvx pkg`). */
const RUNNER_TOOL = /^(?:npx|pnpx|bunx|uvx|pipx)$/;
/** A Python interpreter's package installer in an argument list: `[py, "-m", "pip", "install"]`. */
const PIP_MODULE = /(?:^|\s)-m pip3? install(?:\s|$)/;
/** An argument list that fetches packages when a program runs it with a package tool. */
const installsWith = (tool: string, words: string[]) =>
  RUNNER_TOOL.test(tool)
    ? words.some((w) => !w.startsWith("-"))
    : !!PACKAGE_ARGS[tool]?.test(words.join(" "));

/**
 * Names in an argument list (`provider.packageSpec`, `...pip`) are looked up in the build's
 * constants once every file is read: the value is often set in another file (zotero-translate's
 * `ACP_PACKAGE_SPEC` in constants.js). Alternatives for one word are kept together.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: \u0001 and \u0002 mark a name
const NAMED_RE = /\u0001([\w$]+)\u0002/g;
const named = (name: string) => `\u0001${name}\u0002`;
const SPREAD = "\u0003";
const ALT = "\u0005";
/** A literal that can name a package with its version, or a version on its own. */
const SPEC_VALUE =
  /^(?:@[\w.-]+\/)?[\w.-]+(?:\[[\w,.-]+\])?(?:@[\w.^~<>=*|-]+|\s*(?:===?|~=|>=?|<=?|!=)\s*[\w.*+-]+(?:\s*,\s*[<>=!~]=?\s*[\w.*+-]+)*)$|^v?\d+(?:\.\d+){1,3}(?:[-+.]?[a-z0-9]+)*$/i;
const INSTALL_VERB = /^(?:install|i|add|sync|run|exec|dlx|x|ci|create)$/;
/** A package file pip installs as it is: a wheel or a source archive. */
const PACKAGE_FILE = /\.(?:whl|tar\.gz)$/i;
/** Marks a value that is a package file's path, followed by the file's name. */
const FILE_SPEC = "\u0004";

const nameIn = (e: AstNode | undefined): string | null =>
  e?.type === "Identifier"
    ? (e.name as string)
    : e?.type === "MemberExpression" && !e.computed
      ? ((node(e.property)?.name as string | undefined) ?? null)
      : null;

/** An argument list's words: literals, a template's text, and names to look up later. */
function argWords(els: AstNode[]): string[] {
  return els.map((e) => {
    const s = str(e);
    if (s !== null) return s;
    if (e.type === "SpreadElement") {
      const n = nameIn(node(e.argument));
      return n ? SPREAD + n : EXPR;
    }
    if (e.type === "TemplateLiteral") {
      const exprs = nodes(e.expressions);
      return nodes(e.quasis)
        .map((q, i) => {
          const text = (q.value as { cooked?: string; raw: string }).cooked ?? "";
          if (i >= exprs.length) return text;
          const n = nameIn(exprs[i]);
          return text + (n ? named(n) : EXPR);
        })
        .join("");
    }
    const n = nameIn(e);
    return n ? named(n) : EXPR;
  });
}

/**
 * Records a constant that argument lists may name: a package spec or version
 * (`packageSpec: "pi-acp@0.0.33"`, `const PDF2ZH_VERSION = "2.9.0"`), a reference to an
 * upper-case constant, or an argument list (`const pip = ["pip", "install", …]`).
 */
function noteSpecValue(col: Collector, n: AstNode) {
  const [key, value] =
    n.type === "VariableDeclarator" && node(n.id)?.type === "Identifier"
      ? [node(n.id)?.name as string, node(n.init)]
      : (n.type === "Property" || n.type === "PropertyDefinition") && !n.computed
        ? [nameOf(n), node(n.value)]
        : [null, undefined];
  if (!key || !value) return;
  const s = str(value);
  const ref = nameIn(value);
  // A package file's path, built from its name (`joinPath(staging, "scansci-pdf.whl")`): that
  // file is the version it installs (litmtrans).
  const parts =
    value.type === "CallExpression"
      ? nodes(value.arguments)
      : value.type === "BinaryExpression"
        ? [node(value.left), node(value.right)]
        : [value];
  const file = parts
    .map((p) =>
      p?.type === "TemplateLiteral"
        ? ((nodes(p.quasis).at(-1)?.value as { cooked?: string } | undefined)?.cooked ?? null)
        : p
          ? str(p)
          : null,
    )
    .find((t) => t !== null && PACKAGE_FILE.test(t));
  const entry =
    s !== null && SPEC_VALUE.test(s)
      ? s
      : file
        ? FILE_SPEC + (file.split(/[/\\]/).at(-1) as string)
        : ref && /^[A-Z][A-Z0-9_]{2,}$/.test(ref)
          ? named(ref)
          : null;
  if (entry !== null) {
    const list = col.specValues.get(key) ?? [];
    if (list.length < 10 && !list.includes(entry)) list.push(entry);
    col.specValues.set(key, list);
  } else if (value.type === "ArrayExpression" && !col.specArrays.has(key)) {
    const els = nodes(value.elements);
    if (els.length > 40 || str(els[0]) === null) return;
    const words = argWords(els);
    // An install's words, or a list of its options spread into one (`...pipOptions`).
    if (
      words.some((w) => INSTALL_VERB.test(w) || (/[@=]/.test(w) && SPEC_VALUE.test(w))) ||
      /^--?[a-z]/.test(words[0] ?? "")
    )
      col.specArrays.set(key, words);
  }
}

/** Words with their names looked up: spreads expand, a named value becomes its alternatives. */
function resolveWords(col: Collector, words: string[], depth = 0): string[] {
  const values = (name: string, d: number): string[] => {
    if (d > 2) return [];
    return (col.specValues.get(name) ?? []).flatMap((v) =>
      v.startsWith("\u0001") ? values(v.slice(1, -1), d + 1) : [v],
    );
  };
  return words.flatMap((w) => {
    if (w.startsWith(SPREAD)) {
      const arr = col.specArrays.get(w.slice(1));
      return arr && depth < 2 ? resolveWords(col, arr, depth + 1) : [EXPR];
    }
    if (!w.includes("\u0001")) return [w];
    // Each name's values, combined (a few at most): `${backend.package}==${backend.version}`.
    let acc = [""];
    let last = 0;
    for (const m of w.matchAll(NAMED_RE)) {
      const vs = values(m[1] as string, 0);
      const pre = w.slice(last, m.index);
      acc = acc.flatMap((a) => (vs.length ? vs : [EXPR]).map((v) => a + pre + v)).slice(0, 8);
      last = (m.index ?? 0) + m[0].length;
    }
    return [acc.map((a) => a + w.slice(last)).join(ALT)];
  });
}

/** The package tool a word names: `npm`, `/usr/local/bin/uv`, `"$uv_path"`, `pip3.exe`. */
function toolOf(word: string): string | null {
  const w = word.replace(/^["'&\s]+|["'\s]+$/g, "");
  const base = (w.split(/[/\\]/).at(-1) ?? w).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  const m = base.match(/^(npx|pnpx|bunx|uvx|pipx|npm|pnpm|bun|uv|pip3?|conda|mamba|micromamba)$/);
  if (m)
    return m[1] === "pip3" ? "pip" : /mamba$/.test(m[1] as string) ? "conda" : (m[1] as string);
  if (/^python3?(\.\d+)?$/.test(base)) return "python";
  // A shell variable holding the tool's path: `"$uv_path"`, `$uvPath`, `${NPM_BIN}`.
  const v = w.match(/^\$\{?(\w+)\}?$/)?.[1];
  return v ? toolNamedBy(v.toLowerCase().replace(/_?(path|exe|bin|cmd)$/, "")) : null;
}

/** Flags whose value is a package, a requirements file, or anything else (to skip it). */
const SPEC_FLAG = new Set(["--package", "--with", "--from"]);
const REQ_FLAG = new Set([
  "-r",
  "--requirement",
  "--requirements",
  "--with-requirements",
  "--constraint",
  "--file",
]);
const VALUE_FLAG = new Set([
  "-t",
  "--target",
  "--timeout",
  "--retries",
  "--proxy",
  "--cert",
  "--exists-action",
  "-i",
  "--index-url",
  "--extra-index-url",
  "--index",
  "--default-index",
  "--python",
  "--prefix",
  "--root",
  "--log",
  "--upgrade-strategy",
  "-f",
  "--find-links",
  "--platform",
  "--python-platform",
  "--only-binary",
  "--no-binary",
  "--progress-bar",
  "--cache-dir",
  "--cache",
  "--trusted-host",
  "--python-version",
  "--report",
  "--registry",
  "-w",
  "--workspace",
  "--loglevel",
  "--tag",
  "--project",
  "--directory",
  "--config-file",
  "--env-file",
  "-n",
  "--name",
  "--channel",
  "-e",
  "--editable",
  "--group",
  "--extra",
  "--call",
  "--link-mode",
  "--exclude-newer",
  "--resolution",
  "--prerelease",
  "--keyring-provider",
]);

interface InstallRead {
  tool: string;
  /** Packages it names, each with its alternatives joined by ALT. */
  specs: string[];
  reqs: number;
  /** The requirements files it names (`-r service/requirements.txt`), as written. */
  reqPaths: string[];
  /** Installs a project's dependencies: `uv sync`, `uv run` in a project, `npm ci`. */
  project: boolean;
  /** `--frozen`, `--locked`, `--require-hashes`, `npm ci`. */
  frozen: boolean;
  noDeps: boolean;
}

/** What one package command installs, read from its words; null when no tool starts it. */
function readInstall(words: string[]): InstallRead | null {
  let i = words.findIndex(
    (w, j) => toolOf(w) !== null || (w === "-m" && /^pip3?$/.test(words[j + 1] ?? "")),
  );
  if (i < 0) return null;
  let tool = words[i] === "-m" ? "pip" : (toolOf(words[i] as string) as string);
  i += words[i] === "-m" ? 2 : 1;
  const r: InstallRead = {
    tool,
    specs: [],
    reqs: 0,
    reqPaths: [],
    project: false,
    frozen: false,
    noDeps: false,
  };
  let verb: string | null = RUNNER_TOOL.test(tool) && tool !== "pipx" ? "run" : null;
  for (; i < words.length; i++) {
    const w = words[i] as string;
    if (/^(&&?|\|\|?|;)$/.test(w)) break;
    // `python -m pip …`, and pip reached through conda or uv (`conda run … python -m pip`).
    if (tool === "python" || (tool === "conda" && verb === "run")) {
      if (w === "-m" && /^pip3?$/.test(words[i + 1] ?? "")) {
        tool = "pip";
        verb = null;
        i++;
      } else if (tool === "conda" && toolOf(w) === "python") tool = "python";
      else if (tool === "python" && !w.startsWith("-")) return null;
      continue;
    }
    if (w === "--") {
      if (verb === "run" || verb === "exec" || verb === "x" || verb === "dlx") break;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      const eq = w.indexOf("=");
      const flag = eq > 0 ? w.slice(0, eq) : w;
      const inline = eq > 0 ? w.slice(eq + 1) : undefined;
      const value = () => inline ?? words[++i] ?? "";
      if (/^--(frozen|locked|require-hashes)$/.test(flag)) r.frozen = true;
      else if (flag === "--no-deps") r.noDeps = true;
      const runner = RUNNER_TOOL.test(tool);
      if (SPEC_FLAG.has(flag) || (flag === "-p" && runner && tool !== "uvx")) r.specs.push(value());
      else if (REQ_FLAG.has(flag) || (flag === "-c" && (tool === "pip" || tool === "uv"))) {
        r.reqPaths.push(value());
        r.reqs++;
      } else if (
        VALUE_FLAG.has(flag) ||
        (flag === "-p" && (tool === "uv" || tool === "uvx" || tool === "conda")) ||
        (flag === "-c" && (tool === "conda" || runner))
      )
        value();
      continue;
    }
    if (verb === null) {
      verb = w;
      if (tool === "uv" && w === "pip") [tool, verb] = ["pip", null];
      else if (tool === "uv" && w === "tool") [tool, verb] = ["uvx", null];
      else if (tool === "uvx" && w === "install") verb = "add";
      else if (tool === "npm" && w === "ci") r.frozen = true;
      continue;
    }
    const runs =
      RUNNER_TOOL.test(tool) ||
      (tool === "npm" && /^(exec|x)$/.test(verb)) ||
      (tool === "pnpm" && /^(dlx|exec)$/.test(verb)) ||
      (tool === "bun" && verb === "x");
    if (runs) {
      // The package, unless `--package`/`--from` named it; then the command and its arguments.
      if (!r.specs.length) r.specs.push(w);
      break;
    }
    if (tool === "uv" && verb === "run") break;
    if (/^(install|i|add|create)$/.test(verb)) {
      // conda's interpreter isn't a package from npm or PyPI.
      if (!(tool === "conda" && /^python(=|$)/.test(w))) r.specs.push(w);
      continue;
    }
    break;
  }
  r.tool = tool;
  if (tool === "python") return null;
  // A project's dependencies: `uv sync`, `uv run` without `--with`, `npm ci`, `npm install` alone.
  if (
    (tool === "uv" && (verb === "sync" || (verb === "run" && !r.specs.length))) ||
    ((tool === "npm" || tool === "pnpm" || tool === "bun") &&
      /^(ci|install|i)$/.test(verb ?? "") &&
      !r.specs.length &&
      !r.reqs)
  )
    r.project = true;
  return r;
}

/** An exact version: `name==1.2.3`, `name@1.2.3`, conda's `name=1.2.3`. */
function exactSpec(spec: string): boolean {
  // A wheel or archive it names is one version of the package (its dependencies still float).
  if (spec.startsWith(FILE_SPEC) || (PACKAGE_FILE.test(spec) && !spec.includes(EXPR))) return true;
  const pip = spec.match(/^([^<>=!~,]*?)\s*===?\s*([^,;\s]+)$/);
  if (pip) return /^v?\d+(\.\d+)*([.+-]?[a-z0-9]+)*$/i.test(pip[2] as string);
  const at = spec.lastIndexOf("@");
  if (at > 0) return /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(spec.slice(at + 1));
  return /^[\w.-]+=\d+\.\d+\.\d+\S*$/.test(spec);
}

/** A package's name as the card shows it (with its version when exact), or null if computed. */
function specLabel(spec: string): string | null {
  // A wheel's file name starts with its package and version: `scansci_pdf-1.17.0-py3-none-any.whl`.
  if (spec.startsWith(FILE_SPEC) || PACKAGE_FILE.test(spec)) {
    const base = (spec.replace(FILE_SPEC, "").split(/[/\\]/).at(-1) ?? "").replace(
      PACKAGE_FILE,
      "",
    );
    const [name, version] = base.split("-").length >= 5 ? base.split("-") : [base];
    return name && !name.includes(EXPR) ? (version ? `${name} ${version}` : name) : null;
  }
  const exact = exactSpec(spec);
  const m = spec.match(/^((?:@[\w.-]+\/)?[\w.-]+)(?:\[[^\]]*\])?(?:\s*(?:===?|@|=)\s*(\S+))?/);
  if (!m || spec.includes(EXPR) || /^[\d.]+$/.test(m[1] as string)) return null;
  return exact && m[2] ? `${m[1]} ${m[2].replace(/^v/, "")}` : (m[1] as string);
}

/** A requirements file's packages, one spec each: `requests`, `fastapi>=0.115.0`, `tqdm==4.66.1`. */
function requirementSpecs(text: string): string[] {
  return text
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter((l) => l && !l.startsWith("-") && !/^[a-z+]+:\/\//i.test(l))
    .map((l) => l.replace(/\s+--?\w[\s\S]*$|\s*;[\s\S]*$/, "").replace(/\s+/g, ""));
}

/**
 * A shipped pyproject.toml's `[project] dependencies`. The list ends at the first `]` outside a
 * string: an extra's brackets (`"docling[rapidocr]==2.1"`) are part of the name.
 */
function pyprojectSpecs(text: string): string[] {
  const list =
    text.match(
      /^\s*dependencies\s*=\s*\[((?:"[^"\n]*"|'[^'\n]*'|#[^\n]*(?=\n)|[^\]"'#])*)\]/m,
    )?.[1] ?? "";
  return [...list.matchAll(/"([^"\n]+)"|'([^'\n]+)'|#[^\n]*/g)]
    .map((m) => m[1] ?? m[2])
    .filter((x): x is string => !!x)
    .map((x) => x.replace(/\s*;[\s\S]*$/, "").replace(/\s+/g, ""));
}

/**
 * The requirements files it ships that a command installs from: those it names by file name (all
 * it ships when a name is computed). Null when it names only files it doesn't ship: the user's.
 */
function shippedReqFiles(col: Collector, r: InstallRead): string[] | null {
  if (!r.reqs || !col.reqFiles.size) return null;
  const base = (p: string) => p.split(/[/\\]/).at(-1)?.toLowerCase() ?? p;
  const all = [...col.reqFiles.keys()];
  // `-r ${dir}/requirements-lock.txt` still names its file; a computed name could be any of them.
  if (!r.reqPaths.length || r.reqPaths.some((p) => base(p).includes(EXPR))) return all;
  const named = all.filter((f) => r.reqPaths.some((p) => base(p) === base(f)));
  return named.length ? named : null;
}

/**
 * What a command installs from files the plugin ships: the requirements files it names, or a
 * project's pyproject.toml. Null when it installs from none it ships: a file or project the user
 * supplies isn't the plugin's supply chain.
 */
function shippedSpecs(col: Collector, r: InstallRead): string[] | null {
  if (r.project && r.tool === "uv")
    return col.pyprojects.size ? [...col.pyprojects.values()].flatMap(pyprojectSpecs) : null;
  return (
    shippedReqFiles(col, r)?.flatMap((f) => requirementSpecs(col.reqFiles.get(f) ?? "")) ?? null
  );
}

/** Every requirement pinned to one version: `name==1.2.3`, optionally with hashes. */
function fullyPinned(text: string): boolean {
  const lines = text
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean);
  return lines.every(
    (l) =>
      (l.startsWith("-") && !/^-e\b|^--editable\b/.test(l)) ||
      /^[\w.[\],-]+\s*===?\s*[\w.+!-]+/.test(l),
  );
}

/**
 * How one package command pins what it installs, or null when it names nothing the plugin chose:
 * a requirements file or project the user supplies isn't the plugin's supply chain, and an
 * argument list with no package in it is a prefix other lists extend.
 */
function runPin(col: Collector, r: InstallRead): Pin | null {
  // A project it ships with every dependency exact pins what it names (dependencies still float).
  const project = r.project ? shippedSpecs(col, r) : null;
  if (r.project)
    return col.lockFile
      ? "locked"
      : project?.length && project.every(exactSpec)
        ? "top-level"
        : "unpinned";
  const specs = r.specs.flatMap((s) => s.split(ALT));
  // The files it ships that the command names: another shipped file's pinning isn't this one's.
  const ownReqs = shippedReqFiles(col, r);
  if (!specs.length && !ownReqs) return RUNNER_TOOL.test(r.tool) ? "unpinned" : null;
  const reqsPinned = (ownReqs ?? []).every((f) => fullyPinned(col.reqFiles.get(f) ?? ""));
  if (!reqsPinned || !specs.every(exactSpec)) return "unpinned";
  // Nothing floats: hashes required, no dependencies pulled, or only fully pinned files it ships.
  return r.frozen || r.noDeps || !specs.length ? "locked" : "top-level";
}

const PIN_RANK: Record<Pin, number> = { locked: 0, "top-level": 1, unpinned: 2 };

/**
 * How a plugin's package installs are pinned (the loosest one counts), the packages behind that,
 * and whether one runs from Zotero's startup without asking. A command we can't read counts as
 * unpinned: no fixed version we could see.
 */
function packagePinning(
  col: Collector,
  runs: PackageRun[],
): { pinning?: Pin; packages?: string[]; atStartup?: boolean; once?: boolean } {
  let pinning: Pin | undefined;
  const loose = new Set<string>();
  const exact = new Set<string>();
  let atStartup = false;
  // Every unpinned install waits for an "already installed" check.
  let once = true;
  for (const run of runs) {
    const read = run.words ? readInstall(resolveWords(col, run.words)) : null;
    const pin = read ? runPin(col, read) : "unpinned";
    if (!pin) continue;
    if (!pinning || PIN_RANK[pin] > PIN_RANK[pinning]) pinning = pin;
    if (pin === "unpinned" && !run.once && !calledOnce(col, run)) once = false;
    // The packages it names, and those in the requirements file or project it ships.
    const specs = [
      ...(read?.specs.flatMap((x) => x.split(ALT)) ?? []),
      ...((read && shippedSpecs(col, read)) ?? []),
    ];
    for (const spec of specs) {
      const label = specLabel(spec);
      if (label) (exactSpec(spec) ? exact : loose).add(label);
    }
    const asks =
      run.fnAt !== undefined &&
      /\bconfirm(Ex)?\s*\(|\.prompt\.(confirm|select)\b/.test(
        run.file.text.slice(run.fnAt, run.offset),
      );
    // A setup or update step on a path from startup (`ensureEnvReady`, `installDependencies`), not
    // a command helper that resumes the user's queued work there (zetero-babeldoc's uvx fallback).
    if (!asks && SETUP_STEP.test(run.fn ?? "") && runsAtStartup(col, run.fn)) atStartup = true;
  }
  const packages = [...(pinning === "unpinned" ? loose : exact)].sort().slice(0, 5);
  return {
    ...(pinning ? { pinning } : {}),
    ...(packages.length ? { packages } : {}),
    ...(atStartup ? { atStartup } : {}),
    ...(pinning === "unpinned" && once ? { once } : {}),
  };
}

/** A command line's words, quotes taken off, with `&&`, `||`, `;` and `|` apart. */
const commandWords = (text: string) =>
  text
    .replace(/(&&?|\|\|?|;)/g, " $1 ")
    .split(/\s+/)
    .map((w) => w.replace(/^(["'])(.*)\1$/, "$2"))
    .filter(Boolean);

/** The Python list around a match (`[py, "-m", "pip", "install", "-r", req]`) as words. */
function pyListWords(text: string, at: number): string[] {
  const start = text.lastIndexOf("[", at);
  const end = text.indexOf("]", at);
  if (start < 0 || end < 0 || at - start > 400 || end - at > 400) return [];
  return text
    .slice(start + 1, end)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.match(/^[rbuf]?(["'])(.*)\1$/)?.[2] ?? EXPR);
}

function launchesOwn(col: Collector): boolean {
  return Boolean(
    col.caps.get("process-launch")?.hits.some((h) => h.file.libraryAt(h.offset) === null),
  );
}

/** A compiled program: Windows PE (MZ), ELF, or Mach-O (thin or universal; not a Java class). */
function isExecutable(d: Uint8Array): boolean {
  if (d.length < 1024) return false;
  const u32 = (i: number) =>
    (((d[i] ?? 0) << 24) | ((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0)) >>>
    0;
  const magic = u32(0);
  if (d[0] === 0x4d && d[1] === 0x5a) return true;
  if (magic === 0x7f454c46) return true;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  // 0xCAFEBABE is also a Java class; a universal binary's next word is a small architecture count.
  return magic === 0xcafebabe && u32(4) < 20;
}

/** Encrypted or packed: a long base64 run in text, or near-random bytes, in a file of some size. */
function isOpaque(path: string, data: Uint8Array): boolean {
  if (data.length < 8 * 1024 || data.length > 64 * 1024 * 1024 || MEDIA_EXT.test(path))
    return false;
  const head = data.subarray(0, Math.min(data.length, 256 * 1024));
  const counts = new Array<number>(256).fill(0);
  let printable = 0;
  for (const b of head) {
    counts[b] = (counts[b] ?? 0) + 1;
    if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) printable++;
  }
  if (printable / head.length > 0.97) {
    const text = new TextDecoder().decode(head);
    return /[A-Za-z0-9+/_-]{4096,}={0,2}/.test(text);
  }
  let entropy = 0;
  for (const c of counts) if (c) entropy -= (c / head.length) * Math.log2(c / head.length);
  return entropy > 7.5;
}

/** A download piped into a shell, in a command string or a shipped script. */
/** Downloaded to a file, then run: `curl -o f … && bash f`, `Invoke-WebRequest -OutFile f; & f`. */
const DOWNLOAD_TO_FILE_RUN =
  /\b(?:curl|wget)\b[^\n]{0,300}?(?:\s-o|\s-O|--output)\s+["']?([^\s"']+)["']?[^\n]{0,300}?(?:&&|;|\n)\s*(?:sudo\s+)?(?:ba|z)?sh\s+["']?\1\b|\bInvoke-WebRequest\b[^\n]{0,300}?-OutFile\s+["']?([^\s"';]+)["']?[\s\S]{0,300}?(?:&\s*["']?\2|-File\s+["']?\2)/i;
const DOWNLOAD_RUN =
  /\b(?:curl|wget)\b[^|;&\n]{0,300}\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da)?sh\b|\b(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^|;\n]{0,300}\|\s*iex\b|\biex\s*\(\s*(?:\(\s*)?(?:New-Object\s+(?:System\.)?Net\.WebClient|irm|iwr|Invoke-RestMethod)/i;
/** In a shipped script: fetches a file, then unpacks it or makes it executable. */
const DOWNLOAD_THEN_RUN =
  /\b(?:curl|wget|Invoke-WebRequest|iwr|Start-BitsTransfer)\b[\s\S]{0,2000}?(?:\bchmod\s+(?:[+u]?\+?x|[0-7]{3,4})\b|\btar\s+-?[a-z]*x|\bExpand-Archive\b|\bunzip\s)/i;
const SHELL_SCRIPT = /\.(sh|bash|zsh|command|ps1|psm1|bat|cmd)$/i;
/** Python code that downloads, unpacks and runs: all three parts in one embedded program. */
const PY_DOWNLOAD_RUN = [
  /\burllib\.request\.urlretrieve\(|\burlopen\(|\brequests\.get\(/,
  /\.extractall\(|\btarfile\.open\(|\bzipfile\.ZipFile\(/,
  /\bsubprocess\.(run|call|Popen|check_call|check_output)\(|\bos\.(system|exec\w*)\(/,
];
/**
 * Python calls that send a request: urllib, requests, httpx, aiohttp, http.client, websockets, an
 * AI provider's client given its address; curl, wget or a package install run through subprocess.
 */
const PY_REQUEST_CALL =
  /\b(?:urllib2?\.(?:request\.)?(?:urlopen|Request|urlretrieve)|urllib\.request\.\w+|requests\.(?:get|post|put|patch|delete|head|options|request)|httpx\.(?:get|post|put|patch|delete|head|options|request|stream|Client|AsyncClient)|aiohttp\.(?:request|ClientSession)|(?:http\.client\.)?HTTPS?Connection|websockets?\.(?:connect|create_connection)|(?:Async)?(?:OpenAI|Anthropic)|urlopen|urlretrieve)\s*\(/g;
/** A session or client whose methods send requests: `s = requests.Session()`, `with httpx.Client() as c`. */
const PY_SESSION =
  /(?:([\w.]+)\s*=\s*|\bwith\s+)(?:requests\.Session|httpx\.(?:Async)?Client|aiohttp\.ClientSession|urllib3\.PoolManager)\s*\([^)]*\)(?:\s+as\s+(\w+))?/g;

/** Where the call whose `(` is at `open` ends (its `)`), skipping strings. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 20_000; i++) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch && text[i] !== "\n"; i++)
        if (text[i] === "\\") i++;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth === 0) return i;
  }
  return open;
}

/** Where the list or call around `at` opens (its `[` or `(`), or -1. */
function openAround(text: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0 && i > at - 2000; i--) {
    const ch = text[i] as string;
    if (")]}".includes(ch)) depth++;
    else if ("([{".includes(ch) && depth-- === 0) return i;
  }
  return -1;
}

/** Where the argument starting at `from` ends: a comma or the call's `)` outside brackets. */
function argEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length && i < from + 4000; i++) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch && text[i] !== "\n"; i++)
        if (text[i] === "\\") i++;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && depth-- === 0) return i;
    else if (ch === "," && depth === 0) return i;
  }
  return from;
}

/** A line's indentation, in columns. */
const indentOf = (line: string) => (line.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "    ").length;

/** A Python program's functions (`def`), each with its name and where its body ends. */
function pyDefs(text: string): { name: string; start: number; end: number }[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const out: { name: string; start: number; end: number }[] = [];
  lines.forEach((line, row) => {
    const m = line.match(/^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/);
    if (!m) return;
    const indent = indentOf(line);
    // The body starts after the signature, which may run over several lines.
    const close = closeOf(text, (starts[row] as number) + m[0].length - 1);
    let r = row + 1;
    while (r < lines.length && (starts[r] as number) <= close) r++;
    for (; r < lines.length; r++) {
      const l = lines[r] as string;
      if (l.trim() && !l.trim().startsWith("#") && indentOf(l) <= indent) break;
    }
    out.push({ name: m[2] as string, start: starts[row] as number, end: starts[r] ?? text.length });
  });
  return out;
}

/**
 * The addresses in a shipped Python program that reach a request call: written in its arguments,
 * or held in a name the call uses, assigned in the same function or at module level (a class
 * attribute too), a few assignments on, or handed back by a function (`return BASE`). A function
 * of its own that makes a request counts as one (`_http_post_json(url, …)` around urlopen).
 * Others are names: Linked Data identifiers (`http://sws.geonames.org/…`), a default in
 * `entity.get("@URI", …)`, a docstring's link.
 */
function pyRequestUrls(text: string): (at: number) => boolean {
  const calls: [number, number][] = [];
  const add = (m: RegExpMatchArray) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    calls.push([open, closeOf(text, open)]);
  };
  for (const m of text.matchAll(PY_REQUEST_CALL)) add(m);
  if (/from\s+urllib[\w.]*\s+import[^\n]*\bRequest\b/.test(text))
    for (const m of text.matchAll(/(?<![\w.])Request\s*\(/g)) add(m);
  for (const m of text.matchAll(/\b(?:subprocess\.\w+|os\.(?:system|popen))\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const end = closeOf(text, open);
    if (/\b(?:curl|wget)\b|\b(?:pip3?|uv\s+pip|npm|conda)\s+install\b/.test(text.slice(open, end)))
      calls.push([open, end]);
  }
  // …and as an argument list, run where it's built or from the name it's kept in: a package
  // index (`["-m", "pip", "install", "-i", MIRROR]`) is where it downloads from.
  const commandList = new RegExp(`${PY_PACKAGE_RUN.source}|["'](?:curl|wget)["']`, "g");
  for (const m of text.matchAll(commandList)) {
    const open = openAround(text, m.index ?? 0);
    if (open >= 0 && text[open] === "[") calls.push([open, closeOf(text, open)]);
  }
  const sessions = [...text.matchAll(PY_SESSION)]
    .map((m) => m[2] ?? m[1])
    .filter((x): x is string => !!x);
  if (sessions.length) {
    const esc = sessions.map((x) => x.replace(/\./g, "\\."));
    const re = new RegExp(
      String.raw`(?<![\w.])(?:${esc.join("|")})\.(?:get|post|put|patch|delete|head|options|request|stream|ws_connect|urlopen)\s*\(`,
      "g",
    );
    for (const m of text.matchAll(re)) add(m);
  }
  // Its own functions that make a request, and functions that call those: called by name or on
  // `self`, not a method of another object that shares the name (`entity.get(…)`).
  const defs = pyDefs(text);
  const helpers = new Set<string>();
  for (let round = 0; round < 2; round++)
    for (const d of defs) {
      if (helpers.has(d.name) || !calls.some(([a]) => a > d.start && a < d.end)) continue;
      helpers.add(d.name);
      const re = new RegExp(String.raw`(?:(?<![\w.])|(?<=\b(?:self|cls)\.))${d.name}\s*\(`, "g");
      for (const m of text.matchAll(re))
        if (!/\bdef\s+$/.test(text.slice(Math.max(0, (m.index ?? 0) - 12), m.index))) add(m);
    }
  const defAt = (at: number) =>
    defs
      .filter((d) => d.start <= at && at < d.end)
      .sort((x, y) => x.end - x.start - (y.end - y.start))[0] ?? null;
  // Its argparse options: the name the parsed arguments give each (`--api-base` is read as
  // `args.api_base`) and where its default is written.
  const options = [...text.matchAll(/\badd_argument\s*\(/g)].flatMap((m) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    const call = text.slice(open, closeOf(text, open));
    const d = /\bdefault\s*=\s*/.exec(call);
    const dest =
      call.match(/\bdest\s*=\s*["'](\w+)["']/)?.[1] ??
      call.match(/["']--([A-Za-z][\w-]*)["']/)?.[1] ??
      call.match(/^\(\s*["']([A-Za-z_][\w-]*)["']/)?.[1];
    if (!d || !dest) return [];
    const start = open + d.index + d[0].length;
    return [{ dest: dest.replace(/-/g, "_"), from: start, to: argEnd(text, start) }];
  });
  const assign = /^\s*(?:self\.)?([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)([^\n]*)/gm;
  const returns = [...text.matchAll(/^[ \t]*return\b([^\n]*)/gm)].map((m) => ({
    at: m.index ?? 0,
    expr: m[1] as string,
  }));
  type Def = (typeof defs)[number];
  const seen = new Map<string, boolean>();
  const follow = (name: string, fn: Def | null, depth = 0): boolean => {
    const key = `${name}@${fn?.start ?? -1}`;
    const known = seen.get(key);
    if (known !== undefined) return known;
    seen.set(key, false);
    const [from, to] = fn ? [fn.start, fn.end] : [0, text.length];
    const scope = text.slice(from, to);
    const held = new Set([name]);
    const heldRe = () => new RegExp(String.raw`\b(?:${[...held].join("|")})\b`);
    const handedBack = (re: RegExp) =>
      returns.filter((r) => r.at >= from && r.at < to && re.test(r.expr));
    for (let hop = 0; hop < 3 && scope.length < 500_000; hop++) {
      for (const m of scope.matchAll(assign))
        if (heldRe().test(m[2] as string)) held.add(m[1] as string);
      // `for endpoint in ENDPOINTS:`, `for i, url in enumerate(urls):`, `result.append(url)`.
      for (const m of scope.matchAll(/^\s*for\s+([\w\s,()]+?)\s+in\s+([^\n]*):/gm))
        if (heldRe().test(m[2] as string))
          for (const t of (m[1] as string).match(/\w+/g) ?? []) held.add(t);
      for (const m of scope.matchAll(/(?<![\w.])(\w+)\.(?:append|extend|add|insert)\(([^\n]*)\)/g))
        if (heldRe().test(m[2] as string)) held.add(m[1] as string);
      // At module level, a function that hands it back: `def base(): return BASE`.
      if (!fn)
        for (const r of handedBack(heldRe())) {
          const d = defAt(r.at);
          if (d) held.add(d.name);
        }
    }
    const re = heldRe();
    const found =
      calls.some(([a, b]) => a >= from && b <= to && re.test(text.slice(a, b))) ||
      // An option's default: where the parsed arguments are used, anywhere in the program.
      options.some(
        (o) =>
          o.from >= from &&
          o.from < to &&
          re.test(text.slice(o.from, o.to)) &&
          follow(o.dest, null, depth + 1),
      ) ||
      // Handed back from a function: where its callers use it.
      (!!fn && depth < 2 && handedBack(re).length > 0 && follow(fn.name, null, depth + 1));
    seen.set(key, found);
    return found;
  };
  return (at: number) => {
    if (calls.some(([a, b]) => a < at && at < b)) return true;
    // An option's default: where the parsed arguments use it.
    const option = options.find((o) => o.from <= at && at < o.to);
    if (option) return follow(option.dest, null);
    // The name it's assigned to: `query_url = 'http://ws.geonames.org/' + …`, `self.base = …`, a
    // constant's dict or list over several lines; or the function that returns it. An earlier
    // line counts only when a bracket it opens is still open at the address, not one opened and
    // closed before it (`url = …; requests.post(url)`, then `show("https://…")`).
    const stillOpen = (s: number) => {
      const eol = text.indexOf("\n", s);
      let depth = 0;
      let low = Number.POSITIVE_INFINITY;
      for (let i = s; i < at; i++) {
        const ch = text[i] as string;
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) depth--;
        if (i >= eol) low = Math.min(low, depth);
      }
      return low > 0 && low !== Number.POSITIVE_INFINITY;
    };
    let s = text.lastIndexOf("\n", at) + 1;
    for (let n = 0; n <= 40; n++) {
      const eol = text.indexOf("\n", s);
      const line = text.slice(s, eol < 0 ? undefined : eol);
      const m = line.match(/^\s*(?:self\.)?([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/);
      // `for base in ["https://…", "https://…"]:`, each tried in turn.
      const loop = line.match(/^\s*for\s+([\w\s,()]+?)\s+in\b/);
      const open = n > 0 && (m || loop || /^\s*return\b/.test(line)) && stillOpen(s);
      if (m && (n === 0 || open)) return follow(m[1] as string, defAt(at));
      if (loop && (n === 0 || open))
        return ((loop[1] as string).match(/\w+/g) ?? []).some((t) => follow(t, defAt(at)));
      if (/^\s*return\b/.test(line) && (n === 0 || open)) {
        const fn = defAt(at);
        return !!fn && follow(fn.name, null);
      }
      if (s === 0) break;
      s = text.lastIndexOf("\n", s - 2) + 1;
    }
    return false;
  };
}

/**
 * A server a Python program starts: http.server or socketserver, uvicorn, Flask's or aiohttp's
 * runner, websockets, an MCP server over HTTP (not over stdio).
 */
const PY_SERVER =
  /\b(?:Threading)?HTTPServer\s*\(|\bsocketserver\.\w*(?:TCP|HTTP)Server\s*\(|\buvicorn\.run\s*\(|\bweb\.run_app\s*\(|\bwebsockets\.serve\s*\(|\b(?:app|application|server)\.run\s*\([^)]*\b(?:host|port)\s*=|\.run\s*\([^)]*\btransport\s*=\s*["'](?:http|sse|streamable-http)["']/;
/** A route a Python web framework hands requests to: `@app.post("/x")`, `@router.get(…)`. */
const PY_ROUTE = /@[\w.]+\.(?:get|post|put|delete|patch|route|api_route|websocket)\s*\(/;
/** Names too common to follow through a Python program by name. */
const PY_COMMON = new Set(
  "get set pop append extend update items keys values join split strip format encode decode read write loads dumps load dump len str int float bool dict list tuple print isinstance open range sorted min max sum any all send_response send_header end_headers send_error log_message __init__ super run start stop close main".split(
    " ",
  ),
);
/** The request's Origin (or Sec-Fetch-Site) header read in Python. */
const PY_ORIGIN_READ = /headers(?:\.get\(\s*|\[\s*)["'](?:origin|sec-fetch-site)["']/i;
/** A test: an `if`, a comparison, `not`, `in`, or a value handed back from a check. */
const PY_TEST = /\bif\b|\breturn\b|==|!=|\bnot\b|\bin\b|\bassert\b/;
/** A random value a token can come from. */
const PY_RANDOM = /\bsecrets\.token_\w+\s*\(|\buuid\.uuid4\s*\(|\bos\.urandom\s*\(/;
/** An address taken from the request's body (a base URL, not a document's link). */
const PY_REQUEST_ADDRESS =
  /\b(?:payload|req|request|body|data|params|json_body|request_json|message|msg)\s*(?:\.get\(\s*|\[\s*)["'](?:base_?url|api_?base|api_?url|base|endpoint|host|server)["']/i;

/**
 * A server in a Python program it ships (paperviewzoteroplugin's local service): the functions
 * that take its requests (`do_POST`, a route) and those they call by name, what they check before
 * acting, and what they do. Read as text: it's a small program, not one of Zotero's scripts.
 */
function readPyServer(col: Collector, at: Hit): OwnServer {
  const text = at.file.text;
  const defs = pyDefs(text);
  type Def = (typeof defs)[number];
  // Handlers named by a framework's router rather than a decorator (aiohttp, websockets, Flask).
  const named = new Set(
    [
      ...text.matchAll(
        /\badd_(?:get|post|put|delete|patch|route|api_route)\s*\(\s*[^,()]+,\s*(\w+)|\bwebsockets\.serve\s*\(\s*(\w+)|\bview_func\s*=\s*(\w+)/g,
      ),
    ].map((m) => (m[1] ?? m[2] ?? m[3]) as string),
  );
  // The decorator lines right above a function.
  const decorators = (d: Def) => {
    const lines = text.slice(Math.max(0, d.start - 600), d.start).split("\n");
    lines.pop();
    const out: string[] = [];
    while (lines.length && /^[ \t]*@/.test(lines.at(-1) as string)) out.push(lines.pop() as string);
    return out;
  };
  const decorated = (d: Def) => decorators(d).some((x) => PY_ROUTE.test(x));
  const reach = new Map<Def, number>();
  let frontier = defs.filter(
    (d) => /^do_[A-Z]+$/.test(d.name) || named.has(d.name) || decorated(d),
  );
  for (const d of frontier) reach.set(d, 0);
  for (let depth = 1; depth <= 5 && frontier.length; depth++) {
    const next: Def[] = [];
    for (const d of frontier)
      for (const m of text.slice(d.start, d.end).matchAll(/(?<!\w)(\w+)\s*\(/g)) {
        const name = m[1] as string;
        if (PY_COMMON.has(name)) continue;
        const found = defs.filter((x) => x.name === name);
        if (found.length > 3) continue;
        for (const f of found)
          if (!reach.has(f) && reach.size < 200) {
            reach.set(f, depth);
            next.push(f);
          }
      }
    frontier = next;
  }
  // No handler we could name: the program itself stands in.
  const parts = reach.size
    ? [...reach].map(([d, depth]) => ({ from: d.start, to: d.end, depth }))
    : [{ from: 0, to: text.length, depth: 0 }];
  const all = parts.map((p) => text.slice(p.from, p.to)).join("\n");
  const checks = parts
    .filter((p) => p.depth <= 3)
    .map((p) => text.slice(p.from, p.to))
    .join("\n");
  const lines = checks.split("\n");
  // The Origin header tested, or held in a name that is (`origin = …get("Origin")`, then
  // `if origin not in ALLOWED`); echoing it back in a CORS header isn't a check.
  const origin = lines.some((l, i) => {
    if (!PY_ORIGIN_READ.test(l)) return false;
    if (PY_TEST.test(l.replace(PY_ORIGIN_READ, ""))) return true;
    const held = l.match(/^\s*(\w+)\s*=/)?.[1];
    return (
      !!held &&
      lines
        .slice(i + 1, i + 30)
        .some((x) => new RegExp(String.raw`\b${held}\b`).test(x) && /^\s*(?:if|elif)\b/.test(x))
    );
  });
  const secret =
    /\bcompare_digest\s*\(|\b\w*(?:token|secret|api_?key|password)\w*\s*[!=]=|[!=]=\s*(?:self\.|cls\.)?\w*(?:token|secret)\b/i.test(
      checks,
    ) &&
    (col.makesSecrets || PY_RANDOM.test(text));
  const needsHeader = lines.some(
    (l) =>
      /headers(?:\.get\(\s*|\[\s*)["'](?:x-[\w-]+|authorization)["']/i.test(l) &&
      /==|!=|\bnot\b|compare_digest/.test(l),
  );
  // Body models in FastAPI routes take JSON only; so does Flask's get_json() without force=True.
  const models = new Set(
    [...text.matchAll(/^class\s+(\w+)\s*\(\s*(?:pydantic\.)?BaseModel\s*\)/gm)].map(
      (m) => m[1] as string,
    ),
  );
  const writes = defs.filter((d) =>
    decorators(d).some((x) => /@[\w.]+\.(?:post|put|delete|patch)\s*\(/.test(x)),
  );
  const fastapiJson =
    /\bFastAPI\s*\(/.test(text) &&
    writes.length > 0 &&
    writes.every((d) => {
      const sig = text.slice(d.start, closeOf(text, text.indexOf("(", d.start)));
      return [...models].some((m) => new RegExp(String.raw`:\s*${m}\b`).test(sig));
    });
  // …or the Content-Type tested before a refusal (`if not ct.startswith("application/json")`).
  const typeChecked = lines.some(
    (l) => /content-type/i.test(l) && /application\/json/i.test(l) && /!=|\bnot\b/.test(l),
  );
  const flaskJson =
    /\brequest\.(?:get_json\s*\(\s*\)|json\b)/.test(all) &&
    !/\bget_json\s*\([^)]*force\s*=\s*True|\brequest\.(?:data|form|values|get_data)\b/.test(all);
  const cors =
    /Access-Control-Allow-Origin["']\s*[,:]\s*["']\*["']|\ballow_origins\s*=\s*\[\s*["']\*["']|\bCORS\s*\(\s*app\s*\)/i.test(
      text,
    );
  // Where it listens: on every interface when the address is 0.0.0.0, "::" or "", when aiohttp's
  // or websockets' runner gets none, or when a `--host` argument defaults to one of those.
  const open = text.indexOf("(", at.offset);
  const call = text.slice(at.offset, open >= 0 ? closeOf(text, open) + 1 : at.offset + 200);
  const hostDefault = text.match(
    /add_argument\(\s*["']--host["'][^)]*?\bdefault\s*=\s*["']([^"']*)["']/,
  )?.[1];
  const beyond =
    /["'](?:0\.0\.0\.0|::)["']|\(\s*\(\s*["']["']\s*,/.test(call) ||
    (/\b(?:web\.run_app|websockets\.serve)\b/.test(call) && !/\bhost\s*=|,\s*["']/.test(call)) ||
    (/\bargs\.host\b/.test(call) &&
      hostDefault !== undefined &&
      /^(0\.0\.0\.0|::|)$/.test(hostDefault));
  // What its handlers do: write Zotero's database or save through Zotero's connector, run code or
  // a shell command, or send a stored key to an address the request gives.
  const dbWrite =
    /zotero\.sqlite/.test(text) &&
    /\.execute(?:many)?\s*\(\s*f?["']{1,3}\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.exec(all);
  // Zotero's local API (`:23119/api/users/0/items`) answers reads: only a write method sent to it
  // (`requests.post(…)`) is a change, not a search or an export.
  const saves =
    /\/connector\/save\w+|\b(?:post|put|patch|delete)\s*\(\s*f?["'][^"'\n]*:23119\/api\//i.exec(
      all,
    );
  const write = dbWrite || saves;
  const edits = write ? { file: at.file, offset: text.indexOf(write[0]) } : null;
  return {
    hit: at,
    kind: "python",
    code: {
      edits,
      reads: false,
      byKey: false,
      unkeyed: true,
      needsHeader,
      secret,
      asks: false,
      origin,
      jsonOnly: refusesNonJson(checks) || typeChecked || fastapiJson || flaskJson,
      writeSetting: null,
      file: at.file,
      ranges: parts.map((p) => [p.from, p.to]),
      calls: [],
    },
    setting: null,
    cors,
    beyond,
    runsCode:
      /(?<![\w.])(?:exec|eval)\s*\(|\bsubprocess\.\w+\([^)]*\bshell\s*=\s*True|\bos\.(?:system|popen)\s*\(/.test(
        all,
      ),
    sendsKeys:
      PY_REQUEST_ADDRESS.test(all) &&
      /\bBearer\b|["']Authorization["']|["']x-api-key["']/i.test(all),
  };
}

/** Python code that runs pip or uv: `subprocess.run([py, "-m", "pip", "install", …])`. */
const PY_PACKAGE_RUN =
  /["']-m["']\s*,\s*["']pip["']\s*,\s*["']install["']|["']pip3?["']\s*,\s*["']install["']|["']uv["']\s*,\s*["'](?:pip["']\s*,\s*["']install|sync)["']/;
const SCRIPT_PACKAGE_RUN =
  /(?:^|[\s;&|(])(?:"?\$\{?\w*(?:uv|pip|npm|conda)\w*\}?"?|uvx?|pip3?|python3?\s+-m\s+pip|npm|pnpm|conda|mamba|micromamba)\s+(?:sync\b|pip\s+install\b|install\b|add\b|tool\s+(?:install|run)\b|create\b)|(?:^|[\s;&|(])(?:npx|uvx|pipx\s+run)\s+(?:-y\s+|--yes\s+)?[@\w]/im;
/** Agent tools whose job is running code the model writes. */
const SENT_CODE_TOOL =
  /["'`](zotero_script|run_javascript|execute_javascript|run_js|execute_js|eval_js|js_exec|run_code|execute_code|zotero_js|exec_js)["'`]/;
/** Agent tools that run a shell command the model writes. */
const SHELL_TOOL =
  /^(run_command|execute_command|run_shell|shell_exec|exec_command|run_terminal_command|shell_command|bash_command|sr\.shellRun)$/;
/** A model's tool calls read back (OpenAI, Anthropic, Gemini): the plugin runs an AI assistant. */
const AI_TOOL_LOOP = /\btool_calls\b|["'`]tool_use["'`]|\bfunctionCall\b|\bfunction_call\b/g;
/** Names a code-running call's argument goes by when it is code. */
const CODE_NAME = /^(code|script|source|js|jsCode|snippet|expression|body)$/i;
/**
 * Near an AI tool's definition: a confirmation it always asks for (`requiresConfirmation: true`,
 * `shouldRequireConfirmation() { return true; }`), one turned off or decided per call
 * (`if (input.mode === "read") return false`), or a setting named for running code
 * (`shell_enabled`, `eval.enabled`).
 */
const ALWAYS_TRUE = String.raw`\s*(?::\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?:!0|true)\b|\([^)]*\)\s*\{\s*return\s*(?:!0|true)\b)`;
const CONFIRMS = new RegExp(
  String.raw`(?:requiresConfirmation|needsApproval|requireApproval)\s*:\s*(?:!0|true)\b|Services\.prompt\.confirm|shouldRequireConfirmation${ALWAYS_TRUE}`,
);
const SKIPS_CONFIRM = new RegExp(
  String.raw`(?:requiresConfirmation|needsApproval|requireApproval)\s*:\s*(?:!1|false)\b|shouldRequireConfirmation(?!${ALWAYS_TRUE})`,
);
const CODE_SWITCH =
  /\b(?:shell|eval|javascript|js|script|code)[._-]?(?:enabled|allowed)\b|\b(?:enable|allow)(?:Shell|Eval|JavaScript|Js|Script|Code)\b|\b(?:enable|allow)_(?:shell|eval|javascript|js|script|code)\b/;
const APPROVAL_RANK = { "each-run": 0, "code-switch": 1, none: 2 } as const;

/** Whether what an AI tool runs is approved: each run, by a code-running setting, or not at all. */
function approvalNear(text: string, offsets: number[]): "each-run" | "code-switch" | "none" {
  const regions = offsets.map((o) => text.slice(o, o + 6000));
  if (regions.some((r) => CONFIRMS.test(r)) && !regions.some((r) => SKIPS_CONFIRM.test(r)))
    return "each-run";
  return regions.some((r) => CODE_SWITCH.test(r)) ? "code-switch" : "none";
}
/** Helpers that look a program up on the PATH or among candidates: `findExecutable`, `which`. */
const PATH_SEARCH =
  /^(?:which|where|(?:find|locate|resolve|search|lookup|detect)\w*(?:Executable|Exe|Program|Binary|Bin|Command|Cmd|Path|Python|Node|Tool))$/i;
/** A program's name or path, as a launch's command resolves to (not an address or a sentence). */
const LAUNCH_PATH = /^(?:(?:[A-Za-z]:\\|[/~])[^"'`<>|*?\n]{0,200}[\\/])?[\w.+-]{2,40}$/;
/** A string that names a program to run. */
const PROGRAM_NAME =
  /^(?:\/(?:usr\/)?(?:local\/)?s?bin\/[\w.+-]+|[A-Za-z]:\\.*\.exe|[\w.-]+\.exe|open|xdg-open|qlmanage|gio|rundll32|explorer|osascript|python3?|node|bash|sh|zsh|powershell|pwsh|cmd|java|npx|uvx?|pip3?|claude|codex|gemini|perl|ruby|swift)$/i;
/** The system's openers: they show a file or link in the user's own apps. */
const SYSTEM_OPENER =
  /^(?:\/usr\/bin\/(?:open|xdg-open|qlmanage|gio)|open|xdg-open|qlmanage|gio|rundll32(?:\.exe)?|explorer(?:\.exe)?|C:\\Windows\\(?:explorer|System32\\rundll32)\.exe)$/i;
const SHELL_COMMAND_START =
  /^\s*(?:(?:sudo|exec|set\s+-\w+;?)\s+)*(?:curl|wget|irm|iwr|iex|Invoke-\w+|powershell(?:\.exe)?|pwsh|bash|sh|zsh|cmd(?:\.exe)?|\/bin\/\w+|&)\b/i;
/** An RSA public key written into the code as a JWK (`{ kty: "RSA", n: "…", e: "AQAB" }`). */
const EMBEDDED_RSA_JWK =
  /["']?kty["']?\s*:\s*["']RSA["'][\s\S]{0,40}?["']?n["']?\s*:\s*["'][A-Za-z0-9_-]{200,}|["']?n["']?\s*:\s*["'][A-Za-z0-9_-]{300,}["'][\s\S]{0,300}?["']?kty["']?\s*:\s*["']RSA/;
/**
 * Preferences that guard Zotero itself: Gecko's blocks on remote code in privileged pages, eval
 * with the system principal, add-on signing and compatibility checks, remote debugging.
 */
const SECURITY_PREF =
  /^(security\.(disallow_privileged|disallow_privilegedabout|allow_parent_unrestricted_js_loads|allow_eval|allow_unsafe|fileuri\.strict_origin_policy)|xpinstall\.signatures\.required$|extensions\.checkCompatibility|devtools\.debugger\.(remote-enabled|prompt-connection)$|devtools\.chrome\.enabled$|dom\.security\.)/;

/**
 * Zotero's and Gecko's settings for the whole app, by their full name, and what changing one
 * does (C33). A name Zotero never reads (`extensions.zotero.API_URL`, a top-level
 * `findPDFs.resolvers`) changes nothing, so it isn't here.
 */
const APP_SETTINGS: [RegExp, SettingsChange][] = [
  [/^network\.proxy\.no_proxies_on$/, "proxy-exceptions"],
  [/^network\.proxy\./, "proxy"],
  [
    /^extensions\.zotero\.(sync\.(server|storage)\.|sync\.autoSync$|api\.url$|streaming\.(url|enabled)$)/,
    "sync",
  ],
  [/^extensions\.zotero\.httpServer\.enabled$/, "server"],
  [/^extensions\.zotero\.findPDFs\.resolvers$/, "find-pdf"],
  [/^app\.update\.(auto|enabled?)$/, "updates"],
  [/^network\.protocol-handler\.warn-external\./, "link-prompts"],
];
const appSetting = (key: string) => APP_SETTINGS.find(([re]) => re.test(key))?.[1] ?? null;

/** Whether a value written into the code is true or false (`!0`, `!![]`, `1`); null if computed. */
function truthy(n: AstNode | undefined): boolean | null {
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value !== "string" && !n.regex) return Boolean(n.value);
  if (n.type === "ArrayExpression" || n.type === "ObjectExpression") return true;
  if (n.type === "Identifier" && n.name === "undefined") return false;
  if (n.type === "UnaryExpression" && n.operator === "!") {
    const inner = truthy(node(n.argument));
    return inner === null ? null : !inner;
  }
  return null;
}

/**
 * The full name a preference write lands on. Zotero.Prefs.set puts `extensions.zotero.` in front
 * unless its third argument says the name is global; Gecko's setters take it as given. The plugin
 * template's setPref writes under the plugin's own branch, so it's never Zotero's.
 */
function prefWriteKey(c: string, name: string, args: AstNode[]): string | null {
  if (/(^|\.)set(Bool|Int|Char|String)Pref$/.test(c)) return name;
  if (!/(^|\.)[Pp]refs\.set$/.test(c)) return null;
  // A flag we can't read: a full name is taken as given.
  const global =
    args.length > 2
      ? (truthy(node(args[2])) ?? /^(extensions|network|app|browser)\./.test(name))
      : false;
  return global ? name : `extensions.zotero.${name}`;
}
/** Settings that are switches: turning one on (or off, for these) is the change. */
const SWITCHES: Partial<Record<SettingsChange, "on" | "off">> = {
  server: "on",
  updates: "off",
  "link-prompts": "off",
};

/**
 * Commands that change another program or the computer itself (C33), written where a launch takes
 * them or in a shell script the plugin runs. Instructions shown to the user don't count.
 */
const SETTINGS_COMMANDS: {
  re: RegExp;
  change: SettingsChange;
  target?: string;
  /** Only as an argument list: as one string it's nearly always a line for the user to paste. */
  argsOnly?: boolean;
}[] = [
  { re: /\badd-trusted-cert\b/, change: "certificate", target: "macOS" },
  {
    re: /\bcertutil(?:\.exe)?\s+(?:-\w+\s+)*-addstore\b|\bImport-Certificate\b[^\n]*\\Root\b/i,
    change: "certificate",
    target: "Windows",
  },
  { re: /\blaunchctl\s+(?:load|bootstrap)\b/, change: "autostart", target: "a macOS LaunchAgent" },
  {
    re: /\breg(?:\.exe)?\s+add\s+\S*\\CurrentVersion\\Run\b/i,
    change: "autostart",
    target: "a Windows Run key",
  },
  {
    re: /\bschtasks(?:\.exe)?\s+\/create\b/i,
    change: "autostart",
    target: "a Windows scheduled task",
  },
  {
    re: /\b(?:cp\s+-\w*R|ditto)\b[^\n]*\/Applications\b/,
    change: "program-install",
    target: "/Applications",
  },
  {
    re: /\b(?:npm|pnpm)\s+(?:i|install|add)\s+(?:\S+\s+)*?(?:-g|--global)\b|\byarn\s+global\s+add\b/,
    change: "global-install",
  },
  { re: /\bclaude\s+update\b/, change: "global-install", target: "@anthropic-ai/claude-code" },
  { re: /\b(?:npm|pnpm|yarn)\s+config\s+set\b/, change: "app-config", target: "npm" },
  { re: /\bconda\s+config\s+--(?:set|add|append)\b/, change: "app-config", target: "conda" },
  { re: /\bpip3?\s+config\s+set\b/, change: "app-config", target: "pip" },
  { re: /\bgit\s+config\s+--global\b/, change: "app-config", target: "Git" },
  {
    re: /SetEnvironmentVariable\(\s*['"]Path['"][^\n]*?['"]User['"]\s*\)|\bsetx\s+PATH\b/i,
    change: "shell",
    target: "Windows",
  },
  {
    re: />>\s*["']?(?:~|\$HOME|\$\{HOME\})[/\\]\.(?:zshrc|bashrc|bash_profile|zprofile|profile)\b/,
    change: "shell",
  },
  { re: /\b(?:claude|codex|gemini)\s+mcp\s+add\b/, change: "mcp-config", argsOnly: true },
  // Word's Normal template, changed through its COM object (a macro or a key binding in it).
  {
    re: /\bNormalTemplate\b[\s\S]*\b(?:VBProject|KeyBindings|CustomizationContext)\b/,
    change: "office-macros",
    target: "Word",
  },
];
/** The program a name holds the path of, for settings commands: `npmExecutablePath`, `condaBin`. */
const programNamed = (name: string) =>
  name
    .split(".")
    .at(-1)
    ?.match(/^(npm|pnpm|yarn|conda|pip3?|git|claude|codex|gemini)(?![a-z])/)?.[1] ?? null;
/** Names that hold a program to run: `cmd`, `cliPath`, `agyBin`, `hermesExecutable`. */
const PROGRAM_HOLDER =
  /^(?:command|cmd|executable|exe|program|binary|bin|cli)$|[a-z](?:Path|Bin|Exe|Executable|Command|Cmd)$/;
/** The name a value is bound to: a variable, an assignment's target or an object property. */
function holderName(a: AstNode | undefined): string | null {
  if (a?.type === "VariableDeclarator") return (node(a.id)?.name as string | undefined) ?? null;
  if (a?.type === "AssignmentExpression") return chain(node(a.left))?.split(".").at(-1) ?? null;
  return a?.type === "Property" ? nameOf(a) : null;
}
/** A word every settings command has, to skip the rest of the table for most strings. */
const SETTINGS_HINT =
  /trusted-cert|certutil|Import-Certificate|launchctl|CurrentVersion|schtasks|Applications|npm|yarn|claude|conda|pip|git|Path|setx|>>|mcp|NormalTemplate/i;
/** Packages a global install names: `npm install -g @openai/codex@latest` → `@openai/codex`. */
function globalPackages(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:npm|pnpm)\s+(?:i|install|add)\s+([^\n|&;]*)/g))
    for (const w of (m[1] ?? "").split(/\s+/))
      if (w && !w.startsWith("-") && /^(?:@[\w.-]+\/)?[\w.-]+/.test(w))
        out.push(w.replace(/(.)@.*$/, "$1"));
  return out;
}

/**
 * Another program's settings files, by the path segments written into the code (C33). Both parts
 * must be named in one function (or one constant); it counts when the code on the way to it
 * writes a file, so reading Claude Code's settings.json (zotero-research) doesn't.
 */
const SETTINGS_FILES: {
  dir?: RegExp;
  file: RegExp;
  change: SettingsChange;
  target?: string;
  /** In an AI tool's folder under the user's home, not a copy in the plugin's own workspace. */
  home?: boolean;
  /** The folder named in the function's code instead, held in a name (`jsaddonsDir`). */
  near?: RegExp;
}[] = [
  {
    dir: /(^|[/\\])\.claude([/\\]|$)/,
    file: /(^|[/\\])settings(\.local)?\.json$/,
    change: "app-config",
    target: "Claude Code",
    home: true,
  },
  { file: /(^|[/\\])\.claude\.json$/, change: "app-config", target: "Claude Code", home: true },
  { file: /(^|[/\\])claude_desktop_config\.json$/, change: "mcp-config", target: "Claude Desktop" },
  {
    dir: /(^|[/\\])\.codex([/\\]|$)/,
    file: /(^|[/\\])config\.toml$/,
    change: "app-config",
    target: "Codex CLI",
    home: true,
  },
  {
    dir: /(^|[/\\])\.cursor([/\\]|$)/,
    file: /(^|[/\\])mcp\.json$/,
    change: "mcp-config",
    target: "Cursor",
    home: true,
  },
  { file: /(^|[/\\])cc-switch\.db$/, change: "app-config", target: "CC Switch" },
  {
    file: /(^|[/\\])\.(claude|codex|cursor|gemini)[/\\]skills([/\\]|$)/,
    change: "skills",
    home: true,
  },
  {
    dir: /^Word$|[/\\]Word[/\\]/,
    file: /^STARTUP$|[/\\]Word[/\\]STARTUP([/\\]|$)/i,
    change: "office-macros",
    target: "Word",
  },
  {
    dir: /(^|[/\\])jsaddons([/\\]|$)/,
    file: /(^|[/\\])publish\.xml$/,
    change: "office-macros",
    target: "WPS Office",
    near: /\bjsaddons/i,
  },
  { file: /(^|[/\\])registrymodifications\.xcu$/, change: "app-config", target: "LibreOffice" },
  {
    file: /(^|[/\\])Library[/\\]LaunchAgents([/\\]|$)|^LaunchAgents$/,
    change: "autostart",
    target: "a macOS LaunchAgent",
  },
  {
    file: /Start Menu[/\\]Programs[/\\]Startup\b/i,
    change: "autostart",
    target: "the Windows Startup folder",
  },
  {
    file: /^\.(zshrc|bashrc|bash_profile|zprofile|profile)$|[/\\]\.(zshrc|bashrc|bash_profile|zprofile)$/,
    change: "shell",
  },
];
/** The AI tool a folder belongs to: `.claude/skills` → Claude Code. */
const AI_TOOL_DIRS: [RegExp, string][] = [
  [/\.claude\b/, "Claude Code"],
  [/\.codex\b/, "Codex CLI"],
  [/\.cursor\b/, "Cursor"],
  [/\.gemini\b/, "Gemini CLI"],
];
/** Code that writes or copies a file. */
const WRITES_FILE =
  /\bexecuteTransaction\b|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b|\bZotero\.File\.download\b|\bDownloads\.fetch\b|\bIOUtils\.(?:write\w*|copy|move)\b|\bputContents\w*\s*\(|\bOS\.File\.(?:writeAtomic|copy|move)\b|\.copyTo\w*\s*\(|\.writeString\s*\(|nsIFileOutputStream|\bwrite(?:Utf8|UTF8|Json|JSON|File|Text)\w*\s*\(|\bcopyFile\w*\s*\(|>>\s*["'$]|\bSet-Content\b|\bAdd-Content\b/;
/** The user's home folder, where other programs keep their settings. */
const HOME_DIR =
  /["'`]Home["'`]|home(?:Dir|Directory|Path|Folder)\w*|\bhomedir\b|\bHOME\b|\bUSERPROFILE\b|["'`]~[/\\]/i;
/** Claude Code settings that loosen its permission prompts. */
const AGENT_PERMISSIONS =
  /\bpermissions\b[\s\S]{0,300}\ballow\b|\bdefaultMode\b|\bbypassPermissions\b|\bskipDangerousModePermissionPrompt\b/;
/** MCP servers added in another program's settings. */
const MCP_SERVERS = /\bmcpServers\b|\bmcp_servers\b/;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** An item's own web address: `item.getField("url")`, an attachment's `url`. */
const ITEM_URL = /getField\(\s*["'`]url["'`]|\.(attachmentURL|getField\(["']url["']\))\b/;
export const ITEM_URL_KEY = "(the item's own URL)";

/** An address for a program file: an archive, installer or binary, or a release download. */
const PROGRAM_URL =
  /^https?:\/\/\S+(\.(zip|tar|gz|tgz|xz|7z|exe|msi|dmg|pkg|appimage|deb|rpm)(\?|$)|\/releases\/download\/)/i;

/**
 * Matched on code with comments blanked, and each written for how the tool's output uses it rather
 * than the bare name, so a comment or a README string can't trigger one.
 */
const SIGNATURES: [RegExp, SignalKind][] = [
  // javascript-obfuscator's self-defending check passes this regex source as a call argument:
  // `…['search']('(((.+)+)+)+$')`, with the method name itself often encoded.
  [/\(\s*(['"])\(\(\(\.\+\)\+\)\+\)\+\$\1\s*\)/, "obfuscator-signature"],
  // jsjiami and sojson stamp their version into a string the code keeps: `version_='jsjiami.com.v7'`.
  [/['"]jsjiami\.com\.v\d/i, "obfuscator-signature"],
  [/['"]sojson\.v\d/i, "obfuscator-signature"],
  [/['"]debu['"]\s*\+\s*['"]gger['"]/, "obfuscator-signature"],
  // The dispatcher itself, `while (!![]) { switch (order[i++]) {`: an original `while (true) {
  // switch (node.tag)` printed by the obfuscator (React, the buffer package) isn't one.
  [
    /while\s*\(\s*(?:!!\s*\[\s*\]|!0|true)\s*\)\s*\{\s*switch\s*\(\s*[\w$]+\s*\[\s*[\w$]+\s*\+\+\s*\]\s*\)/,
    "control-flow-flattening",
  ],
  // javascript-obfuscator's string-array decoder, `a = a - 0x1f0; const c = arr(); let d = c[a]`:
  // it survives mangled names, turned-off rotation and a bundler re-minifying the output (0 hits in
  // 1,362 unobfuscated plugins, all 13 obfuscated ones; obfuscation audit, 2026-09-26).
  [
    /\b([\w$]+)\s*=\s*\1\s*-\s*(?:-?\s*(?:0x[0-9a-fA-F]+|\d+)|\([^()]{0,80}\)|[\w$.]+)\s*;[^{}]{0,80}?\[\s*\1\s*\]/,
    "string-array-accessor",
  ],
  // Dean Edwards' packer, parameters renamed or not: base-36 tokens and fromCharCode(c + 29).
  [
    /eval\s*\(\s*function\s*\(\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*\)[\s\S]{0,400}?(?:0x23|35)[\s\S]{0,200}?(?:0x1d|29)[\s\S]{0,200}?(?:0x24|36)/,
    "packer",
  ],
  // javascript-obfuscator writes x['push'](x['shift']()); ordinary queue code uses dot access.
  [/\[['"]push['"]\]\(\s*[\w$]+\[['"]shift['"]\]\(\s*\)\s*\)/, "string-array-rotation"],
];

function textSignals(col: Collector, file: SourceFile, code: string, base: number) {
  const text = blankComments(code);
  for (const [re, kind] of SIGNATURES) {
    const m = re.exec(text);
    if (!m) continue;
    col.signals.push({ kind, file: file.path, hits: [{ file, offset: base + (m.index ?? 0) }] });
  }
}

/**
 * A pattern written for a whole callee name (`^Zotero\.File\.`, `\.nsIProcess$`) turned into one
 * that finds the name anywhere in a file: anchors become identifier boundaries.
 */
const unanchored = (re: RegExp) =>
  new RegExp(
    re.source.replace(/(?<!\\)\^/g, "(?<![\\w$.])").replace(/(?<!\\)\$(?=\||\)|$)/g, "(?![\\w$])"),
    "g",
  );
const FALLBACK_CHAINS = CAPABILITY_CHAINS.map(([re, id, label]) => [unanchored(re), id, label]) as [
  RegExp,
  CapabilityId,
  string,
][];
const FALLBACK_STRINGS = CAPABILITY_STRINGS.map(([re, id, label]) => [
  new RegExp(`["'\`]${re.source.replace(/^\^/, "").replace(/\$$/, "")}`, "g"),
  id,
  label,
]) as [RegExp, CapabilityId, string][];
const FALLBACK_SQL =
  /\b(Zotero\.)?DB\.(?:query|queryAsync|queryTx|queryTxAsync|valueQueryAsync|rowQueryAsync|columnQueryAsync)\s*\(\s*(["'`])((?:(?!\2)[^\\]|\\.)*)\2/g;

/**
 * Comments replaced by spaces, offsets unchanged. Knows strings, template text and regex literals,
 * so a `//` inside `'\x20//\x20…'` doesn't blank the rest of a one-line file (it erased 97% of
 * doc2x.js and hid its rotation signal).
 */
export function blankComments(code: string): string {
  const out = code.split("");
  let i = 0;
  let prev = ""; // last significant character outside strings and comments
  const n = code.length;
  while (i < n) {
    const c = code[i] as string;
    const d = code[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && code[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && d === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) if (code[i] !== "\n") out[i] = " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n && code[i] !== c) {
        if (code[i] === "\\") i++;
        else if (c !== "`" && code[i] === "\n") break;
        i++;
      }
      i++;
      prev = c;
      continue;
    }
    // A regex literal where an expression starts: after an operator, `(`, `,`, `=`, `:` or `return`.
    if (
      c === "/" &&
      (prev === "" ||
        /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) ||
        /\breturn\s*$/.test(code.slice(Math.max(0, i - 8), i)))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < n && code[j] !== "\n") {
        const ch = code[j];
        if (ch === "\\") j++;
        else if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      if (j < n && code[j] === "/") {
        i = j + 1;
        prev = "/";
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/**
 * The pass for code the parser can't read. Weaker than the AST walk, so a file that needs it
 * counts against coverage, but it looks for the same capabilities.
 */
function regexFallback(col: Collector, file: SourceFile, raw: string, base: number) {
  const code = blankComments(raw);
  for (const m of code.matchAll(URL_RE))
    col.url(m[0], { file, offset: base + (m.index ?? 0) }, "unknown");
  const kw: [RegExp, NetworkApi][] = [
    [/\bfetch\s*\(/g, "fetch"],
    [/\bXMLHttpRequest\b/g, "xhr"],
    [/\bZotero\.HTTP\.(request|doGet|doPost)\b/g, "zotero-http"],
    [/\bnew\s+WebSocket\b/g, "websocket"],
  ];
  for (const [re, api] of kw)
    for (const m of code.matchAll(re)) col.api(api, { file, offset: base + (m.index ?? 0) });
  for (const [re, id, label] of [...FALLBACK_CHAINS, ...FALLBACK_STRINGS])
    for (const m of code.matchAll(re)) col.cap(id, { file, offset: base + (m.index ?? 0) }, label);
  for (const m of code.matchAll(FALLBACK_SQL)) {
    const w = (m[3] ?? "").match(SQL_WRITE);
    if (!w?.[1] || !w[2]) continue;
    const hit = { file, offset: base + (m.index ?? 0) };
    const verb = w[1].split(/\s+/)[0]?.toUpperCase() ?? "";
    const table = w[2] === EXPR ? COMPUTED_TABLE : w[2];
    if (m[1]) {
      const cap = col.cap("db-write", hit, "Zotero.DB");
      cap.sql.add(verb);
      cap.tables.add(table);
    } else col.otherDbWrites.push({ hit, verb, table });
  }
  for (const m of code.matchAll(/\b(?:eval|Function)\s*\(\s*(?!["'`)])/g))
    col.cap("dynamic-code", { file, offset: base + (m.index ?? 0) }, "eval");
  const hex = code.match(/\b_0x[0-9a-f]{3,}\b/gi)?.length ?? 0;
  if (hex >= 50) {
    const at = code.search(/\b_0x[0-9a-f]{3,}\b/i);
    col.signals.push({
      kind: "hex-identifiers",
      file: file.path,
      hits: [{ file, offset: base + at }],
    });
  }
  textSignals(col, file, code, base);
}

// ----------------------------------------------------------------------------------------------
// Unicode

const BIDI_OPEN = new Set([0x202a, 0x202b, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068]);
const BIDI_CLOSE = new Set([0x202c, 0x2069]);

/** Whether an offset falls in one of the ranges, which must be sorted by start. */
function inRanges(sorted: [number, number][], offset: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = sorted[mid] as [number, number];
    if (offset < a) hi = mid - 1;
    else if (offset >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Invisible characters in string data: a pasted journal name can carry a few zero-width spaces,
 * but a payload hidden in a string takes a long run.
 */
const DATA_RUN = 32;

function scanUnicode(col: Collector, file: SourceFile, ranges: Ranges) {
  const text = file.text;
  const regexRanges = ranges.regex;
  const strings = [...ranges.strings].sort((a, b) => a[0] - b[0]);
  const runs: Record<string, { start: number; len: number; need: number }> = {};
  const bump = (kind: UnicodeKind, cp: number, offset: number) => {
    const u = col.unicode.get(kind) ?? { codepoints: new Set<string>(), hits: [], count: 0 };
    u.codepoints.add(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    u.count++;
    if (u.hits.length < EVIDENCE_CAP) u.hits.push({ file, offset });
    col.unicode.set(kind, u);
  };
  const inRegex = (offset: number) => regexRanges.some(([a, b]) => offset >= a && offset < b);
  // Trojan Source needs a direction override that is still open when the line ends; balanced
  // pairs (RTL text in a string) and lone closers are ordinary.
  let openOnLine: { cp: number; offset: number }[] = [];
  const endLine = () => {
    for (const o of openOnLine) bump("bidi-control", o.cp, o.offset);
    openOnLine = [];
  };
  let i = 0;
  let flagSequence = false; // 🏴 + tag characters spell subdivision flags (England, Scotland, Wales)
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 10) endLine();
    if (cp === 0x1f3f4 || (flagSequence && cp >= 0xe0020 && cp <= 0xe007f)) {
      flagSequence = true;
      i += ch.length;
      continue;
    }
    flagSequence = false;
    // Skip regex range endpoints ("\u2027-\u202a") and lookup tables; an attack is followed by code.
    if (
      BIDI_OPEN.has(cp) &&
      !inRegex(i) &&
      text[i - 1] !== "-" &&
      text[i + ch.length] !== "-" &&
      /[A-Za-z]/.test(text.slice(i + ch.length, i + ch.length + 8))
    )
      openOnLine.push({ cp, offset: i });
    else if (BIDI_CLOSE.has(cp)) openOnLine.pop();
    const kind: UnicodeKind | null =
      cp >= 0xe0000 && cp <= 0xe007f
        ? "tag-character"
        : cp === 0x200b || cp === 0x200c || cp === 0x2060 || (cp === 0xfeff && i > 0)
          ? "zero-width"
          : (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
            ? "variation-selector"
            : (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000
              ? "private-use"
              : null;
    // Emoji, icon fonts and word-break hints use these one at a time; hidden payloads need runs.
    if (kind === "variation-selector" || kind === "private-use" || kind === "zero-width") {
      const r = runs[kind] ?? { start: i, len: 0, need: 4 };
      if (r.len === 0) {
        r.start = i;
        r.need = kind === "zero-width" && inRanges(strings, i) ? DATA_RUN : 4;
      }
      r.len++;
      runs[kind] = r;
      if (r.len === r.need) for (let k = 0; k < r.need; k++) bump(kind, cp, r.start);
      else if (r.len > r.need) bump(kind, cp, i);
    } else {
      for (const k of Object.keys(runs)) (runs[k] as { len: number }).len = 0;
      if (kind) bump(kind, cp, i);
    }
    i += ch.length;
  }
  endLine();
}

// ----------------------------------------------------------------------------------------------
// Entry point

/** Names that identify the plugin's own servers: repo owner/name, add-on ID domain, homepage. */
export interface DeveloperHints {
  names: string[];
  domains: string[];
}

const GENERIC_LABELS = new Set([
  "api",
  "www",
  "app",
  "apps",
  "auth",
  "cdn",
  "static",
  "service",
  "services",
  "cloud",
  "server",
  "dev",
  "test",
  "prod",
  "zotero",
  "plugin",
  "plugins",
  "github",
  "gitee",
]);

export function isDeveloperHost(host: string, hints: DeveloperHints): boolean {
  const h = host.toLowerCase();
  if (hints.domains.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  // A host label must equal the whole owner or repo name (optionally without "zotero"/"plugin"):
  // "askyourpdf" matches AskYourPdf/zotero_plugin, but "translate" doesn't match zotero-pdf-translate.
  const tokens = new Set<string>();
  for (const name of hints.names) {
    const lower = name.toLowerCase();
    tokens.add(lower.replace(/[^a-z0-9]/g, ""));
    tokens.add(lower.replace(/zotero|plugin|addon/g, "").replace(/[^a-z0-9]/g, ""));
  }
  const labels = h
    .split(".")
    .slice(0, -1)
    .flatMap((l) => [l.replace(/-/g, ""), ...l.split("-")]);
  return labels.some((l) => l.length >= 5 && !GENERIC_LABELS.has(l) && tokens.has(l));
}

function registrableDomain(host: string): string | null {
  const parts = host.toLowerCase().split(".");
  if (parts.length < 2) return null;
  const twoLevel = /^(co|com|org|net|edu|gov|ac)$/.test(parts.at(-2) ?? "") && parts.length >= 3;
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

const SHARED_DOMAINS =
  /^(github\.com|github\.io|gitee\.com|example\.(com|org|net)|gmail\.com|qq\.com|163\.com|outlook\.com|zotero\.org)$/;

export function developerHints(
  repo: string,
  addonId: string | null,
  homepage: string | null,
): DeveloperHints {
  const [owner, name] = repo.split("/");
  const domains = new Set<string>();
  const idDomain = addonId?.includes("@") ? addonId.split("@")[1] : null;
  const reg = idDomain ? registrableDomain(idDomain) : null;
  if (reg && !SHARED_DOMAINS.test(reg)) domains.add(reg);
  try {
    const hh = homepage ? registrableDomain(new URL(homepage).hostname) : null;
    if (hh && !SHARED_DOMAINS.test(hh)) domains.add(hh);
  } catch {
    // not a URL
  }
  return { names: [owner ?? "", name ?? ""].filter(Boolean), domains: [...domains] };
}

/**
 * The manifest Zotero reads: manifest.json for Zotero 7 and later, install.rdf only when the file
 * has no Zotero manifest.json. Hybrid files carry both, and Zotero 7+ ignores install.rdf.
 */
/** The literal address an install call gets, decoding base64 passed through an atob alias. */
function installTarget(arg: AstNode | undefined): string | null {
  const a = node(arg);
  const lit =
    str(a) ??
    (a?.type === "CallExpression" && nodes(a.arguments).length === 1
      ? str(nodes(a.arguments)[0])
      : null);
  if (!lit) return null;
  if (/^https?:\/\//.test(lit)) return lit;
  if (lit.length >= 16 && BASE64.test(lit)) {
    const plain = Buffer.from(lit, "base64").toString("latin1");
    if (/^https?:\/\/[\x21-\x7e]+$/.test(plain)) return plain;
  }
  return null;
}

/**
 * The address an install call gets when the code writes it: a literal, base64 behind an atob
 * alias (hidden), or a fixed folder with a file name added (`folder + name`), through names bound
 * in the file.
 */
function installAddress(
  arg: AstNode | undefined,
  lookup: (name: string) => AstNode[],
  depth = 0,
): { url: string; hidden: boolean; folder: string | null } | null {
  const a = node(arg);
  if (!a || depth > 3) return null;
  const lit =
    str(a) ??
    (a.type === "CallExpression" && nodes(a.arguments).length === 1
      ? str(nodes(a.arguments)[0])
      : null);
  if (lit) {
    if (/^https?:\/\//.test(lit)) return { url: lit, hidden: false, folder: null };
    const url = installTarget(a);
    return url ? { url, hidden: true, folder: null } : null;
  }
  if (a.type === "Identifier") {
    for (const v of lookup(a.name as string).slice(0, 3)) {
      const r = installAddress(v, lookup, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const quasi = nodes(a.quasis)[0];
  const head =
    a.type === "BinaryExpression" && a.operator === "+"
      ? node(a.left)
      : a.type === "TemplateLiteral" && !(quasi?.value as { cooked?: string } | undefined)?.cooked
        ? nodes(a.expressions)[0]
        : undefined;
  const r = head ? installAddress(head, lookup, depth + 1) : null;
  if (!r || /\.xpi(\?|$)/i.test(r.url)) return null;
  return { ...r, folder: head?.type === "Identifier" ? (head.name as string) : r.folder };
}

/**
 * A click handler on a control whose name isn't about installing: `#api-store` installs Garden
 * when it isn't there, which the click on it doesn't ask for (zotero-gpt).
 */
function offTopicClick(code: string, anc: AstNode[], fn: AstNode): boolean {
  const parent = anc[anc.indexOf(fn) - 1];
  const callee = node(parent?.callee);
  if (
    parent?.type !== "CallExpression" ||
    callee?.type !== "MemberExpression" ||
    node(callee.property)?.name !== "addEventListener" ||
    !/^(click|command)$/.test(str(nodes(parent.arguments)[0]) ?? "")
  )
    return false;
  const target = node(callee.object);
  const names = target
    ? [...code.slice(target.start, target.end).matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1])
    : [];
  return (
    names.length > 0 &&
    !names.some((x) => /install|update|upgrade|download|add-?on|plugin|xpi/i.test(x ?? ""))
  );
}

/**
 * The object of helpers a method sits in, when a name holds it: `const zoteroRuntime = { download,
 * prepare(path) { … getInstallForFile … } }`. Code using that object calls the method (confucius).
 */
function holderOf(
  anc: AstNode[],
  fn: AstNode,
  base: number,
): { name: string; span: [number, number] } | null {
  const i = anc.indexOf(fn);
  const [decl, obj, prop] = [anc[i - 3], anc[i - 2], anc[i - 1]];
  const id = node(decl?.id);
  return prop?.type === "Property" &&
    obj?.type === "ObjectExpression" &&
    decl?.type === "VariableDeclarator" &&
    id?.type === "Identifier"
    ? { name: id.name as string, span: [base + obj.start, base + obj.end] }
    : null;
}

/** Owner and repository of a code-host address: `gitee.com/MuiseDestiny/plugins/raw/…`. */
function repoOf(url: string): string | null {
  const m = url.match(
    /^https?:\/\/(?:www\.)?(github\.com|gitee\.com|gitlab\.com|raw\.githubusercontent\.com)\/([^/]+)\/([^/?#]+)/i,
  );
  return m
    ? `${m[1] === "raw.githubusercontent.com" ? "github.com" : m[1]}/${m[2]}/${m[3]}`.toLowerCase()
    : null;
}

function isOwnXpi(url: string, manifest: XpiManifest): boolean {
  if (!/\.xpi(\?|$)/i.test(url)) return false;
  const repo = repoOf(url);
  if (repo && manifest.updateUrl && repo === repoOf(manifest.updateUrl)) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const file = (url.split(/[?#]/)[0]?.split("/").at(-1) ?? "")
    .replace(/\.xpi$/i, "")
    .replace(/[-_.]?v?\d+(\.\d+)*$/, "");
  return !!manifest.name && norm(file).length >= 4 && norm(file) === norm(manifest.name);
}

/** Words in an install's code saying where a file on this computer came from. */
const FROM_BACKUP = /\bbackup|\brestor(?:e|ing)\b/i;
const FROM_LIBRARY = /\bgetFilePath(?:Async)?\s*\(|\bisAttachment\s*\(|\battachmentFilename\b/;
const FROM_DROP = /dataTransfer|mozGetDataAt|application\/x-moz-file|mozFullPath/;
/** …or that it downloaded it first, to a temporary file (confucius). */
const DOWNLOADED =
  /\bdownload\w*\s*\(|HTTP\.request\s*\(|\bfetch\s*\(|createTempFile|["']TmpD["']/i;
/** A dialog before the install: `confirm(…)`, `Services.prompt.confirmEx(…)`, `confirmInstall(…)`. */
const ASKS_BEFORE_INSTALL = /\bconfirm\w*\s*\(/;
/** The downloaded file compared with a hash before it's installed. */
const HASH_CHECK =
  /computeHexDigest|nsICryptoHash|subtle\.digest|\.digest\s*\([^)]*\)[^;]{0,40}[!=]==|[!=]==[^;]{0,60}\.digest\b/;
/** A list of add-ons, a folder of them or an .xpi: `…/addon_infos.json`, `…/addons/`, `…/plugins/x`. */
const CATALOGUE_PATH =
  /addon_infos|\/(?:plugins?|addons?|extensions?)(?:\/|\.json\b|$)|\.xpi\b|\/xpi\//i;
/** Checks of an install address: plain http accepted (`/^https?:\/\//`), or https only. */
const HTTP_OK = /\^https\?:|protocol\s*===?\s*["']http:["']/g;
const HTTPS_ONLY = /\^https:\\\/\\\/|startsWith\(\s*["']https:\/\/["']\s*\)/g;
const ADDRESS_WORDS = /update_?link|updateLink|xpi|download_?url/i;
/** `const on = getPref("x"); if (on !== true) throw …`: the code after it waits for the setting. */
const HELD_PREF = new RegExp(
  String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*${PREF_READ}\s*;?\s*if\s*\(\s*(?:!\s*\1\b|\1\s*!==?\s*true\b)\s*\)\s*\{?\s*(?:return|throw)\b`,
  "g",
);

/** A setting the code before a call waits for: an early return, or one held in a name. */
function guardBefore(text: string): Setting | null {
  const held = [...text.matchAll(HELD_PREF)].at(-1);
  // `Zotero.Prefs.get(key, true)`: the second argument says the key is global, not a default.
  if (held)
    return {
      key: held[2] as string,
      fallback: /Zotero\.Prefs\.get/.test(held[0]) ? null : (held[3]?.trim() ?? null),
    };
  return prefReturn(text);
}

/** The setting's key when it's off by default. Unset counts as off: each guard here tests "on". */
function settingOffByDefault(col: Collector, s: Setting | null): string | null {
  if (!s) return null;
  const value =
    col.prefDefaults.get(s.key) ??
    [...col.prefDefaults].find(([k]) => k.endsWith(`.${s.key}`))?.[1] ??
    s.fallback;
  return value == null || /^(false|!1|!0x1|0|""|''|null|undefined|void 0)$/.test(value.trim())
    ? s.key
    : null;
}

/** Bootstrap's lifecycle hooks are called by Zotero, never by name from the plugin's code. */
const isHook = (d: { file: SourceFile }, name: string) =>
  /(^|\/)bootstrap\.js$/.test(d.file.path) && /^(install|uninstall|startup|shutdown)$/.test(name);

/**
 * The calls into a function: every one when the name is its alone; for a name several functions
 * share, only those in its own file, and none when that file has several.
 */
function callersOf(col: Collector, name: string, file: SourceFile): CallEdge[] {
  const defs = (col.fnSpans.get(name) ?? []).filter((d) => !isHook(d, name));
  const edges = col.callEdges.get(name) ?? [];
  if (defs.length <= 1) return edges;
  return defs.filter((d) => d.file === file).length === 1
    ? edges.filter((e) => e.file === file)
    : [];
}

/** Its own named function innermost around a file offset. */
function functionAt(
  col: Collector,
  file: SourceFile,
  offset: number,
): { name: string; span: [number, number] } | null {
  let best: { name: string; span: [number, number] } | null = null;
  for (const [name, defs] of col.fnSpans)
    for (const d of defs)
      if (
        d.file === file &&
        d.span[0] <= offset &&
        offset < d.span[1] &&
        (!best || d.span[1] - d.span[0] < best.span[1] - best.span[0])
      )
        best = { name, span: d.span };
  return best;
}

/** Where a call path starts from: an add-on install or a settings change in its own code. */
type PathSite = Pick<InstallSite, "hit" | "fn" | "span" | "holder">;

/**
 * Functions in its file that use the object an install's method sits in, as its callers; with
 * `byMethod`, only those naming the method on it (`ProxyManager.apply`, not `.getStatus`).
 */
function holderUsers(col: Collector, site: PathSite, byMethod = false): CallEdge[] {
  const holder = site.holder;
  if (!holder) return [];
  const file = site.hit.file;
  const out: CallEdge[] = [];
  const method =
    byMethod && site.fn ? String.raw`\s*\??\.\s*${site.fn.replaceAll("$", "\\$")}\b` : "";
  const re = new RegExp(
    // Not a property of something else (`x.name`), but spread is a use (`...name`).
    String.raw`(?<![\w$])(?<![^.]\.)${holder.name.replaceAll("$", "\\$")}(?![\w$])${method}`,
    "g",
  );
  for (const m of file.text.matchAll(re)) {
    if (out.length >= 5) break;
    if (m.index >= holder.span[0] - holder.name.length - 10 && m.index < holder.span[1]) continue;
    const fn = functionAt(col, file, m.index);
    if (fn && !out.some((e) => e.caller === fn.name))
      out.push({ caller: fn.name, file, span: fn.span, at: m.index, setting: null });
  }
  return out;
}

type StartPath = {
  /** Each function's name and code, and its code up to the call that leads to the install. */
  texts: { name: string | null; text: string; before: string }[];
  files: Set<SourceFile>;
  setting: Setting | null;
  root: "startup" | "timer" | "event" | "link" | "message" | "shutdown" | null;
};

/**
 * The ways an install (or a settings change) is reached, following calls back by name: from a
 * startup hook or a function handed to a timer (it runs by itself), from its own zotero://
 * handler, from an MCP tool's case, from a shutdown hook, or from nothing we can see calling it
 * (an event handler, so the user started it).
 */
function startPaths(col: Collector, site: PathSite, byMethod = false): StartPath[] {
  const out: StartPath[] = [];
  const visit = (
    fn: { name: string | null; file: SourceFile; span: [number, number]; at: number },
    trail: StartPath,
    names: string[],
    depth: number,
  ) => {
    if (out.length >= 12) return;
    const text = fn.file.text.slice(fn.span[0], fn.span[1]);
    const before = fn.file.text.slice(fn.span[0], fn.at);
    const path: StartPath = {
      texts: [...trail.texts, { name: fn.name, text, before }],
      files: new Set([...trail.files, fn.file]),
      setting: trail.setting ?? guardBefore(before),
      root: null,
    };
    const name = fn.name;
    const hook = name ? (col.hookNames.get(name) ?? name) : null;
    if (hook && STARTUP_HOOK.test(hook)) path.root = "startup";
    else if (hook && SHUTDOWN_HOOK.test(hook)) path.root = "shutdown";
    else if (name && col.timerFns.has(`${fn.file.path}\0${name}`)) path.root = "timer";
    else if (name && col.eventFns.has(`${fn.file.path}\0${name}`)) path.root = "event";
    else if (
      col.linkSpans.some(
        (s) => s.file === fn.file && s.span[0] <= fn.span[0] && fn.span[1] <= s.span[1],
      )
    )
      path.root = "link";
    const edges =
      !path.root && name && depth < 6
        ? callersOf(col, name, fn.file).filter((e) => !names.includes(e.caller))
        : [];
    if (!path.root && !edges.length && depth === 0 && site.holder)
      edges.push(...holderUsers(col, site, byMethod));
    if (!edges.length) {
      out.push(path);
      return;
    }
    for (const e of edges) {
      const next = { ...path, setting: path.setting ?? e.setting };
      if (e.tool) {
        // What an MCP tool's case does before the call: `if (evalEnabled !== true) throw …`.
        const guard = guardBefore(e.file.text.slice(e.tool.at, e.at));
        out.push({
          ...next,
          files: new Set([...next.files, e.file]),
          setting: next.setting ?? guard,
          root: "message",
        });
        continue;
      }
      visit(
        { name: e.caller, file: e.file, span: e.span, at: e.at },
        next,
        [...names, e.caller],
        depth + 1,
      );
    }
  };
  visit(
    { name: site.fn, file: site.hit.file, span: site.span, at: site.hit.offset },
    { texts: [], files: new Set(), setting: null, root: null },
    site.fn ? [site.fn] : [],
    0,
  );
  return out;
}

/** Hosts a catalogue of add-ons comes from, and third-party mirrors or proxies on the way. */
function catalogueSources(
  col: Collector,
  file: SourceFile,
  table: HostTable,
): { hosts: string[]; via: string[] } {
  const hosts = new Set<string>();
  const via = new Set<string>();
  const add = (url: string) => {
    const h = hostOf(url)?.host;
    const cls = h ? classifyHost(table, h) : null;
    if (!h || !cls || ["documentation", "localhost"].includes(cls.category)) return;
    // Only addresses the code uses, not links it shows.
    if (col.hosts.get(h)?.hits.every((x) => x.usage === "link")) return;
    (/mirror|proxy/i.test(cls.provider ?? "") ? via : hosts).add(h);
  };
  const text = file.text;
  for (const m of text.matchAll(/["'`](https?:\/\/[^"'`\s]{4,300})/g)) {
    const url = m[1] as string;
    if (file.libraryAt(m.index) !== null || !CATALOGUE_PATH.test(url.replace(/^\w+:\/\/[^/]+/, "")))
      continue;
    add(url);
    // A proxy in front of a GitHub address: `https://gh-proxy.org/https://raw.githubusercontent.com/…`.
    const behind = url.match(/^https?:\/\/[^/]+\/(https?:\/\/.+)/)?.[1];
    if (behind) add(behind);
  }
  // Built on a base address: `${this.baseUrl}/v1/plugins/…` (Garden's soil.magiczotero.top).
  for (const m of text.matchAll(/\$\{\s*(this\.)?([\w$]+)\s*\}([^`]{0,200})/g)) {
    if (file.libraryAt(m.index) !== null || !CATALOGUE_PATH.test(m[3] as string)) continue;
    const name = (m[2] as string).replaceAll("$", "\\$");
    const decl = m[1]
      ? String.raw`this\.${name}\s*=\s*`
      : String.raw`(?:const|let|var)\s+${name}\s*=\s*`;
    const base = text.match(new RegExp(String.raw`${decl}["'\x60](https?:\/\/[^"'\x60\s]+)`));
    if (base?.[1]) add(base[1]);
  }
  for (const h of githubProxies(file, table)) via.add(h);
  return { hosts: [...hosts].sort(), via: [...via].sort() };
}

/**
 * GitHub proxies the file puts in front of an address or swaps in for github.com: a bare base
 * (`"https://gh-proxy.org/"`) or host (`"$1kkgithub.com"`), not one compared with a hostname or
 * a full address for something else (Garden's styles through ghfast.top).
 */
function githubProxies(file: SourceFile, table: HostTable): string[] {
  const out: string[] = [];
  for (const [h, rule] of table.exact) {
    if (!/GitHub proxy/i.test(rule.provider ?? "") || !file.text.includes(h)) continue;
    const re = new RegExp(
      String.raw`(?<!===?\s*)["'\x60](?:\$\d)?(?:https?:\/\/)?${h.replaceAll(".", "\\.")}\/?["'\x60](?!\s*[!=]==?)`,
      "g",
    );
    if ([...file.text.matchAll(re)].some((m) => file.libraryAt(m.index) === null)) out.push(h);
  }
  return out.sort();
}

/** Whether the files check an install address for https: false when plain http is accepted. */
function httpsChecked(files: Iterable<SourceFile>): boolean | undefined {
  let https: boolean | undefined;
  for (const f of files) {
    const checked = httpsIn(f);
    if (checked === false) return false;
    https ??= checked;
  }
  return https;
}

const httpsSeen = new WeakMap<SourceFile, boolean | undefined>();
function httpsIn(f: SourceFile): boolean | undefined {
  if (httpsSeen.has(f)) return httpsSeen.get(f);
  let https: boolean | undefined;
  // Plain http accepted anywhere wins over an https-only check elsewhere.
  for (const [re, value] of [
    [HTTP_OK, false],
    [HTTPS_ONLY, true],
  ] as const) {
    for (const m of f.text.matchAll(re)) {
      const around = f.text.slice(Math.max(0, m.index - 300), m.index + 300);
      if (f.libraryAt(m.index) !== null || !ADDRESS_WORDS.test(around)) continue;
      https = value;
      break;
    }
    if (https !== undefined) break;
  }
  httpsSeen.set(f, https);
  return https;
}

/** Where an install's file comes from, what starts it, and what's checked, one route per path. */
function installRoutes(
  col: Collector,
  site: InstallSite,
  self: boolean,
  updateUrl: string | null,
  table: HostTable,
): InstallRoute[] {
  const hostsOf = (url: string | null) => {
    const h = url ? hostOf(url)?.host : undefined;
    return h ? [h] : [];
  };
  const context = site.hit.file.text.slice(...site.context);
  let catalogue: { hosts: string[]; via: string[] } | undefined;
  return startPaths(col, site).map((path) => {
    const own = `${path.texts[0]?.text ?? ""}\n${context}`;
    const all = path.texts.map((t) => t.text).join("\n");
    let from: InstallRoute["from"];
    if (site.hidden) from = "hidden";
    else if (path.root === "link" || path.root === "message") from = path.root;
    else if (site.fixed) from = site.page ? "page" : "fixed";
    else if (site.local) {
      // A file on this computer: a backup or the library it's restored from, one the user chose,
      // or one it downloaded first.
      const local = [own, all]
        .map((t) =>
          FROM_BACKUP.test(t)
            ? "backup"
            : FROM_LIBRARY.test(t)
              ? "library"
              : FROM_DROP.test(t)
                ? "file"
                : null,
        )
        .find(Boolean);
      from = local ?? (!DOWNLOADED.test(all) ? "file" : self ? "feed" : "catalogue");
    }
    // Addresses read from a backup in the library count as the backup (zotero-tara).
    else
      from =
        FROM_BACKUP.test(own) && FROM_LIBRARY.test(own) ? "backup" : self ? "feed" : "catalogue";
    const network = ["fixed", "hidden", "page", "catalogue", "feed"].includes(from);
    catalogue ??= from === "catalogue" ? catalogueSources(col, site.hit.file, table) : undefined;
    const sources =
      from === "catalogue" && catalogue
        ? catalogue
        : from === "feed"
          ? {
              hosts: hostsOf(updateUrl),
              via: [...path.files].flatMap((f) => githubProxies(f, table)),
            }
          : network
            ? { hosts: hostsOf(site.fixed), via: [] }
            : { hosts: [], via: [] };
    const auto = path.root === "startup" || path.root === "timer";
    const asks: InstallRoute["asks"] = path.texts.some((t) => ASKS_BEFORE_INSTALL.test(t.before))
      ? "confirm"
      : auto ||
          path.root === "link" ||
          path.root === "message" ||
          (site.offTopicClick && path.texts.length === 1)
        ? "none"
        : "click";
    const https = !network
      ? undefined
      : site.fixed
        ? site.fixed.startsWith("https:")
        : httpsChecked(path.files);
    const setting = settingOffByDefault(col, path.setting);
    return {
      from,
      ...(sources.hosts.length ? { hosts: sources.hosts } : {}),
      ...(sources.via.length ? { via: [...new Set(sources.via)].sort() } : {}),
      asks,
      ...(auto ? { auto } : {}),
      ...(network ? { hash: site.hash || HASH_CHECK.test(all) } : {}),
      ...(https !== undefined ? { https } : {}),
      ...(setting ? { setting } : {}),
    };
  });
}

/**
 * A setting an early return above the node waits for, in its own function: `if
 * (!getPref("trustLinks")) { …; return; }`, also as one part of an `||` (`!isMac || !getPref(x)`).
 */
function guardAbove(code: string, anc: AstNode[]): Setting | null {
  const off = new RegExp(String.raw`(?:^|\|\|)\s*!\s*${PREF_READ}\s*(?:\|\||$)`);
  const m = exitAbove(code, anc, off);
  return m ? { key: m[1] as string, fallback: m[2]?.trim() ?? null } : null;
}

/** An API checked for and used before (`if (typeof h.launchWithURI === "function") return …`). */
const API_PRESENT = /typeof\s+[\w$.?]+\s*===?\s*["']function["']/;

/**
 * The test of an `if` above the node, in its own function, that returns or throws when it
 * matches: the code below runs only when it doesn't.
 */
function exitAbove(code: string, anc: AstNode[], re: RegExp): RegExpMatchArray | null {
  const exits = (st: AstNode | undefined): boolean =>
    st?.type === "ReturnStatement" ||
    st?.type === "ThrowStatement" ||
    (st?.type === "BlockStatement" && exits(nodes(st.body).at(-1)));
  for (let i = anc.length - 2; i >= 0; i--) {
    const a = anc[i] as AstNode;
    if (FUNCTION_TYPES.has(a.type)) return null;
    if (a.type !== "BlockStatement") continue;
    for (const st of nodes(a.body)) {
      if (st === anc[i + 1]) break;
      const test = node(st.test);
      if (st.type !== "IfStatement" || !test || !exits(node(st.consequent))) continue;
      const m = code.slice(test.start, test.end).trim().match(re);
      if (m) return m;
    }
  }
  return null;
}

/** A function called where it's written, `(() => { … })()`: a bundle's wrapper around a module. */
const wrapperFn = (anc: AstNode[], fn: AstNode) => node(anc[anc.indexOf(fn) - 1]?.callee) === fn;

/** Code that writes a file, itself or in a function of its own it calls (`registerWPSAddin(…)`). */
function writesFile(col: Collector, text: string): boolean {
  if (WRITES_FILE.test(text)) return true;
  const called = new Set([...text.matchAll(/\b([A-Za-z_$][\w$]+)\s*\(/g)].map((m) => m[1]));
  let checked = 0;
  for (const name of called) {
    const defs = col.fnSpans.get(name as string) ?? [];
    if (defs.length !== 1 || checked++ > 200) continue;
    const d = defs[0] as { file: SourceFile; span: [number, number] };
    if (WRITES_FILE.test(d.file.text.slice(...d.span))) return true;
  }
  return false;
}

/** The arguments of the call whose `(` is at `open`, as text, split at top-level commas. */
function callArgTexts(text: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length && i < open + 4000; i++) {
    const ch = text[i] as string;
    if (ch === '"' || ch === "'" || ch === "`") {
      // Skip a string; a template's `${…}` is skipped with it, which is enough to split on.
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth === 0) {
      out.push(text.slice(start, i).trim());
      return out.filter(Boolean);
    } else if (ch === "," && depth === 1) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return out.filter(Boolean);
}

/** Where a writer puts its file: copies and downloads take it second, `copyTo` in either. */
function writeTargets(callee: string, args: string[]): string[] {
  if (/\.copyTo\w*$/.test(callee)) return args;
  if (
    /\b(?:IOUtils|OS\.File)\.(?:copy|move)$|\bcopyFile\w*$|\bZotero\.File\.download$|\bDownloads\.fetch$/.test(
      callee,
    )
  )
    return args.slice(1);
  return args.slice(0, 1);
}

/** A name assigned what a file holds, not where it is: `const text = await IOUtils.readUTF8(p)`. */
const READ_VALUE = /\bread\w*\s*\(|\bJSON\.parse\b|\bparse\w*\s*\(/i;

/**
 * Whether a function's code writes the file a path names (C33): a write, or a function of its own
 * that writes, whose target is that path: the same expression (`writeUTF8(join(home, ".zshrc"))`),
 * a name holding it (`const rc = …; putContents(rc, …)`, `f.append(".zshrc")`), or a path join
 * ending in it; a shell redirect or a PowerShell write to it; a database or stream opened on it
 * and written. Reading another program's settings while writing a log file doesn't change them.
 */
function writesPath(col: Collector, text: string, paths: string[]): boolean {
  // The file or folder's own name, from the longest fixed part of each path as written.
  const names = paths
    .map((p) => p.split(EXPR).sort((a, b) => b.length - a.length)[0] ?? "")
    .map((p) => p.split(/[/\\]/).filter(Boolean).at(-1) ?? "")
    .filter((p) => /\w/.test(p));
  if (!names.length) return false;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // In a path written as one string (no spaces): `"~/.zshrc"`, `` `${home}/.zshrc` ``.
  const literal = new RegExp(
    String.raw`["'\`][^"'\`\s]*(?:${names.map(esc).join("|")})(?=["'\`/\\])`,
  );
  const held = new Set<string>();
  const heldRe = () =>
    held.size ? new RegExp(String.raw`(?<![\w$.])(?:${[...held].map(esc).join("|")})\b`) : null;
  // The path itself, or one built on it (`join(dir, "SKILL.md")`, `` `${dir}/x.plist` ``), not a
  // message that mentions it (`log(\`read ${p}\`)`).
  const refers = (s: string) =>
    literal.test(s) || (!!heldRe()?.test(s) && !/["'`][^"'`\n]*\s[^"'`\n]*["'`]/.test(s));
  for (let hop = 0; hop < 3 && text.length < 200_000; hop++) {
    for (const m of text.matchAll(/([\w$.]+)\s*=(?![=>])([^;]*)/g))
      if (refers(m[2] as string) && !READ_VALUE.test(m[2] as string)) held.add(m[1] as string);
    // `dir.append(p)`, `folder.appendRelativePath("Microsoft\\Word\\Startup")`, `initWithPath`.
    for (const m of text.matchAll(/([\w$.]+)\.(?:append\w*|initWithPath)\s*\(([^)]*)\)/g))
      if (refers(m[2] as string)) held.add(m[1] as string);
    // `for (const p of parts)`: each part of a path held in a name.
    for (const m of text.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([\w$]+)\s+of\s+([^)]*)\)/g))
      if (refers(m[2] as string)) held.add(m[1] as string);
  }
  for (const m of text.matchAll(/([\w$.]+)\s*\(/g)) {
    const callee = m[1] as string;
    const writer = WRITES_FILE.test(`${callee}(`);
    if (!writer && !writerCall(col, callee)) continue;
    const args = callArgTexts(text, (m.index ?? 0) + m[0].length - 1);
    if ((writer ? writeTargets(callee, args) : args.slice(0, 1)).some(refers)) return true;
  }
  // `>> ~/.zshrc`, `>> "${rc}"`, `Add-Content -Path $profile`: the word after it.
  for (const m of text.matchAll(
    />>\s*|\b(?:Set|Add|Out)-(?:Content|File)\s+(?:-(?:Literal)?Path\s+)?/g,
  )) {
    const word = text.slice((m.index ?? 0) + m[0].length).match(/^[^\s;&|)]+/)?.[0] ?? "";
    if (names.some((x) => word.includes(x)) || heldRe()?.test(word)) return true;
  }
  // A database or file stream opened on it, then written (garden-for-zotero's cc-switch.db).
  if (
    /\bexecuteTransaction\b|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b|nsIFileOutputStream|\.writeString\s*\(/.test(
      text,
    )
  )
    for (const m of text.matchAll(/\b(?:open\w*|init|DBConnection)\s*\(/g))
      if (callArgTexts(text, (m.index ?? 0) + m[0].length - 1).some(refers)) return true;
  return false;
}

/** A call that writes a file: a writer by name, or a function of its own whose code writes. */
function writerCall(col: Collector, callee: string): boolean {
  if (WRITES_FILE.test(`${callee}(`)) return true;
  const defs = col.fnSpans.get(callee.split(".").at(-1) ?? "") ?? [];
  const d = defs.length === 1 ? defs[0] : undefined;
  return !!d && WRITES_FILE.test(d.file.text.slice(...d.span));
}

/**
 * Whether a way to another program's settings file writes it: the function naming the file writes
 * to it (itself or through a helper it calls: writesPath), or callers take what it gives back
 * (`const path = getConfigPath(…)`, handed up through `return …`) and pass that to a write.
 */
function writesTo(
  col: Collector,
  p: StartPath,
  holder: string | null,
  paths: string[] | undefined,
): boolean {
  const [first, ...up] = p.texts;
  if (first && (paths ? writesPath(col, first.text, paths) : writesFile(col, first.text)))
    return true;
  let from = first?.name ?? holder;
  for (const t of up) {
    if (!from) return false;
    const f = from.replaceAll("$", "\\$");
    // The names what it gives back is held in, a few assignments on (`n = Ir(t)`, `i = xr(n)`,
    // `o = i.path`), and a write handed one of them.
    const held = new Set([f]);
    for (let hop = 0; hop < 3 && t.text.length < 200_000; hop++) {
      const any = new RegExp(String.raw`\b(?:${[...held].join("|")})\b`);
      for (const m of t.text.matchAll(/([\w$]+)\s*=(?![=>])([^;]*)/g))
        if (any.test(m[2] as string)) held.add((m[1] as string).replaceAll("$", "\\$"));
    }
    const arg = new RegExp(
      String.raw`([\w$.]+)\s*\(\s*(?:await\s+)?(?:\.\.\.)?(?:${[...held].join("|")})\b`,
      "g",
    );
    for (const m of t.text.matchAll(arg)) if (writerCall(col, m[1] as string)) return true;
    // Handed on as its result: one more level up.
    if (!new RegExp(String.raw`\breturn\b[^;]*\b${f}\b`).test(t.text)) return false;
    from = t.name;
  }
  return false;
}

/** `if (!isMac || !getPref("x")) return`: the setting off, as one part of an `||`, stops it too. */
const PREF_RETURN_ANY = new RegExp(
  String.raw`if\s*\([^()]*\|\|\s*!\s*${PREF_READ}\s*\)\s*(?:\{\s*)?(?:return|throw)\b`,
  "gi",
);

/**
 * Settings that aren't its own it changes (C33), one entry for each way a change is reached: what
 * starts it (a startup hook or timer runs it by itself; nothing we can see calling it means a
 * click), a dialog on the way, and a setting that's off by default it waits for. Another
 * program's file counts only on a way that writes a file. A preference written back from a
 * shutdown hook is changed only while the plugin runs (pdferret's Find Available PDF sources).
 */
function settingsChanges(col: Collector): { entries: SettingsEntry[]; hits: Hit[] } {
  const paths = col.settingsSites.map((s) => startPaths(col, s, true));
  const launches = launchesOwn(col);
  const undone = new Set(
    col.settingsSites
      .filter((s, i) => s.key && paths[i]?.some((p) => p.root === "shutdown"))
      .map((s) => s.key),
  );
  const entries: SettingsEntry[] = [];
  const hits: Hit[] = [];
  col.settingsSites.forEach((site, i) => {
    if (site.ctx && resolveContext(col, site.ctx) === "shown") return;
    if (site.command && !launches) return;
    const before = entries.length;
    for (const p of paths[i] ?? []) {
      // Its own undo when Zotero closes isn't a change.
      if (p.root === "shutdown") continue;
      const all = p.texts.map((t) => t.text).join("\n");
      if (site.file && !writesTo(col, p, site.holder?.name ?? null, site.paths)) continue;
      // Claude Code's settings with its permission prompts loosened; MCP servers added.
      const change =
        site.file && site.target === "Claude Code" && AGENT_PERMISSIONS.test(all)
          ? "agent-permissions"
          : site.file && site.change === "app-config" && MCP_SERVERS.test(all)
            ? "mcp-config"
            : site.change;
      const auto = p.root === "startup" || p.root === "timer";
      const asks: SettingsEntry["asks"] = p.texts.some((t) => ASKS_BEFORE_INSTALL.test(t.before))
        ? "confirm"
        : auto || p.root === "link" || p.root === "message"
          ? "none"
          : "click";
      const guard =
        site.guard ??
        p.setting ??
        p.texts
          .map((t) => [...t.before.matchAll(PREF_RETURN_ANY)].at(-1))
          .filter((m) => m !== undefined)
          .map((m) => ({ key: m[1] as string, fallback: m[2]?.trim() ?? null }))[0] ??
        null;
      const setting = settingOffByDefault(col, guard);
      entries.push({
        change,
        ...(site.target ? { target: site.target } : {}),
        asks,
        ...(auto ? { auto } : {}),
        ...(setting ? { setting } : {}),
        ...(site.optIn ? { optIn: true } : {}),
        ...(site.whileInstalled || (site.key && undone.has(site.key))
          ? { whileInstalled: true }
          : {}),
      });
    }
    if (entries.length > before) hits.push(site.hit);
  });
  for (const d of col.settingsDefaults) {
    entries.push({ change: d.change, asks: "none", asDefault: true });
    hits.push(d.hit);
  }
  // Servers kept off its proxy say nothing more once it sets the proxy itself.
  const proxy = entries.some((e) => e.change === "proxy");
  const seen = new Set<string>();
  return {
    entries: entries
      .filter((e) => !(proxy && e.change === "proxy-exceptions"))
      .filter((e) => {
        const key = JSON.stringify(e);
        return !seen.has(key) && seen.add(key);
      })
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y), "en"))
      .slice(0, 30),
    hits,
  };
}

export function pickManifest(manifests: XpiManifest[]): XpiManifest | undefined {
  const zotero = manifests.filter((m) => m.target === "zotero");
  return (
    zotero.find((m) => m.format === "manifest.json") ??
    zotero[0] ??
    manifests.find((m) => m.format === "manifest.json") ??
    manifests[0]
  );
}

export interface AnalyzeInput {
  slug: string;
  sha256: string;
  entries: XpiEntry[];
  table: HostTable;
  analyzedAt?: string;
  developer?: DeveloperHints;
}

export interface FileMetrics {
  file: string;
  vendored: boolean;
  identifiers: number;
  hexIdentifiers: number;
  rawStringChars: number;
  escapeChars: number;
}

export interface AnalyzeResult {
  analysis: AnalysisDoc;
  manifests: XpiManifest[];
  updateHost: { host: string; category: string } | null;
  metrics: FileMetrics[];
}

export function analyzeXpi(input: AnalyzeInput): AnalyzeResult {
  const col = new Collector(input.table, input.developer ?? { names: [], domains: [] });
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const manifests: XpiManifest[] = [];
  const manifestFiles: SourceFile[] = [];
  const files = input.entries
    .filter((e) => !e.path.endsWith("/"))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));

  // Files that look encrypted or packed (a JSON envelope around AES ciphertext, or random bytes),
  // so the code that names and decrypts one can be recognised.
  for (const e of files) {
    const base = e.path.split("/").at(-1) as string;
    if (!CODE_EXT.test(e.path) && !HTML_EXT.test(e.path) && isOpaque(e.path, e.data))
      col.opaque.set(base, e.path);
    if (isExecutable(e.data) && base.length >= 4) col.binaries.set(base, e.path);
    // Shell scripts it ships: the settings changes each makes, for code that runs one by name.
    // Comments and echoed instructions don't count.
    if (SHELL_SCRIPT.test(e.path) && e.data.length < 1024 * 1024) {
      const raw = decoder
        .decode(e.data)
        .replace(/^\s*(?:#|REM\b|::).*$|^\s*(?:echo|Write-Host|printf)\b(?!.*>>).*$/gim, "");
      // Its variables filled in: `APP_INSTALL="/Applications"; cp -R ZotLight.app "$APP_INSTALL/"`.
      const vars = new Map(
        [...raw.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=["']?([^"'\n$]*)["']?\s*$/gm)].map(
          (m) => [m[1] as string, m[2] as string],
        ),
      );
      const text = raw.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (x, name: string) => vars.get(name) ?? x);
      const changes = col.scripts.get(base) ?? [];
      for (const s of SETTINGS_COMMANDS)
        if (s.re.test(text))
          changes.push(
            ...(s.change === "global-install" && !s.target
              ? globalPackages(text).map((target) => ({ change: s.change, target }))
              : [{ change: s.change, ...(s.target ? { target: s.target } : {}) }]),
          );
      col.scripts.set(base, changes);
    }
  }

  for (const entry of files) {
    const path = entry.path;
    if (path === "manifest.json" || path === "install.rdf") {
      const text = decoder.decode(entry.data);
      try {
        manifests.push(path === "manifest.json" ? parseManifestJson(text) : parseInstallRdf(text));
        manifestFiles.push(new SourceFile(path, text));
      } catch {
        // an unreadable manifest is reported through the missing version below
      }
    }
    if (path.endsWith(".map")) col.sourceMaps.add(path);
    // A browser extension it ships: the sites it may reach get what the plugin hands it
    // (zotero-prism's extension relays questions to web chats).
    if (/.\/manifest\.json$/.test(path) && entry.data.length < 1e6)
      noteExtension(col, path, entry.data);
    // What its package installs can be pinned by: requirements files and lockfiles it ships.
    if (
      /(^|\/)[\w.-]*(requirements|constraints)[\w.-]*\.txt$/i.test(path) &&
      entry.data.length < 1e6
    ) {
      const text = decoder.decode(entry.data);
      col.reqFiles.set(path, text);
      // …and packages among them that hand data on to an online service (notebooklm-py).
      for (const h of HANDOFFS) {
        const m = h.pkg?.exec(text);
        if (m) col.handoff(h, { file: new SourceFile(path, text), offset: m.index }, "launch");
      }
    }
    if (/(^|\/)(uv\.lock|poetry\.lock|package-lock\.json|pnpm-lock\.yaml|bun\.lockb?)$/.test(path))
      col.lockFile = true;
    if (/(^|\/)pyproject\.toml$/.test(path) && entry.data.length < 1e6)
      col.pyprojects.set(path, decoder.decode(entry.data));
    if (/(^|\/)(prefs\.js|defaults\/preferences\/[^/]+\.js)$/.test(path)) {
      readPrefs(col, new SourceFile(path, decoder.decode(entry.data)));
    }
    const isCode = CODE_EXT.test(path);
    const isHtml = HTML_EXT.test(path);
    if (APPLE_DOUBLE.test(path)) {
      col.skipped.push({ path, reason: "not-code" });
      continue;
    }
    if (!isCode && !isHtml) {
      col.skipped.push({ path, reason: BINARY_EXT.test(path) ? "binary" : "not-code" });
      // An install script the plugin ships and runs: it downloads a program and runs it.
      if (SHELL_SCRIPT.test(path) && entry.data.length < 1024 * 1024) {
        const text = decoder.decode(entry.data);
        const m =
          DOWNLOAD_RUN.exec(text) ??
          DOWNLOAD_TO_FILE_RUN.exec(text) ??
          DOWNLOAD_THEN_RUN.exec(text);
        // Pinned like the JavaScript check below: a SHA-256 written into the script and a hash
        // comparison (codex-bilingual-reader's installer checks the engine and Node.js this way).
        const pinned =
          !DOWNLOAD_RUN.test(text) &&
          /["'][0-9a-f]{64}["']/i.test(text) &&
          /\b(Get-FileHash|sha256sum|shasum\s+-a\s+256|openssl\s+(?:dgst|sha256)|certutil\s+-hashfile)\b/i.test(
            text,
          );
        if (m)
          col.shellDownloads.push({ file: new SourceFile(path, text), offset: m.index, pinned });
        // Packages it installs from npm or PyPI: `"$uv_path" sync --frozen` (jadense-in-zotero),
        // `& $uvPath pip install …` (iris-zotero). Comments and echoed instructions don't count.
        const code = text.replace(/^\s*(?:#|REM\b|::|echo\b|Write-Host\b|printf\b).*$/gim, "");
        const sf = new SourceFile(path, code);
        for (const p of code.matchAll(new RegExp(SCRIPT_PACKAGE_RUN.source, "gim"))) {
          const end = code.indexOf("\n", p.index + 1);
          const line = code.slice(p.index, end < 0 ? undefined : end);
          col.packageRuns.push({ file: sf, offset: p.index, words: commandWords(line) });
        }
      }
      // A Python (or shell) program it ships and runs, which makes requests itself: papermachines'
      // processors call DBpedia Spotlight, zotero-pdf2md's script uploads PDFs to Mistral.
      if (/\.(py|sh|ps1|rb|pl)$/i.test(path) && entry.data.length < 2 * 1024 * 1024) {
        const text = decoder.decode(entry.data);
        if (
          /\b(requests\.|urllib|httpx|aiohttp|http\.client|urlopen|curl\b|wget\b|Invoke-WebRequest|Invoke-RestMethod|openai|anthropic)/.test(
            text,
          )
        ) {
          const sf = new SourceFile(path, text);
          // In Python, only an address that reaches a request call is one it sends to; the rest
          // are names, as in JavaScript (papermachines' Linked Data identifiers).
          const py = /\.py$/i.test(path) ? pyRequestUrls(text) : null;
          for (const u of text.matchAll(URL_RE)) {
            // A URL used as a key, not an address: `claims["https://api.openai.com/auth"]`,
            // `.get("https://…")`, `{"https://…": …}`; the first or last entry of a list
            // (`["https://…", …]`, `[…, "https://…"]`) is still an address.
            const at = u.index ?? 0;
            const before = text.slice(Math.max(0, at - 8), at);
            const after = text.slice(at + u[0].length, at + u[0].length + 3);
            if (/(?:[\w\])]\[|\.get\()\s*["']$/.test(before) || /^["']\s*:/.test(after)) continue;
            const line = text.slice(text.lastIndexOf("\n", at) + 1, at);
            // A comment isn't code.
            if (py && /^[^'"]*#/.test(line)) continue;
            const compare =
              /\b(startswith|endswith|removeprefix|removesuffix)\(|[!=]=\s*["'][^"']*$/.test(line);
            col.scriptUrls.push({
              url: u[0],
              hit: { file: sf, offset: at },
              ...(compare ? { compare } : {}),
              ...(py && !py(at) ? { named: true } : {}),
            });
          }
        }
        if (/\.py$/i.test(path) && PY_PACKAGE_RUN.test(text)) {
          const sf = new SourceFile(path, text);
          for (const m of text.matchAll(new RegExp(PY_PACKAGE_RUN.source, "g")))
            col.packageRuns.push({ file: sf, offset: m.index, words: pyListWords(text, m.index) });
        }
        // A Python program it runs that hands data on to an online service (pdf2zh_next, edge_tts).
        if (/\.py$/i.test(path))
          for (const h of HANDOFFS) {
            const m = h.py?.exec(text);
            if (m) col.handoff(h, { file: new SourceFile(path, text), offset: m.index }, "launch");
          }
        // A Python program it runs that starts a server of its own (read once we know it runs
        // programs: readPyServer).
        const server = /\.py$/i.test(path) ? PY_SERVER.exec(text) : null;
        if (server && col.pyServers.length < 5)
          col.pyServers.push({ file: new SourceFile(path, text), offset: server.index });
        // A Python program it runs that opens Zotero's database itself (kanzi's importer).
        if (/\.py$/i.test(path)) {
          if (/zotero\.sqlite/.test(text)) col.pyNamesZoteroDb = true;
          const db = /\bsqlite3\.connect\s*\(/.exec(text);
          if (db) col.pySqlite.push({ file: new SourceFile(path, text), offset: db.index });
        }
      }
      continue;
    }
    if (
      entry.data.length > MAX_CODE_BYTES ||
      col.codeBytes + entry.data.length > MAX_TOTAL_CODE_BYTES
    ) {
      col.skipped.push({ path, reason: "too-large" });
      continue;
    }
    const file = new SourceFile(path, decoder.decode(entry.data));
    col.analyzed++;
    if (/\bCompactEncrypt\b|["']RSA-OAEP/.test(file.text) && EMBEDDED_RSA_JWK.test(file.text))
      col.jweFiles.add(path);
    col.codeBytes += entry.data.length;
    if (file.vendoredFile && file.vendoredBy)
      addVendored(col, file.vendoredFile, path, file.vendoredBy);
    for (const r of file.regions) addVendored(col, r.library, path, "package-json");
    if (/sourceMappingURL=/.test(file.text.slice(-500))) col.sourceMaps.add(path);
    if (isCode) {
      if (!file.vendoredFile && file.minified) col.minified.add(path);
      if (OWN_DB_CONNECTION.test(file.text)) col.ownDbConnection = true;
      const ranges: Ranges = { regex: [], strings: [] };
      analyzeJs(col, file, blankTranslatorHeader(file.text), 0, ranges);
      scanUnicode(col, file, ranges);
      if (!col.aiLoop && !file.vendoredFile)
        for (const m of file.text.matchAll(AI_TOOL_LOOP))
          if (file.libraryAt(m.index) === null) {
            col.aiLoop = true;
            break;
          }
    } else {
      const htmlRanges: Ranges = { regex: [], strings: [] };
      // Web scripts loaded into one of the plugin's pages (review P11); commented-out tags don't
      // count.
      const markup = file.text.replace(/<!--[\s\S]*?-->/g, (x) => x.replace(/[^\n]/g, " "));
      if (!file.vendoredFile) {
        for (const m of markup.matchAll(REMOTE_SCRIPT_TAG)) {
          const url = m[1] as string;
          const at = { file, offset: (m.index ?? 0) + m[0].indexOf(url) };
          col.url(url, at, "unknown");
          col.cap("remote-script", at, hostOf(url)?.host ?? "web");
        }
      }
      for (const m of file.text.matchAll(/<((?:html:)?script)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
        const attrs = m[2] ?? "";
        if (
          /\bsrc\s*=/.test(attrs) ||
          /type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/i.test(attrs)
        )
          continue;
        // XUL wraps inline scripts in CDATA; blank the markers so offsets stay put.
        const code = (m[3] ?? "").replace(/<!\[CDATA\[|\]\]>/g, (x) => " ".repeat(x.length));
        const base = (m.index ?? 0) + m[0].indexOf(">") + 1;
        if (code.trim()) analyzeJs(col, file, code, base, htmlRanges);
      }
      // Settings fields bound to a preference: `<html:input preference="extensions.x.apiBaseUrl">`.
      for (const m of file.text.matchAll(/\bpreference\s*=\s*["']([^"']+)["']/g)) {
        const key = m[1] ?? "";
        if (!isEndpointKey(key)) continue;
        const e = col.endpoints.get(key) ?? { hits: [] };
        e.hits.push({ file, offset: m.index ?? 0 });
        col.endpoints.set(key, e);
      }
      // A settings field for an address: `type="url"`, or an example address as its placeholder.
      for (const m of file.text.matchAll(/<(?:html:)?input\b[^>]*>/gi)) {
        const tag = m[0];
        if (!/\btype\s*=\s*["']url["']|\bplaceholder\s*=\s*["'][^"']*https?:\/\//i.test(tag))
          continue;
        const key =
          tag.match(/\b(?:preference|id|name)\s*=\s*["']([^"']+)["']/i)?.[1] ?? "address field";
        const e = col.endpoints.get(key) ?? { hits: [] };
        e.hits.push({ file, offset: m.index ?? 0 });
        col.endpoints.set(key, e);
      }
      for (const m of markup.matchAll(URL_RE)) {
        // URLs in markup outside scripts and comments: usually links or resource references
        const before = file.text.slice(Math.max(0, (m.index ?? 0) - 14), m.index ?? 0);
        // Example text in a settings field, not an address the plugin uses.
        if (
          /placeholder\s*=\s*["'][^"']*$/i.test(
            file.text.slice(Math.max(0, (m.index ?? 0) - 200), m.index ?? 0),
          )
        )
          continue;
        // An inline handler that opens it: `onclick="Zotero.launchURL('https://…')"`.
        const tagText = file.text.slice(Math.max(0, (m.index ?? 0) - 300), m.index ?? 0);
        const opened =
          /\bon\w+\s*=\s*"[^"]*$|\bon\w+\s*=\s*'[^']*$/.test(tagText) &&
          /(launchURL|openURL|openInViewer|window\.open|openLinkIn|openTrustedLinkIn|openWebLinkIn)\s*\(\s*(\\?['"]|&quot;|&apos;)?$/.test(
            tagText,
          );
        col.url(
          m[0],
          { file, offset: m.index ?? 0 },
          /href\s*=\s*["']?$/i.test(before) || opened ? "link" : "unknown",
        );
      }
      scanUnicode(col, file, htmlRanges);
    }
  }

  // zotero-plugin-toolkit's zotero:// bridges count when the build sets the toolkit up, and when
  // we can't tell: its setup unread, or the bridge inside obfuscated code.
  const tk = col.toolkit;
  const unsure =
    (!tk.eager && !tk.lazy) ||
    tk.bridges.some((b) =>
      col.signals.some((s) => s.file === b.hit.file.path && STRONG.includes(s.kind)),
    );
  if (tk.bridges.length && (unsure || tk.registers()))
    for (const b of tk.bridges) {
      // A development build's `disableDebugBridgePassword = true` stops the shared debug bridge
      // asking, for every toolkit plugin in that Zotero (zotero-split-viewer).
      const off = b.asks && b.id === "link-runs-code" ? tk.promptOff : null;
      const cap = col.cap(
        b.id,
        b.hit,
        off ? `${b.name} (prompt turned off)` : b.asks ? `${b.name} (asks first)` : b.name,
      );
      if (off) cap.hits.push(off);
      if (b.asks && !off) cap.asksFirst = true;
      else cap.unguarded = true;
    }

  // Downloads a file, makes it executable and launches programs, all in its own code.
  const launches = col.caps
    .get("process-launch")
    ?.hits.some((h) => h.file.libraryAt(h.offset) === null);
  if (col.shellFlag)
    for (const c of col.commandLines) {
      if (resolveContext(col, c.ctx) === "shown") continue;
      if (c.kind === "download") col.shellDownloads.push({ ...c.hit, pinned: false });
      else col.packageRuns.push(c.hit);
    }
  // A byte download near a program's address in the same file (copyfiles.exe on a release page,
  // a few lines above the fetch); a PDF download elsewhere in a big bundle doesn't count.
  if (!col.downloads.length)
    col.downloads.push(
      ...col.byteSaves.filter(
        (h) =>
          h.file.libraryAt(h.offset) === null &&
          col.programUrls.some((u) => u.file === h.file && Math.abs(u.offset - h.offset) < 4000),
      ),
    );
  const scriptDownload = col.downloads.some((h) =>
    /\.(sh|ps1|bat|cmd|py)\b/i.test(h.file.text.slice(h.offset, h.offset + 400)),
  );
  if (
    col.downloads.length &&
    (col.makesExecutable || col.extractsArchive || scriptDownload) &&
    launches
  ) {
    // Pinned: the code hashes the download and compares it with a SHA-256 written into it, so only
    // that exact file can run (a hash fetched from the same server proves nothing).
    const near = (h: Hit) => h.file.text.slice(Math.max(0, h.offset - 4000), h.offset + 4000);
    const hashes = (h: Hit) => /sha-?256|subtle\.digest|createHash|\.sha256\b/i.test(near(h));
    const pinned = col.downloads.every((h) => hashes(h) && /["'`][0-9a-f]{64}["'`]/i.test(near(h)));
    // A checksum fetched from the same place catches a broken download, not a replaced one.
    const sameSource = !pinned && col.downloads.every(hashes);
    for (const h of col.downloads)
      col.cap(
        "download-exec",
        h,
        pinned
          ? "pinned to a SHA-256"
          : sameSource
            ? "checksum from the same source"
            : "download, unpack or chmod, run",
      );
  }
  // Code shipped encrypted, decrypted and run: nobody can review it, and the key may come from a
  // server at run time (zotero-gpt's and zotero-reference's pro-entry.enc).
  if (col.opaqueNamed.size && col.decrypts.length && col.buildsCode) {
    const cap = col.cap(
      "encrypted-code",
      col.decrypts[0] as Hit,
      [...col.opaqueNamed][0] as string,
    );
    for (const h of col.decrypts.slice(1, 3)) cap.hits.push(h);
  }
  // Translators: fetched from the web (code Zotero then runs on web pages), or shipped with it.
  if (col.translatorInstalls.length) {
    const web = col.translatorUrls > 0;
    for (const h of col.translatorInstalls.slice(0, 3))
      col.cap("installs-translators", h, web ? "downloaded" : "bundled");
  }
  // Programs it runs that send data on its behalf, and packages fetched to run.
  col.packageRuns = col.packageRuns.filter(
    (r) => !r.check || installsWith(r.words?.[0] ?? "", resolveWords(col, r.words?.slice(1) ?? [])),
  );
  if (launches) {
    // A prefix test in a script isn't one it sends over (reference-for-zotro's arXiv links).
    for (const s of col.scriptUrls)
      col.url(
        s.url,
        s.hit,
        s.named ? "unknown" : "request",
        s.compare ? { loose: true } : undefined,
      );
    for (const h of col.packageRuns.slice(0, 5)) col.cap("package-run", h, "npx / pip / uv");
    if (col.pyNamesZoteroDb)
      for (const h of col.pySqlite.slice(0, 3))
        col.cap("sqlite-direct", h, "Python script it runs");
    for (const a of col.argLists) {
      const tool = AI_CLI_ARGS.find(([re]) => re.test(a.text))?.[1];
      if (tool && !col.cliNamed.has(tool)) col.cliNamed.set(tool, a.hit);
    }
    // An argument list counts for a package tool named in the same file, when it's in the plugin's
    // own code and held where a launch takes its arguments: a bundled SQL keyword list starting
    // with "add" isn't `pnpm add` (zotero-claudian), nor a list of modes `uv add`
    // (zotero-gemini-notebook's `MCP_AUTO_CONFIG_MODES = ["add", "reset"]`).
    const runs: PackageRun[] = [...col.packageRuns];
    for (const [tool, files] of col.packageTools) {
      const re = PACKAGE_ARGS[tool];
      const args = col.argLists.filter(
        (a) =>
          a.run &&
          re?.test(a.text) &&
          files.has(a.hit.file) &&
          a.hit.file.libraryAt(a.hit.offset) === null,
      );
      for (const a of args.slice(0, 3))
        col.cap(
          "package-run",
          a.hit,
          `${tool} ${a.text.split(" ").find((w) => !w.startsWith("-"))}`,
        );
      for (const a of args) runs.push({ ...a.hit, words: [tool, ...a.words], fn: a.fn });
    }
    const pkg = col.caps.get("package-run");
    if (pkg) Object.assign(pkg, packagePinning(col, runs));
  }
  // A server socket that listens where a setting says, read with the setting's default: on every
  // interface until the user changes it (zotero-filelink-bridge's allowRemote, true in prefs.js)
  // isn't one a setting opens.
  const listenCap = col.caps.get("own-server");
  if (listenCap && col.listenSettings.length) {
    const wide = col.listenSettings.filter((l) => {
      const lower = l.names.map((x) => x.toLowerCase());
      const value = [...col.prefDefaults].find(
        ([k]) => k === l.key || lower.includes((k.split(".").at(-1) ?? "").toLowerCase()),
      )?.[1];
      const on =
        value && /^(true|!0)$/.test(value)
          ? true
          : value && /^(false|!1|0)$/.test(value)
            ? false
            : null;
      // loopbackOnly is false by default.
      return on !== null && on === l.negated;
    });
    if (wide.length) listenCap.apis.add("listens beyond this computer by default (a setting)");
    if (wide.length === col.listenSettings.length)
      listenCap.apis.delete("can listen beyond this computer (a setting)");
  }
  // A server in a Node or Python program it ships counts once we know it runs programs, like the
  // program's other findings (paperviewzoteroplugin's service on 127.0.0.1:20341).
  if (launchesOwn(col)) {
    for (const h of col.pyServers) col.ownServers.push(readPyServer(col, h));
    for (const s of col.ownServers) {
      if (s.kind !== "node" && s.kind !== "python") continue;
      const cap = col.cap(
        "own-server",
        s.hit,
        s.kind === "python" ? "Python program it runs" : "Node program it runs",
      );
      if (s.beyond) cap.apis.add("listens beyond this computer");
      if (s.cors) cap.apis.add("web pages can call it");
    }
  }
  // Wrapping Zotero's own server start to pass bindAllAddr = true opens the connector server to the
  // network (zotero-opds: `original.apply(this, [port, true, max])`).
  for (const f of col.serverInitWraps) col.cap("own-server", f, "listens beyond this computer");
  // The plugin's own server socket answering any web page (`Access-Control-Allow-Origin: *`) lets
  // sites call it. Zotero's own server has checks of its own, so its endpoints are judged one by
  // one (rateServer): the same header on one of them opens nothing by itself.
  for (const h of col.corsHits) {
    const near = h.file.text.slice(h.offset, h.offset + 200);
    if (/["'`]\*["'`]/.test(near) && col.caps.has("own-server"))
      col.cap("own-server", h, "web pages can call it");
  }
  const webEndpoints = rateServer(col);
  // Code sent to it and run: a local endpoint's request body, an MCP tool's argument, or its own
  // AI assistant's tool call (`zotero_script`, `run_javascript`), handed to AsyncFunction / new
  // Function / a sandbox. The assistant is its own when its code reads a model's tool calls;
  // otherwise another program writes the code (zotmcp's MCP tool, zotero-local-write-api's
  // /write endpoint).
  const toolsIn = new Map<SourceFile, number[]>();
  let runner: { hit: Hit; tools: number[] } | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const d of col.dynamicArgs) {
    const h = d.hit;
    const fileText = h.file.text;
    if (!toolsIn.has(h.file))
      toolsIn.set(
        h.file,
        [...fileText.matchAll(new RegExp(SENT_CODE_TOOL.source, "g"))]
          .slice(0, 50)
          .map((m) => m.index),
      );
    const tools = toolsIn.get(h.file) ?? [];
    const codeNamed = d.names.some((x) => CODE_NAME.test(x));
    // A local endpoint close by (in a big bundle, Better BibTeX's formula compiled with new
    // Function has nothing to do with an endpoint registered elsewhere; a small plugin's one file
    // is one piece), and what runs is named as code: `runCode(code)`, `body.script`.
    const endpoint =
      codeNamed &&
      /Zotero\.Server\.Endpoints|server-?socket|nsIServerSocket/.test(
        fileText.length < 150_000
          ? fileText
          : fileText.slice(Math.max(0, h.offset - 6000), h.offset + 6000),
      );
    if (!tools.length && !endpoint) continue;
    // The runner itself: code named as such (`params.script`) nearest a tool's name, not a
    // library loader's eval elsewhere in the bundle (paperpilot's mermaid script).
    const far = tools.length ? Math.min(...tools.map((t) => Math.abs(t - h.offset))) : 0;
    const rank = (codeNamed ? 0 : 1e9) + far;
    if (rank < best) [best, runner] = [rank, { hit: h, tools }];
  }
  if (runner) {
    const text = runner.hit.file.text;
    const ai = runner.tools.length > 0 && col.aiLoop;
    const cap = col.cap(
      "runs-sent-code",
      runner.hit,
      ai
        ? "AI tool"
        : runner.tools.length && /tools\/call/.test(text)
          ? "MCP tool"
          : "local endpoint",
    );
    if (ai) cap.approval = approvalNear(text, runner.tools);
    // Code sent to an endpoint web pages can reach runs for any site that sends it.
    const at = runner.hit;
    if (
      !ai &&
      webEndpoints.some(
        (ep) =>
          ep.code.file === at.file &&
          ep.code.ranges.some(([s, e]) => at.offset >= s && at.offset < e),
      )
    )
      cap.apis.add("web pages");
  }
  // Servers it opens itself: whether any website can reach them, and what they'd do for it.
  rateOwnServers(col, runner && !(runner.tools.length > 0 && col.aiLoop) ? runner.hit : null);
  // A shell tool its own AI assistant can call (llm-for-zotero's `run_command`): what it writes
  // runs on the computer, not only inside Zotero.
  const shell = col.shellTools[0];
  if (shell && col.aiLoop && col.shellFlag && launchesOwn(col)) {
    const cap = col.cap("runs-sent-code", shell, "AI shell tool");
    const approval = approvalNear(
      shell.file.text,
      col.shellTools.filter((x) => x.file === shell.file).map((x) => x.offset),
    );
    // The less guarded of its tools decides.
    if (!cap.approval || APPROVAL_RANK[approval] > APPROVAL_RANK[cap.approval])
      cap.approval = approval;
  }
  // Code packages it downloads and unpacks, then runs in a sandbox or through new Function
  // (zotero-resource-search-mcp's providers): remote code without launching anything.
  if (col.downloads.length && col.extractsArchive && col.buildsCode && !launchesOwn(col))
    col.cap("remote-code", col.downloads[0] as Hit, "downloaded code package");
  // Launching only the system's own openers (`/usr/bin/open`, `xdg-open`, Quick Look, `rundll32
  // url.dll,FileProtocolHandler`) does what Zotero.launchFile and launchURL do (review: zotlit,
  // zoteroquicklookng). Judged from the program names written around each launch.
  const launch = col.caps.get("process-launch");
  if (launch) {
    const own = launch.hits.filter((h) => h.file.libraryAt(h.offset) === null);
    const found = [
      ...own.flatMap((h) =>
        [
          ...h.file.text
            .slice(Math.max(0, h.offset - 300), h.offset + 500)
            .matchAll(/["'`]([^"'`\n]{1,80})["'`]/g),
        ]
          .map((m) => m[1] as string)
          .filter((t) => PROGRAM_NAME.test(t))
          .map((t) => [t, h] as const),
      ),
      // …and what a launch's command resolves to, wherever the path is written.
      ...col.launchCommands.map((c) => [c.name, c.hit] as const),
    ];
    // An AI tool or a hand-off among them written as a path (`/opt/homebrew/bin/agy`, `agy.exe`)
    // or resolved as the command is what the launch runs; a bare "gemini" nearby may be a model id.
    for (const [t, h] of found) if (/[/\\]|\.exe$/i.test(t)) noteProgram(col, t, h);
    for (const c of col.launchCommands) noteProgram(col, c.name, c.hit);
    const named = found.map(([t]) => t);
    // Only openers written around the launches, and no resolved command that isn't one: a command
    // resolved in one branch only (`/usr/bin/open` on macOS, pdf2zh-desktop) doesn't show the rest.
    const nearby = named.slice(0, named.length - col.launchCommands.length);
    if (
      nearby.length &&
      nearby.every((t) => SYSTEM_OPENER.test(t)) &&
      col.launchCommands.every((c) => SYSTEM_OPENER.test(c.name))
    )
      launch.apis.add("system openers only");
    launch.programs = new Set(
      [
        ...new Set(
          named
            // `C:\x5cWindows\x5cSystem32\x5ctasklist.exe` as written in an obfuscated string.
            .map((t) =>
              t.replace(/\\x([0-9a-f]{2})/gi, (_, h: string) =>
                String.fromCharCode(Number.parseInt(h, 16)),
              ),
            )
            .map(
              (t) =>
                t
                  .split(/[\\/]/)
                  .at(-1)
                  ?.replace(/\.exe$/i, "") ?? t,
            )
            .filter((t) => t.length > 1),
        ),
      ]
        // Each name once before the cut, so repeats don't push others out.
        .sort((x, y) => programRank(x) - programRank(y))
        .slice(0, 8),
    );
  }
  // Where each downloaded program comes from, and whether it travels over plain http.
  const dl = col.caps.get("download-exec");
  if (dl) {
    dl.sources = new Set();
    for (const h of dl.hits) {
      // A shipped script is read whole: its addresses sit in variables at the top.
      const script = SHELL_SCRIPT.test(h.file.path);
      const near = script
        ? h.file.text
        : h.file.text.slice(Math.max(0, h.offset - 1500), h.offset + 1500);
      // A base address held in a name, maybe set in another file, joined to a program's file
      // name here: `this.popplerExtractorBaseURL + fileName + ".zip"` (zotero-file).
      const joined = [...near.matchAll(/\b([A-Za-z_$][\w$]*(?:url|uri|base))\b/gi)]
        .map((m) => m[1] as string)
        .filter((name, i, all) => all.indexOf(name) === i && col.namedUrls.has(name))
        .filter((name) =>
          new RegExp(
            `\\b${name.replace(/\$/g, "\\$")}\\b[^;\\n]{0,80}["'\`]\\.(zip|tar|gz|tgz|xz|7z|exe|msi|dmg|pkg|appimage|deb|rpm)["'\`]`,
            "i",
          ).test(near),
        )
        .flatMap((name) => col.namedUrls.get(name) ?? []);
      for (const u of [...[...near.matchAll(URL_RE)].map((m) => m[0]), ...joined]) {
        if (
          !PROGRAM_URL.test(u) &&
          !/\.(sh|ps1|py|bat|cmd)(\?|$)|install/i.test(u) &&
          !joined.includes(u)
        )
          continue;
        const host = hostOf(u)?.host;
        if (!host || dl.sources.size >= 6) continue;
        // By repository on GitHub: whose release it is matters more than the host.
        const gh = u.match(
          /^https?:\/\/(?:github\.com|raw\.githubusercontent\.com)\/([^/]+)\/([^/?#]+)/i,
        );
        const name = gh ? `${gh[1]}/${gh[2]} on GitHub` : host;
        dl.sources.add(u.startsWith("http://") ? `${name} (http)` : name);
        // Where a program is downloaded from is contacted (zotero-copy-anything's gitee.com).
        col.url(
          u,
          { file: h.file, offset: h.file.text.indexOf(u) >= 0 ? h.file.text.indexOf(u) : h.offset },
          "request",
        );
      }
    }
  }
  // A compiled program it ships and runs: its code is machine code nobody here can read.
  if (launches)
    for (const [name, h] of col.binaryNamed)
      col.cap("runs-bundled-binary", h, col.binaries.get(name) ?? name);
  if (col.shellDownloads.length && launches)
    for (const h of col.shellDownloads)
      col.cap("download-exec", h, h.pinned ? "pinned to a SHA-256" : "shell download and run");

  // `this.DB.queryAsync(...)` is Zotero's database unless the plugin opened one of its own.
  if (!col.ownDbConnection) {
    for (const w of col.otherDbWrites) {
      const cap = col.cap("db-write", w.hit, "Zotero.DB");
      cap.sql.add(w.verb);
      cap.tables.add(w.table);
    }
  } else if (col.otherDbWrites.length) {
    // Its own database file (`new Zotero.DBConnection("lyz")`): not Zotero's database, but worth
    // saying (Zotero calls separate files "relatively less bad").
    const cap = col.cap("own-database", col.otherDbWrites[0]?.hit as Hit, "Zotero.DBConnection");
    for (const w of col.otherDbWrites.slice(0, 20)) cap.tables.add(w.table);
  }
  const server = col.caps.get("local-http-server");
  if (server) for (const e of col.endpointNames) server.endpoints.add(e);

  for (const c of col.urlCalls)
    for (const u of col.returnedUrls.get(c.fn) ?? [])
      col.url(
        u.split(EXPR)[0] as string,
        c.hit,
        "request",
        c.sends && /^(http|ws):\/\//i.test(u) ? { sends: c.sends() } : undefined,
      );
  for (const c of col.scriptCalls)
    for (const u of col.returnedUrls.get(c.fn) ?? [])
      if (/^https?:\/\//i.test(u)) {
        col.url(u.split(EXPR)[0] as string, c.hit, "request");
        col.cap("remote-code", c.hit, `${c.kind} over http(s)`);
      }
  const primary = pickManifest(manifests);
  // Add-on installs of its own .xpi (same repository as its update address, or its own name) are
  // it updating itself outside Zotero's updater.
  const installs = col.caps.get("installs-addons");
  if (installs && primary && col.installTargets.length === installs.hits.length) {
    const own = col.installTargets.every((t) => t.url && isOwnXpi(t.url, primary));
    if (own) {
      col.caps.delete("installs-addons");
      for (const t of col.installTargets) col.cap("self-installs", t.hit, "getInstallForURL");
    }
  }
  // Where each install's file comes from, and what starts it.
  for (const id of ["installs-addons", "self-installs"] as const) {
    const c = col.caps.get(id);
    if (!c) continue;
    const sites = col.installSites.filter((s) => c.hits.includes(s.hit));
    const routes = sites.flatMap((s) =>
      installRoutes(col, s, id === "self-installs", primary?.updateUrl ?? null, input.table),
    );
    // A link that changes the catalogue it installs from, without asking (zotero-addons).
    if (col.linkSource && routes.some((r) => r.from === "catalogue"))
      routes.push({ from: "link-source", asks: "none" });
    const seen = new Set<string>();
    c.installs = routes
      .filter((r) => {
        const key = JSON.stringify(r);
        return !seen.has(key) && seen.add(key);
      })
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y), "en"));
  }
  // Settings that aren't its own, and what starts each change.
  const settings = settingsChanges(col);
  const changes = settings.hits.map((h) => col.cap("changes-settings", h)).at(-1);
  if (changes) changes.settings = settings.entries;
  let updateHost: AnalyzeResult["updateHost"] = null;
  if (primary?.updateUrl) {
    const h = hostOf(primary.updateUrl);
    const cls = h ? classifyHost(input.table, h.host) : null;
    const file =
      manifestFiles.find((f) => f.path === primary.format) ?? new SourceFile(primary.format, "");
    const offset = file.text.indexOf(primary.updateUrl);
    const updates = col.cap(
      "self-update",
      { file, offset: Math.max(0, offset) },
      primary.updateUrl,
    );
    // It turns Zotero's automatic updates on for itself at every start, whatever the user chose.
    if (col.autoUpdateSets.some((s) => runsAtStartup(col, s.fn))) updates.forcesAutoUpdate = true;
    if (h && cls) {
      const dev = cls.category === "unknown" && isDeveloperHost(h.host, col.developer);
      updateHost = { host: h.host, category: dev ? "developer-server" : cls.category };
    }
  }

  noteCompanions(col, primary);
  noteUnencrypted(col);
  const analysis = buildDocument(col, input, primary?.version ?? "unknown");
  return { analysis, manifests, updateHost, metrics: col.metrics };
}

/**
 * The user's text, keys or identifiers sent over plain http:// to a host beyond this computer and
 * its network (cleartext-http sweep): anyone on the network in between can read it. One entry per
 * host, from the requests we traced and what their calls send; an https redirect comes too late,
 * as the request has already gone out.
 */
function noteUnencrypted(col: Collector) {
  const entries: UnencryptedEntry[] = [];
  const hits: Hit[] = [];
  for (const [host, e] of [...col.hosts].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const sent = e.hits.filter((h) => h.plain && h.usage === "request" && h.sends?.length);
    if (!sent.length) continue;
    // Search terms were made content or identifiers by host in Collector.url.
    const sends = [...new Set(sent.flatMap((h) => h.sends ?? []))]
      .filter((x): x is UnencryptedEntry["sends"][number] => x !== "search")
      .sort();
    entries.push({ host, sends, ...(sent.every((h) => h.fallback) ? { fallback: true } : {}) });
    hits.push(...sent);
  }
  if (!entries.length) return;
  const [first, ...rest] = hits;
  const cap = col.cap("sends-unencrypted", first as Hit);
  cap.hits.push(...rest);
  cap.unencrypted = entries;
}

function noteCliSetting(col: Collector, key: string, at: Hit) {
  const tool = AI_CLI_SETTING.find(([re]) => re.test(key))?.[1];
  if (tool && !col.cliNamed.has(tool)) col.cliNamed.set(tool, at);
}

/** Identifiers read as words, for names inside them: `picgoUploadUrl`, `openclaw_port`. */
const asWords = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");

/** The line of text an offset sits on. */
function lineAt(text: string, offset: number): string {
  const end = text.indexOf("\n", offset);
  return text.slice(text.lastIndexOf("\n", offset) + 1, end < 0 ? undefined : end);
}

/** A program named where a command goes (a launch, a setting's default): AI tools and hand-offs. */
function noteProgram(col: Collector, name: string, at: Hit) {
  const tool = AI_CLI.find(([re]) => re.test(name))?.[1];
  if (tool && !col.cliNamed.has(tool)) col.cliNamed.set(tool, at);
  const h = HANDOFFS.find((x) => x.run?.test(name));
  if (h) col.handoff(h, at, "launch");
}

/** The last part of a setting that holds a program: `cliPath`, `aiCommand`, `pdf2zh.command`. */
const PROGRAM_SETTING = /(?:cli|bin|exe|executable|command|cmd)(?:[._-]?path)?$|path$|^backend$/i;
/** Zotero's own server and the local model runtimes (Ollama, LM Studio): data stays here. */
const LOCAL_ONLY_PORTS = new Set([23119, 11434, 1234]);
const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i;
/** A browser extension the code names, which files served on Zotero's server go to. */
const BROWSER_EXTENSION =
  /\b(?:Chrome|browser|Edge|Firefox) extension\b|chrome-extension:\/\/|chromewebstore\.google\.com|浏览器(?:扩展|插件)/i;

/**
 * The jobs that make a companion a relay to an online service: translating, voices, chatting with
 * an AI model (or one it names), OCR, cloud sync. At an address the user sets, only these count:
 * an AI analysis on their own backend (paperpulse, zotero-rag) is the server they set up.
 */
const REMOTE_SERVICE =
  /translat|译|\bvoices?\b|\btts\b|text[- ]to[- ]speech|read[- ]aloud|朗读|语音|\bchat|聊天|对话|\bOCR\b|(?<!word ?)cloud|(?<!词)云|deepseek|claude|gemini|kimi|doubao|qwen/i;
/**
 * A companion's job as the plugin's own description gives it, when that job is done online: the
 * services above, and an AI model's analysis or answers.
 */
const REMOTE_JOB = new RegExp(
  `${REMOTE_SERVICE.source}|\\bAI\\b|\\bLLMs?\\b|\\bGPT|\\bagent\\b|\\bRAG\\b|analy[sz]|summar|问答`,
  "i",
);
/** …unless the description says the companion is the user's own server or keeps data local. */
const SELF_HOSTED =
  /self-?host|your own server|local-first|offline|\blocal (?:\w+ )?(?:TTS|speech|voices?)\b|自建|自托管|远程电脑|本机或远程|局域网|离线/i;
/** Programs named around a request that keep data on the computer, or run on the user's server. */
const LOCAL_PROGRAM =
  /\b(?:ollama|lm ?studio|llama[.-]?cpp|llamafile|vllm|xinference|localai|kokoro|piper|libretranslate|mtran\w*|nllb|docling|mineru|grobid|umi-?ocr|anki(?:connect)?|eagle|obsidian|siyuan|whisper|searxng|ragflow|dify|anythingllm|open-?webui)\b/i;
/** Not a companion: its own endpoints in an AI client's setup, a browser's debugging port. */
const NOT_COMPANION = /\bmcp\b|Model Context Protocol|\/json\/(?:version|list)|\/devtools\//i;
/** Its name in the description: "to a local TeXGlot service", "UtterMux voices". */
const COMPANION_NAME =
  /\b(?:to|with|via|through)\s+(?:(?:a|an|the|your)\s+)?(?:local\s+)?([A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*)\b|\b([A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*)\s+(?:voices|service|app|backend|server|desktop)\b/g;
const NOT_A_NAME = /^(?:Zotero|The|Your|Local|PDFs?|Chinese|English|OpenAI)$/;

function companionName(desc: string): string {
  for (const m of desc.matchAll(COMPANION_NAME)) {
    const name = m[1] ?? m[2];
    if (name && !NOT_A_NAME.test(name)) return name;
  }
  return "a program on this computer";
}

/**
 * The services a companion is told to use, by the API keys the plugin asks for ("Doc2X API Key",
 * `deepseek_api_key`), when a service in the hosts table goes by that name.
 */
function keyedServices(col: Collector, text: string): string[] {
  const byName = new Map<string, string>();
  for (const r of col.table.exact.values())
    if (r.provider && ["llm-provider", "translation"].includes(r.category)) {
      const name = r.provider.replace(/\s*\(.*$/, "");
      byName.set(name.toLowerCase().replace(/[^a-z0-9]/g, ""), name);
    }
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z][\w.]*?)[\s_-]*api[\s_-]*key\b/gi)) {
    const name = byName.get((m[1] as string).toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (name) out.add(name);
  }
  return [...out].sort();
}

/**
 * Companions on this computer that pass what the plugin sends them on to an online service: a
 * local server whose code around the request says what it is (Edge voice names, RetainPDF, an
 * OpenClaw gateway), and a browser extension for a known web app that it serves files to on
 * Zotero's server (NotebookLM). Zotero's own server and local model runtimes don't count. A
 * companion we can't name counts as unknown when the plugin's description gives it a job done
 * online and the plugin contacts nothing else itself (review C39: TeXGlot, a desktop translator,
 * a voice bridge); the services it's given API keys for, when the plugin names them. One at an
 * address setting's default on this computer is the server the user sets up (their own
 * PaperPulse instance), unless its job is plainly an online service (REMOTE_SERVICE).
 */
function noteCompanions(col: Collector, manifest: XpiManifest | undefined) {
  const own = col.serverEndpoints
    .map((e) => e.path)
    .filter((x): x is string => !!x && x.length > 1);
  // Ports of address settings whose default is on this computer: the user points them at their
  // own instance (`backendURL` = `http://127.0.0.1:18095`).
  const localPort = (url: string) => {
    const m = url.match(/^[a-z]+:\/\/([^/:]+|\[[^\]]*\])(?::(\d+))?/i);
    return m && LOOPBACK.test(m[1] as string) ? (m[2] ?? "") : null;
  };
  const settable = new Set(
    [...col.endpoints.values()]
      .map((e) => (e.defaultValue ? localPort(e.defaultValue) : null))
      .filter((p): p is string => p !== null),
  );
  let companion: Hit | null = null;
  let setUp: Hit | null = null;
  for (const [host, e] of col.hosts) {
    if (e.cls.category !== "localhost" || !LOOPBACK.test(host)) continue;
    for (const hit of e.hits) {
      if (hit.usage === "link" || hit.file.libraryAt(hit.offset) !== null) continue;
      const text = hit.file.text;
      const url =
        text.slice(hit.offset, hit.offset + 300).match(/(?:https?|wss?):\/\/[^\s"'`]+/)?.[0] ?? "";
      const where = url.match(/^[a-z]+:\/\/[^/:]+(?::(\d+|\$\{[^}]*\}))?(\/[^\s?#]*)?/i);
      // A request built on a helper's address (`fetch(base() + "/api")`) is on the host's port.
      const port = where?.[1] ?? (url ? "" : String(e.port ?? ""));
      const path = where?.[2] ?? "";
      // `http://127.0.0.1:${Zotero.Server.port}` is Zotero's own server, and so is a port read
      // from it just before (`const port = Zotero.Server.port`).
      if (
        LOCAL_ONLY_PORTS.has(Number(port)) ||
        /Server\.port|httpServer/.test(port) ||
        /Zotero\.Server\b(?!\.Endpoints)/.test(
          text.slice(Math.max(0, hit.offset - 600), hit.offset),
        )
      )
        continue;
      // Not a request to a companion: its own MCP endpoint in a client's setup, one of its own
      // endpoints on Zotero's server, a proxy setting, an OAuth redirect.
      const line = lineAt(text, hit.offset);
      if (/^\/(?:mcp|sse)\b/.test(path) || own.some((x) => path.startsWith(x.replace(/\/$/, ""))))
        continue;
      // …or a program that keeps data here, named on the same line (`ankiConnectUrl: …`).
      if (/proxy|redirect_?uri/i.test(line) || LOCAL_PROGRAM.test(asWords(line))) continue;
      // A settings default is read on its own line: the next one is another setting.
      const near = /(^|\/)prefs\.js$|defaults\/preferences\//.test(hit.file.path)
        ? line
        : text.slice(Math.max(0, hit.offset - 1500), hit.offset + 1500);
      const words = asWords(near);
      for (const h of HANDOFFS)
        if (h.local?.test(near) || h.local?.test(words)) col.handoff(h, hit, "local");
      // An OpenAI-style API (`/v1/…`) is a model server, usually a local one; so is a program a
      // small file names anywhere.
      const around = text.length < 100_000 ? text : near;
      if (/^\/v1\b/.test(path) || LOCAL_PROGRAM.test(around) || NOT_COMPANION.test(near)) continue;
      if (settable.has(port)) setUp ??= hit;
      else companion ??= hit;
    }
  }
  for (const ep of col.serverEndpoints) {
    const text = ep.hit.file.text;
    if (ep.hit.file.libraryAt(ep.hit.offset) !== null || !BROWSER_EXTENSION.test(text)) continue;
    for (const h of HANDOFFS) if (h.extension?.test(text)) col.handoff(h, ep.hit, "local");
  }
  const desc = `${manifest?.name ?? ""}: ${manifest?.description ?? ""}`;
  const named = col.handoffs.size > 0 || (launchesOwn(col) && col.cliNamed.size > 0);
  // Services its own code names are on the card already, and say where its data goes.
  const remote = [...col.hosts.values()].some(
    (e) =>
      !["localhost", "code-hosting", "cdn", "documentation"].includes(e.cls.category) &&
      e.hits.some((h) => h.usage !== "link" && h.file.libraryAt(h.offset) === null),
  );
  // A server at an address the user sets counts only when its job is plainly an online service.
  companion ??= setUp && REMOTE_SERVICE.test(desc) ? setUp : null;
  if (
    !companion ||
    named ||
    remote ||
    !REMOTE_JOB.test(desc) ||
    SELF_HOSTED.test(desc) ||
    LOCAL_PROGRAM.test(desc)
  )
    return;
  const program = companionName(manifest?.description ?? "");
  const services = keyedServices(col, companion.file.text);
  col.handoff(
    services.length
      ? { program, provider: services.join(" and "), category: "llm-provider" }
      : { program, provider: "", category: "unknown" },
    companion,
    "local",
  );
}

/** The sites a shipped browser extension's manifest lets it reach (`host_permissions`). */
function noteExtension(col: Collector, path: string, data: Uint8Array) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  let m: { manifest_version?: number; content_scripts?: unknown; background?: unknown } & Record<
    string,
    unknown
  >;
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  if (!m.manifest_version || !(m.content_scripts || m.background)) return;
  const perms = [m.host_permissions, m.manifest_version === 2 ? m.permissions : []].flat();
  const file = new SourceFile(path, text);
  for (const p of perms) {
    // Named sites only: not `<all_urls>`, `*://*/*` or this computer.
    const host = typeof p === "string" ? p.match(/^(?:https?|\*):\/\/([\w.-]+)\//)?.[1] : null;
    if (host && !LOOPBACK.test(host))
      col.url(`https://${host}/`, { file, offset: text.indexOf(p as string) }, "request");
  }
}

function addVendored(col: Collector, name: string, path: string, by: LibraryEvidence) {
  const v = col.vendored.get(name) ?? { files: new Set<string>(), by };
  v.files.add(path);
  col.vendored.set(name, v);
}

function readPrefs(col: Collector, file: SourceFile) {
  for (const m of file.text.matchAll(
    /pref\(\s*["']([^"']+)["']\s*,\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|[^)]*?)\s*,?\s*\)/g,
  )) {
    const key = m[1] ?? "";
    const value = m[3] ?? m[4] ?? "";
    const hit = { file, offset: m.index ?? 0 };
    col.prefDefaults.set(key, (m[2] ?? "").trim());
    if (isCredentialKey(key)) col.cap("credential-storage", hit, "preferences").prefKeys.add(key);
    noteCliSetting(col, key, hit);
    // A program setting's default is what runs until the user changes it (`cliPath: "claude"`,
    // `command: "pi --append-system-prompt …"`).
    const program = value.trim().split(/\s+/)[0];
    if (program && PROGRAM_SETTING.test(key.split(".").at(-1) ?? ""))
      noteProgram(col, program, hit);
    // An AI agent's approval setting (`permissionMode: "acceptEdits"`), for launches that pass it on.
    if (/permission.?mode/i.test(key) && AGENT_MODE_VALUE[value])
      col.agentModes.push({
        program: "Claude Code",
        mode: AGENT_MODE_VALUE[value],
        byDefault: true,
        hit,
        pref: true,
      });
    if (SECURITY_PREF.test(key)) col.cap("disables-security", hit, key);
    // A default for one of Zotero's settings (zotero-style's Sci-Hub resolver): the user's own
    // value wins, and it goes when the plugin does.
    const change = appSetting(key);
    const way = change ? SWITCHES[change] : undefined;
    if (change && (!way || (m[2] ?? "").trim() === (way === "on" ? "true" : "false")))
      col.settingsDefaults.push({ hit, change });
    if (/^(https?|wss?):\/\//.test(value)) {
      // An address setting's default is where the plugin sends data unless the user changes it
      // (review K5: fanyipaiban's default upload server read "servers you configure").
      if (!isEndpointKey(key)) {
        col.url(value, hit, "unknown");
        continue;
      }
      const e = col.endpoints.get(key) ?? { hits: [] };
      e.defaultValue = value;
      e.hits.push(hit);
      col.endpoints.set(key, e);
      col.url(value, hit, "request");
    }
  }
}

// ----------------------------------------------------------------------------------------------
// Document assembly

/** The bundled library a use sits in: the file's own map, or one recognised from the code. */
const libraryOf = (h: Hit) => h.library ?? h.file.libraryAt(h.offset);

function evidenceList(hits: Hit[]): CodeEvidence[] {
  const seen = new Set<string>();
  const out: CodeEvidence[] = [];
  for (const h of [...hits].sort(
    (a, b) => a.file.path.localeCompare(b.file.path, "en") || a.offset - b.offset,
  )) {
    const key = `${h.file.path}:${h.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = h.file.evidence(h.offset);
    out.push(h.library ? { ...e, inVendoredCode: true } : e);
    if (out.length >= EVIDENCE_CAP) break;
  }
  return out;
}

/** The bundled libraries a finding sits in, when any of its uses is in one. */
function libraryNames(hits: Hit[]): { libraries?: string[] } {
  const names = new Set<string>();
  for (const h of hits) {
    const lib = libraryOf(h);
    if (lib) names.add(lib);
  }
  return names.size ? { libraries: [...names].sort().slice(0, 10) } : {};
}

/** The bundled packages the obfuscation sits in, when every signal is inside one. */
function obfuscatedLibraries(signals: Collector["signals"]): { libraries?: string[] } {
  const strong = signals.filter((s) => STRONG.includes(s.kind));
  if (!strong.length) return {};
  const libs = new Set<string>();
  for (const s of strong)
    for (const h of s.hits) {
      const lib = h.file.libraryAt(h.offset);
      if (!lib) return {};
      libs.add(lib);
    }
  return { libraries: [...libs].sort() };
}

const STRONG: SignalKind[] = [
  "hex-identifiers",
  "string-array-rotation",
  "obfuscator-signature",
  "control-flow-flattening",
  "string-array-accessor",
  "packer",
];

/**
 * How sure we are that code is obfuscated (thresholds calibrated against the whole corpus):
 * - high: two or more kinds of structural signal (obfuscator output shows several at once);
 * - medium: one kind of structural signal, backed by a second file or by dense escapes;
 * - low: a single structural signal in one file, or dense escapes alone. Shown on the card and
 *   worth a look, but not enough to call the plugin obfuscated.
 */
export function obfuscationConfidence(signals: { kind: SignalKind; file: string }[]): {
  detected: boolean;
  confidence: "high" | "medium" | "low";
} {
  const strong = signals.filter((s) => STRONG.includes(s.kind));
  const kinds = new Set(strong.map((s) => s.kind));
  const files = new Set(strong.map((s) => s.file));
  // Dense escapes back a structural signal only in the same file; eval of a decoded string is a
  // capability (dynamic code), not a sign of obfuscation (the toolkit's debug bridge does it).
  const weak = signals.filter((s) => s.kind === "escape-density");
  const backed = weak.some((s) => files.has(s.file));
  if (kinds.size >= 2) return { detected: true, confidence: "high" };
  if (kinds.size === 1 && (files.size >= 2 || backed))
    return { detected: true, confidence: "medium" };
  if (kinds.size === 1 || weak.length >= 1) return { detected: true, confidence: "low" };
  return { detected: false, confidence: "high" };
}

/**
 * Programs it hands data to and who they send it to: AI tools and other programs it launches
 * (when it launches programs itself), then companions on this computer.
 */
function programList(col: Collector) {
  const out = new Map<
    string,
    { program: string; provider: string; category?: HostCategory; evidence: CodeEvidence[] }
  >();
  const launches = launchesOwn(col);
  if (launches)
    for (const [program, h] of col.cliNamed)
      out.set(program, {
        program,
        provider: AI_CLI.find(([, p]) => p === program)?.[2] ?? "",
        evidence: evidenceList([h]),
      });
  for (const [program, x] of col.handoffs) {
    if (out.has(program) || (x.via === "launch" && !launches)) continue;
    const way = handoffWay(col, x.hit);
    out.set(program, {
      program,
      provider: x.h.provider,
      ...(x.h.category !== "llm-provider" ? { category: x.h.category } : {}),
      ...(way.documents ? { documents: true } : {}),
      ...(way.automatic ? { automatic: true } : {}),
      evidence: evidenceList([x.hit]),
    });
  }
  return [...out.values()];
}

/** PDF files or their text: a file's path, its full text, a selection in the reader. */
const DOCUMENT_DATA =
  /\.pdf\b|application\/pdf|isPDFAttachment|getFilePath(?:Async)?\s*\(|attachmentText|getFullText|\bFulltext\b|PDFWorker|selectedText|selectionText|getSelection\s*\(|annotationText|annotation\??\.text\b|renderTextSelectionPopup|\bfull_?text\b/i;

/**
 * What the code around a hand-off shows of it, through the functions that lead to it: whether it
 * works with PDF files or their text (`documents`), and whether one of those paths starts without a
 * click (`automatic`: Zotero's startup, a timer, or an observer of new items), unless it waits for
 * a setting that's off by default. A WebSocket opened by itself carries nothing until something is
 * sent on it, so opening one isn't a hand-off without a click.
 */
function handoffWay(col: Collector, hit: Hit): { documents: boolean; automatic: boolean } {
  // Where the address is used: here, and wherever the name it's bound to appears in the file
  // (`const BRIDGE = "http://127.0.0.1:8766"` at the top, the request further down).
  const text = hit.file.text;
  const bound = text
    .slice(Math.max(0, hit.offset - 120), hit.offset)
    .match(/\b([A-Za-z_$][\w$]{2,})\s*[:=]\s*$/)?.[1];
  const uses = [hit.offset];
  if (bound)
    for (const m of text.matchAll(
      new RegExp(String.raw`(?<![\w$])${bound.replaceAll("$", "\\$")}\b`, "g"),
    ))
      if (uses.length < 12 && m.index !== hit.offset && hit.file.libraryAt(m.index) === null)
        uses.push(m.index);
  const paths = uses.flatMap((at) => {
    const fn = functionAt(col, hit.file, at);
    return fn
      ? startPaths(col, {
          hit: { file: hit.file, offset: at },
          fn: fn.name,
          span: fn.span,
          holder: null,
        })
      : [];
  });
  const documents = paths.some((p) => p.texts.some((t) => DOCUMENT_DATA.test(t.text)));
  const socket = /^["'`]?wss?:\/\//i.test(hit.file.text.slice(hit.offset, hit.offset + 10));
  const automatic =
    !socket &&
    paths.some(
      (p) =>
        (p.root === "startup" || p.root === "timer" || p.root === "event") &&
        !settingOffByDefault(col, p.setting),
    );
  return { documents, automatic };
}

function buildDocument(col: Collector, input: AnalyzeInput, version: string): AnalysisDoc {
  const { detected, confidence } = obfuscationConfidence(col.signals);
  const programs = programList(col);

  const signalMap = new Map<string, (typeof col.signals)[number]>();
  for (const s of col.signals) {
    const key = `${s.kind}|${s.file}`;
    const prev = signalMap.get(key);
    if (prev) prev.hits.push(...s.hits);
    else signalMap.set(key, { ...s, hits: [...s.hits] });
  }

  const doc = {
    schemaVersion: 1,
    analyzerVersion: ANALYZER_VERSION,
    analyzedAt: input.analyzedAt ?? new Date().toISOString(),
    input: { slug: input.slug, version, sha256: input.sha256 },
    coverage: {
      filesTotal: col.skipped.length + col.analyzed,
      filesAnalyzed: col.analyzed,
      filesSkipped: col.skipped,
      // One entry per file: an HTML page with three broken inline scripts is one failed file.
      parseFailures: [...new Map(col.parseFailures.map((p) => [p.path, p])).values()].map((p) => ({
        ...p,
        fallback: "regex" as const,
      })),
      partial: col.parseFailures.length > 0 || col.skipped.some((s) => s.reason === "too-large"),
      codeBytes: col.codeBytes,
      failedBytes: [...col.failedBytes.values()].reduce((a, b) => a + b, 0),
    },
    transparency: {
      verdict:
        detected && confidence !== "low"
          ? "obfuscated"
          : col.minified.size
            ? "minified"
            : "readable",
      obfuscation: {
        detected,
        confidence,
        signals: [...signalMap.values()]
          .sort((a, b) => a.kind.localeCompare(b.kind, "en") || a.file.localeCompare(b.file, "en"))
          .map((s) => ({
            kind: s.kind,
            file: s.file,
            ...(s.score !== undefined ? { score: s.score } : {}),
            evidence: evidenceList(s.hits),
          })),
        ...obfuscatedLibraries(col.signals),
      },
      minifiedFiles: [...col.minified].sort(),
      sourceMaps: { present: col.sourceMaps.size > 0, files: [...col.sourceMaps].sort() },
      suspiciousUnicode: [...col.unicode.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([kind, u]) => ({
          kind,
          codepoints: [...u.codepoints].sort(),
          occurrences: u.count,
          evidence: evidenceList(u.hits),
        })),
      vendoredLibraries: [...col.vendored.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([name, v]) => ({ name, files: [...v.files].sort(), identifiedBy: v.by })),
    },
    network: {
      apis: [...col.apis.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([api, hits]) => ({
          api,
          occurrences: hits.length,
          inVendoredCodeOnly: hits.every((h) => h.file.libraryAt(h.offset) !== null),
          ...libraryNames(hits),
          evidence: evidenceList(hits),
        })),
      hosts: [...col.hosts.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([host, h]) => {
          const usages = new Set(h.hits.map((x) => x.usage));
          const usage: Usage = usages.has("request")
            ? "request"
            : usages.size === 1 && usages.has("link")
              ? "link"
              : "unknown";
          return {
            host,
            ...(h.port ? { port: h.port } : {}),
            category: h.cls.category,
            ...(h.cls.provider ? { provider: h.cls.provider } : {}),
            // An upload to a public file drop, encrypted to the developer's key first; a request
            // over plain http.
            flags: [
              ...h.cls.flags,
              ...(h.cls.flags.includes("public-relay") &&
              h.hits.every((x) => col.jweFiles.has(x.file.path))
                ? ["encrypted-upload" as const]
                : []),
              ...(h.hits.some((x) => x.plain && x.usage === "request")
                ? ["unencrypted" as const]
                : []),
            ],
            usage,
            inVendoredCode: h.hits.every((x) => x.file.libraryAt(x.offset) !== null),
            ...libraryNames(h.hits),
            occurrences: h.hits.length,
            evidence: evidenceList(h.hits),
          };
        }),
      dynamicUrls: [...col.dynamicUrls.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .slice(0, 50)
        .map(([pattern, hits]) => ({ pattern, evidence: evidenceList(hits) })),
      configurableEndpoints: [...col.endpoints.entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([prefKey, e]) => ({
          prefKey,
          ...(e.defaultValue ? { defaultValue: e.defaultValue } : {}),
          evidence: evidenceList(e.hits),
        })),
      ...(programs.length ? { programs } : {}),
      hostsTableVersion: input.table.version,
    },
    capabilities: [...col.caps.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([id, c]) => {
        const details: Record<string, unknown> = {};
        if (c.sql.size) details.sqlStatements = [...c.sql].sort();
        if (c.tables.size) details.sqlTables = [...c.tables].sort();
        if (c.endpoints.size) details.endpoints = [...c.endpoints].sort();
        if (c.prefKeys.size) details.prefKeys = [...c.prefKeys].sort();
        if (id === "filesystem") details.fsScope = c.fsScope ?? "unknown";
        if (c.asksFirst || c.unguarded) details.asksFirst = Boolean(c.asksFirst && !c.unguarded);
        if (id === "self-update") details.updateUrl = [...c.apis][0];
        else if (c.apis.size) details.apis = [...c.apis].sort();
        if (c.forcesAutoUpdate) details.apis = [FORCES_AUTO_UPDATE];
        if (c.sources?.size) details.sources = [...c.sources].sort();
        if (c.programs?.size) details.programs = [...c.programs].sort();
        if (c.pinning) details.pinning = c.pinning;
        if (c.packages?.length) details.packages = c.packages;
        if (c.atStartup) details.atStartup = true;
        if (c.once) details.once = true;
        if (c.copiedToBrowser) details.copiedToBrowser = true;
        if (c.approval) details.approval = c.approval;
        if (c.web) details.web = c.web;
        if (c.serverActions?.size) details.serverActions = [...c.serverActions].sort();
        if (c.setting) details.setting = c.setting;
        if (c.needsKey) details.needsKey = true;
        if (c.installs?.length) details.installs = c.installs;
        if (c.settings?.length) details.settings = c.settings;
        if (c.unencrypted?.length) details.unencrypted = c.unencrypted;
        if (id === "process-launch" && col.agentModes.length) details.agentModes = agentModes(col);
        return {
          id,
          occurrences: c.hits.length,
          inVendoredCodeOnly: c.hits.every((h) => libraryOf(h) !== null),
          ...libraryNames(c.hits),
          evidence: evidenceList(c.hits),
          ...(Object.keys(details).length ? { details } : {}),
        };
      }),
    diff: null,
  };
  return Analysis.parse(doc);
}

export function touchesZoteroTables(tables: string[] | undefined): boolean {
  return (tables ?? []).some((t) => ZOTERO_TABLES.has(t.toLowerCase()));
}
