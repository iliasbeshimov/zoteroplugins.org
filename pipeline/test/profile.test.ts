import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHostUsage, SandboxRecord } from "@atlas/schema";
import { beforeAll, describe, expect, it } from "vitest";
import type { CensusRow } from "../src/census/run.ts";
import { blockedBy, provenanceLite, reclassifyHosts, updateHostOf } from "../src/profile/checks.ts";
import {
  detectDocLanguages,
  linkedReadmeLanguages,
  normalizeLocale,
  uiLocales,
} from "../src/profile/languages.ts";
import {
  assignSlugs,
  type ListingInput,
  listingKind,
  resolveListing,
} from "../src/profile/listing.ts";
import { describeChange, type Snapshot } from "../src/profile/regress.ts";
import {
  finishCheck,
  hintsFrom,
  PROFILER_VERSION,
  stable,
  type UpdateCheck,
  unchangedRelease,
  writtenForAnotherFile,
} from "../src/profile/run.ts";
import { observedHosts, readSandboxRecord, withObserved } from "../src/profile/sandbox.ts";
import { compatibilityLabel, DS_CONCERN, score } from "../src/profile/score.ts";
import {
  matchesStatedHash,
  parseUpdateManifest,
  pickUpdate,
  statedHash,
  statedSha256,
} from "../src/profile/updates.ts";
import { analyzeXpi } from "../src/scan/analyze.ts";
import { classifyHost, type HostTable, loadHostTable } from "../src/scan/hosts.ts";

let table: HostTable;
beforeAll(async () => {
  table = await loadHostTable();
});

describe("README languages", () => {
  it("recognises English, Chinese and bilingual READMEs", () => {
    const en =
      "# Fixture\n\nThis plugin adds a button to the item pane. You can use it to copy the citation key of the selected item, and it works with any style.";
    const zh =
      "# 插件\n\n这个插件可以帮助你在 Zotero 中使用 OpenAI 和 DeepSeek 翻译论文，并把结果保存到笔记里。支持 PDF 阅读器中的划词翻译，也支持批量处理条目。";
    expect(detectDocLanguages(en)).toEqual(["en"]);
    expect(detectDocLanguages(zh)).toEqual(["zh"]);
    expect(detectDocLanguages(`${zh}\n\n${en}`).sort()).toEqual(["en", "zh"]);
  });

  it("tells Japanese from Chinese and ignores code, links and badges", () => {
    const ja =
      "このプラグインは、Zotero のアイテムから引用を作成します。選択したテキストを翻訳して、ノートに保存することができます。";
    expect(detectDocLanguages(ja)).toEqual(["ja"]);
    const noisy = `![build](https://img.shields.io/badge/x) [OpenAI](https://openai.com)\n\n\`\`\`js\nconst the = "and to of";\n\`\`\`\n${"中文说明文字，".repeat(20)}`;
    expect(detectDocLanguages(noisy)).toEqual(["zh"]);
  });

  it("finds a short English section among Chinese text full of product names", () => {
    const zh =
      "在 Zotero 中选中论文，右键 LLM Wiki Ingest，插件调用 OpenAI API 自动生成 Wiki 页面。".repeat(
        12,
      );
    const en =
      "## English\n\nSelect a paper in Zotero and the plugin will call an API that you choose. It builds a page for each paper and links it to the others, so you can browse what you have read. You can also ask it to update pages when you add notes, and it will keep your edits.";
    expect(detectDocLanguages(`${zh}\n\n${en}`).sort()).toEqual(["en", "zh"]);
  });

  it("doesn't mistake Spanish or Portuguese for English", () => {
    const es =
      "Un plugin de Zotero que agrega un panel editable en la barra lateral del lector de PDFs. Permite crear, renombrar, anidar, reordenar y borrar marcadores, y guardarlos a la biblioteca como notas.";
    const pt =
      "Plugin para o Zotero que formata as referências de acordo com as normas da universidade, com suporte da biblioteca e a comunidade acadêmica. As correções vão além do que o estilo consegue expressar.";
    expect(detectDocLanguages(es)).toEqual(["latin"]);
    expect(detectDocLanguages(pt)).toEqual(["latin"]);
  });

  it("returns nothing for a README too short to judge", () => {
    expect(detectDocLanguages("# zotero-foo\n\nWIP")).toEqual([]);
  });

  it("finds linked translations of the README", () => {
    const md =
      "[English](README_EN.md) | [简体中文](./README.md) | [日本語](docs/ja/README.md)\n[![CI](https://x/badge.svg)](https://x)\n[Guide](https://example.com/en)";
    expect(linkedReadmeLanguages(md)).toEqual(["en", "ja", "zh"]);
    expect(linkedReadmeLanguages("See [README.en.md](README.en.md)")).toEqual(["en"]);
    expect(linkedReadmeLanguages("[Download](https://github.com/o/r/releases)")).toEqual([]);
  });
});

describe("interface locales", () => {
  it("reads locale folders from the .xpi and normalises tags", () => {
    expect(
      uiLocales([
        "locale/en-US/addon.ftl",
        "locale/zh_CN/addon.ftl",
        "_locales/de/messages.json",
        "chrome/locale/zh-hans/main.dtd",
        "content/locale.js",
      ]),
    ).toEqual(["de", "en-US", "zh-CN", "zh-Hans"]);
    expect(normalizeLocale("pt_br")).toBe("pt-BR");
  });
});

const row = (over: Partial<CensusRow>): CensusRow =>
  ({ verdict: "zotero-plugin", sources: ["topic"], sheetToolType: null, ...over }) as CensusRow;

describe("listing", () => {
  it("lists confirmed plugins, legacy plugins and curated plugins without a release", () => {
    expect(listingKind(row({}))).toBe("plugin");
    expect(listingKind(row({ verdict: "zotero-plugin-legacy" }))).toBe("legacy");
    expect(listingKind(row({ verdict: "no-xpi-release", sources: ["sheet"] }))).toBe("no-release");
    expect(
      listingKind(row({ verdict: "no-xpi-release", sources: ["sheet"], sheetToolType: "Service" })),
    ).toBeNull();
    expect(listingKind(row({ verdict: "no-xpi-release", sources: ["topic"] }))).toBeNull();
    expect(listingKind(row({ verdict: "firefox-extension" }))).toBeNull();
  });

  it("keeps existing slugs and gives clashes an owner suffix", () => {
    const first = assignSlugs({}, ["A/zotero-gpt", "b/Zotero-GPT", "c/x"]);
    expect(first).toEqual({
      "a/zotero-gpt": "zotero-gpt",
      "b/zotero-gpt": "zotero-gpt--b",
      "c/x": "x-plugin",
    });
    const again = assignSlugs(first, ["z/zotero-gpt", "b/zotero-gpt"]);
    expect(again["b/zotero-gpt"]).toBe("zotero-gpt--b");
    expect(again["z/zotero-gpt"]).toBe("zotero-gpt--z");
  });

  it("hides forks behind the original unless they overtook it", () => {
    const base: Omit<ListingInput, "repo" | "slug"> = {
      kind: "plugin",
      isFork: false,
      parent: null,
      downloads: 1000,
      maintenance: "active",
      addonId: "same@id",
    };
    const res = resolveListing([
      { ...base, repo: "o/orig", slug: "orig" },
      { ...base, repo: "f/fork", slug: "fork", isFork: true, parent: "o/orig", downloads: 10 },
      { ...base, repo: "g/fork", slug: "fork2", isFork: true, parent: "O/Orig", downloads: 5000 },
      { ...base, repo: "l/old", slug: "old", kind: "legacy", addonId: null },
    ]);
    expect(res.get("f/fork")).toMatchObject({ hiddenByDefault: true, hiddenReason: "fork" });
    expect(res.get("g/fork")).toMatchObject({ hiddenByDefault: false, fork: { ofSlug: "orig" } });
    expect(res.get("o/orig")?.forks).toEqual(["fork", "fork2"]);
    expect(res.get("o/orig")?.addonIdSharedWith).toEqual(["fork", "fork2"]);
    expect(res.get("l/old")).toMatchObject({ hiddenReason: "legacy", addonIdSharedWith: [] });
  });
});

describe("Zotero blocklist", () => {
  const list = {
    version: 1,
    blockedPlugins: [
      {
        id: "better-bibtex@iris-advies.com",
        versionRanges: [{ maxVersion: "8.999" }],
        reason: "hangs",
      },
    ],
  };
  it("matches the add-on ID and version range", () => {
    expect(blockedBy(list, "Better-BibTeX@iris-advies.com", "8.2.1")?.reason).toBe("hangs");
    expect(blockedBy(list, "better-bibtex@iris-advies.com", "9.0.1")).toBeNull();
    expect(blockedBy(list, "other@x", "1.0")).toBeNull();
  });
});

describe("source match, first pass", () => {
  const at = "2026-09-25T00:00:00Z";
  it("counts a GitHub Actions upload as built from the repository, unless obfuscated", () => {
    const ci = provenanceLite({
      uploader: "github-actions[bot]",
      attestation: { present: false },
      obfuscated: false,
      checkedAt: at,
    });
    expect(ci.level).toBe("plausible");
    expect(ci.explanation).toContain("automated GitHub build");
    const hidden = provenanceLite({
      uploader: "github-actions[bot]",
      attestation: { present: true },
      obfuscated: true,
      checkedAt: at,
    });
    expect(hidden.level).toBe("not-checked");
    expect(hidden.attestation).toEqual({ present: true, verified: false });
    const manual = provenanceLite({
      uploader: "someone",
      attestation: { present: false },
      obfuscated: false,
      checkedAt: at,
    });
    expect(manual.level).toBe("not-checked");
    expect(manual.explanation).toContain("someone account");
    expect(manual.explanation).not.toMatch(/verified|safe|secure/i);
  });

  it("says when a workflow made the release but a person uploaded the file (ccf-rank)", () => {
    const swapped = provenanceLite({
      uploader: "someone",
      releaseAuthor: "github-actions[bot]",
      attestation: { present: false },
      obfuscated: false,
      checkedAt: at,
    });
    expect(swapped.level).toBe("not-checked");
    expect(swapped.explanation).toMatch(
      /^The release was created by an automated GitHub workflow, but this file was uploaded afterwards from the someone account\./,
    );
    // Which account uploaded it is known; that a person did it by hand isn't (three files from the
    // developer's account in the same second, zotero-bookmark-editor).
    expect(swapped.explanation).not.toMatch(/by hand/);
    // Information only: the workflow's own upload, or a person's release, reads as before.
    const ci = provenanceLite({
      uploader: "github-actions[bot]",
      releaseAuthor: "github-actions[bot]",
      attestation: { present: false },
      obfuscated: false,
      checkedAt: at,
    });
    expect(ci.level).toBe("plausible");
    expect(ci.explanation).toContain("uploaded by the project's automated GitHub build");
    const person = provenanceLite({
      uploader: "someone",
      releaseAuthor: "someone",
      attestation: { present: false },
      obfuscated: false,
      checkedAt: at,
    });
    expect(person.explanation).toContain("The developer uploaded the release file");
  });
});

