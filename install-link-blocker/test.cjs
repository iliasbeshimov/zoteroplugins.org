// Offline check of the plugin's lifecycle, with Zotero and Services mocked: node test.cjs
const vm = require("node:vm"),
  fs = require("node:fs"),
  assert = require("node:assert");
const code = fs.readFileSync(`${__dirname}/src/bootstrap.js`, "utf8");
function load(table, prefs, observers, log) {
  const ctx = {
    ADDON_INSTALL: 5,
    ADDON_UNINSTALL: 6,
    Date,
    Services: {
      io: { getProtocolHandler: () => ({ wrappedJSObject: { _extensions: table } }) },
      prefs: {
        getStringPref: (k, d) => (k in prefs ? prefs[k] : d),
        setStringPref: (k, v) => {
          prefs[k] = v;
          for (const o of observers) o();
        },
        clearUserPref: (k) => {
          delete prefs[k];
        },
        addObserver: (_k, f) => {
          if (!observers.includes(f)) observers.push(f);
        },
        removeObserver: (_k, f) => {
          const i = observers.indexOf(f);
          if (i >= 0) observers.splice(i, 1);
        },
      },
    },
    Zotero: {
      PreferencePanes: { register: () => log.push("pane") },
      debug: (m) => log.push(m),
      ProgressWindow: class {
        changeHeadline() {}
        addDescription(t) {
          log.push(`notice: ${t}`);
        }
        show() {}
        startCloseTimer() {}
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}
const K = "zotero://plugin",
  P = "extensions.install-link-blocker.state";
const toolkit = { noContent: true, doAction: () => "toolkit ran" };
const look = (t) => (t[K] ? (t[K] === toolkit ? "toolkit" : "stand-in") : "none");
const run = (name, steps) => {
  const table = {},
    prefs = {},
    observers = [],
    log = [];
  const s = load(table, prefs, observers, log);
  steps({ s, table, prefs, observers, log });
  console.log("ok:", name);
};

run("blocker first, toolkit later, off, on, uninstall", ({ s, table, prefs }) => {
  s.install({}, 5);
  s.startup({ id: "x" });
  assert.equal(look(table), "stand-in");
  table[K] = toolkit; // toolkit registers after us
  assert.equal(look(table), "stand-in");
  s.Services.prefs.setStringPref(P, "off");
  assert.equal(look(table), "toolkit");
  s.Services.prefs.setStringPref(P, "on");
  assert.equal(look(table), "stand-in");
  s.shutdown();
  s.uninstall({}, 6);
  assert.equal(look(table), "toolkit");
  assert.ok(!(P in prefs));
});
run("toolkit first", ({ s, table }) => {
  table[K] = toolkit;
  s.startup({ id: "x" });
  assert.equal(look(table), "stand-in");
  s.shutdown();
  assert.equal(look(table), "toolkit");
});
run("no toolkit: off and shutdown leave nothing, no notice", ({ s, table, log }) => {
  s.startup({ id: "x" });
  table[K].doAction();
  assert.ok(!log.some((l) => l.startsWith("notice")));
  s.Services.prefs.setStringPref("extensions.install-link-blocker.state", "off");
  assert.ok(!(K in table));
  s.shutdown();
  assert.ok(!(K in table));
});
run(
  "startup twice (Zotero's update path), then off and uninstall",
  ({ s, table, observers, log }) => {
    table[K] = toolkit;
    s.startup({ id: "x" });
    s.startup({ id: "x" });
    assert.equal(log.filter((l) => l === "pane").length, 1);
    s.Services.prefs.setStringPref("extensions.install-link-blocker.state", "off");
    assert.equal(look(table), "toolkit");
    s.Services.prefs.setStringPref("extensions.install-link-blocker.state", "on");
    s.shutdown();
    s.uninstall({}, 6);
    assert.equal(look(table), "toolkit");
    assert.equal(observers.length, 0);
  },
);
run("notices: one per burst, and a fresh install starts On", ({ s, table, prefs, log }) => {
  prefs[P] = "off";
  s.install({}, 5);
  assert.ok(!(P in prefs));
  table[K] = toolkit;
  s.startup({ id: "x" });
  table[K].doAction();
  table[K].newChannel();
  table[K].doAction();
  assert.equal(log.filter((l) => l.startsWith("notice")).length, 1);
  assert.ok(!log.some((l) => /\?|url=/.test(l)));
});
run("upgrade keeps Off", ({ s, prefs }) => {
  prefs[P] = "off";
  s.install({}, 7);
  assert.equal(prefs[P], "off");
});
