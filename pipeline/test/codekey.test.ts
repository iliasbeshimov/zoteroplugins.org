// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are plugin source code
import { describe, expect, it } from "vitest";
import { functionKey, functionRanges } from "../src/libs/normalize.ts";
import { parseJs } from "../src/libs/parse.ts";
import { capIn, scanFiles } from "./helpers/scan.ts";

// The shape of llm-for-zotero's download helpers in 3.9.9 and in 3.9.12, where the bundler renamed
// the local modules and helpers (`path2` to `path3`, `ensureDir7` to `ensureDir5`).
const WRITE_399 = `async function writeFileBytes(filePath, bytes) {
  const dir = path2.dirname(filePath);
  await ensureDir7(dir);
  const tmp = filePath + ".tmp";
  try { await IOUtils.write(tmp, bytes); await IOUtils.move(tmp, filePath); }
  catch (e) { if (typeof OS !== "undefined" && OS.File) { await OS.File.writeAtomic(filePath, bytes); } else throw e; }
  const ok = (() => { return !0; })();
  return ok ? void 0 : -1;
}`;
const WRITE_3912 = `async function writeFileBytes(filePath2, bytes2) {
  const dir2 = path3.dirname(filePath2);
  await ensureDir5(dir2);
  const tmp2 = filePath2 + ".tmp";
  try { await IOUtils.write(tmp2, bytes2); await IOUtils.move(tmp2, filePath2); }
  catch (err) { if (typeof OS !== "undefined" && OS.File) { await OS.File.writeAtomic(filePath2, bytes2); } else throw err; }
  const ok2 = (() => { return true; })();
  return ok2 ? undefined : -1;
}`;

describe("functionKey", () => {
  it("is the same for two builds of a function that differ only in local names", () => {
    const a = functionKey(WRITE_399);
    expect(a).toBeTruthy();
    expect(functionKey(WRITE_3912)).toBe(a);
  });

  it("walks nested functions, so a change inside one changes the key", () => {
    const changed = WRITE_399.replace("return !0;", "return !1;");
    expect(functionKey(changed)).not.toBe(functionKey(WRITE_399));
  });

  it("differs when a string literal or a call changes", () => {
    expect(functionKey('function f(a) { return fetch("https://a.example/x", a); }')).not.toBe(
      functionKey('function f(a) { return fetch("https://b.example/x", a); }'),
    );
    expect(functionKey("function f(a) { return a.open(1); }")).not.toBe(
      functionKey("function f(a) { return a.send(1); }"),
    );
    expect(functionKey("function f(a) { return fetch(a); }")).not.toBe(
      functionKey("function f(a) { return other(a); }"),
    );
  });

  it("reads methods, arrows, function expressions and async forms", () => {
    expect(functionKey("run(cmd) { return Subprocess.call({ command: cmd }); }")).toBe(
      functionKey("run(other) { return Subprocess.call({ command: other }); }"),
    );
    expect(
      functionKey("async run(cmd) { return Subprocess.call({ command: cmd }); }"),
    ).toBeTruthy();
    expect(functionKey("get x() { return Zotero.version; }")).toBeTruthy();
    expect(functionKey("(a, b) => fetch(a, b)")).toBe(functionKey("(x, y) => fetch(x, y)"));
    expect(functionKey("function (a) { return a.b; }")).toBeTruthy();
    expect(functionKey("static make(a) { return new Worker(a); }")).toBeTruthy();
  });

  it("returns null for text that isn't one function", () => {
    expect(functionKey("this is ( not code")).toBeNull();
  });
});

describe("functionRanges", () => {
  it("covers functions, methods and arrows, with methods from their name", () => {
    const code = "function a() {} const o = { m(x) { return 1; }, n: () => 2 }; class C { k() {} }";
    const found = functionRanges(parseJs(code)).map(([s, e]) => code.slice(s, e));
    expect(found).toContain("function a() {}");
    expect(found).toContain("m(x) { return 1; }");
    expect(found).toContain("() => 2");
    expect(found).toContain("k() {}");
    expect(found).toHaveLength(4);
  });

  it("adds a base offset", () => {
    expect(functionRanges(parseJs("function a() {}"), 100)).toEqual([[100, 115]]);
  });
});

describe("a finding's codeKey", () => {
  const download = (names: { fn: string; url: string; host: string }) => `
    function info() { return "https://${names.host}/x/y/releases/download/binary/copyfiles-mac"; }
    async function ${names.fn}(${names.url}, path) { const res = await fetch(${names.url}); const buf = await res.arrayBuffer(); await IOUtils.write(path, new Uint8Array(buf));
      await Subprocess.call({ command: "/bin/chmod", arguments: ["777", path] }); }
    async function run(path) { await Subprocess.call({ command: path, arguments: [] }); }`;
  const keyOf = async (source: string, large = false) => {
    // A file over 8 MB isn't fingerprinted for libraries, but its findings still get a codeKey.
    const padding = large ? `/*${"x".repeat(8 * 1024 * 1024 + 10)}*/\n` : "";
    const r = await scanFiles({ "content/index.js": padding + source });
    return capIn(r, "download-exec")?.codeKey;
  };

  it("is the same when the code differs only in local names", async () => {
    const a = await keyOf(download({ fn: "fetchTool", url: "address", host: "gitee.com" }));
    const b = await keyOf(download({ fn: "q", url: "u2", host: "gitee.com" }));
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  it("changes when the download's host changes", async () => {
    const a = await keyOf(download({ fn: "q", url: "u", host: "gitee.com" }));
    const b = await keyOf(download({ fn: "q", url: "u", host: "github.com" }));
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);
  });

  it("is written for a file over the 8 MB fingerprint limit", async () => {
    const small = await keyOf(download({ fn: "q", url: "u", host: "gitee.com" }));
    const large = await keyOf(download({ fn: "q", url: "u", host: "gitee.com" }), true);
    expect(large).toBe(small);
  });

  it("is left out when no hit sits inside a function", async () => {
    const r = await scanFiles({
      "content/index.js": 'Subprocess.call({ command: "/bin/sh", arguments: [] });',
    });
    expect(capIn(r, "process-launch")).toBeDefined();
    expect(capIn(r, "process-launch")?.codeKey).toBeUndefined();
  });
});