// ------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
function analyze(code: string, updateUrl?: string) {
  const manifest = JSON.stringify({
    manifest_version: 2,
    name: "Fixture",
    version: "1.0.0",
    applications: {
      zotero: {
        id: "fixture@example.org",
        strict_min_version: "6.999",
        strict_max_version: "10.*",
        ...(updateUrl ? { update_url: updateUrl } : {}),
      },
    },
  });
  return analyzeXpi({
    slug: "fixture",
    sha256: "b".repeat(64),
    entries: [
      { path: "manifest.json", data: enc.encode(manifest) },
      { path: "content/index.js", data: enc.encode(code) },
    ],
    table,
    analyzedAt: "2026-09-25T00:00:00Z",
  }).analysis;
}

const compat = {
  current: { major: 10, zoteroVersion: "10.0.4", status: "compatible" as const },
  previous: null,
  next: null,
  blockedByZotero: null,
};
const cardFor = (code: string, over: Partial<Parameters<typeof score>[0]> = {}) =>
  score({
    analysis: analyze(code),
    updateHost: null,
    provenance: provenanceLite({
      uploader: null,
      attestation: { present: false },
      obfuscated: false,
      checkedAt: "2026-09-25T00:00:00Z",
    }),
    assetReplaced: false,
    maintenance: { status: "active", lastReleaseAt: null, lastCommitAt: null },
    compatibility: compat,
    currentZotero: "10.0.4",
    computedAt: "2026-09-25T00:00:00Z",
    ...over,
  });

describe("scorecard", () => {
  const openai = `fetch("https://api.openai.com/v1/chat/completions", { method: "POST" });`;

  it("labels a plugin that only calls a named AI service as few concerns", () => {
    const card = cardFor(openai);
    expect(card.facets.dataSharing.value).toBe("named-third-parties");
    expect(card.facets.dataSharing.label).toBe("Only contacts services we could identify");
    // "Source match not checked yet" shows on the facet but doesn't drive the label.
    expect(card.facets.sourceTransparency.drivers).toEqual(["ST-NOT-CHECKED"]);
    expect(card.facets.sourceTransparency.concern).toBe("unknown");
    expect(card.overall).toEqual({ label: "low-concern", ruleId: "OV-LOW", drivers: [] });
  });

  it("marks obfuscated code as serious, and a replaced release file for review", () => {
    const names = Array.from(
      { length: 60 },
      (_, i) => `var _0x${(0x1a2b + i).toString(16)} = ${i};`,
    );
    const obf = `var _0x4f2a = [${Array.from({ length: 40 }, (_, i) => `'s${i}'`).join(",")}];
      (function (_0x1f, _0x2e) { while (--_0x2e) { _0x1f['push'](_0x1f['shift']()); } })(_0x4f2a, 0x1f4);
      ${names.join("\n")} eval(atob(_0x4f2a[0]));`;
    const bad = cardFor(obf);
    expect(bad.overall.label).toBe("high-concern");
    expect(bad.overall.drivers).toContain("sourceTransparency");
    expect(bad.facets.sourceTransparency.label).toBe(
      "Obfuscated code: deliberately scrambled, so we couldn't check all of it",
    );
    const replaced = cardFor(openai, { assetReplaced: true });
    expect(replaced.overall).toMatchObject({
      label: "review-details",
      drivers: ["sourceTransparency"],
    });
  });

  it("changes its input hash only when an input changes", () => {
    const a = cardFor(openai);
    const b = cardFor(openai, { computedAt: "2027-01-01T00:00:00Z" });
    const c = cardFor(openai, {
      maintenance: { status: "dormant", lastReleaseAt: null, lastCommitAt: null },
    });
    expect(b.inputs.inputHash).toBe(a.inputs.inputHash);
    expect(c.inputs.inputHash).not.toBe(a.inputs.inputHash);
  });

  it("says a companion it hands data to is one we can't check, and what it hands over (C39)", () => {
    const companion = (description: string, code: string) =>
      cardFor("", {
        analysis: analyzeXpi({
          slug: "fixture",
          sha256: "b".repeat(64),
          entries: [
            {
              path: "manifest.json",
              data: enc.encode(
                JSON.stringify({
                  manifest_version: 2,
                  name: "Fixture",
                  version: "1.0.0",
                  description,
                  applications: {
                    zotero: { id: "fixture@example.org", strict_min_version: "6.999" },
                  },
                }),
              ),
            },
            { path: "content/index.js", data: enc.encode(code) },
          ],
          table,
          analyzedAt: "2026-09-25T00:00:00Z",
        }).analysis,
      });
    const card = companion(
      "Use UtterMux voices with Zotero Read Aloud.",
      `const BRIDGE = "http://127.0.0.1:8766"; fetch(BRIDGE + "/speak", { method: "POST", body: text });`,
    );
    expect(card.facets.dataSharing.value).toBe("unknown-endpoints");
    // Nothing says what `text` is: "your data".
    expect(card.facets.dataSharing.label).toBe(
      "Hands your data to UtterMux; we can't check where it goes from there",
    );
    // DS-UNKNOWN-HANDOFF is medium, not "unknown".
    expect(card.facets.dataSharing.concern).toBe("medium");
    expect(card.overall.label).toBe("review-details");
    // A PDF's text: "your documents".
    const pdf = companion(
      "Use UtterMux voices with Zotero Read Aloud.",
      `const BRIDGE = "http://127.0.0.1:8766";
       async function speak(item) {
         const text = await Zotero.PDFWorker.getFullText(item.id);
         return fetch(BRIDGE + "/speak", { method: "POST", body: text }); }`,
    );
    expect(pdf.facets.dataSharing.label).toBe(
      "Hands your documents to UtterMux; we can't check where they go from there",
    );
    // An image path, whenever Zotero adds an annotation: "your data", "automatically".
    const piclist = companion(
      "Upload annotation images to an image host via PicList",
      `function startup() {
         Zotero.Notifier.registerObserver({ notify: async (event, type, ids) => {
           for (const id of ids) await uploadAnnotation(Zotero.Items.get(id)); } }, ["item"]); }
       async function uploadAnnotation(item) { return piclistUpload(await imagePath(item)); }
       function piclistUpload(filePath) {
         Zotero.debug("sending to PicList");
         return fetch("http://127.0.0.1:36677/upload", { method: "POST", body: JSON.stringify({ list: [filePath] }) }); }`,
    );
    expect(piclist.facets.dataSharing.label).toBe(
      "Hands your data to PicList automatically; we can't check where it goes from there",
    );
  });

  it("has a concern for every data-sharing rule preview.ts fires", async () => {
    const src = await readFile(new URL("../src/scan/preview.ts", import.meta.url), "utf8");
    const fired = [...src.matchAll(/fire\("(DS-[A-Z-]+)",\s*"(\w+)"\)/g)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    );
    expect(fired.length).toBeGreaterThanOrEqual(10);
    for (const [rule, concern] of fired) expect(DS_CONCERN[rule], rule).toBe(concern);
  });

  it("lists CAP-MINOR once among the capability rules when its capabilities match", () => {
    const card = cardFor(
      `navigator.clipboard.writeText(x); IOUtils.read(p); Zotero.Prefs.get("extensions.x.apiKey");`,
    );
    expect(card.facets.capabilities.concern).toBe("low");
    expect(card.facets.capabilities.drivers).toEqual(["CAP-MINOR"]);
  });

  it("puts web search and page-reading APIs in one category, not with AI model providers", () => {
    for (const h of [
      "api.firecrawl.dev",
      "api.exa.ai",
      "api.metaphor.systems",
      "api.tavily.com",
      "google.serper.dev",
      "serpapi.com",
      "api.search.brave.com",
      "r.jina.ai",
      "s.jina.ai",
    ])
      expect(classifyHost(table, h)?.category, h).toBe("integration");
  });

  it("derives requirement hints from what the code contacts", () => {
    const h = hintsFrom(
      analyze(
        `${openai}\nfetch("http://localhost:11434/api/generate"); Zotero.Prefs.set("apiKey", k);`,
      ),
    );
    expect(h.aiServices).toEqual(["OpenAI"]);
    expect(h.localModels).toBe(true);
  });
});

