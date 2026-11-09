/* global Zotero, Services, Components, ChromeUtils, ADDON_INSTALL, ADDON_UNINSTALL, setTimeout, clearTimeout */
/*
 * Zotero Atlas
 *
 * Finds and installs plugins from zoteroplugins.org inside Zotero, filtered to this Zotero's
 * version, with each plugin's grade, and looks after the plugins already installed:
 * - it can hold an update until the directory has checked it (the first-run screen's
 *   recommended answer, or later in Zotero's settings). An update whose file we analysed and
 *   whose grade isn't lower than the version you have installs as usual; anything else waits in
 *   "Your plugins" for you to decide. Plugins the directory doesn't list are never held: we
 *   can't check them. Holding uses Zotero's own install listeners and changes no Zotero setting,
 *   so removing Atlas leaves Zotero's updates exactly as they were.
 * - it tells you when a plugin is blocked by Zotero's blocklist or named in our list of known
 *   security problems (a bar above your library until you deal with it), when one drops a grade,
 *   when an update is held, when Zotero turned one off and a version that works is listed, or when
 *   a newer version is out and Zotero hasn't installed it (one notice, and a red dot on the
 *   Atlas button by the sync button until you look).
 * - it shows each plugin's grade in Tools → Plugins, marks the plugins it can't check, and after
 *   an update lets you go back to the version you had (the file we analysed).
 *
 * What it contacts:
 * - raw.githubusercontent.com, the directory's public repository: the catalogue (catalog.json)
 *   once a day, and the list of known security problems (advisories.json) every 6 hours.
 *   github.com for a plugin file when you click Install or go back to an earlier version.
 *   Zotero's own installer downloads the file and refuses it unless it matches the SHA-256 we
 *   analysed.
 * - zoteroatlas.com, only while "Send my plugin list" is chosen (the first-run screen's default
 *   answer, or later in Zotero's settings): the installed plugins' IDs, versions and whether
 *   each is enabled, under a random ID made on this computer, with the Zotero version, the
 *   operating system and this plugin's version. Sent at first run, when that list changes, and
 *   once a week. Choosing "Don't send" sends one request to delete the record. Nothing from your
 *   library, no account, nothing that identifies you.
 * - zoteroatlas.com, when you post a rating: the plugin and version you rate, your stars and
 *   review, the Zotero version, the operating system and this plugin's version, a scrambled ID
 *   for this Zotero (so rating again replaces your rating) and, while "Send my plugin list" is
 *   chosen, the random ID above (so the rating can say how long you had the plugin).
 *
 * What it stores: four settings (extensions.zotero-atlas.usage, .updates, .id, .state) and the
 * catalogue and advisories in <Zotero data directory>/zotero-atlas/. Uninstalling removes all
 * of it.
 */

const ID = "atlas@zoteroatlas.com";
const RAW = "https://raw.githubusercontent.com/iliasbeshimov/zoteroplugins.org/main/data";
const CATALOG_URL = `${RAW}/generated/catalog.json`;
const ADVISORIES_URL = `${RAW}/advisories.json`;
const USAGE_URL = "https://zoteroatlas.com/api/v1/plugins";
const RATINGS_URL = "https://zoteroatlas.com/api/v1/ratings";
const SITE = "https://zoteroplugins.org";
const HOME = "https://zoteroatlas.com";

/**
 * Opens a page in the browser. Pages on zoteroplugins.org get ?ref=atlas, which only tells the site
 * not to show its note about this plugin; the site takes it out of the address straight away.
 */
function openPage(url) {
  if (url.startsWith(`${SITE}/`)) {
    const cut = url.indexOf("#");
    const path = cut < 0 ? url : url.slice(0, cut);
    const hash = cut < 0 ? "" : url.slice(cut);
    url = `${path}${path.includes("?") ? "&" : "?"}ref=atlas${hash}`;
  }
  Zotero.launchURL(url);
}
const PREF = {
  usage: "extensions.zotero-atlas.usage", // "" (not asked yet), "yes" or "no"
  updates: "extensions.zotero-atlas.updates", // "" (not asked yet), "hold" or "off"
  id: "extensions.zotero-atlas.id", // the random ID, only while usage is "yes"
  state: "extensions.zotero-atlas.state", // JSON, see state()
};
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const START_DELAY = 20 * 1000; // after startup, before the first check: let Zotero settle
const ASK_DELAY = 8 * 1000; // after the main window opens, before the first-run screen
const ADVISORIES_EVERY = 6 * HOUR;
const STUCK_AFTER = 3 * DAY; // behind the listed version this long, with nothing held: tell
const RECENT = 30 * DAY; // updates shown under "Updates", with a way back
const WAIT_AT_MOST = WEEK; // an update we haven't checked by then is yours to decide
const RANK = { "A+": 4, A: 3, B: 2, C: 1, "–": 0 };
const RATER_SALT = "zotero-atlas ratings v1";
const RATER_ROUNDS = 600000;
const REMOVED_FOR = 30 * DAY; // a removed plugin can still be rated for this long
const MAX_REVIEW = 1000;
const XHTML = "http://www.w3.org/1999/xhtml";
const CONTENT = "chrome://zotero-atlas/content";

let rootURI = "";
let version = "";
let chromeHandle = null;
let started = false;
let timer = null;
let advTimer = null;
let askTimer = null;
let refreshTimer = null;
let asked = false;
let atlasWindow = null;
let catalog = null; // { data, fetchedAt }
let advisories = null; // { data, fetchedAt }
let last = null; // the latest review(), for the windows and the Plugins window
const windows = new Map(); // main window → { menu, button, banner, style }
const pages = new Set(); // open Plugins window documents we've added to
const listeners = new Set(); // the Atlas window's refresh, while it's open
const paused = new Map(); // add-on ID → an update download held this session
const allowOnce = new Set(); // "id@version": installs Atlas started or you allowed

// ---------------------------------------------------------------------------------------------
// Lifecycle

// A new install starts with nothing: not asked yet, no ID, nothing seen.
function install(_data, reason) {
  if (reason === ADDON_INSTALL) clearPrefs();
}

function startup({ id, version: v, rootURI: root }) {
  if (started) return;
  started = true;
  rootURI = root;
  version = v;
  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"].getService(
    Components.interfaces.amIAddonManagerStartup,
  );
  chromeHandle = aomStartup.registerChrome(Services.io.newURI(`${rootURI}manifest.json`), [
    ["content", "zotero-atlas", "content/"],
  ]);
  Zotero.ZoteroAtlas = Atlas;
  Services.prefs.addObserver(PREF.usage, onUsagePref);
  Services.prefs.addObserver(PREF.updates, onUpdatesPref);
  Zotero.PreferencePanes.register({
    pluginID: id,
    src: `${rootURI}settings.xhtml`,
    scripts: [`${rootURI}settings.js`],
  });
  const AM = addonManager();
  AM.addInstallListener(installListener);
  AM.addAddonListener(addonListener);
  // What was fetched last time, so an update that arrives before today's check can be judged.
  readSaved("catalog.json").then((c) => {
    if (c && !catalog) catalog = c;
  });
  readSaved("advisories.json").then((a) => {
    if (a && !advisories) advisories = a;
  });
  for (const win of Zotero.getMainWindows()) addToWindow(win);
  watchPluginsWindows(true);
  // At Zotero's start the main window opens after plugins; installed while Zotero is open, it
  // won't load again. Either way, wait for it here rather than for onMainWindowLoad alone.
  Zotero.uiReadyPromise.then(() => {
    if (!started) return;
    const win = Zotero.getMainWindows()[0];
    if (!win) return;
    addToWindow(win);
    maybeAsk(win);
  });
  timer = setTimeout(check, START_DELAY);
}

