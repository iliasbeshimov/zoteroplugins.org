/* global Zotero, Services, Components, ChromeUtils, ADDON_INSTALL, ADDON_UNINSTALL, setTimeout, clearTimeout */
/*
 * Zotero Atlas
 *
 * Finds and installs plugins from zoteroplugins.org inside Zotero, filtered to this Zotero's
 * version, with each plugin's grade, and watches the plugins already installed: it says when
 * one drops a grade, when the update Zotero would apply is graded worse, when Zotero's blocklist
 * blocks it, or when Zotero has disabled it because it doesn't work with this version.
 *
 * What it contacts:
 * - raw.githubusercontent.com, once a day, for the catalogue (catalog.json in the directory's
 *   public repository), and github.com for a plugin file when you click Install. Zotero's own
 *   installer downloads the file and refuses it unless it matches the SHA-256 we analysed.
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
 * What it stores: three settings (extensions.zotero-atlas.usage, .id, .state) and the catalogue
 * in <Zotero data directory>/zotero-atlas/catalog.json. Uninstalling removes all of it.
 */

const ID = "atlas@zoteroatlas.com";
const CATALOG_URL =
  "https://raw.githubusercontent.com/iliasbeshimov/zoteroplugins.org/main/data/generated/catalog.json";
const USAGE_URL = "https://zoteroatlas.com/api/v1/plugins";
const RATINGS_URL = "https://zoteroatlas.com/api/v1/ratings";
const SITE = "https://zoteroplugins.org";
const HOME = "https://zoteroatlas.com";
const PREF = {
  usage: "extensions.zotero-atlas.usage", // "" (not asked yet), "yes" or "no"
  id: "extensions.zotero-atlas.id", // the random ID, only while usage is "yes"
  state: "extensions.zotero-atlas.state", // JSON, see state()
};
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const START_DELAY = 20 * 1000; // after startup, before the first check: let Zotero settle
const ASK_DELAY = 8 * 1000; // after the main window opens, before the first-run screen
const RANK = { "A+": 4, A: 3, B: 2, C: 1, "–": 0 };
const RATER_SALT = "zotero-atlas ratings v1";
const RATER_ROUNDS = 600000;
const REMOVED_FOR = 30 * DAY; // a removed plugin can still be rated for this long
const MAX_REVIEW = 1000;

const ASK_TEXT =
  "Zotero Atlas never sends your library, notes, files, Zotero account, email or anything " +
  "that identifies you.\n\n" +
  'With "Send my plugin list" it sends one thing: the list of plugins installed in this ' +
  "Zotero, with their versions, under a random ID created on this computer. We publish the " +
  "totals so everyone can see which plugins people actually use.\n\n" +
  "You can change this any time in Zotero's settings, under Zotero Atlas.";

let rootURI = "";
let version = "";
let chromeHandle = null;
let started = false;
let timer = null;
let askTimer = null;
let asked = false;
let atlasWindow = null;
let catalog = null; // { data, fetchedAt }
const menus = new Map(); // main window → the menu item added to it

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
  Zotero.PreferencePanes.register({
    pluginID: id,
    src: `${rootURI}settings.xhtml`,
    scripts: [`${rootURI}settings.js`],
  });
  for (const win of Zotero.getMainWindows()) addToWindow(win);
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
  clearTimeout(timer);
  clearTimeout(askTimer);
  timer = null;
  askTimer = null;
  Services.prefs.removeObserver(PREF.usage, onUsagePref);
  for (const win of [...menus.keys()]) removeFromWindow(win);
  if (atlasWindow && !atlasWindow.closed) atlasWindow.close();
  atlasWindow = null;
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

// The first-run screen, once per session, a moment after the window is there.
function maybeAsk(window) {
  if (asked || pref(PREF.usage)) return;
  asked = true;
  askTimer = setTimeout(() => ask(window), ASK_DELAY);
}