describe("badge wording for package installs and sent code", () => {
  const badge = (code: string, id: string) =>
    cardFor(code).facets.capabilities.badges.find((b) => b.id === id);

  it("says how package installs are pinned and when they run", () => {
    const latest = badge(
      `async function ensureEnv() { await run(npmPath, ["install", "-g", "@openai/codex@latest"]); }
       async function onStartup() { await ensureEnv(); } Subprocess.call({ command: p, arguments: [] });`,
      "package-run",
    );
    expect(latest).toMatchObject({
      concern: "high",
      label: "Installs and runs npm or PyPI packages without a fixed version",
      detail: "@openai/codex: installs the newest version each time, at startup, without asking",
    });
    // Behind an "already installed" check it installs once (paperviewzoteroplugin's venv).
    const once = badge(
      `async function ensureEnvReady() { if (!fileExists(envPython)) {
         await runProcessChecked(envPython, ["-m", "pip", "install", "requests"]); } }
       async function onStartup() { await ensureEnvReady(); } Subprocess.call({ command: p, arguments: [] });`,
      "package-run",
    );
    expect(once?.detail).toBe(
      "requests: installs whatever version is newest when it installs them, at startup, without asking",
    );
    // The overall reason says why it's serious.
    const card = cardFor(
      `async function ensureEnv() { await run(npmPath, ["install", "-g", "@openai/codex@latest"]); }
       Subprocess.call({ command: p, arguments: [] });`,
    );
    expect(card.overall.reasons).toContain(
      "Installs and runs npm or PyPI packages without a fixed version",
    );
    const fixed = badge(
      `Subprocess.call({ command: npxPath, arguments: ["--yes", "--package", "pi-acp@0.0.33", "pi-acp"] });`,
      "package-run",
    );
    expect(fixed).toMatchObject({
      concern: "medium",
      label: "Installs and runs software packages from npm or PyPI",
      detail: "pi-acp 0.0.33: installs a fixed version; its own dependencies can still change",
    });
    const locked = badge(
      `Subprocess.call({ command: py, arguments: ["-m", "pip", "install", "--no-deps", "mineru==4.0.0"] });`,
      "package-run",
    );
    expect(locked?.detail).toBe("Installs a locked set of packages");
  });

  it("names who writes the code it runs, and whether each run is approved", () => {
    const endpoint = badge(
      `function handle(data) { const code = data.code; return new AsyncFunction("Zotero", code)(Zotero); }
       Zotero.Server.Endpoints["/write"] = E; const op = "run_javascript";`,
      "runs-sent-code",
    );
    expect(endpoint).toMatchObject({
      label: "Runs code other programs on this computer send it",
      concern: "medium",
    });
    expect(endpoint?.detail).toBeUndefined();
    const assistant = badge(
      `const tool = { spec: { name: "zotero_script" }, shouldRequireConfirmation() { return false; },
         execute(params) { return new AsyncFunction("Zotero", params.script)(Zotero); } };
       for (const c of message.tool_calls) run(c);`,
      "runs-sent-code",
    );
    expect(assistant).toMatchObject({
      label: "Runs code its AI assistant writes, with full access to Zotero",
      concern: "high",
      detail: "It can run without showing you the code first",
    });
    const shell = badge(
      `const tool = { name: "run_command", requiresConfirmation: true, execute: (a) => Subprocess.call({ command: "/bin/sh", arguments: ["-c", a.command] }) };
       for (const c of message.tool_calls) run(c);`,
      "runs-sent-code",
    );
    expect(shell).toMatchObject({
      label: "Runs commands its AI assistant writes, with full access to your computer",
      concern: "medium",
      detail: "It shows you the code and asks before each run",
    });
  });

  it("says when it copies a browser's sign-in cookies into a browser it starts", () => {
    const code = `function copyRealEdgeCookies(profile) {
        const real = \`\${getLocalAppDataPath()}\\\\Microsoft\\\\Edge\\\\User Data\`;
        copyFile(\`\${real}\\\\Default\\\\Network\\\\Cookies\`, \`\${profile}\\\\Default\\\\Network\\\\Cookies\`); }
      function launchEdge(profile, url) {
        copyRealEdgeCookies(profile);
        Subprocess.call({ command: edge, arguments: [\`--user-data-dir=\${profile}\`, url] }); }`;
    expect(badge(code, "browser-credentials")).toMatchObject({
      concern: "high",
      detail:
        "Copies your Microsoft Edge sign-in cookies into a browser it controls, which is then signed into every site you're signed into there",
    });
    const read = `const p = \`\${home}/Library/Application Support/Google/Chrome/Default/Network/Cookies\`;
      const db = Services.storage.openUnsharedDatabase(pathToFile(p));`;
    expect(badge(read, "browser-credentials")?.detail).toBe(
      "Reads the sign-in cookies saved in Google Chrome, which cover every site you're signed into there",
    );
  });

  it("adds how an AI coding agent is started to the launch badge", () => {
    const launch = badge(
      `const args = ["-p", q, "--permission-mode", s.mode ?? "acceptEdits"];
       if (yolo) args.push("--dangerously-skip-permissions");
       Subprocess.call({ command: "claude", arguments: args });`,
      "process-launch",
    );
    expect(launch).toMatchObject({
      concern: "medium",
      detail:
        "Programs it names include claude; runs Claude Code with file edits accepted automatically; a setting lets Claude Code run without asking",
    });
  });
});

describe("badge wording for a server it runs itself (C3)", () => {
  const badge = (code: string) =>
    cardFor(code).facets.capabilities.badges.find((b) => b.id === "own-server");
  const server = (tool: string) => `
    function start() {
      const s = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      s.init(23124, true, -1);
      s.asyncListen({ onSocketAccepted(socket, transport) { handle(read(transport)); } }); }
    async function handle(text) { const req = JSON.parse(text.slice(text.indexOf("\\r\\n\\r\\n") + 4)); if (req.method === "tools/call") return addTag(req.params.arguments); }
    async function addTag(args) { ${tool} const item = Zotero.Items.get(args.id); item.addTag(args.tag); await item.saveTx(); }`;

  it("says any website can make it act, what it can do, and the setting it waits for", () => {
    expect(badge(server(""))).toMatchObject({
      label:
        "Any website you visit can make it act through its local server: it doesn't check where requests come from",
      concern: "high",
      detail: "A website can make it change your library",
    });
    expect(
      badge(
        server(
          `if (Zotero.Prefs.get("extensions.zotero.fixture.write.enabled", true) !== true) return;`,
        ),
      ),
    ).toMatchObject({
      concern: "medium",
      detail:
        'A website can make it change your library, only while its "write.enabled" setting is on (it\'s off by default)',
    });
    // A level allows rather than turns on; the label no longer says a setting opens it to the network.
    expect(
      badge(
        server(
          `if (String(settings.get("dangerous.writeLevel") || "readonly") === "readonly") return;`,
        ).replace("s.init(23124, true, -1)", "s.init(23124, !allowRemote, -1)"),
      )?.detail,
    ).toBe(
      'A website can make it change your library, only when its "writeLevel" setting allows it (it doesn\'t by default); a setting can also open it to your network',
    );
    // One that only answers keeps the plain wording.
    expect(
      badge(`const s = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
        s.init(23124, true, -1); s.asyncListen({ onSocketAccepted(socket, t) { reply(t, "pong"); } });`),
    ).toMatchObject({ label: "Runs its own server for programs on this computer", concern: "low" });
  });
});

describe("badge wording from the review of C1-C3", () => {
  const badge = (code: string, id: string, over: Partial<Parameters<typeof score>[0]> = {}) =>
    cardFor(code, over).facets.capabilities.badges.find((b) => b.id === id);
  const socket = (handler: string) => `
    function start() {
      const s = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      s.init(23124, true, -1);
      s.asyncListen({ onSocketAccepted(socket, transport) { handle(read(transport)); } }); }
    ${handler}`;
  const tagByKey = (gate = "") =>
    socket(`async function handle(text) { const req = JSON.parse(text.slice(text.indexOf("\\r\\n\\r\\n") + 4)); if (req.method === "tools/call") return addTag(req.params.arguments); }
      async function addTag(args) { ${gate} const item = Zotero.Items.getByLibraryAndKey(1, args.key); item.addTag(args.tag); await item.saveTx(); }`);

  it("says a website needs an item's key when every change its server makes needs one", () => {
    expect(badge(tagByKey(), "own-server")).toMatchObject({
      label:
        "A website that knows an item's key could make it change your library through its local server",
      concern: "medium",
      detail:
        "A website can make it change your library, but only if it knows an item's key (the ID Zotero gives each item)",
    });
    // Behind a write setting too: two steps lower, still worded as what a website can do.
    expect(
      badge(
        tagByKey(
          `if (Zotero.Prefs.get("extensions.zotero.fixture.write.enabled", true) !== true) return;`,
        ),
        "own-server",
      ),
    ).toMatchObject({
      label:
        "A website that knows an item's key could make it change your library through its local server",
      concern: "low",
      detail:
        "A website can make it change your library, only while its \"write.enabled\" setting is on (it's off by default) and only if it knows an item's key (the ID Zotero gives each item)",
    });
    // zotero-ai-summary: a web page can reach its endpoint, but must name the note it overwrites.
    expect(
      badge(
        `Zotero.Server.Endpoints["/x/note"] = class { supportedMethods = ["PUT"]; supportedDataTypes = ["text/plain"];
           allowRequestsFromUnsafeWebContent = true;
           async init(req) { const note = await Zotero.Items.getByLibraryAndKeyAsync(1, req.data.key); note.setNote(req.data.html); await note.saveTx(); } };`,
        "server-edits-library",
      ),
    ).toMatchObject({
      label: "A website that knows an item's key could change your library through it",
      concern: "medium",
      detail:
        "A website would need to know an item's key (the ID Zotero gives each item) to change it",
    });
  });

  it("says whose code a website makes it run", () => {
    expect(
      badge(
        socket(
          `function handle(data) { const code = data.slice(data.indexOf("\\r\\n\\r\\n") + 4); const fn = new Function("Zotero", code); fn(Zotero); }`,
        ),
        "own-server",
      )?.detail,
    ).toBe("A website can make it run code the site sends");
  });

  it("says a socket listens on the network by default when its setting's default is to", () => {
    const code = socket(
      `async function handle(text) { const item = Zotero.Items.get(Number(text)); item.addTag("x"); await item.saveTx(); }`,
    ).replace("s.init(23124, true, -1)", "s.init(23124, !allowRemote, -1)");
    const wide = (analysis: ReturnType<typeof analyze>) => {
      const own = analysis.capabilities.find((c) => c.id === "own-server");
      if (own?.details?.apis)
        own.details.apis = own.details.apis.map((x) =>
          x === "can listen beyond this computer (a setting)"
            ? "listens beyond this computer by default (a setting)"
            : x,
        );
      return analysis;
    };
    expect(badge(code, "own-server", { analysis: wide(analyze(code)) })?.detail).toBe(
      "A website can make it change your library; it listens on your network by default",
    );
    const quiet = socket(`function handle(text) { reply("pong"); }`).replace(
      "s.init(23124, true, -1)",
      "s.init(23124, !allowRemote, -1)",
    );
    expect(badge(quiet, "own-server", { analysis: wide(analyze(quiet)) })).toMatchObject({
      label: "Runs a server other computers on your network can reach",
      concern: "medium",
      detail: "It listens on your network by default",
    });
    // A setting whose default keeps it on this computer keeps the setting wording.
    expect(badge(quiet, "own-server")).toMatchObject({
      label: "Runs a local server; a setting (off by default) opens it to your network",
    });
  });
});

