import { describe, expect, it } from "vitest";
import { indexFromSources, loadLibraryIndex, type NetworkDescriptor } from "../src/libs/index.ts";
import { hostIn, scanFiles } from "./helpers/scan.ts";

// A library with enough distinct calls to be recognised on content alone, a loader that sends a
// file to the address its upload setting names, an address it always sends diagrams to and a
// player it loads for links in the user's content.
const widgets = Array.from(
  { length: 40 },
  (_, i) => `api.registerWidget("widget-name-${i}", opts.widgets.item${i});`,
).join("\n");
const LIB = `var api = {};
var opts = {};
${widgets}
api.diagramUrl = "https://diagrams.render-test.dev/svg/~1";
api.playerUrl = "https://player.render-test.dev/play?";
function load(e, d) {
  var x = new XMLHttpRequest();
  x.open("POST", e.options.upload.url);
  x.setRequestHeader("X-Upload-Token", e.options.upload.token);
  x.send(d);
}
api.hooks.onReady("start-up-hook", function () { api.step1(); api.step2(); api.step3(); });
api.load = load;
`;

const descriptor: NetworkDescriptor = {
  displayName: "Libv",
  role: "the widget kit it bundles",
  configKeys: ["mode", "cdn", "toolbar", "upload", "preview", "hint"],
  minConfigKeys: 3,
  options: [
    {
      path: "cdn",
      default: "https://cdn.libv-assets.dev/libv@{version}",
      what: "loads its scripts",
    },
    { path: "preview.theme.path", default: "{cdn}/css", what: "loads preview styles" },
    {
      path: "upload.url",
      default: "",
      unlessSet: ["upload.handler"],
      what: "uploads files",
      sends: true,
    },
  ],
  fixed: [
    {
      host: "diagrams.render-test.dev",
      literal: "https://diagrams.render-test.dev/svg/~1",
      what: "sends diagrams",
      needsAsset: "dist/js/diagram/encoder.js",
      sends: true,
    },
  ],
  userContent: [
    {
      literal: "https://player.render-test.dev/play?",
      unlessFalse: "preview.render.media.enable",
      what: "shows videos your notes link to",
    },
  ],
};

const libraries = () => indexFromSources({ libv: [LIB] }, { libv: descriptor });

/** A plugin that ships the library and passes it `config` (the source of an object literal). */
const plugin = (config: string, before = "") => ({
  "content/libv.js": LIB,
  "content/main.js": `${before}\nfunction start(el) { return new Libv(el, ${config}); }\n`,
});

const scan = (files: Record<string, string>) => scanFiles(files, { libraries: libraries() });
const network = (r: Awaited<ReturnType<typeof scan>>) => r.analysis.network.libraryNetwork?.[0];
const option = (r: Awaited<ReturnType<typeof scan>>, path: string) =>
  network(r)?.options.find((o) => o.path === path);
const xhr = (r: Awaited<ReturnType<typeof scan>>) =>
  r.analysis.network.apis.find((a) => a.api === "xhr");

