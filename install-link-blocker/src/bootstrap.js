/* global Zotero, Services, ADDON_INSTALL, ADDON_UNINSTALL */
/*
 * Install Link Blocker
 *
 * zotero-plugin-toolkit, a library many Zotero plugins are built with, usually adds two zotero://
 * links to Zotero: zotero://plugin installs a plugin from an address in the link without Zotero
 * asking first, and zotero://ztoolkit-debug runs code from the link (current versions ask
 * first). Web pages and documents can open zotero:// links.
 *
 * On (the default): those two links are blocked. Off: this plugin steps aside, and the links work
 * exactly as if it weren't installed. Disabling or removing it is the same as Off.
 *
 * Its code makes no network requests. It stores one setting, extensions.install-link-blocker.state.
 */

const PREF = "extensions.install-link-blocker.state"; // "on" or "off"
const NOTICES = {
  "zotero://plugin":
    "Blocked a link asking Zotero to install a plugin. Nothing was installed. To add a plugin " +
    "you trust, download its file and install it from Tools → Plugins.",
  "zotero://ztoolkit-debug": "Blocked a link asking Zotero to run code. Nothing was run.",
};

// Zotero's table of zotero:// link handlers; what other plugins set up for each link, handed
// back unchanged when this is off or removed; our stand-in for each link; when each notice last
// showed.
let table;
let started = false;
const theirs = {};
const ours = {};
const shown = {};
for (const link in NOTICES) ours[link] = standIn(link);

// A new install always starts On.
function install(_data, reason) {
  if (reason === ADDON_INSTALL) Services.prefs.clearUserPref(PREF);
}

function startup({ id }) {
  if (started) return;
  started = true;
  table = Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions;
  Services.prefs.addObserver(PREF, apply);
  apply();
  Zotero.PreferencePanes.register({ pluginID: id, src: "settings.xhtml" });
}

function shutdown() {
  if (!started) return;
  started = false;
  Services.prefs.removeObserver(PREF, apply);
  for (const link in NOTICES) stepAside(link);
}

function uninstall(_data, reason) {
  if (reason === ADDON_UNINSTALL) Services.prefs.clearUserPref(PREF);
}

// Zotero calls these on every plugin; this one has nothing to do in windows.
function onMainWindowLoad() {}
function onMainWindowUnload() {}

function apply() {
  const on = Services.prefs.getStringPref(PREF, "on") !== "off";
  for (const link in NOTICES) {
    if (on) block(link);
    else stepAside(link);
  }
}

// Put our stand-in in the link's place, keeping what was there. Plugins start in any order, so a
// plugin that sets the link up after this only changes what we'd hand back.
function block(link) {
  const now = Object.getOwnPropertyDescriptor(table, link);
  if (now?.get === ours[link].get) return;
  theirs[link] = now;
  Object.defineProperty(table, link, ours[link]);
}

function stepAside(link) {
  const now = Object.getOwnPropertyDescriptor(table, link);
  if (now?.get !== ours[link].get) return;
  delete table[link];
  if (theirs[link]) Object.defineProperty(table, link, theirs[link]);
}

function standIn(link) {
  const handler = {
    noContent: true,
    doAction: () => notice(link),
    // Returns nothing, so Zotero cancels the request.
    newChannel: () => notice(link),
  };
  return {
    configurable: true,
    enumerable: true,
    get: () => handler,
    set: (value) => {
      theirs[link] = { value, writable: true, enumerable: true, configurable: true };
    },
  };
}

// A notice only when a link was actually stopped (without this plugin, a link no plugin set up
// does nothing), and at most one every few seconds.
function notice(link) {
  Zotero.debug(`Install Link Blocker blocked a ${link} link`);
  if (!theirs[link] || Date.now() - (shown[link] ?? 0) < 5000) return;
  shown[link] = Date.now();
  const win = new Zotero.ProgressWindow({ closeOnClick: true });
  win.changeHeadline("Install Link Blocker");
  win.addDescription(NOTICES[link]);
  win.show();
  win.startCloseTimer(8000);
}