describe("badge wording for Zotero's built-in server", () => {
  const badge = (code: string, id: string) =>
    cardFor(code).facets.capabilities.badges.find((b) => b.id === id);

  it("says who can change the library through an endpoint, and which setting it waits for", () => {
    const local = badge(
      `Zotero.Server.Endpoints["/x/tag"] = class { async init(req) { item.addTag(req.data.tag); await item.saveTx(); } };`,
      "server-edits-library",
    );
    expect(local).toMatchObject({
      label: "Other programs on this computer can change your library through it",
      concern: "low",
    });
    const web = badge(
      `Zotero.Server.Endpoints["/x/tag"] = class { supportedMethods = ["POST"]; supportedDataTypes = ["text/plain"];
         allowRequestsFromUnsafeWebContent = true; async init(req) { await item.saveTx(); } };`,
      "server-edits-library",
    );
    expect(web).toMatchObject({
      label: "Any website you visit can change your library through it",
      concern: "high",
    });
    const localApi = badge(
      `Zotero.Server.LocalAPI.Add = class extends Zotero.Server.LocalAPI.Schema { async run(req) { await item.saveTx(); } };
       Zotero.Server.Endpoints["/api/plus/add"] = Zotero.Server.LocalAPI.Add;`,
      "server-edits-library",
    );
    expect(localApi).toMatchObject({
      concern: "none",
      detail: "Only while Zotero's local API is turned on (it's off by default)",
    });
  });

  it("describes a patch that opens every endpoint to the websites you approve", () => {
    const opened = badge(
      `function ask(origin) { Services.prompt.confirmEx(null, "Connect", origin, 0, "Allow", "Deny", null, null, {}); }
       const proto = Zotero.Server.RequestHandler.prototype; const orig = proto._generateResponse;
       proto._generateResponse = function (s, t, b) { const out = orig.call(this, s, t, b);
         if (approved.has(this.origin)) return out + "Access-Control-Allow-Origin: " + this.origin + " Access-Control-Allow-Headers: Zotero-Allowed-Request"; ask(this.origin); return out; };`,
      "local-http-server",
    );
    expect(opened).toMatchObject({
      label:
        "Lets websites you approve use Zotero's built-in server, including other plugins' endpoints",
      concern: "medium",
    });
    expect(opened?.detail).toMatch(/^It asks once per website/);
  });

  it("names turning Zotero's server back on apart from turning on its local API", () => {
    expect(
      badge(`Zotero.Prefs.set("httpServer.enabled", true);`, "changes-settings"),
    ).toMatchObject({
      label: "Changes Zotero settings that aren't its own",
      concern: "low",
      detail: "Turns Zotero's built-in server back on if you've turned it off",
    });
    expect(
      badge(`Zotero.Prefs.set("httpServer.localAPI.enabled", true);`, "enables-local-api")?.label,
    ).toBe("Turns on Zotero's local API, so programs on this computer can read your library");
  });
});

describe("badge wording for settings changes", () => {
  const badge = (code: string) =>
    cardFor(code).facets.capabilities.badges.find((b) => b.id === "changes-settings");

  it("says what it changes in another program, whether it asks, and the setting it waits for", () => {
    const cert = badge(
      `async function trust() { if (!Services.prompt.confirm(null, "x", "Trust?")) return;
         await Subprocess.call({ command: "/usr/bin/security", arguments: ["add-trusted-cert", "-r", "trustRoot", ca] }); }
       async function init() { if (!getPref("httpsProxyEnabled")) return; await trust(); }
       function startup() { init(); }`,
    );
    expect(cert).toMatchObject({
      label: "Changes settings in other programs or on your computer",
      concern: "medium",
      detail:
        "Adds a certificate to your Mac's trusted certificates, after asking you, only while its \"httpsProxyEnabled\" setting is on (it's off by default)",
    });
    const zotero = badge(
      `function onStartup() { Services.prefs.setIntPref("network.proxy.type", 1); }
       btn.addEventListener("click", () => Zotero.Prefs.set("network.protocol-handler.warn-external.obsidian", false, true));`,
    );
    expect(zotero).toMatchObject({
      label: "Changes Zotero settings that aren't its own",
      concern: "medium",
      detail:
        "Changes Zotero's proxy settings, at startup, without asking; stops Zotero asking before it opens obsidian:// links in other apps",
    });
  });
});

describe("badge wording for data sent over plain http", () => {
  const badge = (code: string) =>
    cardFor(code).facets.capabilities.badges.find((b) => b.id === "sends-unencrypted");

  it("names where text goes unencrypted, a fallback, and lookups apart", () => {
    const card = cardFor(
      `var ENDPOINTS = ["https://pro.fixture-dev.xyz/v1/activate", "http://124.156.114.124:5000/v1/activate"];
       async function activate(user) { for (const url of ENDPOINTS) await fetch(url, { method: "POST", body: JSON.stringify({ zotero: user.uid }) }); }
       fetch("http://fanyi.youdao.com/translate?i=" + encodeURIComponent(selection), {});
       fetch("http://export.arxiv.org/api/query?id_list=" + encodeURIComponent(arxivId), {});`,
    );
    expect(card.facets.capabilities.badges.find((b) => b.id === "sends-unencrypted")).toMatchObject(
      {
        label:
          "Sends your text or keys unencrypted (http://) to 124.156.114.124 and fanyi.youdao.com",
        concern: "medium",
        detail:
          "To 124.156.114.124 only if its https servers can't be reached, which someone on your network can arrange; only lookups, such as a DOI, to export.arxiv.org; anyone on the network in between can read it",
      },
    );
    const hosts = card.facets.dataSharing.hosts;
    expect(hosts.find((h) => h.category === "translation")?.unencrypted).toEqual([
      "fanyi.youdao.com",
    ]);
    // The https server before it isn't marked.
    expect(hosts.find((h) => h.category === "unknown")).toMatchObject({
      hosts: ["124.156.114.124", "pro.fixture-dev.xyz"],
      unencrypted: ["124.156.114.124"],
    });
    expect(
      badge(`fetch("http://sru.hebis.de/sru?query=" + encodeURIComponent(isbn), {});`),
    ).toMatchObject({
      label: "Sends lookups unencrypted (http://) to sru.hebis.de",
      concern: "low",
      detail:
        "Only public identifiers, titles or search terms, such as a DOI or an ISBN; anyone on the network in between can read it",
    });
  });
});

describe("badge wording for add-on installs", () => {
  const feed = "https://github.com/fixture/plugin/releases/download/release/update.json";
  const badge = (code: string, id: string, updateUrl?: string) =>
    cardFor("", { analysis: analyze(code, updateUrl) }).facets.capabilities.badges.find(
      (b) => b.id === id,
    );

  it("says where installs come from, whether it asks, and what's checked", () => {
    const market = badge(
      `const XPI_BASE_URL = "https://ftp.zotero-chinese.com/addons/";
       class Api { constructor() { this.baseUrl = "https://soil.fixture-dev.top"; }
         downloadUrl(id) { return \`\${this.baseUrl}/v1/plugins/\${id}/download\`; } xpiUrl(p) { return XPI_BASE_URL + p; } }
       async function installAddonFromUrl(url) { const install = await AddonManager.getInstallForURL(url); await install.install(); }`,
      "installs-addons",
    );
    expect(market).toMatchObject({
      concern: "medium",
      detail: "From its catalogue at soil.fixture-dev.top via ftp.zotero-chinese.com",
    });
    const silent = badge(
      `const PROXIES = ["https://gh-proxy.org/"];
       async function installAddonFrom(url) { const install = await AddonManager.getInstallForURL(url); await install.install(); }
       async function runSelfUpdateCheck() { const update = await latest(); for (const u of [update.update_link, PROXIES[0] + update.update_link]) await installAddonFrom(u); }
       async function onStartup() { await runSelfUpdateCheck(); }`,
      "self-installs",
      feed,
    );
    expect(silent).toMatchObject({
      concern: "high",
      detail:
        "From its own update feed at github.com via gh-proxy.org, by itself, not checked against a hash",
    });
    const backup = badge(
      `async function restoreFromFile(zip) { await unzip(zip, tmp); for (const a of backupPrefs.addons) (await AddonManager.getInstallForFile(xpiOf(a))).install(); }`,
      "installs-addons",
    );
    expect(backup).toMatchObject({
      concern: "low",
      detail: "Every add-on in a backup file you pick",
    });
    const agent = badge(
      `async function installFromUrl(url) { const install = await AddonManager.getInstallForURL(url); await install.install(); }
       function handleToolCall(name, args) { switch (name) { case "install_plugin_from_url": {
         const on = Zotero.Prefs.get("extensions.zotero.agent.eval.enabled", true); if (on !== true) throw new Error("off");
         return installFromUrl(args.url); } } }
       const methods = ["tools/call"];`,
      "installs-addons",
    );
    expect(agent).toMatchObject({
      concern: "medium",
      detail:
        'From an address another program or an AI tool sends, without asking, only while its "eval.enabled" setting is on (it\'s off by default)',
    });
  });

  it("notes when it turns Zotero's automatic updates on for itself at startup", () => {
    const card = cardFor("", {
      analysis: analyze(
        `async function onStartup() { const addon = await AddonManager.getAddonByID(id); addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_ENABLE; }`,
        feed,
      ),
      updateSource: {
        kind: "this-project",
        label: "Updates come from this project's GitHub repository",
      },
    });
    expect(card.facets.sourceTransparency.updates?.note).toBe(
      "It turns Zotero's automatic updates on for itself at every start, even if you turned them off",
    );
    expect(card.overall.label).toBe("low-concern");
  });
});