function onMainWindowUnload({ window }) {
  removeFromWindow(window);
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
 * catalogEtag, catalogAt: the catalogue's freshness. sentAt, sentHash: the last usage report.
 * seen: { addonId: { grade, version } } as last reviewed, so a grade drop can be told.
 * noticed: { key: time } notices already shown, so each shows once.
 * removed: { addonId: { slug, name, version, at } } plugins removed in the last 30 days, so
 *   they can still be rated.
 * rated: { "slug|version": { stars, at } } ratings posted from this Zotero.
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

// ---------------------------------------------------------------------------------------------
// The catalogue: one JSON file from the directory's repository, kept for a day

async function readCatalogFile() {
  try {
    const f = dataFile("catalog.json");
    if (!f.exists()) return null;
    const saved = JSON.parse(await Zotero.File.getContentsAsync(f));
    return saved?.data?.schemaVersion === 1 ? saved : null;
  } catch (_e) {
    return null;
  }
}

async function writeCatalogFile(saved) {
  try {
    await Zotero.File.createDirectoryIfMissingAsync(dataFile().path);
    await Zotero.File.putContentsAsync(dataFile("catalog.json"), JSON.stringify(saved));
  } catch (e) {
    Zotero.debug(`Zotero Atlas: couldn't save the catalogue: ${e}`);
  }
}

async function fetchCatalog(force) {
  if (!catalog) catalog = await readCatalogFile();
  if (!force && catalog && Date.now() - catalog.fetchedAt < DAY) return catalog.data;
  const headers = { Accept: "application/json" };
  const etag = state().catalogEtag;
  if (catalog && etag) headers["If-None-Match"] = etag;
  let xhr;
  try {
    xhr = await Zotero.HTTP.request("GET", CATALOG_URL, {
      headers,
      successCodes: [200, 304],
      timeout: 30000,
    });
  } catch (e) {
    Zotero.debug(`Zotero Atlas: couldn't fetch the catalogue: ${e}`);
    if (catalog) return catalog.data;
    throw new Error("The catalogue couldn't be fetched. Check your connection and try again.");
  }
  if (xhr.status === 304 && catalog) {
    catalog.fetchedAt = Date.now();
  } else {
    const data = JSON.parse(xhr.responseText);
    if (data?.schemaVersion !== 1 || !Array.isArray(data.plugins))
      throw new Error("The catalogue isn't in the form this version understands.");
    catalog = { data, fetchedAt: Date.now() };
    saveState({ catalogEtag: xhr.getResponseHeader("ETag") || "" });
  }
  await writeCatalogFile(catalog);
  return catalog.data;
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
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

const NOTICE = {
  blocked: (e) => `${e.name}: Zotero's blocklist blocks version ${e.version} (${e.blocked}).`,
  "worse-update": (e) =>
    `${e.name}: the update offered for it (${e.update.version || "unknown version"}) is graded ${e.update.grade}, lower than the ${e.grade} of version ${e.version}.`,
  "grade-drop": (e, from) => `${e.name} went from ${from} to ${e.grade}: ${e.because}.`,
  "disabled-fix": (e, _p, zv) =>
    `${e.name} is disabled by Zotero (not for Zotero ${zv}); a version that works is listed.`,
  disabled: (e, _p, zv) =>
    `${e.name} is disabled by Zotero: no listed version works with Zotero ${zv}.`,
};
const PROMINENT = new Set(["blocked", "worse-update"]);

/**
 * Each installed plugin against the catalogue: its entry (or none), what's worth a look
 * (flags), and the notices not shown before. Remembers the grades seen.
 */
async function review(force) {
  const data = await fetchCatalog(force);
  const byId = new Map();
  for (const p of data.plugins) if (p.id && !byId.has(p.id)) byId.set(p.id, p);
  const addons = await installed();
  const zv = Zotero.version;
  const st = state();
  const seen = st.seen || {};
  const noticed = st.noticed || {};
  const items = [];
  const fresh = [];
  for (const a of addons) {
    const e = byId.get(a.id) || null;
    if (!e) {
      items.push({ addon: a, entry: null, flags: ["not-listed"], texts: [] });
      continue;
    }
    const flags = [];
    const cmp = Services.vc.compare(a.version, e.version);
    if (e.blocked) flags.push("blocked");
    if (
      e.update &&
      e.update.grade !== "–" &&
      e.grade !== "–" &&
      RANK[e.update.grade] < RANK[e.grade]
    )
      flags.push("worse-update");
    // A drop stays on the list for a month, or until the grade is back up.
    const prev = seen[a.id];
    let from = prev?.droppedFrom && Date.now() - (prev.droppedAt || 0) < 30 * DAY ? prev : null;
    if (prev && e.grade !== "–" && prev.grade !== "–" && RANK[e.grade] < RANK[prev.grade])
      from = { droppedFrom: prev.grade, droppedAt: Date.now() };
    if (from && RANK[e.grade] >= RANK[from.droppedFrom]) from = null;
    if (from) flags.push("grade-drop");
    if (a.appDisabled) flags.push(fileFor(e, zv) ? "disabled-fix" : "disabled");
    if (cmp < 0) flags.push("outdated");
    const text = (f) => NOTICE[f](e, from?.droppedFrom, zv);
    const texts = flags.filter((f) => NOTICE[f]).map(text);
    items.push({ addon: a, entry: e, flags, texts, same: cmp === 0 });
    for (const f of flags) {
      if (!NOTICE[f]) continue;
      const key = `${a.id}|${f}|${e.version}|${e.grade}`;
      if (noticed[key]) continue;
      noticed[key] = Date.now();
      fresh.push({ flag: f, text: text(f) });
    }
    seen[a.id] = {
      grade: e.grade,
      version: e.version,
      slug: e.slug,
      name: e.name,
      installed: a.version,
      ...(from || {}),
    };
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
    delete seen[id];
  }
  for (const [id, r] of Object.entries(removed))
    if (addons.some((a) => a.id === id) || Date.now() - r.at > REMOVED_FOR) delete removed[id];
  for (const [key, at] of Object.entries(noticed))
    if (Date.now() - at > 90 * DAY) delete noticed[key];
  saveState({ seen, noticed, removed });
  return { items, fresh, zotero: zv, catalog: data, fetchedAt: catalog.fetchedAt };
}

function notify(fresh) {
  if (!fresh.length) return;
  const win = new Zotero.ProgressWindow({ closeOnClick: true });
  win.changeHeadline("Zotero Atlas");
  const loud = fresh.filter((n) => PROMINENT.has(n.flag));
  for (const n of loud.slice(0, 3)) win.addDescription(n.text);
  const rest = fresh.length - Math.min(loud.length, 3);
  if (rest > 0)
    win.addDescription(
      `${rest} more thing${rest === 1 ? "" : "s"} to look at: Tools → Zotero Atlas → Your plugins.`,
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
    await maybeSend(await installed());
  } catch (e) {
    Zotero.debug(`Zotero Atlas: check failed: ${e}`);
  }
  if (started) timer = setTimeout(check, DAY);
}

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
  const AM = addonManager();
  const inst = await AM.getInstallForURL(build.url, {
    hash: `sha256:${build.sha256}`,
    name: entry.name,
    version: entry.version,
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
      onInstallEnded: () =>
        resolve({ ok: true, message: `${entry.name} ${entry.version} is installed.` }),
    });
    inst.install();
  });
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
// Usage data: only after "Send my plugin list"