function shutdown() {
  if (!started) return;
  started = false;
  for (const t of [timer, advTimer, askTimer, refreshTimer]) clearTimeout(t);
  timer = advTimer = askTimer = refreshTimer = null;
  Services.prefs.removeObserver(PREF.usage, onUsagePref);
  Services.prefs.removeObserver(PREF.updates, onUpdatesPref);
  try {
    const AM = addonManager();
    AM.removeInstallListener(installListener);
    AM.removeAddonListener(addonListener);
  } catch (_e) {
    // Zotero is closing.
  }
  watchPluginsWindows(false);
  for (const doc of [...pages]) undecorate(doc);
  for (const win of [...windows.keys()]) removeFromWindow(win);
  if (atlasWindow && !atlasWindow.closed) atlasWindow.close();
  atlasWindow = null;
  listeners.clear();
  paused.clear();
  allowOnce.clear();
  if (chromeHandle) chromeHandle.destruct();
  chromeHandle = null;
  delete Zotero.ZoteroAtlas;
}

function uninstall(_data, reason) {
  if (reason !== ADDON_UNINSTALL) return;
  clearPrefs();
  try {
    dataFile().remove(true);
  } catch (_e) {
    // Nothing stored yet.
  }
}

function onMainWindowLoad({ window }) {
  addToWindow(window);
  maybeAsk(window);
}

function onMainWindowUnload({ window }) {
  removeFromWindow(window);
}

// The first-run screen, once per session, a moment after the window is there. Someone who
// answered the usage question before 1.0 isn't asked again: "Your plugins" offers holding.
function maybeAsk(window) {
  if (asked || pref(PREF.usage)) return;
  asked = true;
  askTimer = setTimeout(() => ask(window), ASK_DELAY);
}

// ---------------------------------------------------------------------------------------------
// Settings and state

function pref(key) {
  return Services.prefs.getStringPref(key, "");
}

function setPref(key, value) {
  Services.prefs.setStringPref(key, value);
}

function clearPrefs() {
  for (const key of Object.values(PREF)) Services.prefs.clearUserPref(key);
}

/**
 * catalogEtag, advisoriesEtag: the files' freshness. sentAt, sentHash: the last usage report.
 * seen: { addonId: { grade, version, slug, name, installed } } as last reviewed, so a grade drop
 *   and an update can be told.
 * noticed: { key: time } notices already shown, so each shows once.
 * acked: { key: time } what needed you when you last opened "Your plugins": the red dot is for
 *   anything since. dismissed: { key: time } bars you closed.
 * removed: { addonId: { slug, name, version, at } } plugins removed in the last 30 days, so
 *   they can still be rated.
 * rated: { "slug|version": { stars, at } } ratings posted from this Zotero.
 * held: { addonId: { version, from, reason, at, name } } updates waiting: "unchecked" until the
 *   directory has analysed the file, "worse", "blocked" or "advisory" until you decide, "kept"
 *   once you chose to keep your version, "pinned" after you went back.
 * pinned: { addonId: version } the version you went back to; its updates wait for you.
 * history: { addonId: [{ from, to, at }] } recent version changes, newest first.
 * behind: { addonId: { version, since } } a newer listed version Zotero hasn't installed.
 * hashes: { addonId: { path, size, modified, sha256 } } installed files already hashed.
 */
function state() {
  try {
    const s = JSON.parse(pref(PREF.state) || "{}");
    return s && typeof s === "object" ? s : {};
  } catch (_e) {
    return {};
  }
}

function saveState(patch) {
  const next = { ...state(), ...patch };
  setPref(PREF.state, JSON.stringify(next));
  return next;
}

function dataFile(name) {
  const f = Zotero.File.pathToFile(Zotero.DataDirectory.dir);
  f.append("zotero-atlas");
  if (name) f.append(name);
  return f;
}

const holding = () => pref(PREF.updates) === "hold";

// ---------------------------------------------------------------------------------------------
// The catalogue (once a day) and the advisories (every 6 hours), both from the directory's repository

async function readSaved(name) {
  try {
    const f = dataFile(name);
    if (!f.exists()) return null;
    const saved = JSON.parse(await Zotero.File.getContentsAsync(f));
    return saved?.data?.schemaVersion === 1 ? saved : null;
  } catch (_e) {
    return null;
  }
}

async function writeSaved(name, saved) {
  try {
    await Zotero.File.createDirectoryIfMissingAsync(dataFile().path);
    await Zotero.File.putContentsAsync(dataFile(name), JSON.stringify(saved));
  } catch (e) {
    Zotero.debug(`Zotero Atlas: couldn't save ${name}: ${e}`);
  }
}

/** A JSON file kept for `maxAge`, fetched again with its ETag: the cached copy or a fresh one. */
async function fetchKept({ name, url, maxAge, etagKey, cached, valid }, force) {
  let kept = cached || (await readSaved(name));
  if (!force && kept && Date.now() - kept.fetchedAt < maxAge) return kept;
  const headers = { Accept: "application/json" };
  const etag = state()[etagKey];
  if (kept && etag) headers["If-None-Match"] = etag;
  let xhr;
  try {
    xhr = await Zotero.HTTP.request("GET", url, {
      headers,
      successCodes: [200, 304],
      timeout: 30000,
    });
  } catch (e) {
    Zotero.debug(`Zotero Atlas: couldn't fetch ${name}: ${e}`);
    if (kept) return kept;
    throw e;
  }
  if (xhr.status === 304 && kept) {
    kept = { ...kept, fetchedAt: Date.now() };
  } else {
    const data = JSON.parse(xhr.responseText);
    if (data?.schemaVersion !== 1 || !valid(data)) throw new Error(`${name} isn't readable`);
    kept = { data, fetchedAt: Date.now() };
    saveState({ [etagKey]: xhr.getResponseHeader("ETag") || "" });
  }
  await writeSaved(name, kept);
  return kept;
}

async function fetchCatalog(force) {
  try {
    catalog = await fetchKept(
      {
        name: "catalog.json",
        url: CATALOG_URL,
        maxAge: DAY,
        etagKey: "catalogEtag",
        cached: catalog,
        valid: (d) => Array.isArray(d.plugins),
      },
      force,
    );
  } catch (e) {
    if (String(e.message).includes("readable"))
      throw new Error("The catalogue isn't in the form this version understands.");
    throw new Error("The catalogue couldn't be fetched. Check your connection and try again.");
  }
  return catalog.data;
}

/** The known security problems; an empty list when they can't be fetched. */
async function fetchAdvisories(force) {
  try {
    advisories = await fetchKept(
      {
        name: "advisories.json",
        url: ADVISORIES_URL,
        maxAge: ADVISORIES_EVERY,
        etagKey: "advisoriesEtag",
        cached: advisories,
        valid: (d) => Array.isArray(d.advisories),
      },
      force,
    );
  } catch (_e) {
    // Keep what we had; nothing new is known.
  }
  return advisories?.data?.advisories ?? [];
}

// ---------------------------------------------------------------------------------------------
// Installed plugins and what the catalogue says about them

function addonManager() {
  try {
    return ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;
  } catch (_e) {
    return ChromeUtils.import("resource://gre/modules/AddonManager.jsm").AddonManager;
  }
}

