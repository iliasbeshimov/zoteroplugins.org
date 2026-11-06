// Offline check of the plugin's behaviour, with Zotero, Services and the AddonManager mocked:
//   node test.cjs
const vm = require("node:vm");
const fs = require("node:fs");
const assert = require("node:assert");
const code = fs.readFileSync(`${__dirname}/src/bootstrap.js`, "utf8");

const CATALOG_URL =
  "https://raw.githubusercontent.com/iliasbeshimov/zoteroplugins.org/main/data/generated/catalog.json";
const USAGE_URL = "https://zoteroatlas.com/api/v1/plugins";

// A version comparator close enough to Mozilla's for these tests: "*" is infinitely large.
function compare(a, b) {
  const pa = String(a).split("."),
    pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] === "*" ? Infinity : Number(pa[i] ?? 0);
    const y = pb[i] === "*" ? Infinity : Number(pb[i] ?? 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const build = (o) => ({
  name: "x.xpi",
  url: "https://github.com/d/x/releases/download/v1/x.xpi",
  sha256: "a".repeat(64),
  supports: [9, 10],
  min: "9.0",
  max: "10.*",
  ...o,
});
const entry = (o) => ({
  slug: "x",
  name: "X",
  id: "x@example.org",
  repo: "https://github.com/d/x",
  page: "https://zoteroplugins.org/p/x",
  summary: "Does x.",
  jobs: ["citing"],
  grade: "A",
  because: "every code check came out low",
  version: "1.2.0",
  publishedAt: null,
  supports: [9, 10],
  current: { zotero: "10.0.7", status: "compatible" },
  file: build({}),
  builds: [],
  update: null,
  blocked: null,
  tested: null,
  needs: { apiKey: "none", services: [], localModel: false, launchesPrograms: false },
  downloads: 10,
  stars: 1,
  maintenance: "active",
  lastReleaseAt: null,
  docsChineseOnly: false,
  ...o,
});
const catalogJson = (plugins) =>
  JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-11-03T00:00:00Z",
    currentZotero: "10.0.7",
    rulesVersion: "0.9.0",
    site: "https://zoteroplugins.org",
    plugins,
  });