describe("what a bundled library sends", () => {
  it("takes a local cdn through a variable, and leaves the library's calls out", async () => {
    const r = await scan(
      plugin(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: plugin source, not a template
        '{ mode: "ir", cdn: base, toolbar: [], preview: { theme: { path: `${base}/css` } } }',
        'var base = "resource://fixture/libv";',
      ),
    );
    expect(network(r)).toMatchObject({ library: "libv", configFound: true });
    expect(option(r, "cdn")?.state).toBe("local");
    expect(option(r, "preview.theme.path")?.state).toBe("local");
    expect(option(r, "upload.url")?.state).toBe("off");
    expect(xhr(r)).toBeUndefined();
  });

  it("uses the defaults when the plugin passes no settings", async () => {
    const r = await scan({ "content/libv.js": LIB, "content/main.js": "var a = 1;\n" });
    expect(network(r)?.configFound).toBe(false);
    expect(option(r, "cdn")).toEqual({ path: "cdn", state: "remote", host: "cdn.libv-assets.dev" });
    const host = hostIn(r, "cdn.libv-assets.dev");
    expect(host).toMatchObject({ usage: "request", inVendoredCode: false });
    expect(xhr(r)).toBeDefined();
  });

  it("counts an upload address in the settings as the plugin's own destination", async () => {
    const r = await scan(
      plugin(
        '{ mode: "ir", cdn: "resource://x/libv", toolbar: [], upload: { url: "https://uploads.fileserver-test.dev/put" } }',
      ),
    );
    expect(option(r, "upload.url")).toEqual({
      path: "upload.url",
      state: "remote",
      host: "uploads.fileserver-test.dev",
    });
    expect(hostIn(r, "uploads.fileserver-test.dev")).toMatchObject({
      usage: "request",
      inVendoredCode: false,
    });
    expect(xhr(r)).toBeDefined();
  });

  it("turns the upload address off when a handler is set", async () => {
    const r = await scan(
      plugin(
        '{ mode: "ir", cdn: "resource://x/libv", toolbar: [], upload: { url: "https://uploads.fileserver-test.dev/put", handler: async () => null } }',
      ),
    );
    expect(option(r, "upload.url")?.state).toBe("off");
    // The address is still written in the code, but nothing sends there.
    expect(hostIn(r, "uploads.fileserver-test.dev")?.usage).not.toBe("request");
    expect(xhr(r)).toBeUndefined();
  });

  it("keeps the library's calls when a setting can't be read", async () => {
    const r = await scan(plugin('{ mode: "ir", cdn: getBase(), toolbar: [] }'));
    expect(option(r, "cdn")?.state).toBe("unknown");
    expect(xhr(r)).toBeDefined();
  });

  it("merges settings by their worst outcome when several objects match", async () => {
    const r = await scan({
      "content/libv.js": LIB,
      "content/main.js": `var a = new Libv("a", { mode: "ir", cdn: "resource://x/libv", toolbar: [] });
var b = new Libv("b", { mode: "wysiwyg", cdn: "https://elsewhere.fileserver-test.dev/libv", toolbar: [] });
`,
    });
    expect(option(r, "cdn")).toEqual({
      path: "cdn",
      state: "remote",
      host: "elsewhere.fileserver-test.dev",
    });
    expect(hostIn(r, "elsewhere.fileserver-test.dev")).toBeDefined();
  });

  it("sends diagrams only when the script that encodes them ships", async () => {
    const local = '{ mode: "ir", cdn: "resource://x/libv", toolbar: [] }';
    const missing = await scan(plugin(local));
    expect(network(missing)?.fixed).toEqual([
      { host: "diagrams.render-test.dev", state: "missing-asset" },
    ]);
    expect(hostIn(missing, "diagrams.render-test.dev")?.usage).not.toBe("request");

    const shipped = await scan({
      ...plugin(local),
      "content/libv/dist/js/diagram/encoder.js": "var encode = 1;\n",
    });
    expect(network(shipped)?.fixed).toEqual([
      { host: "diagrams.render-test.dev", state: "active" },
    ]);
    expect(hostIn(shipped, "diagrams.render-test.dev")).toMatchObject({
      usage: "request",
      inVendoredCode: false,
    });

    const remote = await scan(
      plugin('{ mode: "ir", cdn: "https://cdn.render-test.dev/libv", toolbar: [] }'),
    );
    expect(network(remote)?.fixed).toEqual([{ host: "diagrams.render-test.dev", state: "active" }]);

    const unknown = await scan(plugin('{ mode: "ir", cdn: getBase(), toolbar: [] }'));
    expect(network(unknown)?.fixed).toEqual([
      { host: "diagrams.render-test.dev", state: "unknown" },
    ]);
  });

  it("loads videos for the user's links unless the plugin turns them off", async () => {
    const on = await scan(plugin('{ mode: "ir", cdn: "resource://x/libv", toolbar: [] }'));
    expect(network(on)?.userContent).toEqual([
      { what: "shows videos your notes link to", state: "on" },
    ]);
    for (const off of ["false", "!1"]) {
      const r = await scan(
        plugin(
          `{ mode: "ir", cdn: "resource://x/libv", toolbar: [], preview: { render: { media: { enable: ${off} } } } }`,
        ),
      );
      expect(network(r)?.userContent).toEqual([
        { what: "shows videos your notes link to", state: "off" },
      ]);
    }
  });

  it("doesn't take the library's own defaults, or a language file, for the plugin's settings", async () => {
    const defaults = `function Options() {
  this.defaultOptions = { mode: "both", cdn: CDN, toolbar: [], preview: {} };
  api.merge.options(this.defaultOptions.preview.theme, this.options.upload.token);
}`;
    const dictionary = `window.I18n = { mode: "Mode", cdn: "CDN", toolbar: "Toolbar", ${Array.from({ length: 30 }, (_, i) => `word${i}: "w"`).join(", ")} };`;
    const r = await scanFiles(
      {
        "content/libv.js": `${LIB}\n${defaults}\n`,
        "content/i18n/en.js": dictionary,
        "content/main.js": `new Libv("a", { mode: "ir", cdn: "resource://x/libv", toolbar: [] });\n`,
      },
      { libraries: indexFromSources({ libv: [`${LIB}\n${defaults}\n`] }, { libv: descriptor }) },
    );
    expect(option(r, "cdn")?.state).toBe("local");
  });

  it("reads Vditor's descriptor from the catalogue", () => {
    const vditor = loadLibraryIndex().network.get("vditor");
    expect(vditor).toMatchObject({ displayName: "Vditor", minConfigKeys: 3 });
    expect(vditor?.options.map((o) => o.path)).toContain("upload.url");
  });

  it("says nothing when the library was found only by calls it shares with others", async () => {
    const bare = LIB.replace(/^api\.(diagram|player)Url = .*$/gm, "");
    const r = await scanFiles(
      {
        "content/libv.js": bare,
        "content/main.js":
          'new Libv("a", { mode: "ir", cdn: "resource://x/libv", toolbar: [] });\n',
      },
      { libraries: indexFromSources({ libv: [bare] }, { libv: descriptor }) },
    );
    expect(r.analysis.transparency.vendoredLibraries.map((v) => v.name)).toEqual(["libv"]);
    expect(r.analysis.network.libraryNetwork).toBeUndefined();
    expect(xhr(r)).toBeDefined();
  });

  it("says nothing for a plugin that doesn't ship the library", async () => {
    const r = await scan({ "content/main.js": "var a = 1;\n" });
    expect(r.analysis.network.libraryNetwork).toBeUndefined();
  });
});