describe("compatibility line", () => {
  const t = (status: "compatible" | "incompatible" | "unknown", major: number) => ({
    major,
    zoteroVersion: `${major}.0`,
    status,
  });
  it("says whether current Zotero runs it, apart from the overall label", () => {
    expect(compatibilityLabel(compat)).toBe("Works with Zotero 10");
    expect(
      compatibilityLabel({
        ...compat,
        current: t("incompatible", 10),
        previous: t("compatible", 9),
      }),
    ).toBe("Doesn't work with Zotero 10; works with Zotero 9");
    expect(
      compatibilityLabel({
        ...compat,
        current: t("incompatible", 10),
        previous: t("incompatible", 9),
        next: t("compatible", 11),
      }),
    ).toBe("Doesn't work with Zotero 10; made for Zotero 11 (in development)");
    expect(
      compatibilityLabel({ ...compat, blockedByZotero: { reason: "crashes", source: "x" } }),
    ).toBe("Blocked by Zotero: crashes");
    const card = cardFor(`const x = 1;`, {
      compatibility: { ...compat, current: t("incompatible", 10), previous: t("compatible", 9) },
    });
    expect(card.facets.compatibility.label).toBe(
      "Doesn't work with Zotero 10; works with Zotero 9",
    );
    expect(card.overall.label).toBe("low-concern");
  });

  const none = {
    ...compat,
    current: { ...compat.current, status: "incompatible" as const },
    previous: t("incompatible", 9),
    next: t("incompatible", 11),
  };

  it("names the version when it runs on another Zotero 10 but not the current one", () => {
    // zotero-trackpad-navigation: strict_max_version 10.0.2.
    expect(
      compatibilityLabel({ ...none, supported: [10], range: { min: "10.0.1", max: "10.0.2" } }),
    ).toBe("Doesn't work with Zotero 10.0.4; it stops at Zotero 10.0.2");
    expect(
      compatibilityLabel({ ...none, supported: [10], range: { min: "10.1", max: null } }),
    ).toBe("Doesn't work with Zotero 10.0.4; it needs Zotero 10.1 or later");
    // zotlite: 6.999 to 10.0, which is 10.0.0.
    expect(
      compatibilityLabel({
        ...none,
        previous: t("compatible", 9),
        supported: [7, 8, 9, 10],
        range: { min: "6.999", max: "10.0" },
      }),
    ).toBe("Doesn't work with Zotero 10.0.4; works with Zotero 9");
    // A range that ends before Zotero 10 still names the major.
    expect(compatibilityLabel({ ...none, supported: [7, 8] })).toBe(
      "Doesn't work with Zotero 10; made for Zotero 7–8",
    );
  });

  it("names the next major when its minimum is past the dev build", () => {
    // strict_min_version "11.0": Zotero 11.0-dev.5 comes before it, but it's no older plugin.
    expect(compatibilityLabel({ ...none, supported: [11] })).toBe(
      "Doesn't work with Zotero 10; made for Zotero 11 (in development)",
    );
  });

  it("says why Zotero won't install the file, whatever its range", () => {
    const refused = (installProblem: "invalid-id" | "no-update-url" | "no-max-version") =>
      compatibilityLabel({ ...none, supported: [], installProblem });
    expect(refused("no-update-url")).toBe(
      "Zotero won't install this file: its manifest has no update address, which Zotero requires",
    );
    expect(refused("invalid-id")).toBe(
      "Zotero won't install this file: its add-on ID isn't in a form Zotero accepts",
    );
    expect(refused("no-max-version")).toBe(
      "Zotero won't install this file: its manifest has no maximum Zotero version, which Zotero requires",
    );
    // The facet carries the reason; the overall label stays about the code.
    const card = cardFor(`const x = 1;`, {
      compatibility: { ...none, supported: [], installProblem: "no-update-url" },
    });
    expect(card.facets.compatibility).toMatchObject({
      installProblem: "no-update-url",
      concern: "high",
      current: { status: "incompatible" },
    });
    expect(card.overall.label).toBe("low-concern");
    expect(cardFor(`const x = 1;`).facets.compatibility.installProblem).toBeUndefined();
  });
});

describe("update manifests", () => {
  const manifest = JSON.stringify({
    addons: {
      "Fixture@Example.org": {
        updates: [
          {
            version: "1.0.0",
            update_link: "https://example.org/1.0.0.xpi",
            applications: { zotero: { strict_min_version: "6.999", strict_max_version: "9.*" } },
          },
          {
            version: "2.0.0",
            update_link: "https://example.org/2.0.0.xpi",
            update_hash: `sha256:${"A".repeat(64)}`,
            applications: { zotero: { strict_min_version: "6.999", strict_max_version: "10.*" } },
          },
          {
            version: "3.0.0",
            update_link: "https://example.org/3.0.0.xpi",
            applications: { zotero: { strict_min_version: "11.0", strict_max_version: "11.*" } },
          },
        ],
      },
    },
  });

  it("finds the add-on's entries whatever the ID's case, and nothing for other IDs", () => {
    expect(parseUpdateManifest(manifest, "fixture@example.org")).toHaveLength(3);
    expect(parseUpdateManifest(manifest, "other@example.org")).toBeNull();
    expect(parseUpdateManifest("<rdf/>", "fixture@example.org")).toBeNull();
  });

  it("reads an update.rdf, as Zotero 5 and 6 plugins publish (ZotFile)", () => {
    const rdf = `<?xml version="1.0" encoding="UTF-8"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:em="http://www.mozilla.org/2004/em-rdf#">
        <rdf:Description about="urn:mozilla:extension:zotfile@columbia.edu">
          <em:updates><rdf:Seq><rdf:li><rdf:Description>
            <em:version>5.1.2</em:version>
            <em:targetApplication><rdf:Description>
              <em:id>zotero@chnm.gmu.edu</em:id><em:minVersion>5.0.0</em:minVersion><em:maxVersion>6.*</em:maxVersion>
              <em:updateLink>https://github.com/jlegewie/zotfile/releases/download/v5.1.2/zotfile-5.1.2-fx.xpi</em:updateLink>
            </rdf:Description></em:targetApplication>
          </rdf:Description></rdf:li></rdf:Seq></em:updates>
        </rdf:Description>
      </rdf:RDF>`;
    const entries = parseUpdateManifest(rdf, "zotfile@columbia.edu") ?? [];
    expect(entries).toEqual([
      {
        version: "5.1.2",
        link: "https://github.com/jlegewie/zotfile/releases/download/v5.1.2/zotfile-5.1.2-fx.xpi",
        hash: null,
        min: "5.0.0",
        max: "6.*",
      },
    ]);
    expect(pickUpdate(entries, "6.0.30")?.version).toBe("5.1.2");
    expect(parseUpdateManifest(rdf, "other@example.org")).toBeNull();
  });

  it("picks what the current Zotero would install: the newest entry whose range covers it", () => {
    const entries = parseUpdateManifest(manifest, "fixture@example.org") ?? [];
    const pick = pickUpdate(entries, "10.0.4");
    expect(pick?.version).toBe("2.0.0");
    expect(pick && statedSha256(pick)).toBe("a".repeat(64));
    expect(pickUpdate(entries, "9.0.6")?.version).toBe("2.0.0");
    expect(pickUpdate(entries.slice(0, 1), "10.0.4")).toBeNull();
  });

  it("rates a card by the file the update address offers when it differs", () => {
    const base = { kind: "other-repository", label: "Updates come from a/b on Gitee" };
    const worse = cardFor(`const x = 1;`, {
      updateSource: {
        ...base,
        check: { result: "different-file", note: "…", targetLabel: "high-concern" },
      },
    });
    expect(worse.overall.label).toBe("high-concern");
    expect(worse.facets.sourceTransparency.drivers).toContain("ST-UPDATE-TARGET");
    expect(worse.facets.sourceTransparency.label).toBe(
      "Updates replace it with a version that has serious concerns",
    );
    expect(worse.facets.sourceTransparency.updates?.check).toBe("…");
    const same = cardFor(`const x = 1;`, {
      updateSource: { ...base, check: { result: "same-file", note: "…", targetLabel: null } },
    });
    expect(same.overall.label).toBe("low-concern");
    const fine = cardFor(`const x = 1;`, {
      updateSource: {
        ...base,
        check: { result: "different-file", note: "…", targetLabel: "low-concern" },
      },
    });
    expect(fine.overall.label).toBe("low-concern");
    // Not worse than this file: the project's next release with the same findings.
    const alsoSerious = cardFor(`window.eval(await (await fetch(u)).text());`, {
      updateSource: {
        ...base,
        check: { result: "different-file", note: "…", targetLabel: "high-concern" },
      },
    });
    expect(alsoSerious.overall.label).toBe("high-concern");
    expect(alsoSerious.facets.sourceTransparency.drivers).not.toContain("ST-UPDATE-TARGET");
    // A file Zotero refuses (its hash doesn't match the entry's) isn't what users end up running.
    const refused = cardFor(`const x = 1;`, {
      updateSource: {
        ...base,
        check: { result: "different-file", note: "…", targetLabel: "high-concern", refused: true },
      },
    });
    expect(refused.overall.label).toBe("low-concern");
    expect(refused.facets.sourceTransparency.drivers).not.toContain("ST-UPDATE-TARGET");
  });

  it("reads update_hash in every form Zotero checks, and compares it with the file", () => {
    const entry = (hash: string | null) => ({
      version: "1",
      link: "x",
      hash,
      min: null,
      max: null,
    });
    const bytes = new TextEncoder().encode("fixture");
    expect(statedHash(entry(`SHA512:${"AB".repeat(64)}`))).toEqual({
      algorithm: "sha512",
      hex: "ab".repeat(64),
    });
    expect(statedHash(entry(`sha384:${"c".repeat(96)}`))?.algorithm).toBe("sha384");
    expect(statedHash(entry(` sha1:${"d".repeat(40)} `))?.algorithm).toBe("sha1");
    expect(statedHash(entry(null))).toBeNull();
    expect(statedHash(entry("md5-ish"))).toBeNull();
    // Only a SHA-256 names the file by our own identity.
    expect(statedSha256(entry(`sha512:${"a".repeat(128)}`))).toBeNull();
    expect(statedSha256(entry(`sha256:${"A".repeat(64)}`))).toBe("a".repeat(64));
    for (const algorithm of ["sha1", "sha256", "sha384", "sha512"] as const) {
      const hex = createHash(algorithm).update(bytes).digest("hex");
      const stated = statedHash(entry(`${algorithm}:${hex.toUpperCase()}`));
      expect(stated && matchesStatedHash(stated, bytes)).toBe(true);
      expect(stated && matchesStatedHash(stated, new TextEncoder().encode("other"))).toBe(false);
    }
  });

  const check = (over: Partial<UpdateCheck>): UpdateCheck => ({
    checkedAt: "2026-09-25T00:00:00Z",
    status: 200,
    result: "same-file",
    version: "1.8.0",
    link: "https://github.com/o/p/releases/download/v1.8.0/p.xpi",
    zoteroVersion: "10.0.4",
    sha256: "c".repeat(64),
    label: null,
    releaseFile: null,
    note: "",
    ...over,
  });

  it("says Zotero won't install an update whose file doesn't match the stated hash", () => {
    expect(finishCheck(check({}), null, "p", 10).note).toBe(
      "The update address offers this version",
    );
    const same = finishCheck(check({ statedHash: "sha512:ab", hashMatches: false }), null, "p", 10);
    expect(same.note).toBe(
      "The update address offers this version, but Zotero won't install it as an update: the file doesn't match the fingerprint the update address gives",
    );
    const other = finishCheck(
      check({
        result: "different-file",
        version: "2.0.0",
        link: "https://example.org/p-2.0.0.xpi",
        statedHash: "sha256:ab",
        hashMatches: false,
      }),
      null,
      "p",
      10,
    );
    expect(other.note).toBe(
      "The update address offers version 2.0.0 from example.org, but Zotero won't install it: the file doesn't match the fingerprint the update address gives",
    );
  });

  it("takes a mismatch with its own update manifest as a replaced file, when the file came later", () => {
    // ccf-rank: CI published 1.8.0 and wrote update.json at 06:37; the file was re-uploaded at 06:43.
    const doc = {
      version: "1.8.0",
      releaseAuthor: "github-actions[bot]",
      publishedAt: "2026-09-22T06:37:24Z",
      manifest: { version: "1.8.0" },
      asset: { sha256: "c".repeat(64), uploadedAt: "2026-09-22T06:43:58Z" },
    };
    const build = { doc } as never;
    const swapped = check({ hashMatches: false, manifestModifiedAt: "2026-09-22T06:37:27.000Z" });
    expect(writtenForAnotherFile(swapped, build)).toBe(true);
    // A person's own release with the file attached after publishing may have had no file before
    // (zotero-roam); one whose author we don't know reads as before.
    expect(
      writtenForAnotherFile(swapped, { doc: { ...doc, releaseAuthor: "hyfaust" } } as never),
    ).toBe(false);
    expect(writtenForAnotherFile(swapped, { doc: { ...doc, releaseAuthor: null } } as never)).toBe(
      true,
    );
    // The manifest was rewritten after the upload, or carries no date: we can't tell which changed.
    expect(
      writtenForAnotherFile({ ...swapped, manifestModifiedAt: "2026-09-22T07:00:00.000Z" }, build),
    ).toBe(false);
    // Uploaded within two minutes of the manifest or of publishing: the same workflow run can do
    // that, even with a person's token (zotero2eagle--yueneiqi, 18 seconds after the manifest).
    expect(
      writtenForAnotherFile({ ...swapped, manifestModifiedAt: "2026-09-22T06:43:40.000Z" }, build),
    ).toBe(false);
    expect(
      writtenForAnotherFile(swapped, {
        doc: { ...doc, publishedAt: "2026-09-22T06:42:30Z" },
      } as never),
    ).toBe(false);
    expect(writtenForAnotherFile({ ...swapped, manifestModifiedAt: undefined }, build)).toBe(false);
    // Another version, a matching hash, or another file isn't evidence about this one.
    expect(writtenForAnotherFile({ ...swapped, version: "1.7.0" }, build)).toBe(false);
    expect(writtenForAnotherFile({ ...swapped, hashMatches: true }, build)).toBe(false);
    expect(writtenForAnotherFile({ ...swapped, result: "different-file" }, build)).toBe(false);

    const card = cardFor(`const x = 1;`, { manifestMismatch: true });
    expect(card.facets.sourceTransparency.drivers).toContain("ST-ASSET-REPLACED");
    expect(card.facets.sourceTransparency).toMatchObject({
      assetReplaced: true,
      assetReplacedDetail:
        "The file doesn't match the fingerprint its own update manifest gives for this version",
      label: "Release file replaced after publication",
    });
    expect(card.overall).toMatchObject({
      label: "review-details",
      drivers: ["sourceTransparency"],
    });
    // Unchanged cards keep their input hash.
    expect(cardFor(`const x = 1;`, { manifestMismatch: false }).inputs.inputHash).toBe(
      cardFor(`const x = 1;`).inputs.inputHash,
    );
  });
});