/** A fresh mocked Zotero. `opts.answer` scripts the dialogs, `opts.http` the network, `opts.addons` what's installed. */
function load(opts = {}) {
  const prefs = {},
    observers = {},
    timers = [],
    log = [],
    http = [],
    notices = [],
    dialogs = [],
    files = {};
  const answers = [...(opts.answer ?? [])];
  const t = {
    prefs,
    timers,
    log,
    http,
    notices,
    dialogs,
    files,
    addons: opts.addons ?? [],
    installs: [],
    httpHandler:
      opts.http ??
      (() => {
        throw new Error("offline");
      }),
    installError: opts.installError ?? 0,
    flush() {
      const due = timers.splice(0);
      for (const x of due) x.fn();
      return due.length;
    },
  };
  const file = (path) => ({
    path,
    append(n) {
      this.path += `/${n}`;
    },
    exists: () => path in files || Object.keys(files).some((k) => k.startsWith(`${path}/`)),
    remove() {
      for (const k of Object.keys(files))
        if (k === this.path || k.startsWith(`${this.path}/`)) delete files[k];
    },
  });
  const mainWindow = () => ({
    document: {
      getElementById: (id) => (id === "menu_ToolsPopup" ? t.popup : null),
      createXULElement: (tag) => ({
        tag,
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        addEventListener() {},
        remove() {
          t.popup.children = t.popup.children.filter((c) => c !== this);
        },
      }),
    },
    openDialog: (...a) => {
      t.opened = a;
      return { closed: false, focus() {}, close() {} };
    },
  });
  t.popup = {
    children: [],
    appendChild(c) {
      this.children.push(c);
    },
  };
  t.window = mainWindow();
  const ctx = {
    ADDON_INSTALL: 5,
    ADDON_UNINSTALL: 6,
    Date,
    JSON,
    Math,
    Promise,
    Error,
    Object,
    Array,
    Map,
    Set,
    String,
    Number,
    Boolean,
    setTimeout: (fn, ms) => {
      const id = { fn, ms };
      timers.push(id);
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.indexOf(id);
      if (i >= 0) timers.splice(i, 1);
    },
    Components: {
      classes: {
        "@mozilla.org/addons/addon-manager-startup;1": {
          getService: () => ({
            registerChrome: (_u, entries) => {
              t.chrome = entries;
              return {
                destruct: () => {
                  t.chrome = null;
                },
              };
            },
          }),
        },
      },
      interfaces: { amIAddonManagerStartup: {} },
    },
    ChromeUtils: {
      importESModule: () => ({ AddonManager: t.AM }),
      import: () => ({ AddonManager: t.AM }),
    },
    Services: {
      io: { newURI: (s) => s },
      vc: { compare },
      uuid: { generateUUID: () => ({ toString: () => "{12345678-1234-4123-8123-123456789abc}" }) },
      prefs: {
        getStringPref: (k, d) => (k in prefs ? prefs[k] : d),
        setStringPref: (k, v) => {
          const was = prefs[k];
          prefs[k] = v;
          if (was !== v) for (const o of observers[k] ?? []) o();
        },
        clearUserPref: (k) => {
          const had = k in prefs;
          delete prefs[k];
          if (had) for (const o of observers[k] ?? []) o();
        },
        addObserver: (k, f) => {
          observers[k] = observers[k] ?? [];
          observers[k].push(f);
        },
        removeObserver: (k, f) => {
          observers[k] = (observers[k] ?? []).filter((x) => x !== f);
        },
      },
      prompt: {
        BUTTON_TITLE_IS_STRING: 127,
        BUTTON_POS_0: 1,
        BUTTON_POS_1: 256,
        BUTTON_POS_0_DEFAULT: 0,
        BUTTON_POS_1_DEFAULT: 1 << 24,
        confirmEx: (_w, title, text, flags, b0, b1) => {
          dialogs.push({ title, text, flags, b0, b1 });
          return answers.length ? answers.shift() : 1;
        },
      },
    },
    Zotero: {
      version: opts.zotero ?? "10.0.7",
      isWin: false,
      isMac: true,
      isLinux: false,
      debug: (m) => log.push(m),
      PreferencePanes: { register: (o) => log.push(`pane:${o.src}`) },
      getMainWindows: () => t.mainWindows ?? [],
      uiReadyPromise: Promise.resolve(),
      getMainWindow: () => t.window,
      launchURL: (u) => log.push(`open:${u}`),
      Users: { getLocalUserKey: () => t.localKey ?? "AbCd2345" },
      DataDirectory: { dir: "/data" },
      File: {
        pathToFile: file,
        createDirectoryIfMissingAsync: async () => {},
        putContentsAsync: async (f, s) => {
          files[f.path] = s;
        },
        getContentsAsync: async (f) => files[f.path],
      },
      HTTP: {
        request: async (method, url, o) => {
          http.push({ method, url, body: o?.body, headers: o?.headers });
          return t.httpHandler(method, url, o);
        },
      },
      ProgressWindow: class {
        changeHeadline() {}
        addDescription(s) {
          notices.push(s);
        }
        show() {}
        startCloseTimer() {}
      },
      alert: () => {},
    },
  };
  t.AM = {
    ERROR_INCORRECT_HASH: -2,
    getAllAddons: async () => [
      { id: "atlas@zoteroatlas.com", type: "extension", version: "0.1.0", isActive: true },
      ...t.addons,
    ],
    getInstallForURL: async (url, o) => {
      const inst = {
        url,
        opts: o,
        error: t.installError,
        listeners: [],
        addListener(l) {
          this.listeners.push(l);
        },
        install() {
          for (const l of this.listeners)
            (t.installError ? l.onDownloadFailed : l.onInstallEnded)();
        },
      };
      t.installs.push(inst);
      return inst;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  t.s = ctx;
  return t;
}

const ok200 = (text, etag = '"e1"') => ({
  status: 200,
  responseText: text,
  getResponseHeader: (h) => (h === "ETag" ? etag : null),
});
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick();
};
const run = async (name, fn) => {
  await fn();
  console.log("ok:", name);
};

(async () => {
  await run(
    "lifecycle: menu, pane once, chrome registered and removed, uninstall clears everything",
    async () => {
      const t = load();
      t.prefs["extensions.zotero-atlas.usage"] = "yes";
      t.s.install({}, 5);
      assert.ok(!("extensions.zotero-atlas.usage" in t.prefs), "a new install starts unasked");
      t.s.startup({ id: "atlas@zoteroatlas.com", version: "0.1.0", rootURI: "jar:x!/" });
      t.s.startup({ id: "atlas@zoteroatlas.com", version: "0.1.0", rootURI: "jar:x!/" });
      assert.deepEqual(t.chrome, [["content", "zotero-atlas", "content/"]]);
      assert.equal(t.log.filter((l) => l.startsWith("pane:")).length, 1);
      assert.ok(t.s.Zotero.ZoteroAtlas, "API exposed");
      t.s.onMainWindowLoad({ window: t.window });
      assert.equal(t.popup.children.length, 1);
      assert.equal(t.popup.children[0].attrs.label, "Zotero Atlas: find plugins…");
      t.s.shutdown({}, 2);
      assert.equal(t.popup.children.length, 0);
      assert.equal(t.chrome, null);
      assert.ok(!t.s.Zotero.ZoteroAtlas);
      t.files["/data/zotero-atlas/catalog.json"] = "{}";
      t.prefs["extensions.zotero-atlas.id"] = "abc";
      t.s.uninstall({}, 6);
      assert.deepEqual(t.prefs, {});
      assert.deepEqual(t.files, {});
    },
  );

  await run(
    "first run: asked once, 'Send my plugin list' is the default, 'Don't send' sends nothing",
    async () => {
      const t = load({ answer: [1], http: () => ok200(catalogJson([])) });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      t.s.onMainWindowLoad({ window: t.window });
      t.s.onMainWindowLoad({ window: t.window });
      assert.equal(t.timers.filter((x) => x.ms === 8000).length, 1, "one ask timer");
      t.flush();
      await settle();
      assert.equal(t.dialogs.length, 1);
      assert.equal(t.dialogs[0].title, "Zotero Atlas");
      assert.ok(t.dialogs[0].text.startsWith("Zotero Atlas never sends your library"));
      assert.equal(t.dialogs[0].b0, "Send my plugin list");
      assert.equal(t.dialogs[0].b1, "Don't send");
      assert.ok(!(t.dialogs[0].flags & (1 << 24)), "Send my plugin list is the default button");
      assert.equal(t.prefs["extensions.zotero-atlas.usage"], "no");
      assert.ok(
        !t.http.some((h) => h.url.includes("zoteroatlas.com")),
        "nothing sent to zoteroatlas.com",
      );
      assert.ok(!t.prefs["extensions.zotero-atlas.id"], "no ID made");
      t.s.onMainWindowLoad({ window: t.window });
      t.flush();
      await settle();
      assert.equal(t.dialogs.length, 1, "not asked again");
    },
  );

  await run(
    "installed while Zotero is open: asked from startup, menu added to the open window",
    async () => {
      const t = load({ answer: [1], http: () => ok200(catalogJson([])) });
      t.mainWindows = [t.window];
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      await settle();
      assert.equal(t.popup.children.length, 1, "menu in the open window");
      assert.equal(t.timers.filter((x) => x.ms === 8000).length, 1, "ask scheduled from startup");
      t.s.onMainWindowLoad({ window: t.window });
      assert.equal(t.timers.filter((x) => x.ms === 8000).length, 1, "not scheduled twice");
      t.flush();
      await settle();
      assert.equal(t.dialogs.length, 1);
      assert.equal(t.prefs["extensions.zotero-atlas.usage"], "no");
    },
  );

  await run(
    "at Zotero's start: the window comes with the UI-ready promise, asked once",
    async () => {
      const t = load({ answer: [1], http: () => ok200(catalogJson([])) });
      let ready;
      t.s.Zotero.uiReadyPromise = new Promise((r) => {
        ready = r;
      });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      assert.equal(t.popup.children.length, 0, "no window yet");
      t.mainWindows = [t.window];
      ready();
      await settle();
      assert.equal(t.popup.children.length, 1, "menu added when the UI is ready");
      t.s.onMainWindowLoad({ window: t.window });
      assert.equal(t.popup.children.length, 1, "not added twice");
      assert.equal(t.timers.filter((x) => x.ms === 8000).length, 1, "asked once");
    },
  );

  await run(
    "'Send my plugin list': a random ID and exactly these fields, our own plugin left out",
    async () => {
      const t = load({
        answer: [0],
        http: (m) => (m === "POST" ? { status: 204 } : ok200(catalogJson([]))),
        addons: [
          { id: "b@x", type: "extension", version: "2.0", isActive: false, name: "Secret Name" },
          { id: "a@x", type: "extension", version: "1.0", isActive: true, name: "A" },
          { id: "theme@x", type: "theme", version: "1", isActive: true },
        ],
      });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      t.s.onMainWindowLoad({ window: t.window });
      t.flush();
      await settle();
      assert.equal(t.prefs["extensions.zotero-atlas.usage"], "yes");
      assert.equal(t.prefs["extensions.zotero-atlas.id"], "12345678-1234-4123-8123-123456789abc");
      const post = t.http.find((h) => h.method === "POST");
      assert.equal(post.url, USAGE_URL);
      const body = JSON.parse(post.body);
      assert.deepEqual(Object.keys(body), ["id", "atlas", "zotero", "os", "event", "plugins"]);
      assert.deepEqual(body, {
        id: "12345678-1234-4123-8123-123456789abc",
        atlas: "0.1.0",
        zotero: "10.0.7",
        os: "mac",
        event: "first-run",
        plugins: [
          { id: "a@x", version: "1.0", enabled: true },
          { id: "b@x", version: "2.0", enabled: false },
        ],
      });
      assert.ok(!post.body.includes("Secret Name"), "no plugin names");
      assert.ok(!post.body.includes("zoteroatlas.com"), "our own plugin isn't listed");
    },
  );

  await run(
    "the daily check: catalogue fetched and kept, each notice once, grades remembered",
    async () => {
      const plugins = [
        entry({ id: "blocked@x", name: "Blocked", blocked: "crashes Zotero", slug: "blocked" }),
        entry({
          id: "worse@x",
          name: "Worse",
          update: { version: "1.3.0", grade: "C" },
          slug: "worse",
        }),
        entry({
          id: "drop@x",
          name: "Drop",
          grade: "B",
          because: "it launches programs on your computer",
          slug: "drop",
        }),
        entry({
          id: "dis@x",
          name: "Dis",
          supports: [11],
          file: build({ min: "11.0", max: "11.*", supports: [11] }),
          builds: [build({ name: "dis-z10.xpi", supports: [10], min: "10.0", max: "10.*" })],
          slug: "dis",
        }),
        entry({ id: "fine@x", name: "Fine", slug: "fine" }),
      ];
      let fetches = 0;
      const t = load({
        http: (m, url) => {
          if (url === CATALOG_URL) {
            fetches++;
            return ok200(catalogJson(plugins));
          }
          throw new Error("unexpected");
        },
        addons: [
          { id: "blocked@x", type: "extension", version: "1.2.0", isActive: true },
          { id: "worse@x", type: "extension", version: "1.2.0", isActive: true },
          { id: "drop@x", type: "extension", version: "1.1.0", isActive: true },
          { id: "dis@x", type: "extension", version: "1.2.0", isActive: false, appDisabled: true },
          { id: "fine@x", type: "extension", version: "1.2.0", isActive: true },
          { id: "unknown@x", type: "extension", version: "0.1", isActive: true },
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.prefs["extensions.zotero-atlas.state"] = JSON.stringify({
        seen: { "drop@x": { grade: "A", version: "1.1.0" } },
      });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      assert.equal(t.timers[0].ms, 20000, "first check waits for Zotero to settle");
      t.flush();
      await settle(20);
      assert.equal(fetches, 1);
      assert.ok(
        t.files["/data/zotero-atlas/catalog.json"].includes('"schemaVersion":1'),
        "catalogue saved",
      );
      assert.deepEqual(t.notices, [
        "Blocked: Zotero's blocklist blocks version 1.2.0 (crashes Zotero).",
        "Worse: the update offered for it (1.3.0) is graded C, lower than the A of version 1.2.0.",
        "2 more things to look at: Tools → Zotero Atlas → Your plugins.",
      ]);
      const st = JSON.parse(t.prefs["extensions.zotero-atlas.state"]);
      assert.equal(st.seen["drop@x"].grade, "B");
      assert.equal(st.seen["drop@x"].droppedFrom, "A", "the drop is remembered");
      assert.equal(st.catalogEtag, '"e1"');
      assert.equal(Object.keys(st.noticed).length, 4);
      const rv = await t.s.Zotero.ZoteroAtlas.review(false);
      const flags = Object.fromEntries(rv.items.map((i) => [i.addon.id, i.flags]));
      assert.deepEqual(flags, {
        "blocked@x": ["blocked"],
        "dis@x": ["disabled-fix"],
        "drop@x": ["grade-drop", "outdated"],
        "fine@x": [],
        "unknown@x": ["not-listed"],
        "worse@x": ["worse-update"],
      });
      assert.equal(rv.fresh.length, 0, "nothing new to notice");
      assert.equal(
        rv.items.find((i) => i.addon.id === "drop@x").texts[0],
        "Drop went from A to B: it launches programs on your computer.",
      );
      assert.equal(fetches, 1, "within a day the saved catalogue is used");
      assert.equal(t.timers.length, 1, "next check scheduled");
      assert.equal(t.timers[0].ms, 24 * 60 * 60 * 1000);
      assert.ok(!t.http.some((h) => h.url.includes("zoteroatlas.com")), "'no' sends nothing");

      plugins[2].grade = "A";
      const back = await t.s.Zotero.ZoteroAtlas.review(true);
      assert.deepEqual(
        back.items.find((i) => i.addon.id === "drop@x").flags,
        ["outdated"],
        "back up: no longer a drop",
      );
    },
  );

  await run("catalogue: a 304 and a failed fetch both keep the saved copy", async () => {
    let mode = "ok";
    const t = load({
      http: (_m, url, o) => {
        if (mode === "ok") return ok200(catalogJson([entry({})]));
        if (mode === "304") {
          assert.equal(o.headers["If-None-Match"], '"e1"');
          return { status: 304, responseText: "", getResponseHeader: () => null };
        }
        throw new Error("down");
      },
    });
    t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
    const A = t.s.Zotero.ZoteroAtlas;
    const first = await A.catalog(true);
    assert.equal(first.plugins.length, 1);
    mode = "304";
    assert.equal((await A.catalog(true)).plugins.length, 1);
    mode = "down";
    assert.equal((await A.catalog(true)).plugins.length, 1, "kept after a failed fetch");
    const fresh = load({
      http: () => {
        throw new Error("down");
      },
    });
    fresh.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
    await assert.rejects(fresh.s.Zotero.ZoteroAtlas.catalog(true), /couldn't be fetched/);
  });

  await run(
    "usage: weekly, on change, kept for retry when the server is down, deleted on 'Don't send'",
    async () => {
      let down = false;
      const t = load({
        http: (m, url) => {
          if (url === CATALOG_URL) return ok200(catalogJson([]));
          if (down) throw new Error("503");
          return { status: 204 };
        },
        addons: [{ id: "a@x", type: "extension", version: "1.0", isActive: true }],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "yes";
      t.prefs["extensions.zotero-atlas.id"] = "11111111-1111-4111-8111-111111111111";
      const hash = "a@x@1.0:1";
      t.prefs["extensions.zotero-atlas.state"] = JSON.stringify({
        sentAt: Date.now() - 8 * 24 * 3600 * 1000,
        sentHash: hash,
      });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      t.flush();
      await settle(20);
      const posts = () =>
        t.http.filter((h) => h.method === "POST").map((h) => JSON.parse(h.body).event);
      assert.deepEqual(posts(), ["weekly"]);
      t.addons.push({ id: "b@x", type: "extension", version: "2.0", isActive: true });
      down = true;
      await t.s.maybeSend(await t.s.installed());
      assert.deepEqual(posts(), ["weekly", "changed"]);
      assert.equal(
        JSON.parse(t.prefs["extensions.zotero-atlas.state"]).sentHash,
        hash,
        "a failed send changes nothing",
      );
      down = false;
      await t.s.maybeSend(await t.s.installed());
      assert.deepEqual(posts(), ["weekly", "changed", "changed"]);
      assert.equal(
        JSON.parse(t.prefs["extensions.zotero-atlas.state"]).sentHash,
        "a@x@1.0:1\nb@x@2.0:1",
      );
      await t.s.maybeSend(await t.s.installed());
      assert.equal(posts().length, 3, "nothing to send");
      t.s.Zotero.ZoteroAtlas.usage.set("no");
      await settle();
      const del = t.http.find((h) => h.method === "DELETE");
      assert.equal(del.url, `${USAGE_URL}/11111111-1111-4111-8111-111111111111`);
      assert.equal(t.prefs["extensions.zotero-atlas.id"], "");
      assert.equal(JSON.parse(t.prefs["extensions.zotero-atlas.state"]).sentAt, 0);
      t.s.Zotero.ZoteroAtlas.usage.set("yes");
      await settle();
      assert.deepEqual(posts(), ["weekly", "changed", "changed", "first-run"]);
      assert.ok(t.prefs["extensions.zotero-atlas.id"], "a new ID");
    },
  );

  await run(
    "install: refuses an unanalysed file, cancel installs nothing, a wrong hash installs nothing, success",
    async () => {
      const t = load({ answer: [1, 0, 0] });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      const A = t.s.Zotero.ZoteroAtlas;
      const e = entry({});
      let r = await A.install(e, build({ sha256: null }), t.window);
      assert.ok(!r.ok && /haven't analysed/.test(r.message));
      assert.equal(t.installs.length, 0);
      r = await A.install(e, null, t.window);
      assert.ok(!r.ok && /No listed version/.test(r.message));
      r = await A.install(e, e.file, t.window);
      assert.ok(!r.ok && r.cancelled);
      assert.equal(t.installs.length, 0);
      assert.ok(/grade A: every code check came out low/.test(t.dialogs[0].text));
      assert.ok(/SHA-256 aaaaaaaaaaaa/.test(t.dialogs[0].text));
      t.installError = -2;
      r = await A.install(e, e.file, t.window);
      assert.ok(!r.ok && /doesn't match the one we analysed/.test(r.message));
      assert.deepEqual(t.installs[0].opts.hash, `sha256:${"a".repeat(64)}`);
      t.installError = 0;
      r = await A.install(e, e.file, t.window);
      assert.ok(r.ok && /is installed/.test(r.message));
      assert.ok(
        t.timers.some((x) => x.ms === 5000),
        "a check follows an install",
      );
    },
  );

  await run(
    "ratings: a slow hash of Zotero's key, never the key; exactly these fields; the list ID only while sending",
    async () => {
      const t = load({ http: () => ({ status: 204, responseText: "" }) });
      t.s.startup({ id: "a", version: "0.2.0", rootURI: "r/" });
      const A = t.s.Zotero.ZoteroAtlas;
      const win = { crypto: require("node:crypto").webcrypto, TextEncoder };
      const target = { slug: "x", addon: "x@example.org", version: "1.2.0", name: "X" };
      const r = await A.ratings.rate({ ...target, stars: 4, text: "  Good.  " }, win);
      assert.ok(r.ok, r.message);
      const req = t.http.at(-1);
      assert.equal(req.url, "https://zoteroatlas.com/api/v1/ratings");
      const sent = JSON.parse(req.body);
      assert.deepEqual(Object.keys(sent).sort(), [
        "addon",
        "atlas",
        "os",
        "rater",
        "slug",
        "stars",
        "text",
        "version",
        "zotero",
      ]);
      const expected = require("node:crypto")
        .pbkdf2Sync("AbCd2345", "zotero-atlas ratings v1", 600000, 32, "sha256")
        .toString("hex");
      assert.equal(sent.rater, expected, "PBKDF2 of the local user key");
      assert.ok(!req.body.includes("AbCd2345"), "the key itself is never sent");
      assert.equal(sent.text, "Good.");
      assert.deepEqual(
        [sent.stars, sent.version, sent.atlas, sent.os],
        [4, "1.2.0", "0.2.0", "mac"],
      );
      assert.equal(A.ratings.rated("x", "1.2.0").stars, 4);
      assert.equal(A.ratings.rated("x", "1.1.0"), null);

      t.prefs["extensions.zotero-atlas.usage"] = "yes";
      t.prefs["extensions.zotero-atlas.id"] = "12345678-1234-4123-8123-123456789abc";
      await A.ratings.rate({ ...target, stars: 2 }, win);
      const again = JSON.parse(t.http.at(-1).body);
      assert.equal(again.install, "12345678-1234-4123-8123-123456789abc");
      assert.equal(again.rater, expected, "same Zotero, same ID");
      assert.equal(again.text, null);

      const n = t.http.length;
      assert.equal((await A.ratings.rate({ ...target, stars: 0 }, win)).ok, false);
      assert.equal((await A.ratings.rate({ ...target, stars: 6 }, win)).ok, false);
      assert.equal(t.http.length, n, "nothing sent without one to five stars");

      t.httpHandler = () => {
        const e = new Error("HTTP 429");
        e.status = 429;
        throw e;
      };
      const busy = await A.ratings.rate({ ...target, stars: 5 }, win);
      assert.ok(!busy.ok && /Too many ratings/.test(busy.message));
      assert.equal(A.ratings.rated("x", "1.2.0").stars, 2, "a failed rating isn't remembered");
    },
  );

  await run("ratings: a removed plugin can be rated for 30 days, then it's forgotten", async () => {
    const e = entry({});
    const x = {
      id: "x@example.org",
      type: "extension",
      name: "X",
      version: "1.1.0",
      isActive: true,
    };
    const t = load({ addons: [x], http: () => ok200(catalogJson([e])) });
    t.s.startup({ id: "a", version: "0.2.0", rootURI: "r/" });
    const A = t.s.Zotero.ZoteroAtlas;
    await A.review(true);
    assert.deepEqual(A.ratings.removed(), []);
    t.addons = [];
    await A.review(false);
    const gone = A.ratings.removed();
    assert.equal(gone.length, 1);
    assert.deepEqual(
      { id: gone[0].id, slug: gone[0].slug, name: gone[0].name, version: gone[0].version },
      { id: "x@example.org", slug: "x", name: "X", version: "1.1.0" },
    );
    t.addons = [x];
    await A.review(false);
    assert.deepEqual(A.ratings.removed(), [], "installed again: not listed as removed");
    t.addons = [];
    await A.review(false);
    const st = JSON.parse(t.prefs["extensions.zotero-atlas.state"]);
    st.removed["x@example.org"].at = Date.now() - 31 * 24 * 3600 * 1000;
    t.prefs["extensions.zotero-atlas.state"] = JSON.stringify(st);
    await A.review(false);
    assert.deepEqual(A.ratings.removed(), [], "forgotten after 30 days");
  });

  await run("worksWith and fileFor compare versions the way Zotero does", async () => {
    const t = load();
    t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
    const A = t.s.Zotero.ZoteroAtlas;
    assert.equal(A.worksWith(build({ min: "7.0", max: "10.*" }), "10.0.7"), true);
    assert.equal(A.worksWith(build({ min: "7.0", max: "10.0" }), "10.0.7"), false);
    assert.equal(A.worksWith(build({ min: "7.0", max: "10.0.2" }), "10.0.4"), false);
    assert.equal(A.worksWith(build({ min: "11.0", max: "11.*" }), "10.0.7"), false);
    assert.equal(A.worksWith(build({ supports: [] }), "10.0.7"), false);
    const e = entry({
      supports: [11],
      file: build({ min: "11.0", max: "11.*", supports: [11] }),
      builds: [build({ name: "z10.xpi", supports: [10] })],
    });
    assert.equal(A.fileFor(e, "10.0.7").name, "z10.xpi");
    assert.equal(A.fileFor(entry({ supports: [] }), "10.0.7"), null);
    assert.equal(A.fileFor(entry({}), "10.0.7").name, "x.xpi");
  });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