async function installed() {
  const all = await addonManager().getAllAddons();
  return all
    .filter((a) => a.type === "extension" && a.id && a.id !== ID)
    .map((a) => ({
      id: a.id,
      name: a.name || a.id,
      version: a.version || "",
      enabled: Boolean(a.isActive),
      appDisabled: Boolean(a.appDisabled),
      userDisabled: Boolean(a.userDisabled),
      file: addonFile(a),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The .xpi Zotero keeps for an installed add-on, or null for one loaded from a folder. */
function addonFile(addon) {
  try {
    const uri = addon.getResourceURI ? addon.getResourceURI() : null;
    if (uri?.scheme !== "jar") return null;
    return uri
      .QueryInterface(Components.interfaces.nsIJARURI)
      .JARFile.QueryInterface(Components.interfaces.nsIFileURL).file;
  } catch (_e) {
    return null;
  }
}

/** A file's SHA-256, read in one go (plugin files are a few megabytes at most). */
function fileSha256(file) {
  const Cc = Components.classes;
  const Ci = Components.interfaces;
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(hash.SHA256);
  const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream,
  );
  stream.init(file, 0x01, 0, 0);
  try {
    hash.updateFromStream(stream, 0xffffffff);
  } finally {
    stream.close();
  }
  const bin = hash.finish(false);
  let out = "";
  for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

/** The installed file's SHA-256, remembered until the file changes. */
function installedSha256(a, hashes) {
  const f = a.file;
  if (!f) return null;
  try {
    const known = hashes[a.id];
    const size = f.fileSize;
    const modified = f.lastModifiedTime;
    if (known && known.path === f.path && known.size === size && known.modified === modified)
      return known.sha256;
    const sha256 = fileSha256(f);
    hashes[a.id] = { path: f.path, size, modified, sha256 };
    return sha256;
  } catch (e) {
    Zotero.debug(`Zotero Atlas: couldn't read ${a.id}'s file: ${e}`);
    return null;
  }
}

/** Whether Zotero at `zv` installs this build, comparing versions the way Zotero does. */
function worksWith(build, zv) {
  if (!build || build.supports.length === 0) return false;
  if (build.min && Services.vc.compare(zv, build.min) < 0) return false;
  if (build.max && Services.vc.compare(zv, build.max) > 0) return false;
  return true;
}

/** The release file to install on Zotero `zv`: the main build, or another build that works. */
function fileFor(entry, zv) {
  if (entry.file && entry.supports.length > 0 && worksWith(entry.file, zv)) return entry.file;
  return entry.builds.find((b) => worksWith(b, zv)) || null;
}

/**
 * Every file of a plugin the directory analysed: the listed release's builds, what its update
 * address offers, and up to three earlier releases. Each with its version and grade.
 */
function checkedFiles(entry) {
  const out = [];
  for (const b of [entry.file, ...(entry.builds || [])])
    if (b?.sha256)
      out.push({ version: entry.version, grade: entry.grade, sha256: b.sha256, build: b });
  if (entry.update?.sha256 && entry.update.version)
    out.push({
      version: entry.update.version,
      grade: entry.update.grade,
      sha256: entry.update.sha256,
    });
  for (const p of entry.previous || [])
    if (p.file?.sha256)
      out.push({ version: p.version, grade: p.grade, sha256: p.file.sha256, build: p.file });
  return out;
}

/** The grade the directory gave this version of the plugin, or null if it never checked it. */
function gradeOfVersion(entry, v) {
  if (!entry || !v) return null;
  if (Services.vc.compare(v, entry.version) === 0) return entry.grade;
  if (entry.update?.version && Services.vc.compare(v, entry.update.version) === 0)
    return entry.update.grade;
  const p = (entry.previous || []).find((x) => Services.vc.compare(v, x.version) === 0);
  return p ? p.grade : null;
}

/** Known security problems that cover this version of this add-on. */
function advisoriesFor(list, addonId, v) {
  return (list || []).filter(
    (x) =>
      x.addon === addonId &&
      (!x.affects?.min || Services.vc.compare(v, x.affects.min) >= 0) &&
      (!x.affects?.max || Services.vc.compare(v, x.affects.max) <= 0),
  );
}

/**
 * Whether an update to `v` (file `sha256`) of the plugin `entry`, replacing `from`, installs now
 * or waits, and why: { hold: false } or { hold: true, reason }. Plugins the directory doesn't
 * list are never held. A version you went back from waits while you're pinned to the old one.
 */
function holdDecision({ entry, id, v, from, sha256, adv, pinned }) {
  if (pinned) return { hold: true, reason: "pinned" };
  if (!entry) return { hold: false };
  if (advisoriesFor(adv, id, v).length) return { hold: true, reason: "advisory" };
  if (entry.blocked && Services.vc.compare(v, entry.version) === 0)
    return { hold: true, reason: "blocked" };
  const file = sha256 ? checkedFiles(entry).find((f) => f.sha256 === sha256) : null;
  if (!file || file.grade === "–") return { hold: true, reason: "unchecked" };
  const before = gradeOfVersion(entry, from);
  if (before && before !== "–" && RANK[file.grade] < RANK[before])
    return { hold: true, reason: "worse", grade: file.grade, before };
  return { hold: false };
}

const ago = (t) => Date.now() - (t || 0);

/**
 * What to tell you about one installed plugin, most serious first. Each alert: { key, level,
 * flag, text, actions }. critical: a bar above the library until dealt with, the red dot and
 * one notice. important: the red dot and one notice. info: only in Zotero Atlas and the
 * Plugins window.
 */
function alertsFor(item, ctx) {
  const { addon: a, entry: e } = item;
  const out = [];
  const add = (level, flag, text, extra = {}, keyPart = "") =>
    out.push({ key: `${a.id}|${flag}|${a.version}|${keyPart}`, level, flag, text, ...extra });
  // Turned off, a plugin no longer runs: what's known about it stays, without interrupting.
  for (const x of advisoriesFor(ctx.advisories, a.id, a.version))
    add(
      !a.enabled ? "info" : x.severity === "critical" ? "critical" : "important",
      "advisory",
      `${x.name} ${a.version} ${x.title}. ${a.enabled ? x.text : "It's turned off; you can remove it in Tools → Plugins."}`,
      { url: x.url, off: a.enabled },
      x.id,
    );
  const held = item.held;
  if (!e) {
    if (held?.reason === "pinned")
      add("info", "pinned", `You went back to ${a.version}. Its updates wait until you choose.`);
    return out;
  }
  const cmp = Services.vc.compare(a.version, e.version);
  if (e.blocked && cmp === 0)
    add(
      a.enabled ? "critical" : "info",
      "blocked",
      `${e.name} is blocked by Zotero: ${e.blocked}.${a.enabled ? "" : " It's turned off."}`,
      { url: e.page, off: a.enabled },
    );
  if (held) {
    const v = held.version;
    if (held.reason === "worse")
      add(
        "important",
        "held",
        `Update ${v} held: graded ${held.grade || gradeOfVersion(e, v) || "lower"}, lower than the ${held.before || gradeOfVersion(e, a.version) || e.grade} of the version you have.`,
        { held },
        v,
      );
    else if (held.reason === "blocked")
      add("important", "held", `Update ${v} held: Zotero's blocklist blocks it.`, { held }, v);
    else if (held.reason === "advisory")
      add(
        "important",
        "held",
        `Update ${v} held: it's on our list of known security problems.`,
        { held },
        v,
      );
    else if (held.reason === "kept")
      add("info", "kept", `You kept ${a.version}; update ${v} isn't installed.`, { held }, v);
    else if (held.reason === "pinned")
      add(
        "info",
        "pinned",
        `You went back to ${a.version}. Its updates wait until you choose.`,
        { held },
        v,
      );
    else if (ago(held.at) > WAIT_AT_MOST)
      // Never trapped: a week without our check, and it's your call.
      add(
        "important",
        "held",
        `Update ${v} has waited a week, and we haven't checked it. You can install it anyway or keep ${a.version}.`,
        { held },
        `${v}|week`,
      );
    else
      add(
        "info",
        "waiting",
        `Update ${v} waits for our check. It installs after that if it isn't graded lower.`,
        { held },
        v,
      );
  }
  if (
    !holding() &&
    e.update &&
    e.update.grade !== "–" &&
    e.grade !== "–" &&
    RANK[e.update.grade] < RANK[e.grade] &&
    cmp >= 0
  )
    add(
      "important",
      "worse-update",
      `The update Zotero would install (${e.update.version || "a new version"}) is graded ${e.update.grade}, lower than the ${e.grade} of the version you have.`,
      {},
      e.update.version || "",
    );
  if (item.droppedFrom)
    add(
      "important",
      "grade-drop",
      `${e.name} went from ${item.droppedFrom} to ${e.grade}: ${e.because}.`,
      {},
      e.grade,
    );
  if (a.appDisabled) {
    const fix = fileFor(e, ctx.zv);
    if (fix)
      add(
        "important",
        "disabled-fix",
        cmp === 0
          ? `Zotero turned ${e.name} off: the copy you have isn't for Zotero ${ctx.zv}. Another build of ${e.version} works, and we've checked it.`
          : `Zotero turned ${e.name} off: ${a.version} isn't for Zotero ${ctx.zv}. Version ${e.version} works, and we've checked it.`,
        { install: { entry: e, build: fix } },
        e.version,
      );
    else
      add(
        "info",
        "disabled",
        `Zotero turned ${e.name} off: no version we know works with Zotero ${ctx.zv}.`,
      );
  }
  if (
    cmp < 0 &&
    !held &&
    !a.appDisabled &&
    item.behindSince &&
    ago(item.behindSince) > STUCK_AFTER
  ) {
    const build = fileFor(e, ctx.zv);
    if (build)
      add(
        "important",
        "stuck",
        `${e.name} ${e.version} is out and Zotero hasn't installed it. You have ${a.version}.`,
        { install: { entry: e, build } },
        e.version,
      );
  }
  if (item.check === "different-file")
    add(
      "info",
      "different-file",
      `Not the file we checked: this copy of ${a.version} differs from the one we analysed.`,
    );
  else if (item.check === "unchecked-version")
    add(
      "info",
      "unchecked-version",
      `We haven't checked ${a.version}. The newest version we've checked is ${e.version}.`,
    );
  const up = item.updated;
  if (up && !held) {
    const before = gradeOfVersion(e, up.from);
    const now = gradeOfVersion(e, a.version);
    const grades =
      before && now && before !== "–" && now !== "–"
        ? before === now
          ? ` Same grade, ${now}.`
          : ` Its grade went from ${before} to ${now}.`
        : "";
    add(
      "info",
      "updated",
      `Updated from ${up.from} on ${new Date(up.at).toLocaleDateString()}.${grades}`,
      { back: item.back },
      up.to,
    );
  }
  return out;
}

/**
 * Each installed plugin against the catalogue and the advisories: its entry (or none), what's
 * worth telling (alerts), and the notices not shown before. Remembers grades, versions, the
 * installed files' hashes and when a plugin fell behind.
 */
async function review(force) {
  const data = await fetchCatalog(force);
  const adv = await fetchAdvisories(force);
  const byId = new Map();
  for (const p of data.plugins) if (p.id && !byId.has(p.id)) byId.set(p.id, p);
  const addons = await installed();
  const zv = Zotero.version;
  const st = state();
  const seen = st.seen || {};
  const noticed = st.noticed || {};
  const hashes = st.hashes || {};
  const history = st.history || {};
  const behind = st.behind || {};
  const held = st.held || {};
  const pinned = st.pinned || {};
  const items = [];
  const fresh = [];
  const ctx = { advisories: adv, zv };
  for (const a of addons) {
    const e = byId.get(a.id) || null;
    const prev = seen[a.id];
    // A version change since the last look: an update (or going back), kept for a month.
    if (prev?.installed && prev.installed !== a.version) {
      history[a.id] = [
        { from: prev.installed, to: a.version, at: Date.now() },
        ...(history[a.id] || []),
      ].slice(0, 3);
    }
    if (history[a.id]) history[a.id] = history[a.id].filter((h) => ago(h.at) < RECENT);
    if (history[a.id] && !history[a.id].length) delete history[a.id];
    // An update that has since installed, or one you went past, no longer waits.
    const h = held[a.id];
    if (h && h.reason !== "pinned" && Services.vc.compare(a.version, h.version) >= 0)
      delete held[a.id];
    if (pinned[a.id] && pinned[a.id] !== a.version) {
      delete pinned[a.id];
      if (held[a.id]?.reason === "pinned") delete held[a.id];
    }
    const item = { addon: a, entry: e, held: held[a.id] || null, flags: [] };
    if (pinned[a.id] && !item.held) item.held = { version: "", reason: "pinned", at: 0 };
    if (e) {
      const cmp = Services.vc.compare(a.version, e.version);
      item.same = cmp === 0;
      // Whether the installed file is one we analysed.
      const sha = installedSha256(a, hashes);
      const files = checkedFiles(e);
      const ofVersion = files.filter((f) => Services.vc.compare(f.version, a.version) === 0);
      item.check = !sha
        ? "unknown"
        : files.some((f) => f.sha256 === sha)
          ? "checked"
          : ofVersion.length
            ? "different-file"
            : cmp > 0
              ? "unchecked-version"
              : "older";
      // A drop stays on the list for a month, or until the grade is back up.
      let from = prev?.droppedFrom && ago(prev.droppedAt) < 30 * DAY ? prev : null;
      if (prev && e.grade !== "–" && prev.grade !== "–" && RANK[e.grade] < RANK[prev.grade])
        from = { droppedFrom: prev.grade, droppedAt: Date.now() };
      if (from && RANK[e.grade] >= RANK[from.droppedFrom]) from = null;
      // Only the version you have: a lower grade for a newer one is a held or worse update.
      if (from && cmp === 0) item.droppedFrom = from.droppedFrom;
      if (cmp < 0) {
        if (behind[a.id]?.version !== e.version)
          behind[a.id] = { version: e.version, since: Date.now() };
        item.behindSince = behind[a.id].since;
      } else delete behind[a.id];
      // The latest update this month, and the file to go back to: the version you had.
      const up = history[a.id]?.[0];
      if (up && Services.vc.compare(up.to, up.from) > 0) {
        item.updated = up;
        const target =
          Services.vc.compare(up.from, e.version) === 0
            ? { version: e.version, grade: e.grade, file: fileFor(e, zv) }
            : (e.previous || []).find((p) => Services.vc.compare(p.version, up.from) === 0);
        if (target?.file?.sha256 && worksWith(target.file, zv)) item.back = target;
      }
      seen[a.id] = {
        grade: e.grade,
        version: e.version,
        slug: e.slug,
        name: e.name,
        installed: a.version,
        ...(from || {}),
      };
    } else {
      item.flags.push("not-listed");
      seen[a.id] = { grade: "–", version: "", slug: "", name: a.name, installed: a.version };
    }
    item.alerts = alertsFor(item, ctx);
    for (const al of item.alerts) item.flags.push(al.flag);
    for (const al of item.alerts) {
      if (al.level === "info" || noticed[al.key]) continue;
      noticed[al.key] = Date.now();
      fresh.push({ level: al.level, flag: al.flag, text: al.text });
    }
    items.push(item);
  }
  // A plugin gone since the last look is remembered for a month, so it can still be rated: the
  // people who remove a plugin at once are the ones who most need to say why.
  const removed = st.removed || {};
  for (const id of Object.keys(seen)) {
    if (addons.some((a) => a.id === id)) continue;
    const s = seen[id];
    if (s.slug)
      removed[id] = {
        slug: s.slug,
        name: s.name,
        version: s.installed || s.version,
        at: Date.now(),
      };
    for (const m of [seen, hashes, history, behind, held, pinned]) delete m[id];
  }
  for (const [id, r] of Object.entries(removed))
    if (addons.some((a) => a.id === id) || ago(r.at) > REMOVED_FOR) delete removed[id];
  for (const m of [noticed, st.acked || {}, st.dismissed || {}])
    for (const [key, at] of Object.entries(m)) if (ago(at) > 90 * DAY) delete m[key];
  saveState({ seen, noticed, removed, hashes, history, behind, held, pinned });
  last = {
    items,
    fresh,
    zotero: zv,
    catalog: data,
    fetchedAt: catalog.fetchedAt,
    advisoriesAt: advisories?.fetchedAt || 0,
  };
  changed();
  return last;
}

/** Alerts that want you: critical or important. */
function attention(rv) {
  return (rv?.items || []).flatMap((i) =>
    i.alerts.filter((a) => a.level !== "info").map((a) => ({ ...a, item: i })),
  );
}

/** Whether anything needs you that you haven't seen in "Your plugins" yet. */
function unseen(rv) {
  const acked = state().acked || {};
  return attention(rv).filter((a) => !acked[a.key]);
}

/** Opening "Your plugins" clears the dot until something new comes up. */
function ack() {
  const acked = state().acked || {};
  const fresh = attention(last).filter((a) => !acked[a.key]);
  if (!fresh.length) return;
  for (const a of fresh) acked[a.key] = Date.now();
  saveState({ acked });
  changed();
}

function dismiss(key) {
  const dismissed = state().dismissed || {};
  dismissed[key] = Date.now();
  saveState({ dismissed });
  changed();
}

function notify(fresh) {
  if (!fresh.length) return;
  const win = new Zotero.ProgressWindow({ closeOnClick: true });
  win.changeHeadline("Zotero Atlas");
  const order = (n) => (n.level === "critical" ? 0 : 1);
  const shown = [...fresh].sort((a, b) => order(a) - order(b)).slice(0, 2);
  for (const n of shown) win.addDescription(n.text);
  const rest = fresh.length - shown.length;
  if (rest > 0)
    win.addDescription(
      `${rest} more thing${rest === 1 ? "" : "s"} to look at: click the Zotero Atlas button by the sync button.`,
    );
  win.show();
  win.startCloseTimer(12000);
}

async function check() {
  clearTimeout(timer);
  timer = null;
  try {
    const { fresh } = await review(false);
    notify(fresh);
    await releaseHeld();
    await maybeSend(await installed());
  } catch (e) {
    Zotero.debug(`Zotero Atlas: check failed: ${e}`);
  }
  if (started) {
    timer = setTimeout(check, DAY);
    clearTimeout(advTimer);
    advTimer = setTimeout(checkAdvisories, ADVISORIES_EVERY);
  }
}

// Between the daily checks: only the advisories, which are for anything urgent.
async function checkAdvisories() {
  advTimer = null;
  try {
    await fetchAdvisories(true);
    const { fresh } = await review(false);
    notify(fresh);
  } catch (e) {
    Zotero.debug(`Zotero Atlas: advisories check failed: ${e}`);
  }
  if (started) advTimer = setTimeout(checkAdvisories, ADVISORIES_EVERY);
}

/** After changes in Zotero's add-ons: review again with what's already fetched. */
function refreshSoon() {
  if (!started) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    review(false).catch((e) => Zotero.debug(`Zotero Atlas: review failed: ${e}`));
  }, 1500);
}

const addonListener = {
  onEnabled: refreshSoon,
  onDisabled: refreshSoon,
  onInstalled: refreshSoon,
  onUninstalled: refreshSoon,
};

// ---------------------------------------------------------------------------------------------
// Holding updates: Zotero downloads an update, asks its install listeners, and installs it only
// if none says no. Atlas says no until the directory has checked the file.

const installListener = {
  onDownloadEnded(inst) {
    try {
      return onUpdateDownloaded(inst);
    } catch (e) {
      Zotero.debug(`Zotero Atlas: couldn't judge an update: ${e}`);
      return undefined;
    }
  },
  onInstallEnded() {
    refreshSoon();
  },
};

function onUpdateDownloaded(inst) {
  const existing = inst.existingAddon;
  const id = existing?.id || inst.addon?.id;
  const v = inst.version || inst.addon?.version;
  if (!existing || !id || id === ID || !v) return undefined; // a new install, or Atlas itself
  if (allowOnce.delete(`${id}@${v}`)) return undefined; // one Atlas started, or you allowed
  const st = state();
  const pinned = Boolean(st.pinned?.[id]);
  if (!pinned && !holding()) return undefined;
  const byId = catalog?.data?.plugins?.find((p) => p.id === id) || null;
  if (!catalog && !pinned) return undefined; // nothing to judge by yet: Zotero goes ahead
  let sha256 = null;
  try {
    sha256 = inst.file ? fileSha256(inst.file) : null;
  } catch (_e) {
    sha256 = null;
  }
  const d = holdDecision({
    entry: byId,
    id,
    v,
    from: existing.version,
    sha256,
    adv: advisories?.data?.advisories,
    pinned,
  });
  if (!d.hold) return undefined;
  const held = st.held || {};
  const was = held[id];
  held[id] = {
    version: v,
    from: existing.version,
    reason: was?.reason === "kept" && was.version === v ? "kept" : d.reason,
    grade: d.grade,
    before: d.before,
    at: was?.version === v ? was.at : Date.now(),
    name: existing.name || id,
  };
  saveState({ held });
  paused.set(id, inst);
  Zotero.debug(`Zotero Atlas: held ${id} ${v} (${d.reason})`);
  refreshSoon();
  return false;
}

/** Let a held update install: the paused download if it's still here, or ask Zotero for it again. */
async function letUpdate(id, v) {
  allowOnce.add(`${id}@${v}`);
  const inst = paused.get(id);
  paused.delete(id);
  const AM = addonManager();
  if (inst && inst.state === AM.STATE_DOWNLOADED && inst.version === v) {
    allowOnce.delete(`${id}@${v}`); // it won't ask the listeners again
    inst.install();
    return true;
  }
  const addon = await AM.getAddonByID(id);
  if (!addon) return false;
  return new Promise((resolve) => {
    addon.findUpdates(
      {
        onUpdateAvailable: (_a, install) => {
          install.install();
          resolve(true);
        },
        onNoUpdateAvailable: () => resolve(false),
        onUpdateFinished: () => resolve(false),
      },
      AM.UPDATE_WHEN_USER_REQUESTED,
    );
  });
}

/** Updates waiting only for our check, now checked and not graded lower: let them through. */
async function releaseHeld() {
  const st = state();
  const held = st.held || {};
  const byId = new Map((catalog?.data?.plugins || []).map((p) => [p.id, p]));
  for (const [id, h] of Object.entries(held)) {
    if (h.reason !== "unchecked") continue;
    if (!holding()) {
      delete held[id];
      await letUpdate(id, h.version).catch(() => false);
      continue;
    }
    const e = byId.get(id);
    if (!e) {
      delete held[id];
      await letUpdate(id, h.version).catch(() => false);
      continue;
    }
    const knows = checkedFiles(e).find((f) => Services.vc.compare(f.version, h.version) === 0);
    if (!knows || knows.grade === "–") continue;
    const before = gradeOfVersion(e, h.from);
    if (before && before !== "–" && RANK[knows.grade] < RANK[before]) {
      held[id] = { ...h, reason: "worse", grade: knows.grade, before };
      continue;
    }
    delete held[id];
    await letUpdate(id, h.version).catch(() => false);
  }
  saveState({ held });
}

/** "Update anyway", "Keep mine", "Go back", "Update" after going back, "Turn it off". */
const decide = {
  async update(id) {
    const held = state().held || {};
    const h = held[id];
    if (!h) return false;
    delete held[id];
    const pinned = state().pinned || {};
    delete pinned[id];
    saveState({ held, pinned });
    const ok = await letUpdate(id, h.version);
    refreshSoon();
    return ok;
  },
  keep(id) {
    const held = state().held || {};
    if (!held[id]) return;
    held[id] = { ...held[id], reason: "kept" };
    saveState({ held });
    review(false).catch(() => {});
  },
  async unpin(id) {
    const pinned = state().pinned || {};
    const held = state().held || {};
    const h = held[id];
    delete pinned[id];
    delete held[id];
    saveState({ pinned, held });
    if (h?.version) await letUpdate(id, h.version);
    else {
      const addon = await addonManager().getAddonByID(id);
      addon?.findUpdates(
        { onUpdateAvailable: (_a, install) => install.install() },
        addonManager().UPDATE_WHEN_USER_REQUESTED,
      );
    }
    refreshSoon();
  },
  /** Install the version you had, the file we analysed, and hold its updates until you choose. */
  async back(item, window) {
    const t = item.back;
    if (!t?.file?.sha256) return { ok: false, message: "We don't have that version's file." };
    const entry = item.entry;
    const r = await installFile(
      { id: entry.id, name: entry.name, version: t.version, build: t.file },
      window,
    );
    if (r.ok) {
      const pinned = state().pinned || {};
      pinned[entry.id] = t.version;
      saveState({ pinned });
      refreshSoon();
    }
    return r;
  },
  async off(id) {
    const addon = await addonManager().getAddonByID(id);
    if (!addon) return false;
    await addon.disable();
    refreshSoon();
    return true;
  },
};

// ---------------------------------------------------------------------------------------------
// Installing: Zotero's own installer, which refuses a file that doesn't match the hash

async function installPlugin(entry, build, window) {
  if (!build)
    return {
      ok: false,
      message: `No listed version of ${entry.name} works with Zotero ${Zotero.version}.`,
    };
  if (!build.sha256)
    return {
      ok: false,
      message: `We haven't analysed ${build.name}, so Zotero Atlas won't install it. You can install it from its GitHub page.`,
    };
  const p = Services.prompt;
  const flags =
    p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_0 +
    p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_1 +
    p.BUTTON_POS_0_DEFAULT;
  const grade = entry.grade === "–" ? "not graded yet" : `grade ${entry.grade}: ${entry.because}`;
  const choice = p.confirmEx(
    window || null,
    `Install ${entry.name}?`,
    `${entry.name} ${entry.version}, ${grade}.\n\nZotero downloads ${build.name} from GitHub and installs it only if it matches the file we analysed (SHA-256 ${build.sha256.slice(0, 12)}…).`,
    flags,
    "Install",
    "Cancel",
    null,
    null,
    {},
  );
  if (choice !== 0) return { ok: false, cancelled: true, message: "" };
  return installFile({ id: entry.id, name: entry.name, version: entry.version, build }, window);
}

/** Hand one analysed file to Zotero's installer, which checks the hash. */
async function installFile({ id, name, version: v, build }) {
  const AM = addonManager();
  if (id) allowOnce.add(`${id}@${v}`);
  const inst = await AM.getInstallForURL(build.url, {
    hash: `sha256:${build.sha256}`,
    name,
    version: v,
    telemetryInfo: { source: "zotero-atlas" },
  });
  const result = await new Promise((resolve) => {
    const fail = (why) => () => {
      const hash = inst.error === AM.ERROR_INCORRECT_HASH;
      resolve({
        ok: false,
        message: hash
          ? `The file on GitHub doesn't match the one we analysed, so nothing was installed. The release may have been replaced; the plugin's page says when we've checked it again.`
          : `${why} (error ${inst.error}). Nothing was installed.`,
      });
    };
    inst.addListener({
      onDownloadFailed: fail("The download failed"),
      onDownloadCancelled: fail("The download was cancelled"),
      onInstallFailed: fail("Zotero couldn't install it"),
      onInstallCancelled: fail("The install was cancelled"),
      onInstallEnded: () => resolve({ ok: true, message: `${name} ${v} is installed.` }),
    });
    inst.install();
  });
  if (id && !result.ok) allowOnce.delete(`${id}@${v}`);
  if (result.ok) {
    clearTimeout(timer);
    timer = setTimeout(check, 5000);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Ratings: stars and an optional review, sent only when you click Post

let rater = null;

const hex = (buf) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The ID this Zotero's ratings are posted under: a slow, salted hash of the key Zotero made for
 * this database (Zotero.Users.getLocalUserKey()), never the key itself, which for a library that
 * doesn't sync appears in item addresses. The same Zotero gives the same ID, so rating again
 * replaces a rating, and nothing is stored for it.
 */
async function raterId(win) {
  if (rater) return rater;
  const key = Zotero.Users.getLocalUserKey();
  const w = win || Zotero.getMainWindow();
  if (!key || !w?.crypto?.subtle || !w.TextEncoder) throw new Error("no rater key");
  const enc = new w.TextEncoder();
  const subtle = w.crypto.subtle;
  const base = await subtle.importKey("raw", enc.encode(key), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(RATER_SALT), iterations: RATER_ROUNDS },
    base,
    256,
  );
  rater = hex(bits);
  return rater;
}

/** Exactly what a rating sends. */
async function ratingPayload({ slug, addon, version: rated, stars, text }, win) {
  const body = {
    rater: await raterId(win),
    slug,
    addon,
    version: rated,
    stars,
    text: text || null,
    os: os(),
    zotero: Zotero.version,
    atlas: version,
  };
  if (pref(PREF.usage) === "yes" && pref(PREF.id)) body.install = pref(PREF.id);
  return body;
}

async function rate(r, win) {
  const stars = Number(r.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5)
    return { ok: false, message: "Choose from one to five stars." };
  const text = typeof r.text === "string" ? r.text.trim().slice(0, MAX_REVIEW) : "";
  let body;
  try {
    body = await ratingPayload({ ...r, stars, text }, win);
  } catch (e) {
    Zotero.debug(`Zotero Atlas: no rating ID: ${e}`);
    return { ok: false, message: "Zotero isn't ready to rate yet. Try again in a moment." };
  }
  try {
    await Zotero.HTTP.request("POST", RATINGS_URL, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      timeout: 20000,
      errorDelayMax: 0,
    });
  } catch (e) {
    const status = e?.status ?? e?.xmlhttp?.status ?? 0;
    Zotero.debug(`Zotero Atlas: rating not sent: ${e}`);
    return {
      ok: false,
      message:
        status === 429
          ? "Too many ratings from your network in the last hour. Please try again later."
          : status >= 400 && status < 500
            ? "zoteroatlas.com didn't accept this rating."
            : "Couldn't reach zoteroatlas.com. Check your connection and try again.",
    };
  }
  const rated = state().rated || {};
  rated[`${r.slug}|${r.version}`] = { stars, at: Date.now() };
  saveState({ rated });
  return { ok: true, message: "Thanks. Your rating is in." };
}

// ---------------------------------------------------------------------------------------------
// The first-run screen: holding updates, and usage data

const ASK_TEXT =
  "Zotero Atlas never sends your library, notes, files, Zotero account, email or anything " +
  "that identifies you.\n\n" +
  'With "Send my plugin list" it sends one thing: the list of plugins installed in this ' +
  "Zotero, with their versions, under a random ID created on this computer. We use the " +
  "totals to see which plugins people actually use, and we don't publish them.\n\n" +
  "You can change this any time in Zotero's settings, under Zotero Atlas.";

function ask(window) {
  askTimer = null;
  if (pref(PREF.usage)) return;
  // Both answers start at the recommended choice; closing the screen keeps them.
  const answer = { usage: "yes", updates: "hold", done: false };
  answer.wrappedJSObject = answer;
  try {
    (window || Zotero.getMainWindow()).openDialog(
      `${CONTENT}/firstrun.xhtml`,
      "zotero-atlas-firstrun",
      "chrome,modal,centerscreen,titlebar",
      answer,
    );
  } catch (e) {
    // The screen couldn't open: ask the one question that needs an answer the plain way.
    Zotero.debug(`Zotero Atlas: first-run screen failed: ${e}`);
    const p = Services.prompt;
    const flags =
      p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_0 +
      p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_1 +
      p.BUTTON_POS_0_DEFAULT;
    const choice = p.confirmEx(
      window || null,
      "Zotero Atlas",
      ASK_TEXT,
      flags,
      "Send my plugin list",
      "Don't send",
      null,
      null,
      {},
    );
    answer.usage = choice === 0 ? "yes" : "no";
    answer.updates = "";
  }
  if (answer.updates) setPref(PREF.updates, answer.updates === "hold" ? "hold" : "off");
  setPref(PREF.usage, answer.usage === "no" ? "no" : "yes");
  changed();
}

// ---------------------------------------------------------------------------------------------
// Usage data: only after "Send my plugin list"

function newId() {
  return Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
}

function os() {
  return Zotero.isWin ? "windows" : Zotero.isMac ? "mac" : "linux";
}

/** Exactly what is sent, and nothing else. */
function payload(addons, event) {
  return {
    id: pref(PREF.id),
    atlas: version,
    zotero: Zotero.version,
    os: os(),
    event,
    plugins: addons.map((a) => ({ id: a.id, version: a.version, enabled: a.enabled })),
  };
}

function pluginsHash(addons) {
  return addons.map((a) => `${a.id}@${a.version}:${a.enabled ? 1 : 0}`).join("\n");
}

async function send(event, addons) {
  if (pref(PREF.usage) !== "yes") return false;
  if (!pref(PREF.id)) setPref(PREF.id, newId());
  const body = payload(addons, event);
  try {
    // No retries by Zotero's HTTP client on a server error: the next check sends again.
    await Zotero.HTTP.request("POST", USAGE_URL, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      timeout: 20000,
      errorDelayMax: 0,
    });
  } catch (e) {
    Zotero.debug(`Zotero Atlas: usage report not sent (${event}): ${e}`);
    return false;
  }
  saveState({ sentAt: Date.now(), sentHash: pluginsHash(addons) });
  return true;
}

async function maybeSend(addons) {
  if (pref(PREF.usage) !== "yes") return false;
  const st = state();
  if (!st.sentAt) return send("first-run", addons);
  if (pluginsHash(addons) !== st.sentHash) return send("changed", addons);
  if (Date.now() - st.sentAt > WEEK) return send("weekly", addons);
  return false;
}

async function forget() {
  const id = pref(PREF.id);
  setPref(PREF.id, "");
  saveState({ sentAt: 0, sentHash: "" });
  if (!id) return false;
  try {
    await Zotero.HTTP.request("DELETE", `${USAGE_URL}/${id}`, {
      timeout: 20000,
      errorDelayMax: 0,
    });
    return true;
  } catch (e) {
    Zotero.debug(`Zotero Atlas: delete request failed: ${e}`);
    return false;
  }
}

// Holding turned off (here or in the settings pane): what waited only for our check goes ahead.
function onUpdatesPref() {
  if (!started) return;
  if (!holding()) releaseHeld().then(() => refreshSoon());
  changed();
}

// The choice changed, from the first-run screen or the settings pane.
function onUsagePref() {
  const choice = pref(PREF.usage);
  if (choice === "yes") installed().then((a) => send("first-run", a));
  else forget();
}

// ---------------------------------------------------------------------------------------------
// The main window: Tools → Zotero Atlas, the button by the sync button, the bar for critical alerts

function el(doc, tag, attrs = {}, ns = null) {
  const e = ns ? doc.createElementNS(ns, tag) : doc.createXULElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function addToWindow(win) {
  const doc = win.document;
  if (windows.has(win)) return;
  const popup = doc.getElementById("menu_ToolsPopup");
  if (!popup) return;
  const parts = {};
  // The window's styles for the button and the bar.
  try {
    parts.style = el(doc, "link", { rel: "stylesheet", href: `${CONTENT}/zotero.css` }, XHTML);
    doc.documentElement.appendChild(parts.style);
  } catch (_e) {
    parts.style = null;
  }
  // Tools → Zotero Atlas…, right under Plugins, with the logo.
  const item = el(doc, "menuitem", {
    id: "zotero-atlas-menu",
    label: "Zotero Atlas…",
    class: "menuitem-iconic",
    image: `${CONTENT}/icons/atlas.svg`,
  });
  item.addEventListener("command", () => openWindow("find"));
  const plugins = doc.getElementById("menu_addons");
  if (plugins?.parentNode === popup) plugins.after(item);
  else popup.appendChild(item);
  parts.menu = item;
  // The button by the sync button, in every tab.
  const sync = doc.getElementById("zotero-tb-sync-error") || doc.getElementById("zotero-tb-sync");
  if (sync?.parentNode) {
    const button = el(doc, "toolbarbutton", {
      id: "zotero-atlas-tb",
      class: "zotero-tb-button",
      tooltiptext: "Zotero Atlas",
      tabindex: "-1",
    });
    button.addEventListener("command", () => openWindow("mine"));
    sync.parentNode.insertBefore(button, sync);
    parts.button = button;
  }
  // The bar for a blocked plugin or a known security problem, above the library.
  const trees = doc.getElementById("zotero-trees");
  if (trees?.parentNode) {
    const box = el(doc, "vbox", {
      id: "zotero-atlas-banner-container",
      class: "banner-container",
      collapsed: "true",
      role: "status",
    });
    const bar = el(doc, "div", { id: "zotero-atlas-banner", class: "banner" }, XHTML);
    box.appendChild(bar);
    trees.parentNode.insertBefore(box, trees);
    parts.banner = box;
  }
  windows.set(win, parts);
  paintWindow(win);
}

function removeFromWindow(win) {
  const parts = windows.get(win);
  if (!parts) return;
  for (const k of ["menu", "button", "banner", "style"]) parts[k]?.remove();
  windows.delete(win);
}

/** The dot, the button's tooltip and the bar, from the latest review. */
function paintWindow(win) {
  const parts = windows.get(win);
  if (!parts) return;
  const doc = win.document;
  const want = unseen(last);
  const all = attention(last);
  if (parts.button) {
    if (want.length) parts.button.setAttribute("attention", "true");
    else parts.button.removeAttribute("attention");
    parts.button.setAttribute(
      "tooltiptext",
      all.length
        ? `Zotero Atlas: ${all.length} thing${all.length === 1 ? "" : "s"} to look at`
        : last
          ? "Zotero Atlas: your plugins are fine"
          : "Zotero Atlas",
    );
  }
  if (parts.banner) {
    const dismissed = state().dismissed || {};
    const crit = all.filter((a) => a.level === "critical" && !dismissed[a.key]);
    const bar = parts.banner.firstChild;
    bar.textContent = "";
    if (!crit.length) {
      parts.banner.setAttribute("collapsed", "true");
      return;
    }
    const first = crit[0];
    const msg = el(doc, "div", { class: "message" }, XHTML);
    msg.textContent =
      crit.length > 1 ? `${first.text} (and ${crit.length - 1} more in Zotero Atlas)` : first.text;
    bar.appendChild(msg);
    const link = (label, fn) => {
      const a = el(doc, "a", { class: "link", href: "#" }, XHTML);
      a.textContent = label;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        fn();
      });
      bar.appendChild(a);
    };
    if (first.off) link("Turn it off", () => decide.off(first.item.addon.id));
    link("What we know", () => (first.url ? openPage(first.url) : openWindow("mine")));
    bar.appendChild(el(doc, "div", { class: "spacer" }, XHTML));
    const close = el(
      doc,
      "div",
      { role: "button", class: "close-btn", title: "Close", tabindex: "0" },
      XHTML,
    );
    close.appendChild(el(doc, "span", { class: "icon" }, XHTML));
    close.addEventListener("click", () => dismiss(first.key));
    bar.appendChild(close);
    parts.banner.removeAttribute("collapsed");
  }
}

