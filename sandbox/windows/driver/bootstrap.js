/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils */
/*
 * Zotero Atlas's windows on a real Windows desktop (sandbox/windows/run.ps1). It opens each
 * window in turn, says where it is, and waits while the script photographs the screen, checks the
 * title bar is on it and presses the key that should close it. Then it records whether the window
 * closed. Steps and answers are files in the folder named by ATLAS_WIN_IO:
 *   ready-<step>.json   written here: the key to press and where the window is
 *   acted-<step>        written by the script once it has pressed the key
 *   finished.json       written here at the end: every step's result
 */
const IO = Services.env.get("ATLAS_WIN_IO");
const results = [];
const errors = [];

// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function install() {}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function uninstall() {}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function shutdown() {}

// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function startup() {
  if (!IO) return;
  run()
    .catch((e) => errors.push(String(e?.stack || e)))
    .finally(() => write("finished.json", { results, errors }));
}

const delay = (ms) =>
  new Promise((r) =>
    ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(r, ms),
  );

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_e) {
      // not yet
    }
    await delay(250);
  }
  return null;
}

const write = (name, data) =>
  IOUtils.writeUTF8(PathUtils.join(IO, name), JSON.stringify(data, null, 2));

function windowAt(part) {
  for (const w of Services.wm.getEnumerator(null))
    if (!w.closed && w.location?.href?.includes(part)) return w;
  return null;
}

function where(win) {
  const s = win.screen;
  return {
    screenX: win.screenX,
    screenY: win.screenY,
    outerWidth: win.outerWidth,
    outerHeight: win.outerHeight,
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    availLeft: s.availLeft,
    availTop: s.availTop,
    availWidth: s.availWidth,
    availHeight: s.availHeight,
    devicePixelRatio: win.devicePixelRatio,
  };
}

/** Let a window load and settle, hand it to the script, then see whether the key closed it. */
async function check(step, win, key, extra, inspect) {
  await waitFor(() => win.document?.readyState === "complete", 20000);
  await delay(2500);
  win.focus();
  await delay(300);
  const before = where(win);
  await write(`ready-${step}.json`, { step, key, where: before, ...extra });
  const acted = await waitFor(() => IOUtils.exists(PathUtils.join(IO, `acted-${step}`)), 90000);
  await delay(1500);
  const closed = win.closed;
  const result = { step, key, acted: !!acted, closed, before, after: closed ? null : where(win) };
  if (inspect && !closed) Object.assign(result, inspect(win));
  results.push(result);
  if (!win.closed) win.close();
  await delay(800);
}

async function run() {
  await Zotero.uiReadyPromise;
  const A = await waitFor(() => Zotero.ZoteroAtlas, 60000);
  if (!A) throw new Error("Zotero Atlas didn't start");
  results.push({ step: "atlas", version: A.version, zotero: Zotero.version });

  // The first-run screen opens by itself a few seconds after the main window. A test run never
  // sends a plugin list: choose "Don't send", then Enter means Done.
  const first = await waitFor(() => windowAt("firstrun.xhtml"), 60000);
  if (first) {
    await waitFor(() => first.document?.getElementById("no"), 20000);
    first.document.getElementById("no").click();
    await check("firstrun", first, "{ENTER}");
  } else results.push({ step: "firstrun", missing: true });
  results.push({
    step: "answers",
    usage: Services.prefs.getStringPref("extensions.zotero-atlas.usage", ""),
  });

  // The Atlas window: Escape closes it, and so does Ctrl+W.
  await check("escape", A.openWindow("find"), "{ESC}");
  await check("ctrl-w", A.openWindow("find"), "^w");

  // The "All jobs" list, opened with Alt+Down: does it have a background?
  const listWin = A.openWindow("find");
  await waitFor(() => listWin.document?.getElementById("job"), 20000);
  listWin.document.getElementById("job").focus();
  await check(
    "dropdown",
    listWin,
    "%{DOWN}",
    { expect: "the list opens with a background" },
    (w) => {
      const list = w.document.getElementById("ContentSelectDropdown");
      const pop = list?.menupopup || list?.querySelector("menupopup");
      if (!pop) return { popup: null };
      const part = pop.openOrClosedShadowRoot?.querySelector('[part~="content"]');
      const bg = (e) => (e ? w.getComputedStyle(e).backgroundColor : null);
      // How many copies of its text the first item shows (each item carries two, one hidden).
      const item = pop.querySelector("menuitem");
      const texts = item
        ? [...item.children].filter(
            (c) =>
              w.getComputedStyle(c).display !== "none" &&
              (c.getAttribute("value") || c.textContent || "").trim() !== "",
          ).length
        : null;
      return {
        popup: {
          state: pop.state,
          host: bg(pop),
          content: bg(part),
          appearance: w.getComputedStyle(pop).appearance,
          texts,
        },
      };
    },
  );

  // With text in the search box, the first Escape only empties it and the window stays open.
  const win = A.openWindow("find");
  await waitFor(() => win.document?.getElementById("q"), 20000);
  const q = win.document.getElementById("q");
  q.value = "pdf";
  q.dispatchEvent(new win.Event("input"));
  q.focus();
  await check("escape-search", win, "{ESC}", { expect: "stays open, search emptied" }, (w) => ({
    searchAfter: w.document.getElementById("q").value,
  }));
}