describe("hosts seen when we ran it (DS-OBSERVED)", () => {
  const sandboxRecord = (over: Partial<SandboxRecord> = {}): SandboxRecord => ({
    schemaVersion: 1,
    sandboxVersion: "1.0.0",
    slug: "fixture",
    sha256: "b".repeat(64),
    addonId: "fixture@example.org",
    zotero: "10.0.3",
    testedAt: "2026-09-27T05:25:06Z",
    seconds: 137,
    verdict: "as-described",
    loaded: true,
    cutShort: false,
    exercised: {
      itemsSelected: 3,
      readerOpened: true,
      settingsPane: true,
      menuItems: 2,
      dialogs: 0,
    },
    contacted: [],
    requests: [],
    refused: [],
    programs: [],
    servers: [],
    settings: [],
    files: [],
    databaseStructureChanged: false,
    unexpected: [],
    ...over,
  });
  const developer = { names: ["someone", "myplugin"], domains: [] };
  const testedCard = (code: string, over: Partial<SandboxRecord> = {}) => {
    const record = sandboxRecord(over);
    return cardFor(code, { tested: { record, hosts: observedHosts(record, table, developer) } });
  };
  const openai = `fetch("https://api.openai.com/v1/chat/completions", { method: "POST" });`;
  // The code names Crossref, but no request we traced reaches it.
  const named = `const CROSSREF = "https://api.crossref.org/works"; function go(u) { return fetch(u); }`;
  const group = (card: ReturnType<typeof cardFor>, category: string) =>
    card.facets.dataSharing.hosts.find((h) => h.category === category);

  it("adds a host the code doesn't name, classified by the hosts table, as a traced request", () => {
    const card = testedCard(openai, { contacted: ["api.crossref.org", "api.openai.com"] });
    expect(group(card, "scholarly-api")).toEqual({
      category: "scholarly-api",
      hosts: ["api.crossref.org"],
      observed: ["api.crossref.org"],
    });
    expect(card.facets.dataSharing.value).toBe("named-third-parties");
    expect(card.facets.dataSharing.label).toBe("Only contacts services we could identify");
    expect(card.facets.dataSharing.drivers).toEqual(["DS-NAMED", "DS-OBSERVED"]);
    expect(card.overall.label).toBe("low-concern");
    // A host it already contacts in the code is marked too.
    expect(group(card, "llm-provider")?.observed).toEqual(["api.openai.com"]);
  });

  it("raises data sharing for a server we couldn't identify, as a traced request would", () => {
    const card = testedCard(openai, { contacted: ["api.unlisted-service.net"] });
    expect(group(card, "unknown")).toEqual({
      category: "unknown",
      hosts: ["api.unlisted-service.net"],
      observed: ["api.unlisted-service.net"],
    });
    expect(card.facets.dataSharing.value).toBe("unknown-endpoints");
    expect(card.facets.dataSharing.label).toBe(
      "Contacts a server we couldn't identify: api.unlisted-service.net",
    );
    expect(card.facets.dataSharing.drivers).toEqual(["DS-UNKNOWN", "DS-OBSERVED"]);
    expect(card.overall).toMatchObject({ label: "review-details", drivers: ["dataSharing"] });
  });

  it("recognises the developer's own server by name, as the analysis does", () => {
    const card = testedCard(openai, { contacted: ["api.myplugin.dev"] });
    expect(group(card, "developer-server")?.observed).toEqual(["api.myplugin.dev"]);
    expect(card.facets.dataSharing.value).toBe("developer-servers");
    expect(card.facets.dataSharing.label).toBe("Contacts the developer's server: api.myplugin.dev");
    expect(card.overall.label).toBe("review-details");
  });

  it("confirms a host the code only names", () => {
    const before = cardFor(named);
    expect(group(before, "scholarly-api")?.unconfirmed).toEqual(["api.crossref.org"]);
    expect(before.facets.dataSharing.label).toBe("Its code only names services we could identify");
    // www.x and x are one host.
    for (const seen of ["api.crossref.org", "www.api.crossref.org"]) {
      const card = testedCard(named, { contacted: [seen] });
      expect(group(card, "scholarly-api")).toEqual({
        category: "scholarly-api",
        hosts: ["api.crossref.org"],
        observed: ["api.crossref.org"],
      });
      expect(card.facets.dataSharing.label).toBe("Only contacts services we could identify");
    }
  });

  it("counts GitHub's download hosts as github.com", () => {
    const card = testedCard(openai, {
      contacted: [
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
        "codeload.github.com",
      ],
    });
    expect(group(card, "code-hosting")).toEqual({
      category: "code-hosting",
      hosts: ["github.com"],
      observed: ["github.com"],
    });
  });

  it("treats a name the hosts table ignores as a server we couldn't identify once contacted", () => {
    expect(classifyHost(table, "x.com")).toBeNull();
    const [seen] = observedHosts(sandboxRecord({ contacted: ["x.com"] }), table, developer);
    expect(seen).toEqual({ host: "x.com", category: "unknown", flags: [] });
  });

  it("uses a test only for the exact file it ran", () => {
    const record = sandboxRecord({
      sha256: "c".repeat(64),
      contacted: ["api.unlisted-service.net"],
    });
    const card = cardFor(openai, {
      tested: { record, hosts: observedHosts(record, table, developer) },
    });
    expect(card.tested).toBeUndefined();
    expect(group(card, "unknown")).toBeUndefined();
    expect(card).toEqual(cardFor(openai));
  });

  it("puts the test on the card, and changes the input hash with it", () => {
    const card = testedCard(openai, { contacted: ["api.openai.com"] });
    expect(card.tested).toEqual({
      zotero: "10.0.3",
      testedAt: "2026-09-27T05:25:06Z",
      verdict: "as-described",
      exercised: {
        itemsSelected: 3,
        readerOpened: true,
        settingsPane: true,
        menuItems: 2,
        dialogs: 0,
      },
      contacted: ["api.openai.com"],
      unexpected: [],
    });
    expect(card.inputs.inputHash).not.toBe(cardFor(openai).inputs.inputHash);
    expect(testedCard(openai, { testedAt: "2026-10-01T00:00:00Z" }).inputs.inputHash).not.toBe(
      testedCard(openai).inputs.inputHash,
    );
  });

  it("leaves refused addresses, programs, servers, settings and files to the test's reasons", () => {
    const reasons = [
      "tried to reach a local or private address: 127.0.0.1 (private)",
      "started programs: ['/usr/bin/python3 server.py']",
      "opened servers: ['tcp 0.0.0.0:8080']",
      "changed settings that aren't its own: ['network.proxy.type']",
      "wrote files outside Zotero's folders: ['A /home/zotero/notes.md']",
      "changed Zotero's database structure",
    ];
    const card = testedCard(openai, {
      verdict: "unexpected",
      refused: ["127.0.0.1 (private)"],
      programs: ["/usr/bin/python3 server.py"],
      servers: ["tcp 0.0.0.0:8080"],
      settings: ["network.proxy.type"],
      files: ["A /home/zotero/notes.md"],
      databaseStructureChanged: true,
      unexpected: reasons,
    });
    const plain = cardFor(openai);
    expect(card.overall).toEqual(plain.overall);
    expect(card.facets.capabilities).toEqual(plain.facets.capabilities);
    expect(card.facets.dataSharing.hosts.flatMap((h) => h.hosts)).not.toContain("127.0.0.1");
    expect(card.tested).toMatchObject({ verdict: "unexpected", unexpected: reasons });
  });

  it("judges the hosts against the card before we ran it, not the card the report was read with", () => {
    // A report read again after a re-profile finds the hosts the test put on the card, and calls
    // the test as described. The card still says what it didn't list before.
    const card = testedCard(openai, { contacted: ["api.openai.com", "api.unlisted-service.net"] });
    expect(group(card, "unknown")?.observed).toEqual(["api.unlisted-service.net"]);
    expect(card.tested).toMatchObject({
      verdict: "unexpected",
      unexpected: [
        "contacted api.unlisted-service.net, which its card didn't list before we ran it",
      ],
    });
    // Other findings keep their place after the hosts.
    expect(
      testedCard(openai, {
        verdict: "unexpected",
        contacted: ["api.unlisted-service.net"],
        unexpected: [
          "contacted api.unlisted-service.net, which its card doesn't list",
          "changed Zotero's database structure",
        ],
      }).tested?.unexpected,
    ).toEqual([
      "contacted api.unlisted-service.net, which its card didn't list before we ran it",
      "changed Zotero's database structure",
    ]);
  });

  it("drops a host reason the card before we ran it answers, as report.py matches names", () => {
    // An older report counted GitHub's download host as a host of its own.
    const github = `fetch("https://github.com/o/r/releases/download/release/update.json"); fetch("https://www.nature.com/x");`;
    const card = testedCard(github, {
      verdict: "unexpected",
      contacted: [
        "github.com",
        "idp.nature.com",
        "raw.githubusercontent.com",
        "release-assets.githubusercontent.com",
      ],
      unexpected: ["contacted release-assets.githubusercontent.com, which its card doesn't list"],
    });
    expect(card.tested).toMatchObject({ verdict: "as-described", unexpected: [] });
  });

  it("keeps an unfinished test unfinished", () => {
    const card = testedCard(openai, {
      verdict: "incomplete",
      contacted: ["api.unlisted-service.net"],
    });
    expect(card.tested).toMatchObject({
      verdict: "incomplete",
      unexpected: [
        "contacted api.unlisted-service.net, which its card didn't list before we ran it",
      ],
    });
  });

  it("takes no hosts from a plugin that didn't start", () => {
    const record = sandboxRecord({
      verdict: "not-loaded",
      loaded: false,
      contacted: ["x.org"],
      unexpected: ["contacted x.org, which its card doesn't list"],
    });
    expect(observedHosts(record, table, developer)).toEqual([]);
    const card = cardFor(openai, { tested: { record, hosts: [] } });
    // The card still doesn't list it, so the record's reason stands as written.
    expect(card.tested).toMatchObject({
      verdict: "not-loaded",
      unexpected: ["contacted x.org, which its card doesn't list"],
    });
    expect(card.facets.dataSharing).toEqual(cardFor(openai).facets.dataSharing);
  });

  // Records from sandbox 1.1.0 say what each host's requests carried.
  const usage = (
    hosts: Record<string, SandboxHostUsage["usage"]>,
    sent: Record<string, SandboxHostUsage["sent"]> = {},
  ): Pick<SandboxRecord, "sandboxVersion" | "contacted" | "hostUsage"> => ({
    sandboxVersion: "1.1.0",
    contacted: Object.keys(hosts).sort(),
    hostUsage: Object.fromEntries(
      Object.entries(hosts).map(([h, u]) => [h, { usage: u, sent: sent[h] ?? [] }]),
    ),
  });

  it("counts a host as a traced request only when it received data", () => {
    const card = testedCard(
      openai,
      usage({
        "api.unlisted-service.net": "sends-data",
        "api.crossref.org": "sends-library-data",
      }),
    );
    expect(group(card, "unknown")?.observed).toEqual(["api.unlisted-service.net"]);
    expect(group(card, "scholarly-api")?.observed).toEqual(["api.crossref.org"]);
    expect(card.facets.dataSharing.drivers).toEqual(["DS-UNKNOWN", "DS-OBSERVED"]);
    expect(card.overall.label).toBe("review-details");
  });

  it("doesn't add a host it only loaded pages from, and lists it on the test", () => {
    const plain = cardFor(openai);
    const card = testedCard(
      openai,
      usage({ "api.unlisted-service.net": "fetches", "doi.org": "fetches" }),
    );
    expect(card.facets.dataSharing).toEqual(plain.facets.dataSharing);
    expect(card.overall).toEqual(plain.overall);
    expect(card.tested?.fetched).toEqual(["api.unlisted-service.net", "doi.org"]);
    expect(card.tested?.sentTo).toBeUndefined();
    // Nor one the code only links to: the card doesn't list it, so nothing is marked seen.
    const linked = `${openai} function help() { Zotero.launchURL("https://api.unlisted-service.net/help"); }`;
    const help = testedCard(linked, usage({ "api.unlisted-service.net": "fetches" }));
    expect(help.facets.dataSharing).toEqual(cardFor(linked).facets.dataSharing);
    expect(help.facets.dataSharing.drivers).not.toContain("DS-OBSERVED");
    // An older record can't tell a page load from a request that sends data: it counts, as before.
    const older = testedCard(openai, { contacted: ["api.unlisted-service.net"] });
    expect(group(older, "unknown")?.observed).toEqual(["api.unlisted-service.net"]);
    expect(older.tested?.fetched).toBeUndefined();
  });

  it("marks a host the card lists as seen when it only loaded pages there, without a new rating", () => {
    const before = cardFor(named);
    const card = testedCard(named, usage({ "api.crossref.org": "fetches" }));
    // Contacted: seen when we ran it, and no longer only named in the code.
    expect(group(card, "scholarly-api")).toEqual({
      category: "scholarly-api",
      hosts: ["api.crossref.org"],
      observed: ["api.crossref.org"],
    });
    expect(card.facets.dataSharing.label).toBe("Only contacts services we could identify");
    expect(card.facets.dataSharing.drivers).toEqual(["DS-NAMED", "DS-OBSERVED"]);
    expect(card.facets.dataSharing.value).toBe(before.facets.dataSharing.value);
    expect(card.facets.dataSharing.concern).toBe(before.facets.dataSharing.concern);
    expect(card.tested).toMatchObject({ verdict: "as-described", fetched: ["api.crossref.org"] });
    // The rules still read it as named only (a page load from a public relay isn't sending data
    // through it).
    const { analysis, seen } = withObserved(analyze(named), [
      { host: "api.crossref.org", category: "scholarly-api", flags: [], usage: "fetches" },
    ]);
    expect(seen).toEqual(new Set(["api.crossref.org"]));
    expect(analysis.network.hosts.find((h) => h.host === "api.crossref.org")?.usage).not.toBe(
      "request",
    );
  });

  it("says what went where", () => {
    const card = testedCard(
      openai,
      usage(
        {
          "api.crossref.org": "sends-library-data",
          "api.openai.com": "sends-library-data",
          "api.unlisted-service.net": "sends-data",
          "doi.org": "fetches",
        },
        { "api.crossref.org": ["identifiers", "titles"], "api.openai.com": ["pdf-text"] },
      ),
    );
    expect(card.tested?.sentTo).toEqual([
      { host: "api.crossref.org", sent: ["identifiers", "titles"] },
      { host: "api.openai.com", sent: ["pdf-text"] },
    ]);
    expect(card.tested?.fetched).toEqual(["doi.org"]);
    expect(card.tested?.contacted).toEqual([
      "api.crossref.org",
      "api.openai.com",
      "api.unlisted-service.net",
      "doi.org",
    ]);
  });

  it("expects a page load from a service the hosts table names, not from an unidentified server", () => {
    // A DOI resolving to a publisher's page: the card didn't list it, but it's a named service.
    const card = testedCard(
      openai,
      usage({
        "api.openai.com": "sends-data",
        "www.nature.com": "fetches",
        "en.wikipedia.org": "fetches",
      }),
    );
    expect(card.tested).toMatchObject({ verdict: "as-described", unexpected: [] });
    // A page load from a server we couldn't identify, or the developer's, still says someone uses
    // the plugin.
    const unknown = testedCard(
      openai,
      usage({ "api.unlisted-service.net": "fetches", "api.myplugin.dev": "fetches" }),
    );
    expect(unknown.tested).toMatchObject({
      verdict: "unexpected",
      unexpected: [
        "contacted api.myplugin.dev, which its card didn't list before we ran it",
        "contacted api.unlisted-service.net, which its card didn't list before we ran it",
      ],
    });
    expect(unknown.facets.dataSharing).toEqual(cardFor(openai).facets.dataSharing);
    // A named host that received data, which the card didn't list, is unexpected as before.
    expect(testedCard(openai, usage({ "www.nature.com": "sends-data" })).tested).toMatchObject({
      verdict: "unexpected",
      unexpected: ["contacted www.nature.com, which its card didn't list before we ran it"],
    });
  });

  it("counts GitHub's download hosts by the most any of them received", () => {
    const hosts = (u: Parameters<typeof usage>[0]) =>
      observedHosts(sandboxRecord(usage(u)), table, developer);
    expect(
      hosts({ "github.com": "fetches", "release-assets.githubusercontent.com": "sends-data" }),
    ).toEqual([
      {
        host: "github.com",
        category: "code-hosting",
        provider: "GitHub",
        flags: [],
        usage: "sends-data",
      },
    ]);
    expect(
      hosts({ "codeload.github.com": "fetches", "github.com": "fetches" }).map((h) => h.usage),
    ).toEqual(["fetches"]);
    // A name the record doesn't say about counts as data.
    const partial = sandboxRecord({
      sandboxVersion: "1.1.0",
      contacted: ["codeload.github.com", "github.com"],
      hostUsage: { "github.com": { usage: "fetches", sent: [] } },
    });
    expect(observedHosts(partial, table, developer)[0]?.usage).toBeUndefined();
    // The test lists them as page loads only when none of GitHub's names received data.
    const tested = (u: Parameters<typeof usage>[0]) => testedCard(openai, usage(u)).tested;
    expect(
      tested({ "github.com": "fetches", "release-assets.githubusercontent.com": "sends-data" })
        ?.fetched,
    ).toBeUndefined();
    expect(tested({ "codeload.github.com": "fetches", "github.com": "fetches" })?.fetched).toEqual([
      "codeload.github.com",
      "github.com",
    ]);
  });

  it("counts a page load from a usage-tracking service as data", () => {
    // Loading a counter's address is how it counts users.
    const card = testedCard(openai, usage({ "api.countapi.xyz": "fetches" }));
    expect(group(card, "telemetry")?.observed).toEqual(["api.countapi.xyz"]);
    expect(card.facets.dataSharing.drivers).toEqual(["DS-NAMED", "DS-TELEMETRY", "DS-OBSERVED"]);
    expect(card.facets.dataSharing.label).toBe("Sends usage data to api.countapi.xyz");
    expect(card.tested?.fetched).toBeUndefined();
    expect(card.tested).toMatchObject({
      verdict: "unexpected",
      unexpected: ["contacted api.countapi.xyz, which its card didn't list before we ran it"],
    });
  });

  it("expects page loads only from services that serve their own pages", () => {
    // A code host or CDN serves whatever the developer put there (an update list, a program), and
    // a server on a hosting platform is usually the developer's: listed, not added, and not
    // something the card said.
    const card = testedCard(
      openai,
      usage({
        "cdn.jsdelivr.net": "fetches",
        "gitee.com": "fetches",
        "someapp.workers.dev": "fetches",
      }),
    );
    expect(card.facets.dataSharing).toEqual(cardFor(openai).facets.dataSharing);
    expect(card.tested).toMatchObject({
      verdict: "unexpected",
      fetched: ["cdn.jsdelivr.net", "gitee.com", "someapp.workers.dev"],
      unexpected: [
        "contacted cdn.jsdelivr.net, which its card didn't list before we ran it",
        "contacted gitee.com, which its card didn't list before we ran it",
        "contacted someapp.workers.dev, which its card didn't list before we ran it",
      ],
    });
  });

  it("marks every entry of a host the code names, and leaves the stored analysis alone", () => {
    const a = analyze(named);
    const { analysis, seen } = withObserved(a, [
      { host: "api.crossref.org", category: "scholarly-api", flags: [] },
    ]);
    expect(seen).toEqual(new Set(["api.crossref.org"]));
    expect(analysis.network.hosts.find((h) => h.host === "api.crossref.org")?.usage).toBe(
      "request",
    );
    expect(a.network.hosts.find((h) => h.host === "api.crossref.org")?.usage).not.toBe("request");
  });

  it("shows the hosts seen and the test's verdict in the regression report", () => {
    const before: Snapshot = {
      label: "low-concern",
      dataSharing: "named-third-parties",
      dataSharingLabel: "Only contacts services we could identify",
      hosts: ["llm-provider:api.openai.com"],
      observed: [],
      badges: [],
      transparency: null,
      drivers: ["DS-NAMED"],
      asset: "p.xpi",
      version: "1.0.0",
      autoUpdates: true,
      scan: "analyzed",
      tested: null,
      compatibility: "Works with Zotero 10",
      worksWithCurrent: true,
    };
    const after: Snapshot = {
      ...before,
      hosts: ["llm-provider:api.openai.com", "scholarly-api:api.crossref.org"],
      observed: ["scholarly-api:api.crossref.org"],
      drivers: ["DS-NAMED", "DS-OBSERVED"],
      tested: "as-described",
    };
    expect(
      describeChange({ slug: "p", hidden: false, downloads: 1, before, after, fields: [] }),
    ).toEqual([
      "hosts: +scholarly-api:api.crossref.org",
      "seen when we ran it: +scholarly-api:api.crossref.org",
      "rules: +DS-OBSERVED",
      "tested: no → as-described",
    ]);
    const refused: Snapshot = {
      ...before,
      compatibility:
        "Zotero won't install this file: its manifest has no update address, which Zotero requires",
      worksWithCurrent: false,
    };
    expect(
      describeChange({
        slug: "p",
        hidden: false,
        downloads: 1,
        before,
        after: refused,
        fields: ["compatibility.current", "compatibility.supports"],
      }),
    ).toEqual([
      `compatibility: "Works with Zotero 10" → "Zotero won't install this file: its manifest has no update address, which Zotero requires"`,
      "works with current Zotero: true → false",
      "other fields: compatibility.current, compatibility.supports",
    ]);
  });

  it("reads a record that validates, and nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-sandbox-"));
    const save = (slug: string, doc: unknown) =>
      writeFile(join(dir, `${slug}.json`), typeof doc === "string" ? doc : JSON.stringify(doc));
    await save("fixture", sandboxRecord());
    await save("no-file-hash", { ...sandboxRecord({ slug: "no-file-hash" }), sha256: null });
    await save("other-slug", sandboxRecord({ slug: "fixture" }));
    await save("broken", "{");
    expect(await readSandboxRecord("fixture", dir)).toEqual(sandboxRecord());
    expect(await readSandboxRecord("no-file-hash", dir)).toBeNull();
    expect(await readSandboxRecord("other-slug", dir)).toBeNull();
    expect(await readSandboxRecord("broken", dir)).toBeNull();
    expect(await readSandboxRecord("missing", dir)).toBeNull();
  });
});