/** Something changed: repaint every window, the Plugins window and the Atlas window. */
function changed() {
  for (const win of windows.keys()) {
    try {
      paintWindow(win);
    } catch (e) {
      Zotero.debug(`Zotero Atlas: couldn't update a window: ${e}`);
    }
  }
  for (const doc of pages) decorate(doc);
  for (const fn of listeners) {
    try {
      fn();
    } catch (_e) {
      listeners.delete(fn);
    }
  }
}

function openWindow(tab) {
  if (atlasWindow && !atlasWindow.closed) {
    atlasWindow.focus();
    if (tab) atlasWindow.zoteroAtlasShow?.(tab);
    return atlasWindow;
  }
  const args = { tab: tab || "find" };
  args.wrappedJSObject = args;
  atlasWindow = Zotero.getMainWindow().openDialog(
    `${CONTENT}/atlas.xhtml`,
    "zotero-atlas",
    "chrome,centerscreen,resizable,dialog=no,width=1000,height=720",
    args,
  );
  return atlasWindow;
}

// ---------------------------------------------------------------------------------------------
// Tools → Plugins: each plugin's grade, a line when there's something to know, "Find more plugins"

const ADDONS_PAGE = "chrome://mozapps/content/extensions/aboutaddons.html";
let wmListener = null;