function ask(window) {
  askTimer = null;
  if (pref(PREF.usage)) return;
  const p = Services.prompt;
  const flags =
    p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_0 +
    p.BUTTON_TITLE_IS_STRING * p.BUTTON_POS_1 +
    p.BUTTON_POS_0_DEFAULT; // "Send my plugin list"; closing the dialog answers "Don't send"
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
  setPref(PREF.usage, choice === 0 ? "yes" : "no");
}

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

// The choice changed, from the first-run screen or the settings pane.
function onUsagePref() {
  const choice = pref(PREF.usage);
  if (choice === "yes") installed().then((a) => send("first-run", a));
  else forget();
}

// ---------------------------------------------------------------------------------------------
// Windows and menus

function addToWindow(win) {
  const doc = win.document;
  const popup = doc.getElementById("menu_ToolsPopup");
  if (!popup || menus.has(win)) return;
  const item = doc.createXULElement("menuitem");
  item.id = "zotero-atlas-menu";
  item.setAttribute("label", "Zotero Atlas: find plugins…");
  item.addEventListener("command", () => openWindow());
  popup.appendChild(item);
  menus.set(win, item);
}

function removeFromWindow(win) {
  menus.get(win)?.remove();
  menus.delete(win);
}

function openWindow() {
  if (atlasWindow && !atlasWindow.closed) {
    atlasWindow.focus();
    return atlasWindow;
  }
  atlasWindow = Zotero.getMainWindow().openDialog(
    "chrome://zotero-atlas/content/atlas.xhtml",
    "zotero-atlas",
    "chrome,centerscreen,resizable,dialog=no,width=1000,height=700",
  );
  return atlasWindow;
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
  worksWith,
  fileFor,
  install: installPlugin,
  openWindow,
  openPage: (url) => Zotero.launchURL(url),
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