describe("re-applying the hosts table", () => {
  it("updates categories without re-reading the .xpi and leaves current analyses alone", () => {
    const a = analyze(`fetch("https://api.newprovider-fixture.ai/v1");`);
    expect(a.network.hosts[0]?.category).toBe("unknown");
    const newer: HostTable = {
      ...table,
      version: "test-2",
      exact: new Map([
        ...table.exact,
        [
          "api.newprovider-fixture.ai",
          {
            pattern: "api.newprovider-fixture.ai",
            category: "llm-provider",
            provider: "NewAI",
            flags: [],
          },
        ],
      ]),
    } as HostTable;
    const b = reclassifyHosts(a, newer, { names: [], domains: [] });
    expect(b.network.hosts[0]).toMatchObject({ category: "llm-provider", provider: "NewAI" });
    expect(b.network.hostsTableVersion).toBe("test-2");
    expect(reclassifyHosts(a, table, { names: [], domains: [] })).toBe(a);
  });

  it("classifies the update host, recognising the developer's own domain", () => {
    expect(
      updateHostOf("https://raw.githubusercontent.com/o/r/main/update.json", table, {
        names: [],
        domains: [],
      })?.category,
    ).toBe("code-hosting");
    expect(
      updateHostOf("https://updates.myplugin.dev/u.json", table, {
        names: [],
        domains: ["myplugin.dev"],
      }),
    ).toEqual({ host: "updates.myplugin.dev", category: "developer-server" });
  });
});