/** Notice the Plugins window (Zotero's viewer showing aboutaddons.html) when it opens. */
function watchPluginsWindows(on) {
  if (!on) {
    if (wmListener) Services.wm.removeListener(wmListener);
    wmListener = null;
    return;
  }
  const hook = (win) => {
    const tryPage = () => {
      const browser = win.document?.querySelector?.("browser");
      const doc = browser?.contentDocument;
      if (doc?.location?.href?.startsWith(ADDONS_PAGE)) {
        if (doc.readyState === "complete") decorate(doc);
        else doc.defaultView?.addEventListener("load", () => decorate(doc), { once: true });
      }
    };
    // The viewer makes its <browser> in its own load event; the page loads after that.
    win.addEventListener(
      "load",
      () => {
        if (win.document?.documentElement?.getAttribute("windowtype") !== "zotero:basicViewer")
          return;
        win.setTimeout(() => {
          const browser = win.document.querySelector("browser");
          browser?.addEventListener("pageshow", tryPage);
          tryPage();
        });
      },
      { once: true },
    );
  };
  wmListener = {
    onOpenWindow(xulWin) {
      try {
        hook(xulWin.docShell.domWindow);
      } catch (_e) {
        // Not a window we can look into.
      }
    },
    onCloseWindow() {},
  };
  Services.wm.addListener(wmListener);
  // A Plugins window already open (Atlas installed or updated while it was).
  for (const win of Services.wm.getEnumerator("zotero:basicViewer")) {
    const doc = win.document.querySelector("browser")?.contentDocument;
    if (doc?.location?.href?.startsWith(ADDONS_PAGE)) decorate(doc);
  }
}

