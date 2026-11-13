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
  // A tiny DOM: elements know their parent, children, attributes and listeners.
  const node = (tag) => {
    const n = {
      tag,
      attrs: {},
      children: [],
      parentNode: null,
      listeners: {},
      textContent: "",
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return k in this.attrs ? this.attrs[k] : null;
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      addEventListener(type, fn) {
        this.listeners[type] = this.listeners[type] ?? [];
        this.listeners[type].push(fn);
      },
      appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        return c;
      },
      insertBefore(c, ref) {
        c.parentNode = this;
        const i = this.children.indexOf(ref);
        this.children.splice(i < 0 ? this.children.length : i, 0, c);
        return c;
      },
      after(c) {
        const p = this.parentNode;
        c.parentNode = p;
        p.children.splice(p.children.indexOf(this) + 1, 0, c);
      },
      remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
      },
      get firstChild() {
        return this.children[0] ?? null;
      },
      click() {
        for (const f of this.listeners.click ?? []) f({ preventDefault() {} });
        for (const f of this.listeners.command ?? []) f({});
      },
    };
    Object.defineProperty(n, "textContent", {
      get() {
        return this._text ?? "";
      },
      set(v) {
        this._text = v;
        if (v === "") this.children = [];
      },
    });
    return n;
  };
  t.node = node;
  const mainWindow = () => {
    const ids = {};
    const doc = {
      documentElement: node("window"),
      getElementById: (id) => ids[id] ?? null,
      createXULElement: (tag) => node(tag),
      createElementNS: (_ns, tag) => node(tag),
    };
    t.popup = node("menupopup");
    ids.menu_ToolsPopup = t.popup;
    if (!opts.bareWindow) {
      const plugins = node("menuitem");
      plugins.attrs.id = "menu_addons";
      t.popup.appendChild(plugins);
      ids.menu_addons = plugins;
      const bar = node("hbox");
      const sync = node("toolbarbutton");
      bar.appendChild(sync);
      ids["zotero-tb-sync"] = sync;
      t.toolbar = bar;
      const pane = node("tab-content");
      const trees = node("hbox");
      pane.appendChild(trees);
      ids["zotero-trees"] = trees;
      t.pane = pane;
    }
    return {
      document: doc,
      openDialog: (url, name, features, args) => {
        if (String(url).includes("firstrun")) {
          t.firstRun = (t.firstRun ?? 0) + 1;
          if (opts.firstRunFails) throw new Error("no window");
          if (opts.firstRun) Object.assign(args, opts.firstRun);
          return {};
        }
        t.opened = [url, name, features, args];
        return { closed: false, focus() {}, close() {} };
      },
    };
  };
  t.ours = () => t.popup.children.filter((c) => c.attrs.id === "zotero-atlas-menu");
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
      wm: {
        addListener: (l) => {
          t.wm = l;
        },
        removeListener: () => {
          t.wm = null;
        },
        getEnumerator: () => [],
      },
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
    STATE_DOWNLOADED: 6,
    UPDATE_WHEN_USER_REQUESTED: 1,
    installListeners: [],
    addonListeners: [],
    addInstallListener(l) {
      this.installListeners.push(l);
    },
    removeInstallListener(l) {
      this.installListeners = this.installListeners.filter((x) => x !== l);
    },
    addAddonListener(l) {
      this.addonListeners.push(l);
    },
    removeAddonListener(l) {
      this.addonListeners = this.addonListeners.filter((x) => x !== l);
    },
    getAddonByID: async (id) => {
      const a = t.addons.find((x) => x.id === id);
      if (!a) return null;
      return {
        ...a,
        disable: async () => {
          a.isActive = false;
          a.userDisabled = true;
          t.log.push(`disabled:${id}`);
        },
        findUpdates: (l) => {
          t.log.push(`findUpdates:${id}`);
          const inst = {
            version: t.offered?.[id] ?? "9.9.9",
            install() {
              t.log.push(`install:${id}@${this.version}`);
            },
          };
          l.onUpdateAvailable?.(a, inst);
        },
      };
    },
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
    "lifecycle: menu under Plugins, the button by sync, the bar, pane once; all removed; uninstall clears everything",
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
      assert.equal(t.ours().length, 1);
      assert.equal(t.popup.children[1], t.ours()[0], "right under Plugins");
      assert.equal(t.ours()[0].attrs.label, "Zotero Atlas…");
      assert.equal(t.ours()[0].attrs.class, "menuitem-iconic");
      assert.match(t.ours()[0].attrs.image, /icons\/atlas\.svg$/);
      const button = t.toolbar.children[0];
      assert.equal(button.attrs.id, "zotero-atlas-tb", "the button sits before sync");
      assert.equal(button.attrs.attention, undefined, "no dot before anything is known");
      assert.equal(t.pane.children[0].attrs.id, "zotero-atlas-banner-container");
      assert.equal(t.pane.children[0].attrs.collapsed, "true", "the bar starts hidden");
      assert.equal(t.AM.installListeners.length, 1, "listens for updates");
      t.s.shutdown({}, 2);
      assert.equal(t.ours().length, 0);
      assert.equal(t.toolbar.children.length, 1, "button removed");
      assert.equal(t.pane.children.length, 1, "bar removed");
      assert.equal(t.AM.installListeners.length, 0, "stops listening");
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
    "first run: one screen, asked once; 'Don't send' sends nothing; holding as chosen",
    async () => {
      const t = load({
        firstRun: { usage: "no", updates: "off" },
        http: () => ok200(catalogJson([])),
      });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      t.s.onMainWindowLoad({ window: t.window });
      t.s.onMainWindowLoad({ window: t.window });
      assert.equal(t.timers.filter((x) => x.ms === 8000).length, 1, "one ask timer");
      t.flush();
      await settle();
      assert.equal(t.firstRun, 1);
      assert.equal(t.prefs["extensions.zotero-atlas.usage"], "no");
      assert.equal(t.prefs["extensions.zotero-atlas.updates"], "off");
      assert.ok(
        !t.http.some((h) => h.url.includes("zoteroatlas.com")),
        "nothing sent to zoteroatlas.com",
      );
      assert.ok(!t.prefs["extensions.zotero-atlas.id"], "no ID made");
      t.s.onMainWindowLoad({ window: t.window });
      t.flush();
      await settle();
      assert.equal(t.firstRun, 1, "not asked again");
    },
  );

  await run(
    "first run: closing the screen keeps the recommended answers (send, hold)",
    async () => {
      const t = load({ http: (m) => (m === "POST" ? { status: 204 } : ok200(catalogJson([]))) });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      t.s.onMainWindowLoad({ window: t.window });
      t.flush();
      await settle();
      assert.equal(t.prefs["extensions.zotero-atlas.usage"], "yes");
      assert.equal(t.prefs["extensions.zotero-atlas.updates"], "hold");
    },
  );

  await run(
    "first run: if the screen can't open, the usage question is asked plainly; updates stay unasked",
    async () => {
      const t = load({ firstRunFails: true, answer: [1], http: () => ok200(catalogJson([])) });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      t.s.onMainWindowLoad({ window: t.window });
      t.flush();
      await settle();
      assert.equal(t.dialogs.length, 1);
      assert.ok(t.dialogs[0].text.startsWith("Zotero Atlas never sends your library"));
      assert.equal(t.dialogs[0].b0, "Send my plugin list");
      assert.ok(!(t.dialogs[0].flags & (1 << 24)), "Send my plugin list is the default button");
      assert.equal(t.prefs["extensions.zotero-atlas.usage"], "no");
      assert.ok(!t.prefs["extensions.zotero-atlas.updates"], "holding not chosen for them");
    },
  );

  await run(
    "installed while Zotero is open: asked from startup, menu added to the open window",
    async () => {
      const t = load({ firstRun: { usage: "no" }, http: () => ok200(catalogJson([])) });
      t.mainWindows = [t.window];
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      await settle();
      assert.equal(t.ours().length, 1, "menu in the open window");
      assert.equal(t.timers.filter((x) => x.ms === 8000).length, 1, "ask scheduled from startup");
      t.s.onMainWindowLoad({ window: t.window });
      assert.equal(t.timers.filter((x) => x.ms === 8000).length, 1, "not scheduled twice");
      t.flush();
      await settle();
      assert.equal(t.firstRun, 1);
      assert.equal(t.prefs["extensions.zotero-atlas.usage"], "no");
    },
  );

  await run(
    "at Zotero's start: the window comes with the UI-ready promise, asked once",
    async () => {
      const t = load({ firstRun: { usage: "no" }, http: () => ok200(catalogJson([])) });
      let ready;
      t.s.Zotero.uiReadyPromise = new Promise((r) => {
        ready = r;
      });
      t.s.startup({ id: "a", version: "0.1.0", rootURI: "r/" });
      assert.equal(t.ours().length, 0, "no window yet");
      t.mainWindows = [t.window];
      ready();
      await settle();
      assert.equal(t.ours().length, 1, "menu added when the UI is ready");
      t.s.onMainWindowLoad({ window: t.window });
      assert.equal(t.ours().length, 1, "not added twice");
      assert.equal(t.timers.filter((x) => x.ms === 8000).length, 1, "asked once");
    },
  );

  await run(
    "'Send my plugin list': a random ID and exactly these fields, our own plugin left out",
    async () => {
      const t = load({
        firstRun: { usage: "yes" },
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
        http: (_m, url) => {
          if (url === CATALOG_URL) {
            fetches++;
            return ok200(catalogJson(plugins));
          }
          throw new Error("unexpected");
        },
        addons: [
          { id: "blocked@x", type: "extension", version: "1.2.0", isActive: true },
          { id: "worse@x", type: "extension", version: "1.2.0", isActive: true },
          { id: "drop@x", type: "extension", version: "1.2.0", isActive: true },
          { id: "dis@x", type: "extension", version: "1.2.0", isActive: false, appDisabled: true },
          { id: "fine@x", type: "extension", version: "1.2.0", isActive: true },
          { id: "unknown@x", type: "extension", version: "0.1", isActive: true },
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.prefs["extensions.zotero-atlas.state"] = JSON.stringify({
        seen: { "drop@x": { grade: "A", version: "1.2.0" } },
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
        "Blocked is blocked by Zotero: crashes Zotero.",
        "Zotero turned Dis off: the copy you have isn't for Zotero 10.0.7. Another build of 1.2.0 works, and we've checked it.",
        "2 more things to look at: click the Zotero Atlas button by the sync button.",
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
        "drop@x": ["grade-drop"],
        "fine@x": [],
        "unknown@x": ["not-listed"],
        "worse@x": ["worse-update"],
      });
      const levels = Object.fromEntries(
        rv.items.map((i) => [i.addon.id, i.alerts.map((a) => a.level).join(",")]),
      );
      assert.equal(levels["blocked@x"], "critical");
      assert.equal(levels["worse@x"], "important");
      assert.equal(rv.fresh.length, 0, "nothing new to notice");
      assert.equal(
        rv.items.find((i) => i.addon.id === "drop@x").alerts[0].text,
        "Drop went from A to B: it launches programs on your computer.",
      );
      assert.equal(fetches, 1, "within a day the saved catalogue is used");
      assert.ok(
        t.timers.some((x) => x.ms === 24 * 60 * 60 * 1000),
        "next check scheduled",
      );
      assert.ok(
        t.timers.some((x) => x.ms === 6 * 60 * 60 * 1000),
        "advisories every 6 hours",
      );
      assert.ok(!t.http.some((h) => h.url.includes("zoteroatlas.com")), "'no' sends nothing");

      plugins[2].grade = "A";
      const back = await t.s.Zotero.ZoteroAtlas.review(true);
      assert.deepEqual(
        back.items.find((i) => i.addon.id === "drop@x").flags,
        [],
        "back up: no longer a drop",
      );
    },
  );

  await run("catalogue: a 304 and a failed fetch both keep the saved copy", async () => {
    let mode = "ok";
    const t = load({
      http: (_m, _url, o) => {
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
        http: (_m, url) => {
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

  const ADV_URL =
    "https://raw.githubusercontent.com/iliasbeshimov/zoteroplugins.org/main/data/advisories.json";
  const sha = (c) => c.repeat(64);
  const advJson = (advisories) =>
    JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-09T00:00:00Z", advisories });

  await run(
    "holdDecision: never for unlisted plugins; unchecked, worse, blocked, advisory, pinned",
    async () => {
      const t = load();
      const e = entry({
        grade: "A",
        version: "1.2.0",
        file: build({ sha256: sha("b") }),
        previous: [
          { version: "1.1.0", grade: "A", file: build({ sha256: sha("c") }) },
          { version: "1.0.0", grade: "B", file: build({ sha256: sha("d") }) },
        ],
      });
      const d = (o) =>
        t.s.holdDecision({
          entry: e,
          id: e.id,
          v: "1.2.0",
          from: "1.1.0",
          sha256: sha("b"),
          adv: [],
          ...o,
        });
      assert.deepEqual(d({ entry: null }), { hold: false }, "not listed: never held");
      assert.deepEqual(d({}), { hold: false }, "checked, same grade: installs");
      assert.equal(d({ sha256: sha("f") }).reason, "unchecked", "a file we never analysed");
      assert.equal(d({ sha256: null }).reason, "unchecked");
      assert.equal(d({ pinned: true }).reason, "pinned");
      const worse = t.s.holdDecision({
        entry: { ...e, grade: "B" },
        id: e.id,
        v: "1.2.0",
        from: "1.1.0",
        sha256: sha("b"),
        adv: [],
      });
      assert.deepEqual(worse, { hold: true, reason: "worse", grade: "B", before: "A" });
      assert.deepEqual(
        t.s.holdDecision({
          entry: e,
          id: e.id,
          v: "1.2.0",
          from: "1.0.0",
          sha256: sha("b"),
          adv: [],
        }),
        { hold: false },
        "better than the B you had",
      );
      assert.equal(d({ entry: { ...e, blocked: "crashes" } }).reason, "blocked");
      const adv = [{ addon: e.id, affects: { min: "1.2.0", max: null }, severity: "critical" }];
      assert.equal(d({ adv }).reason, "advisory");
      assert.equal(
        d({ adv: [{ ...adv[0], affects: { min: null, max: "1.1.9" } }] }).hold,
        false,
        "an advisory for older versions doesn't hold this one",
      );
      assert.equal(
        d({ entry: { ...e, grade: "–" } }).reason,
        "unchecked",
        "a file we couldn't grade waits",
      );
    },
  );

  await run(
    "holding: the update listener pauses unchecked updates, lets checked ones through",
    async () => {
      const e = entry({ grade: "A", version: "1.2.0", file: build({ sha256: sha("b") }) });
      const t = load({
        http: (_m, url) => (url === CATALOG_URL ? ok200(catalogJson([e])) : ok200(advJson([]))),
        addons: [
          { id: "x@example.org", type: "extension", name: "X", version: "1.1.0", isActive: true },
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.prefs["extensions.zotero-atlas.updates"] = "hold";
      t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
      await t.s.Zotero.ZoteroAtlas.catalog(true);
      const L = t.AM.installListeners[0];
      const inst = (o) => ({
        version: "1.2.0",
        file: {},
        existingAddon: { id: "x@example.org", version: "1.1.0", name: "X" },
        state: 6,
        install() {
          t.log.push("resumed");
        },
        ...o,
      });
      t.s.fileSha256 = () => sha("b");
      assert.equal(L.onDownloadEnded(inst()), undefined, "checked and not worse: installs");
      t.s.fileSha256 = () => sha("9");
      assert.equal(L.onDownloadEnded(inst()), false, "a file we haven't checked waits");
      let st = JSON.parse(t.prefs["extensions.zotero-atlas.state"]);
      assert.equal(st.held["x@example.org"].reason, "unchecked");
      assert.equal(st.held["x@example.org"].from, "1.1.0");
      assert.equal(
        L.onDownloadEnded(inst({ existingAddon: null })),
        undefined,
        "a new install is never held",
      );
      assert.equal(
        L.onDownloadEnded(
          inst({ existingAddon: { id: "atlas@zoteroatlas.com", version: "0.2.0" } }),
        ),
        undefined,
        "Atlas updates itself as usual",
      );
      assert.equal(
        L.onDownloadEnded(inst({ existingAddon: { id: "other@x", version: "1" } })),
        undefined,
        "a plugin we don't list is never held",
      );
      // "Update anyway": the paused download goes ahead, once.
      assert.equal(await t.s.Zotero.ZoteroAtlas.decide.update("x@example.org"), true);
      assert.ok(t.log.includes("resumed"));
      st = JSON.parse(t.prefs["extensions.zotero-atlas.state"]);
      assert.ok(!st.held["x@example.org"], "no longer held");
      t.prefs["extensions.zotero-atlas.updates"] = "off";
      assert.equal(L.onDownloadEnded(inst()), undefined, "holding off: Zotero's updates as usual");
    },
  );

  await run(
    "holding: an update waiting for our check goes ahead once the catalogue knows it",
    async () => {
      let plugins = [entry({ grade: "A", version: "1.1.0", file: build({ sha256: sha("a") }) })];
      const t = load({
        http: (_m, url) => (url === CATALOG_URL ? ok200(catalogJson(plugins)) : ok200(advJson([]))),
        addons: [
          { id: "x@example.org", type: "extension", name: "X", version: "1.1.0", isActive: true },
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.prefs["extensions.zotero-atlas.updates"] = "hold";
      t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
      const A = t.s.Zotero.ZoteroAtlas;
      await A.catalog(true);
      t.s.fileSha256 = () => sha("b");
      const inst = {
        version: "1.2.0",
        file: {},
        existingAddon: { id: "x@example.org", version: "1.1.0", name: "X" },
        state: 0,
        install() {},
      };
      assert.equal(t.AM.installListeners[0].onDownloadEnded(inst), false);
      let rv = await A.review(false);
      const al = rv.items[0].alerts.find((a) => a.flag === "waiting");
      assert.equal(al.level, "info", "waiting for our check is quiet: no dot");
      assert.equal(t.s.unseen(rv).length, 0);
      // A week without our check: it's yours to decide.
      const week = JSON.parse(t.prefs["extensions.zotero-atlas.state"]);
      const at = week.held["x@example.org"].at;
      week.held["x@example.org"].at = Date.now() - 8 * 24 * 3600 * 1000;
      t.prefs["extensions.zotero-atlas.state"] = JSON.stringify(week);
      const late = (await A.review(false)).items[0].alerts.find((a) => a.flag === "held");
      assert.equal(late.level, "important");
      assert.match(late.text, /^Update 1\.2\.0 has waited a week/);
      week.held["x@example.org"].at = at;
      t.prefs["extensions.zotero-atlas.state"] = JSON.stringify(week);
      // Next day: the catalogue has analysed 1.2.0, graded A.
      plugins = [
        entry({
          grade: "A",
          version: "1.2.0",
          file: build({ sha256: sha("b") }),
          previous: [{ version: "1.1.0", grade: "A", file: build({ sha256: sha("a") }) }],
        }),
      ];
      await A.catalog(true);
      await t.s.releaseHeld();
      assert.ok(t.log.includes("findUpdates:x@example.org"), "asks Zotero for the update again");
      assert.ok(t.log.some((l) => l.startsWith("install:x@example.org")));
      assert.ok(!JSON.parse(t.prefs["extensions.zotero-atlas.state"]).held["x@example.org"]);
      // Graded lower instead: it now needs you.
      const held = JSON.parse(t.prefs["extensions.zotero-atlas.state"]);
      held.held = {
        "x@example.org": { version: "1.2.0", from: "1.1.0", reason: "unchecked", at: Date.now() },
      };
      t.prefs["extensions.zotero-atlas.state"] = JSON.stringify(held);
      plugins[0].grade = "B";
      await A.catalog(true);
      await t.s.releaseHeld();
      const h = JSON.parse(t.prefs["extensions.zotero-atlas.state"]).held["x@example.org"];
      assert.deepEqual([h.reason, h.grade, h.before], ["worse", "B", "A"]);
      rv = await A.review(false);
      const need = rv.items[0].alerts.find((a) => a.flag === "held");
      assert.equal(need.level, "important");
      assert.equal(
        need.text,
        "Update 1.2.0 held: graded B, lower than the A of the version you have.",
      );
      // "Keep 1.1.0": quiet from then on.
      A.decide.keep("x@example.org");
      await settle();
      rv = await A.review(false);
      assert.deepEqual(
        rv.items[0].alerts.map((a) => [a.flag, a.level]),
        [["kept", "info"]],
      );
    },
  );

  await run("the red dot, the bar and the notices: once each, cleared by looking", async () => {
    const e = entry({ id: "bad@x", name: "Bad", blocked: "it uploads your library" });
    const t = load({
      http: (_m, url) => (url === CATALOG_URL ? ok200(catalogJson([e])) : ok200(advJson([]))),
      addons: [{ id: "bad@x", type: "extension", name: "Bad", version: "1.2.0", isActive: true }],
    });
    t.prefs["extensions.zotero-atlas.usage"] = "no";
    t.prefs["extensions.zotero-atlas.updates"] = "hold";
    t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
    t.s.onMainWindowLoad({ window: t.window });
    t.flush();
    await settle(20);
    const button = t.toolbar.children[0];
    const banner = t.pane.children[0];
    assert.equal(button.attrs.attention, "true", "a red dot");
    assert.equal(button.attrs.tooltiptext, "Zotero Atlas: 1 thing to look at");
    assert.equal(banner.attrs.collapsed, undefined, "the bar shows");
    const bar = banner.children[0];
    assert.equal(bar.children[0].textContent, "Bad is blocked by Zotero: it uploads your library.");
    assert.deepEqual(
      bar.children.filter((c) => c.tag === "a").map((c) => c.textContent),
      ["Turn it off", "What we know"],
    );
    assert.deepEqual(t.notices, ["Bad is blocked by Zotero: it uploads your library."]);
    t.s.Zotero.ZoteroAtlas.ack();
    assert.equal(button.attrs.attention, undefined, "looked at: no dot");
    assert.equal(banner.attrs.collapsed, undefined, "the bar stays until dealt with or closed");
    bar.children.find((c) => c.tag === "a").click();
    await settle();
    assert.ok(t.log.includes("disabled:bad@x"), "Turn it off turns it off");
    bar.children.find((c) => c.attrs.class === "close-btn").click();
    assert.equal(banner.attrs.collapsed, "true", "closed");
    await t.s.Zotero.ZoteroAtlas.review(false);
    assert.equal(t.notices.length, 1, "each notice once");
    assert.equal(banner.attrs.collapsed, "true", "stays closed");
  });

  const DAYS = 24 * 3600 * 1000;
  const STATE = "extensions.zotero-atlas.state";
  const getState = (t) => JSON.parse(t.prefs[STATE]);
  const putState = (t, st) => {
    t.prefs[STATE] = JSON.stringify(st);
  };
  /** Pretends Atlas first saw each of these add-ons `days` ago. */
  const age = (t, days) => {
    const st = getState(t);
    for (const [id, d] of Object.entries(days)) st.seen[id].since = Date.now() - d * DAYS;
    putState(t, st);
  };
  const addon = (id, name, o = {}) => ({
    id,
    type: "extension",
    name,
    version: "1.0.0",
    isActive: true,
    ...o,
  });

  await run(
    "asking for ratings: two weeks in, three at a time, a blue dot that looking clears, once a month",
    async () => {
      const ids = ["a", "b", "c", "d", "off"];
      const plugins = ids.map((k) =>
        entry({ slug: k, id: `${k}@x`, name: k.toUpperCase(), version: "1.0.0" }),
      );
      const t = load({
        http: (_m, url) =>
          url === CATALOG_URL
            ? ok200(catalogJson(plugins))
            : url.includes("/ratings")
              ? { status: 204, responseText: "" }
              : ok200(advJson([])),
        addons: [
          ...ids.map((k) => addon(`${k}@x`, k.toUpperCase(), { isActive: k !== "off" })),
          addon("unlisted@x", "Unlisted"),
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.prefs["extensions.zotero-atlas.updates"] = "hold";
      t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
      t.s.onMainWindowLoad({ window: t.window });
      t.flush();
      await settle(20);
      const A = t.s.Zotero.ZoteroAtlas;
      const button = t.toolbar.children[0];
      assert.equal(button.attrs.attention, undefined, "nothing to rate on day one");
      assert.deepEqual(A.ratings.asking(), []);
      assert.equal(
        getState(t).seen["a@x"].early,
        true,
        "there before Atlas: in use at least that long",
      );

      // 13 days: still too soon.
      age(t, { "a@x": 13, "b@x": 13, "c@x": 13, "d@x": 13, "off@x": 13, "unlisted@x": 13 });
      await A.review(false);
      assert.deepEqual(A.ratings.asking(), []);
      assert.equal(getState(t).askRound, null);

      // Two weeks and more: the three in use longest; never a turned-off or unlisted plugin.
      age(t, { "a@x": 40, "b@x": 30, "c@x": 20, "d@x": 15, "off@x": 50, "unlisted@x": 60 });
      await A.review(false);
      assert.deepEqual(
        A.ratings.asking().map((i) => i.entry.slug),
        ["a", "b", "c"],
      );
      assert.equal(button.attrs.attention, "rate", "a blue dot, not the red one");
      assert.equal(button.attrs.tooltiptext, "Zotero Atlas: 3 plugins to rate");
      assert.deepEqual(t.notices, [], "no notice for ratings, ever");
      assert.ok(!t.http.some((r) => r.url.includes("/ratings")), "asking sends nothing");

      // Opening "Your plugins" clears the dot; the cards stay.
      A.ack();
      assert.equal(button.attrs.attention, undefined);
      assert.equal(A.ratings.asking().length, 3);

      // "Not now" and a rating each take a card away.
      A.ratings.later("b");
      const win = { crypto: require("node:crypto").webcrypto, TextEncoder };
      const r = await A.ratings.rate(
        { slug: "c", addon: "c@x", version: "1.0.0", name: "C", stars: 5 },
        win,
      );
      assert.ok(r.ok, r.message);
      assert.deepEqual(
        A.ratings.asking().map((i) => i.entry.slug),
        ["a"],
      );

      // Within the month: no new round, so D waits.
      await A.review(false);
      assert.deepEqual(getState(t).askRound.slugs, ["a", "b", "c"]);
      assert.equal(button.attrs.attention, undefined);

      // A month on: a new round with the next ready plugin only; asked, put off and rated ones
      // aren't asked about again.
      const st = getState(t);
      st.askRound.at = Date.now() - 31 * DAYS;
      putState(t, st);
      assert.deepEqual(A.ratings.asking(), [], "an old round's cards go");
      await A.review(false);
      assert.deepEqual(
        A.ratings.asking().map((i) => i.entry.slug),
        ["d"],
      );
      assert.equal(button.attrs.attention, "rate");
      assert.equal(button.attrs.tooltiptext, "Zotero Atlas: how is D working? Rate it");

      // Turned off since: its card goes.
      t.addons.find((x) => x.id === "d@x").isActive = false;
      await A.review(false);
      assert.deepEqual(A.ratings.asking(), []);
      assert.equal(button.attrs.attention, undefined);
    },
  );

  await run("asking for ratings: the red dot wins, and looking clears both", async () => {
    const plugins = [
      entry({ id: "bad@x", slug: "bad", name: "Bad", blocked: "it uploads your library" }),
      entry({ id: "good@x", slug: "good", name: "Good" }),
    ];
    const t = load({
      http: (_m, url) => (url === CATALOG_URL ? ok200(catalogJson(plugins)) : ok200(advJson([]))),
      addons: [addon("bad@x", "Bad", { version: "1.2.0" }), addon("good@x", "Good")],
    });
    t.prefs["extensions.zotero-atlas.usage"] = "no";
    t.prefs["extensions.zotero-atlas.updates"] = "hold";
    t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
    t.s.onMainWindowLoad({ window: t.window });
    t.flush();
    await settle(20);
    const A = t.s.Zotero.ZoteroAtlas;
    age(t, { "good@x": 20 });
    await A.review(false);
    const button = t.toolbar.children[0];
    assert.deepEqual(
      A.ratings.asking().map((i) => i.entry.slug),
      ["good"],
    );
    assert.equal(button.attrs.attention, "true", "red wins");
    assert.equal(button.attrs.tooltiptext, "Zotero Atlas: 1 thing to look at");
    A.ack();
    assert.equal(button.attrs.attention, undefined, "both seen");
    assert.ok(getState(t).askRound.seenAt);
  });

  await run(
    "asking for ratings: a plugin installed after Atlas counts from then; an upgrade from before since starts the clock",
    async () => {
      const plugins = [entry({}), entry({ id: "y@x", slug: "y", name: "Y" })];
      const t = load({
        http: (_m, url) => (url === CATALOG_URL ? ok200(catalogJson(plugins)) : ok200(advJson([]))),
        addons: [],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      // State from an Atlas that didn't keep since: X was already known.
      putState(t, {
        seen: { "x@example.org": { grade: "A", version: "1.2.0", installed: "1.2.0" } },
      });
      t.addons = [addon("x@example.org", "X", { version: "1.2.0" })];
      t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
      const A = t.s.Zotero.ZoteroAtlas;
      await A.review(true);
      let seen = getState(t).seen["x@example.org"];
      assert.ok(Date.now() - seen.since < 60000, "the clock starts now");
      assert.equal(seen.early, true);
      t.addons.push(addon("y@x", "Y"));
      await A.review(false);
      seen = getState(t).seen;
      assert.equal(seen["y@x"].early, undefined, "installed with Atlas there: exact");
      const since = seen["x@example.org"].since;
      await A.review(false);
      assert.equal(getState(t).seen["x@example.org"].since, since, "kept across reviews");
    },
  );

  await run(
    "advisories: fetched every 6 hours, matched by version, critical ones interrupt",
    async () => {
      const e = entry({ id: "q@x", name: "QuickCite" });
      let advFetches = 0;
      const t = load({
        http: (_m, url) => {
          if (url === CATALOG_URL) return ok200(catalogJson([e]));
          assert.equal(url, ADV_URL);
          advFetches++;
          return ok200(
            advJson([
              {
                id: "ZPA-2026-001",
                addon: "q@x",
                slug: "x",
                name: "QuickCite",
                affects: { min: "1.0", max: "1.2.0" },
                severity: "critical",
                title: "uploads your library",
                text: "Turn it off and update to 1.2.1.",
                fixedIn: "1.2.1",
                url: "https://zoteroplugins.org/p/x",
                publishedAt: "2026-11-09T00:00:00Z",
              },
            ]),
          );
        },
        addons: [
          { id: "q@x", type: "extension", name: "QuickCite", version: "1.2.0", isActive: true },
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
      const rv = await t.s.Zotero.ZoteroAtlas.review(true);
      const al = rv.items[0].alerts[0];
      assert.equal(al.level, "critical");
      assert.equal(
        al.text,
        "QuickCite 1.2.0 uploads your library. Turn it off and update to 1.2.1.",
      );
      assert.equal(al.url, "https://zoteroplugins.org/p/x");
      assert.ok(t.files["/data/zotero-atlas/advisories.json"], "kept on disk");
      await t.s.Zotero.ZoteroAtlas.review(false);
      assert.equal(advFetches, 1, "within 6 hours the saved copy is used");
      t.addons[0].version = "1.2.1";
      const fixed = await t.s.Zotero.ZoteroAtlas.review(false);
      assert.ok(!fixed.items[0].alerts.some((a) => a.flag === "advisory"), "1.2.1 isn't affected");
    },
  );

  await run(
    "the installed file: checked, a different copy, or a version we haven't checked",
    async () => {
      const e = entry({
        version: "1.2.0",
        file: build({ sha256: sha("b") }),
        previous: [{ version: "1.1.0", grade: "A", file: build({ sha256: sha("a") }) }],
      });
      const t = load({
        http: (_m, url) => (url === CATALOG_URL ? ok200(catalogJson([e])) : ok200(advJson([]))),
        addons: [
          { id: "x@example.org", type: "extension", name: "X", version: "1.2.0", isActive: true },
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
      t.s.addonFile = () => ({ path: "/p/x.xpi", fileSize: 10, lastModifiedTime: 1 });
      let hashed = 0;
      let fileHash = sha("b");
      t.s.fileSha256 = () => {
        hashed++;
        return fileHash;
      };
      const lines = async () =>
        (await t.s.Zotero.ZoteroAtlas.review(false)).items[0].alerts.map((a) => a.flag);
      assert.deepEqual(await lines(), [], "the file we checked: nothing to say");
      await lines();
      assert.equal(hashed, 1, "hashed once while the file is unchanged");
      t.s.addonFile = () => ({ path: "/p/x.xpi", fileSize: 11, lastModifiedTime: 2 });
      fileHash = sha("e");
      assert.deepEqual(await lines(), ["different-file"]);
      t.addons[0].version = "1.3.0-beta.1";
      t.s.addonFile = () => ({ path: "/p/x.xpi", fileSize: 12, lastModifiedTime: 3 });
      const rv = await t.s.Zotero.ZoteroAtlas.review(false);
      const u = rv.items[0].alerts.find((a) => a.flag === "unchecked-version");
      assert.equal(
        u.text,
        "We haven't checked 1.3.0-beta.1. The newest version we've checked is 1.2.0.",
      );
      assert.equal(u.level, "info");
    },
  );

  await run(
    "going back: after an update, back to the file we checked, then held until you choose",
    async () => {
      const e = entry({
        version: "1.2.0",
        grade: "B",
        file: build({ sha256: sha("b") }),
        previous: [
          {
            version: "1.1.0",
            grade: "A",
            file: build({
              sha256: sha("a"),
              url: "https://github.com/d/x/releases/download/v1.1.0/x.xpi",
            }),
          },
        ],
      });
      const t = load({
        http: (_m, url) => (url === CATALOG_URL ? ok200(catalogJson([e])) : ok200(advJson([]))),
        addons: [
          { id: "x@example.org", type: "extension", name: "X", version: "1.1.0", isActive: true },
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.prefs["extensions.zotero-atlas.updates"] = "off";
      t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
      const A = t.s.Zotero.ZoteroAtlas;
      await A.review(true);
      t.addons[0].version = "1.2.0"; // Zotero updated it
      let rv = await A.review(false);
      const item = rv.items[0];
      const up = item.alerts.find((a) => a.flag === "updated");
      assert.match(up.text, /^Updated from 1\.1\.0 on .*\. Its grade went from A to B\.$/);
      assert.equal(item.back.version, "1.1.0");
      const r = await A.decide.back(item, t.window);
      assert.ok(r.ok, r.message);
      const inst = t.installs.at(-1);
      assert.equal(inst.url, "https://github.com/d/x/releases/download/v1.1.0/x.xpi");
      assert.equal(inst.opts.hash, `sha256:${sha("a")}`);
      assert.equal(
        JSON.parse(t.prefs["extensions.zotero-atlas.state"]).pinned["x@example.org"],
        "1.1.0",
      );
      t.addons[0].version = "1.1.0";
      rv = await A.review(false);
      assert.deepEqual(
        rv.items[0].alerts.map((a) => a.flag),
        ["pinned"],
      );
      // Zotero offers 1.2.0 again: it waits, even with holding off.
      t.s.fileSha256 = () => sha("b");
      const again = {
        version: "1.2.0",
        file: {},
        existingAddon: { id: "x@example.org", version: "1.1.0", name: "X" },
        state: 0,
        install() {},
      };
      assert.equal(t.AM.installListeners[0].onDownloadEnded(again), false);
      await A.decide.unpin("x@example.org");
      assert.ok(
        t.log.some((l) => l.startsWith("install:x@example.org")),
        "Update: it goes ahead",
      );
      assert.ok(!JSON.parse(t.prefs["extensions.zotero-atlas.state"]).pinned["x@example.org"]);
    },
  );

  await run(
    "a newer version Zotero hasn't installed for 3 days needs you; before that it's quiet",
    async () => {
      const e = entry({ version: "1.2.0" });
      const t = load({
        http: (_m, url) => (url === CATALOG_URL ? ok200(catalogJson([e])) : ok200(advJson([]))),
        addons: [
          { id: "x@example.org", type: "extension", name: "X", version: "1.1.0", isActive: true },
        ],
      });
      t.prefs["extensions.zotero-atlas.usage"] = "no";
      t.s.startup({ id: "a", version: "1.0.0", rootURI: "r/" });
      const A = t.s.Zotero.ZoteroAtlas;
      assert.deepEqual((await A.review(true)).items[0].alerts, []);
      const st = JSON.parse(t.prefs["extensions.zotero-atlas.state"]);
      st.behind["x@example.org"].since = Date.now() - 4 * 24 * 3600 * 1000;
      t.prefs["extensions.zotero-atlas.state"] = JSON.stringify(st);
      const al = (await A.review(false)).items[0].alerts[0];
      assert.equal(al.flag, "stuck");
      assert.equal(al.level, "important");
      assert.equal(al.text, "X 1.2.0 is out and Zotero hasn't installed it. You have 1.1.0.");
      assert.equal(al.install.build.name, "x.xpi");
    },
  );
  await run("parsePrefsJs: reads pref() lines of every value type", async () => {
    const t = load();
    const p = t.s.parsePrefsJs(
      [
        'pref("extensions.x.on", true);',
        "pref('extensions.x.mode', 'fast');",
        'pref("extensions.x.n", 42);',
        'pref("extensions.x.s", "a \\"q\\" b");',
        '// pref("extensions.x.commented", 1);',
        "not a pref",
      ].join("\n"),
    );
    assert.equal(p["extensions.x.on"], true);
    assert.equal(p["extensions.x.mode"], "fast");
    assert.equal(p["extensions.x.n"], 42);
    assert.equal(p["extensions.x.s"], 'a "q" b');
    assert.equal("extensions.x.commented" in p, false);
  });

  await run(
    "prefsToExport: declared and same-branch prefs; never Zotero's; secrets only when asked",
    async () => {
      const t = load();
      const declared = {
        "extensions.x.on": true,
        "extensions.zotero.x.mode": "a",
        "extensions.zotero.lastViewed": 1,
      };
      const values = {
        "extensions.x.on": false,
        "extensions.x.extra": 3,
        "extensions.x.apiKey": "sk-1",
        "extensions.x.authToken": "t",
        "extensions.zotero.x.mode": "b",
        "extensions.zotero.lastViewed": 9,
        "extensions.zotero.export.lastTranslator": "q",
        "extensions.other.y": 1,
      };
      const { prefs, leftOut } = t.s.prefsToExport(declared, values);
      assert.deepEqual(Object.keys(prefs).sort(), [
        "extensions.x.extra",
        "extensions.x.on",
        "extensions.zotero.x.mode",
      ]);
      assert.equal(leftOut, 2);
      const all = t.s.prefsToExport(declared, values, { secrets: true });
      assert.equal(all.prefs["extensions.x.apiKey"], "sk-1");
      assert.equal(all.leftOut, 0);
      assert.equal(t.s.isSecretPref("extensions.x.password"), true);
      assert.equal(
        t.s.isSecretPref("extensions.keyboard.layout"),
        false,
        "only the last part counts",
      );
    },
  );

  await run("exportDoc / readExport: round trip, checked by hash, settings optional", async () => {
    const t = load();
    const e = entry({ file: build({ sha256: "b".repeat(64) }) });
    const doc = t.s.exportDoc({
      atlas: "1.2.0",
      zotero: "10.0.7",
      now: Date.UTC(2026, 10, 13),
      plugins: [
        { id: "x@example.org", name: "X", version: "1.2.0", sha256: "b".repeat(64) },
        { id: "y@example.org", name: "Y", version: "0.1", sha256: "c".repeat(64) },
      ],
      byId: { "x@example.org": e },
    });
    assert.equal(doc.exportedAt, "2026-11-13T00:00:00.000Z");
    assert.equal(doc.plugins[0].checked, true);
    assert.equal(doc.plugins[1].checked, false);
    assert.equal("settings" in doc, false);
    assert.equal(t.s.exportName(Date.UTC(2026, 10, 13)), "zotero-plugins-2026-11-13.json");
    const back = t.s.readExport(
      JSON.stringify({
        ...doc,
        settings: {
          "x@example.org": {
            "extensions.x.on": true,
            "extensions.zotero.lastViewed": 1,
            "extensions.x.obj": {},
          },
        },
      }),
    );
    assert.equal(back.plugins.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(back.settings)), {
      "x@example.org": { "extensions.x.on": true },
    });
    assert.equal(t.s.readExport("not json"), null);
    assert.equal(t.s.readExport('{"plugins":3}'), null);
  });

  await run(
    "planImport: exact, newer, installed, incompatible, unchecked; settings only for what installed",
    async () => {
      const t = load();
      const e = entry({
        version: "1.2.0",
        file: build({ sha256: "b".repeat(64) }),
        previous: [{ version: "1.1.0", grade: "A", file: build({ sha256: "c".repeat(64) }) }],
      });
      const old = entry({
        id: "old@example.org",
        file: build({ min: "6.0", max: "6.*", supports: [6] }),
        supports: [6],
      });
      const byId = {
        "x@example.org": e,
        "old@example.org": old,
        "bad@example.org": entry({ id: "bad@example.org", blocked: "crashes" }),
      };
      const plan = t.s.planImport(
        [
          { id: "x@example.org", name: "X", version: "1.1.0" },
          { id: "x@example.org", name: "X", version: "0.9.0" },
          { id: "here@example.org", name: "H", version: "1" },
          { id: "old@example.org", name: "O", version: "1.2.0" },
          { id: "bad@example.org", name: "B", version: "1.2.0" },
          { id: "none@example.org", name: "N", version: "1" },
        ],
        { byId, installedIds: ["here@example.org"], zv: "10.0.7" },
      );
      assert.deepEqual(
        plan.map((p) => p.action),
        ["install", "newer", "installed", "incompatible", "unchecked", "unchecked"],
      );
      assert.equal(plan[0].version, "1.1.0");
      assert.equal(plan[1].version, "1.2.0");
      assert.equal(t.s.planText(plan[0]), "Installs 1.1.0, checked");
      assert.equal(t.s.planText(plan[1]), "Installs 1.2.0, the newest checked one");
      assert.equal(t.s.planText(plan[3]), "Doesn't work with this Zotero");
      assert.equal(t.s.planText(plan[5]), "Can't install: no checked file");
      const s = t.s.settingsToApply(
        plan,
        { "x@example.org": { a: 1 }, "here@example.org": { b: 2 } },
        ["x@example.org"],
      );
      assert.deepEqual(JSON.parse(JSON.stringify(s)), { "x@example.org": { a: 1 } });
    },
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