describe("nightly reuse", () => {
  const doc = {
    tag: "v1.2.0",
    publishedAt: "2026-09-01T00:00:00Z",
    prerelease: false,
    asset: {
      name: "p.xpi",
      url: "https://github.com/o/p/releases/download/v1.2.0/p.xpi",
      size: 1000,
      sha256: "c".repeat(64),
      githubAssetId: 7,
      uploader: "github-actions[bot]",
      uploadedAt: "2026-09-01T00:05:00Z",
    },
  };
  const known = new Map([[doc.asset.sha256, { file: "1.2.0.json", doc }]]) as never;
  const existing = {
    profilerVersion: PROFILER_VERSION,
    install: { tag: "v1.2.0", publishedAt: "2026-09-01T00:00:00Z", otherAssets: [] },
  } as never;
  const censusRow = (over: Partial<CensusRow>) =>
    row({
      latestTag: "v1.2.0",
      latestAssets: [
        { name: "p.xpi", size: 1000, updatedAt: "2026-09-01T00:05:00Z", downloadCount: 5 },
      ],
      ...over,
    });

  it("skips the GitHub call when the census shows the same release files", () => {
    const rel = unchangedRelease(censusRow({}), existing, known);
    // The uploader survives, so the source check doesn't lose "built on GitHub".
    expect(rel?.assets[0]).toMatchObject({
      id: 7,
      digest: `sha256:${"c".repeat(64)}`,
      uploader: { login: "github-actions[bot]" },
    });
  });

  it("fetches again after a new tag or a replaced file", () => {
    expect(unchangedRelease(censusRow({ latestTag: "v1.3.0" }), existing, known)).toBeNull();
    const replaced = censusRow({
      latestAssets: [
        { name: "p.xpi", size: 1000, updatedAt: "2026-09-20T00:00:00Z", downloadCount: 5 },
      ],
    });
    expect(unchangedRelease(replaced, existing, known)).toBeNull();
    expect(unchangedRelease(censusRow({}), null, known)).toBeNull();
    const older = {
      profilerVersion: "0.0.1",
      install: { tag: "v1.2.0", otherAssets: [] },
    } as never;
    expect(unchangedRelease(censusRow({}), older, known)).toBeNull();
  });
});

describe("change detection", () => {
  it("ignores key order and timestamps, not content", () => {
    const a = {
      slug: "x",
      generatedAt: "2026-01-01T00:00:00Z",
      trust: { major: 10, zoteroVersion: "10.0.4" },
    };
    const b = {
      trust: { zoteroVersion: "10.0.4", major: 10 },
      generatedAt: "2026-09-25T00:00:00Z",
      slug: "x",
    };
    expect(stable(a)).toBe(stable(b));
    expect(stable(a)).not.toBe(stable({ ...b, slug: "y" }));
  });
});

describe("a reviewed download-and-run finding", () => {
  // zotero-copy-anything's shape: fetch a program, write it, chmod it, run it.
  const code = `function info() { return "https://gitee.com/x/y/releases/download/binary/copyfiles-mac"; }
    async function get(url, path) { const res = await fetch(url); const buf = await res.arrayBuffer(); await IOUtils.write(path, new Uint8Array(buf));
      await Subprocess.call({ command: "/bin/chmod", arguments: ["777", path] }); }
    async function run(path) { await Subprocess.call({ command: path, arguments: [] }); }`;
  const review = (
    over: Partial<NonNullable<Parameters<typeof score>[0]["downloadReview"]>> = {},
  ) => ({
    files: ["b".repeat(64)],
    real: true,
    concern: "medium" as const,
    rule: "CAP-DOWNLOAD-EXEC-REVIEWED",
    summary: "On first start it downloads a small helper program and runs it.",
    ...over,
  });
  const dl = (card: ReturnType<typeof score>) =>
    card.facets.capabilities.badges.find((b) => b.id === "download-exec");

  it("is high until it's reviewed", () => {
    const card = cardFor(code);
    expect(dl(card)?.concern).toBe("high");
    expect(card.facets.capabilities.drivers).toContain("CAP-DOWNLOAD-EXEC");
  });

  it("takes the review's level, rule and wording for the file it reviewed", () => {
    const card = cardFor(code, { downloadReview: review() });
    expect(dl(card)).toMatchObject({
      label: "Downloads a program and runs it",
      concern: "medium",
      detail: "On first start it downloads a small helper program and runs it.",
    });
    expect(card.facets.capabilities.drivers).toContain("CAP-DOWNLOAD-EXEC-REVIEWED");
    expect(card.facets.capabilities.drivers).not.toContain("CAP-DOWNLOAD-EXEC");
    const told = cardFor(code, {
      downloadReview: review({ concern: "low", rule: "CAP-DOWNLOAD-EXEC-TOLD" }),
    });
    expect(dl(told)?.label).toBe("Downloads and runs a program it tells you about");
  });

  it("ignores a review of another file, and drops a finding the review found isn't real", () => {
    expect(
      dl(cardFor(code, { downloadReview: review({ files: ["c".repeat(64)] }) }))?.concern,
    ).toBe("high");
    expect(dl(cardFor(code, { downloadReview: review({ real: false }) }))).toBeUndefined();
  });
});