/** The one line a plugin's card shows: the most serious thing to know, or nothing. */
function lineFor(item) {
  const order = { critical: 0, important: 1, info: 2 };
  const quiet = new Set(["updated"]); // a plain update shows only with a way back
  const pick = [...(item.alerts || [])]
    .filter((a) => !quiet.has(a.flag) || item.back)
    .sort((a, b) => order[a.level] - order[b.level])[0];
  return pick || null;
}

function decorate(doc) {
  if (!started || !doc?.defaultView || doc.defaultView.closed) {
    pages.delete(doc);
    return;
  }
  if (!pages.has(doc)) {
    pages.add(doc);
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = `${CONTENT}/plugins.css`;
    link.id = "zotero-atlas-style";
    doc.head.appendChild(link);
    const obs = new doc.defaultView.MutationObserver(() => {
      if (doc._zoteroAtlasPending) return;
      doc._zoteroAtlasPending = true;
      doc.defaultView.requestAnimationFrame(() => {
        doc._zoteroAtlasPending = false;
        paintPage(doc);
      });
    });
    obs.observe(doc.body, { childList: true, subtree: true });
    doc._zoteroAtlasObserver = obs;
    doc.defaultView.addEventListener("unload", () => pages.delete(doc), { once: true });
    if (!last) review(false).catch(() => {});
  }
  paintPage(doc);
}

