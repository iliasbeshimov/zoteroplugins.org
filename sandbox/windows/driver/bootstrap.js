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

  // The first-run screen opens by itself a few seconds after the main window: one question,
  // holding updates, ticked; Enter means Done. Sharing isn't on it and starts on by itself;
  // run.ps1 points zoteroatlas.com at this computer, so the first report (with the first check,
  // 20 s after start) can't leave it. A release from before 1.4 asks about sharing too: answer
  // "Don't send" there.
  const first = await waitFor(() => windowAt("firstrun.xhtml"), 60000);
  if (first) {
    await waitFor(() => first.document?.getElementById("done"), 20000);
    const d = first.document;
    const text = d.body.textContent.replace(/\s+/g, " ");
    const screen = {
      holdTicked: d.getElementById("hold")?.checked,
      mentionsSharing: /plugin list|send|shar/i.test(text),
    };
    d.getElementById("no")?.click();
    await check("firstrun", first, "{ENTER}", screen);
    Object.assign(results[results.length - 1], screen);
  } else results.push({ step: "firstrun", missing: true });
  await delay(30000);
  const atlasPref = (k) => Services.prefs.getStringPref(`extensions.zotero-atlas.${k}`, "");
  results.push({
    step: "answers",
    usage: atlasPref("usage"),
    updates: atlasPref("updates"),
    sentAt: JSON.parse(atlasPref("state") || "{}").sentAt || 0,
  });

  // About: four tabs that fit, the box ticked; unticking it turns sharing off. Then Escape.
  const ab = A.openWindow("about");
  if (await waitFor(() => ab.document?.getElementById("share"), 20000)) {
    await delay(1500);
    const d = ab.document;
    const head = d.querySelector("header").getBoundingClientRect();
    const tabs = [...d.querySelectorAll(".tabs .tab")];
    const info = {
      tabs: tabs.length,
      tabsFit: tabs.every((t) => t.getBoundingClientRect().right <= head.right),
      shown: !d.getElementById("about").hidden,
      hold: d.getElementById("hold")?.checked,
      checked: d.getElementById("share").checked,
    };
    d.getElementById("share").click();
    await delay(1500);
    info.usageAfter = atlasPref("usage");
    info.checkedAfter = d.getElementById("share").checked;
    await check("about", ab, "{ESC}", info);
    Object.assign(results[results.length - 1], info);
  } else results.push({ step: "about", missing: true });

  // The Atlas window: Escape closes it, and so does Ctrl+W.
  await check("escape", A.openWindow("find"), "{ESC}");
  await check("ctrl-w", A.openWindow("find"), "^w");

  // The "All jobs" list, opened with Alt+Down: does it have a background? It's on the results
  // view of Find plugins, so open that first.
  const listWin = A.openWindow("find");
  await waitFor(() => listWin.zoteroAtlasFind, 20000);
  listWin.zoteroAtlasFind?.showList();
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

  // Move to another computer: save the list with settings, then open a list and show the plan.
  // Nothing is installed: the plan is only shown.
  const mv = A.openWindow("move");
  if (
    !(await waitFor(() => mv.zoteroAtlasMove && mv.document.getElementById("move-settings"), 20000))
  ) {
    results.push({ step: "move-saved", missing: true });
    return;
  }
  mv.document.getElementById("move-settings").click();
  const saveTo = PathUtils.join(IO, "zotero-plugins-test.json");
  const ex = await mv.zoteroAtlasMove.exportTo(saveTo);
  const saved = JSON.parse(await IOUtils.readUTF8(saveTo));
  results.push({
    step: "move-saved",
    ok: Boolean(ex),
    plugins: saved.plugins.map((p) => p.id),
    settings: "settings" in saved,
  });
  results.push({
    step: "move-export-text",
    text: mv.document.getElementById("move-export-out").textContent,
  });
  await check("move-export", mv, "{ESC}", { expect: "the saved line" });

  const list = PathUtils.join(IO, "zotero-plugins-other.json");
  await IOUtils.writeUTF8(
    list,
    JSON.stringify({
      atlas: "1.2.0",
      exportedAt: "2026-11-14T00:00:00.000Z",
      zotero: "10.0.8",
      plugins: [
        {
          id: "Knowledge4Zotero@windingwind.com",
          name: "Better Notes for Zotero",
          version: "0.0.1",
        },
        { id: "better-bibtex@iris-advies.com", name: "Better BibTeX for Zotero", version: "0.0.1" },
        { id: "atlas-windows-driver@zoteroplugins.invalid", name: "Driver", version: "1" },
        { id: "nobody@zoteroplugins.invalid", name: "Not listed", version: "1" },
      ],
      settings: {
        "Knowledge4Zotero@windingwind.com": { "extensions.zotero.Knowledge4Zotero.x": 1 },
      },
    }),
  );
  const im = A.openWindow("move");
  await waitFor(() => im.zoteroAtlasMove, 20000);
  await im.zoteroAtlasMove.importFrom(list);
  const doc = im.document;
  results.push({
    step: "move-plan",
    rows: [...doc.querySelectorAll("#move-plan .prow .ptext")].map((e) => e.textContent),
    button: doc.querySelector("#move-plan .plan-act button")?.textContent || null,
  });
  await check("move-import", im, "{ESC}", { expect: "the plan for each plugin" });

  // The file picker Atlas uses to save and open lists: the module loads and a picker can be set
  // up on the Atlas window (it isn't shown).
  const fpWin = A.openWindow("move");
  await waitFor(() => fpWin.document?.readyState === "complete", 20000);
  try {
    const FP = ChromeUtils.importESModule(
      "chrome://zotero/content/modules/filePicker.mjs",
    ).FilePicker;
    const fp = new FP();
    fp.init(fpWin, "Open a list of plugins", fp.modeOpen);
    fp.appendFilter("JSON", "*.json");
    results.push({
      step: "move-filepicker",
      ok: typeof fp.show === "function" && fp.returnOK !== undefined,
    });
  } catch (e) {
    results.push({ step: "move-filepicker", ok: false, error: String(e) });
  }
  fpWin.close();
  await delay(800);

  // A real import: a list with one small checked plugin and one of its settings. Install it with
  // the window's own button, then read what Zotero has.
  const ADDON = "abbreviation-helper@cydoimos.github.io";
  const PREF = "extensions.abbreviation-helper.tooltipFontSize";
  const real = PathUtils.join(IO, "zotero-plugins-real.json");
  await IOUtils.writeUTF8(
    real,
    JSON.stringify({
      atlas: "1.2.0",
      exportedAt: "2026-11-14T00:00:00.000Z",
      zotero: "10.0.8",
      plugins: [{ id: ADDON, name: "Abbreviation Helper", version: "2.2.0" }],
      settings: { [ADDON]: { [PREF]: 15 } },
    }),
  );
  const rw = A.openWindow("move");
  await waitFor(() => rw.zoteroAtlasMove, 20000);
  await rw.zoteroAtlasMove.importFrom(real);
  const rdoc = rw.document;
  const go = rdoc.querySelector("#move-plan .plan-act button");
  const planned = rdoc.querySelector("#move-plan .prow .ptext")?.textContent || null;
  let note = null;
  if (go) {
    go.click();
    note = await waitFor(() => {
      const t = rdoc.querySelector("#move-plan .plan-act .mnote")?.textContent || "";
      return / installed\./.test(t) ? t : null;
    }, 120000);
  }
  let AM;
  try {
    AM = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;
  } catch (_e) {
    AM = ChromeUtils.import("resource://gre/modules/AddonManager.jsm").AddonManager;
  }
  const addon = await AM.getAddonByID(ADDON);
  let pref = null;
  try {
    pref = Services.prefs.getIntPref(PREF);
  } catch (_e) {
    // not set
  }
  results.push({
    step: "move-install",
    planned,
    button: go?.textContent || null,
    row: rdoc.querySelector("#move-plan .prow .ptext")?.textContent || null,
    note,
    installed: addon ? addon.version : null,
    pref,
  });
  await check("move-installed", rw, "{ESC}", { expect: "the plugin installed, its setting set" });

  // Removing it (from 1.5.0): Escape on the remove sheet is Cancel and keeps the window; Remove
  // and Undo bring it back; Remove, Done, then closing the window (Ctrl+W) deletes it.
  const btn = (root, text) =>
    [...(root?.querySelectorAll("button") || [])].find((b) => b.textContent === text) || null;
  const mine = async () => {
    const w = A.openWindow("mine");
    await waitFor(() => w.document?.querySelector("#all .prow"), 30000);
    await delay(1500);
    const all = w.document.querySelector("#all details");
    if (all) all.open = true;
    const row = [...w.document.querySelectorAll("#all .prow")].find((r) =>
      r.textContent.includes("Abbreviation Helper"),
    );
    return { w, row };
  };
  const sheetIn = (w) => w.document.querySelector(".sheet-back:not(#sheet) .sheet");
  const pending = (a) => Boolean(a && a.pendingOperations & AM.PENDING_UNINSTALL);
  let m = await mine();
  if (!m.w.document.querySelector(".pacts") || !m.row || !addon) {
    results.push({ step: "remove-escape", missing: true });
    m.w.close();
    return;
  }
  btn(m.row, "Remove…")?.click();
  await waitFor(() => sheetIn(m.w), 5000);
  await check(
    "remove-escape",
    m.w,
    "{ESC}",
    { expect: "the sheet closes, the window stays" },
    (w) => ({
      sheet: Boolean(sheetIn(w)),
    }),
  );
  m = await mine();
  btn(m.row, "Remove…")?.click();
  await waitFor(() => sheetIn(m.w), 5000);
  btn(sheetIn(m.w), "Remove")?.click();
  await delay(1500);
  const removedNow = pending(await AM.getAddonByID(ADDON));
  btn(sheetIn(m.w), "Undo")?.click();
  await delay(2500);
  let a = await AM.getAddonByID(ADDON);
  results.push({ step: "remove-undo", removedNow, pending: pending(a), active: a?.isActive });
  m.w.close();
  await delay(1000);
  m = await mine();
  btn(m.row, "Remove…")?.click();
  await waitFor(() => sheetIn(m.w), 5000);
  btn(sheetIn(m.w), "Remove")?.click();
  await delay(1500);
  btn(sheetIn(m.w), "Done")?.click();
  await delay(1000);
  const beforeClose = pending(await AM.getAddonByID(ADDON));
  await check("remove-close", m.w, "^w", { expect: "closing the window deletes it" });
  await delay(3000);
  a = await AM.getAddonByID(ADDON);
  Object.assign(results[results.length - 1], { beforeClose, gone: a === null });
}