function undecorate(doc) {
  pages.delete(doc);
  try {
    doc._zoteroAtlasObserver?.disconnect();
    for (const e of doc.querySelectorAll(".zotero-atlas, #zotero-atlas-style")) e.remove();
  } catch (_e) {
    // The window is gone.
  }
}

function paintPage(doc) {
  const obs = doc._zoteroAtlasObserver;
  obs?.disconnect(); // our own changes shouldn't wake it
  try {
    const heading = doc.querySelector(".main-heading");
    const menu = heading?.querySelector(".page-options-menu");
    if (heading && menu && !heading.querySelector(".zotero-atlas-find")) {
      const b = doc.createElement("button");
      b.className = "zotero-atlas zotero-atlas-find";
      b.textContent = "Find more plugins";
      b.title = "Open Zotero Atlas";
      b.addEventListener("click", () => openWindow("find"));
      heading.insertBefore(b, menu);
    }
    const byId = new Map((last?.items || []).map((i) => [i.addon.id, i]));
    for (const card of doc.querySelectorAll("addon-card")) {
      const id = card.addon?.id || card.getAttribute("addon-id");
      if (!id || id === ID) continue;
      const item = byId.get(id);
      const name = card.querySelector(".addon-name");
      const contents = card.querySelector(".card-contents");
      if (!name || !contents) continue;
      const sig = item
        ? JSON.stringify([
            item.entry?.grade,
            item.addon.version,
            (item.alerts || []).map((a) => a.key),
          ])
        : "none";
      // Unchanged and still there (a card that re-renders loses what we added).
      if (card.dataset.zoteroAtlas === sig && card.querySelector(".zotero-atlas-grade")) continue;
      card.dataset.zoteroAtlas = sig;
      for (const old of card.querySelectorAll(".zotero-atlas")) old.remove();
      if (!item) continue;
      // The grade, or "Not listed" for a plugin Atlas can't check.
      const pill = doc.createElement("a");
      pill.href = "#";
      const e = item.entry;
      if (e) {
        const g = e.grade;
        pill.className = `zotero-atlas zotero-atlas-grade g-${g === "–" ? "none" : g === "A+" ? "Ap" : g}`;
        pill.textContent = g === "–" ? "Not graded" : g;
        pill.title =
          g === "–"
            ? `Not graded yet on zoteroplugins.org. Click for its card.`
            : `Zotero Plugins grade ${g}: ${e.because}. Click for the full card.`;
        pill.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openPage(e.page);
        });
      } else {
        pill.className = "zotero-atlas zotero-atlas-grade g-none";
        pill.textContent = "Not listed";
        pill.title =
          "Not on zoteroplugins.org, so Zotero Atlas can't check it or hold its updates. Click to submit it.";
        pill.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openPage(`${SITE}/submit`);
        });
      }
      name.after(pill);
      const al = lineFor(item);
      if (!al) continue;
      const line = doc.createElement("div");
      line.className = `zotero-atlas zotero-atlas-line level-${al.level}`;
      const dot = doc.createElement("span");
      dot.className = "dot";
      const text = doc.createElement("span");
      text.className = "text";
      text.textContent = al.text;
      line.append(dot, text);
      const act = (label, fn, primary) => {
        const b = doc.createElement("button");
        b.className = primary ? "primary" : "";
        b.textContent = label;
        b.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          b.disabled = true;
          try {
            await fn();
          } finally {
            b.disabled = false;
          }
        });
        line.append(b);
      };
      if (al.off) act("Turn it off", () => decide.off(id), true);
      if (al.flag === "held") act("Review", () => openWindow("mine"));
      if (al.flag === "kept" || al.flag === "pinned") act("Review", () => openWindow("mine"));
      if (al.flag === "updated" && item.back)
        act(`Go back to ${item.back.version}`, () => openWindow("mine"));
      if (al.install)
        act(
          `Install ${al.install.entry.version}`,
          () => installPlugin(al.install.entry, al.install.build, doc.defaultView),
          true,
        );
      if (al.url && !al.off) act("What we know", () => openPage(al.url));
      contents.appendChild(line);
    }
  } catch (e) {
    Zotero.debug(`Zotero Atlas: couldn't add to the Plugins window: ${e}`);
  } finally {
    obs?.observe(doc.body, { childList: true, subtree: true });
  }
}

/** What the window and the settings pane use. */
const Atlas = {
  ID,
  SITE,
  HOME,
  RANK,
  get version() {
    return version;
  },
  catalog: fetchCatalog,
  installed,
  review,
  last: () => last,
  worksWith,
  fileFor,
  install: installPlugin,
  openWindow,
  openPage,
  attention: () => attention(last),
  ack,
  dismiss,
  decide,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  updates: {
    choice: () => pref(PREF.updates),
    set: (choice) => setPref(PREF.updates, choice === "hold" ? "hold" : "off"),
  },
  ratings: {
    rate,
    rated: (slug, v) => state().rated?.[`${slug}|${v}`] || null,
    removed: () => Object.entries(state().removed || {}).map(([id, r]) => ({ id, ...r })),
    payload: ratingPayload,
  },
  usage: {
    choice: () => pref(PREF.usage),
    set: (choice) => setPref(PREF.usage, choice === "yes" ? "yes" : "no"),
    id: () => pref(PREF.id),
    lastSent: () => state().sentAt || 0,
    payload: async (event) => payload(await installed(), event || "preview"),
    forget,
  },
};
