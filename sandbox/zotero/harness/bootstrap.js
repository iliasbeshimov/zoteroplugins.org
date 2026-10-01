/* global Zotero, Services, IOUtils, ChromeUtils, Ci */
/**
 * The sandbox harness. In a throwaway Zotero it either seeds the test library (ATLAS_MODE=seed)
 * or walks through ordinary use while another plugin is installed (test, or baseline with no
 * plugin): startup, selecting items, opening a PDF, opening the plugin's settings, then idle.
 * It records the add-ons' states and every console message, writes ATLAS_RESULTS and quits.
 * The proxy and the monitor record the rest from outside.
 */

const PHASE_MS = { startup: 25000, library: 1500, reader: 12000, prefs: 8000, idle: 20000 };
// Longest each step may take, so a plugin that blocks one step can't stop the run; and when the
// whole run gives up (before the container's own limit), keeping what it has.
const STEP_MS = { library: 60000, prefs: 30000, menus: 170000, links: 150000, clicks: 240000 };
// A minute before the container's own limit (ATLAS_TIMEOUT), so the harness can still write.
const WATCHDOG_MS = ((Number(Services.env.get("ATLAS_TIMEOUT")) || 360) - 60) * 1000;

// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function install() {}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function uninstall() {}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function shutdown() {}

// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function startup() {
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  setTimeout(() => finish({ watchdog: true }), WATCHDOG_MS);
  Services.ww.registerNotification(answerPrompts);
  run().catch((e) => finish({ harnessError: String(e?.stack || e) }));
}

/**
 * A dialog a plugin opens (an alert, a confirmation, a text prompt) would stop the run until
 * someone answered it. Answer it the way a user would: record its text and press OK.
 */
function answerPrompts(win, topic) {
  if (topic !== "domwindowopened") return;
  win.addEventListener(
    "load",
    () => {
      const doc = win.document;
      if (!/commonDialog|dialog\.xhtml/.test(doc.documentURI)) return;
      const text = (doc.getElementById("infoBody") ?? doc.body)?.textContent ?? "";
      out.prompts ??= [];
      out.prompts.push({
        title: doc.title,
        text: text.trim().slice(0, 500),
        at: Date.now(),
      });
      // ATLAS_PROMPT=cancel answers Cancel instead (the click check uses both).
      const cancel = env("ATLAS_PROMPT", "accept") === "cancel";
      out.prompts[out.prompts.length - 1].answered = cancel ? "cancel" : "ok";
      win.setTimeout(() => {
        try {
          if (cancel) doc.querySelector("dialog")?.cancelDialog();
          else doc.querySelector("dialog")?.acceptDialog();
        } catch {
          win.close();
        }
      }, 500);
    },
    { once: true },
  );
}

const env = (key, fallback) => Services.env.get(key) || fallback;
const delay = (ms) => Zotero.Promise.delay(ms);
const out = { phases: [] };
const within = (ms, promise) =>
  Promise.race([
    promise,
    delay(ms).then(() => Promise.reject(new Error(`gave up after ${ms} ms`))),
  ]);

/** Each step is recorded as it starts, so a run cut short still shows how far it got. */
function mark(name) {
  out.phases.push({ name, at: Date.now() });
  Zotero.debug(`[atlas-harness] ${name}`);
  IOUtils.writeJSON(env("ATLAS_PROGRESS", "/results/progress.json"), out).catch(() => {});
}

async function run() {
  await Zotero.initializationPromise;
  if (Zotero.uiReadyPromise)
    await within(60000, Zotero.uiReadyPromise).catch((e) => {
      out.uiReadyError = String(e);
    });
  Object.assign(out, {
    mode: env("ATLAS_MODE", "test"),
    target: env("ATLAS_TARGET_ID", ""),
    zotero: Zotero.version,
    startedAt: Date.now(),
  });
  if (out.mode === "seed") {
    await seed();
    out.seeded = true;
    return finish(out);
  }
  mark("startup");
  out.addonsAtStart = await within(5000, addons()).catch(() => []);
  await delay(PHASE_MS.startup);
  if (out.mode === "links") {
    mark("links");
    await step("links", checkLinks);
    out.addons = await addons();
    mark("end");
    return finish(out);
  }
  if (out.mode === "clicks") {
    mark("clicks");
    await step("clicks", checkClicks);
    out.addons = await addons();
    mark("end");
    return finish(out);
  }
  mark("library");
  await step("library", exerciseLibrary);
  mark("prefs");
  await step("prefs", openPrefs);
  mark("menus");
  await step("menus", exerciseMenus);
  mark("idle");
  await delay(PHASE_MS.idle);
  out.addons = await addons();
  mark("end");
  finish(out);
}

async function step(name, fn) {
  try {
    await within(STEP_MS[name] ?? 60000, fn());
  } catch (e) {
    out[`${name}Error`] = String(e?.stack || e);
  }
}

/** Select each top-level item, then open the PDF in the reader and close it again. */
async function exerciseLibrary() {
  const win = Zotero.getMainWindow();
  const lib = Zotero.Libraries.userLibraryID;
  const ids = await Zotero.Items.getAll(lib, true, false, true);
  out.itemsSelected = 0;
  for (const id of ids.slice(0, 6)) {
    await win.ZoteroPane.selectItem(id);
    out.itemsSelected++;
    await delay(PHASE_MS.library);
  }
  const all = await Zotero.Items.getAll(lib, false, false, false);
  const pdf = all.find((i) => i.isPDFAttachment?.());
  if (!pdf) return;
  mark("reader");
  const reader = await Zotero.Reader.open(pdf.id);
  out.readerOpened = !!reader;
  await delay(PHASE_MS.reader);
  if (reader?.tabID) win.Zotero_Tabs.close(reader.tabID);
}

/** Open Zotero's settings at the plugin's own pane when it registered one. */
async function openPrefs() {
  const panes = (Zotero.PreferencePanes?.pluginPanes ?? []).filter(
    (p) => p.pluginID === out.target,
  );
  out.prefPanes = panes.map((p) => p.id);
  const win = Zotero.Utilities.Internal.openPreferences(panes[0]?.id);
  await delay(PHASE_MS.prefs);
  const prefsWin = win ?? Services.wm.getMostRecentWindow("zotero:pref");
  prefsWin?.close();
}

/**
 * The menus a plugin adds to, opened so menus built on demand fill in: the item and collection
 * context menus and the menu bar, one level of submenus deep.
 */
const MENU_POPUPS = ["zotero-itemmenu", "zotero-collectionmenu"];

async function openedMenus(win) {
  const doc = win.document;
  const popups = [
    ...MENU_POPUPS.map((id) => doc.getElementById(id)),
    ...doc.querySelectorAll("#main-menubar > menu > menupopup"),
  ].filter(Boolean);
  const items = [];
  const visit = async (popup, path, depth) => {
    try {
      popup.openPopupAtScreen(200, 200, true);
    } catch {}
    await delay(400);
    for (const el of popup.children) {
      const label = el.getAttribute("label") || el.id || "";
      if (el.localName === "menuitem" && !el.disabled && !el.hidden)
        items.push({ key: `${path}/${el.id || label}`, label, el, popup });
      else if (el.localName === "menu" && depth < 1 && el.menupopup)
        await visit(el.menupopup, `${path}/${el.id || label}`, depth + 1);
    }
    try {
      popup.hidePopup();
    } catch {}
  };
  for (const popup of popups) await visit(popup, popup.id || popup.parentNode?.id || "menu", 0);
  // Toolbar buttons in the main window (the items toolbar, the tab bar).
  for (const el of doc.querySelectorAll("toolbarbutton")) {
    if (el.hidden || el.disabled || el.closest("menupopup")) continue;
    const label = el.getAttribute("label") || el.getAttribute("tooltiptext") || "";
    if (el.id || label) items.push({ key: `toolbar/${el.id || label}`, label, el, popup: null });
  }
  return items;
}

/**
 * Baseline: record the menu items Zotero has by itself. Test: click each item the plugin added
 * (with the article selected, or the test collection for its menu), one at a time, closing any
 * window or dialog it opens so a modal prompt can't stop the run.
 */
async function exerciseMenus() {
  const win = Zotero.getMainWindow();
  const art = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false, false)).find(
    (i) => i.getField("title") === "Deep learning",
  );
  if (art) await win.ZoteroPane.selectItem(art.id);
  const items = await openedMenus(win);
  if (out.mode === "baseline") {
    await IOUtils.writeJSON(
      env("ATLAS_MENUS_OUT", "/results/menus.json"),
      items.map((i) => i.key),
    );
    return;
  }
  let known;
  try {
    known = new Set(await IOUtils.readJSON("/in/menus.json"));
  } catch {
    out.menusSkipped = "no baseline menu list";
    return;
  }
  const added = items.filter((i) => !known.has(i.key)).slice(0, 20);
  out.menuItems = added.map((i) => i.key);
  out.menuClicks = [];
  for (const item of added) {
    const before = new Set(openWindows());
    if (item.key.startsWith("zotero-collectionmenu")) {
      const coll = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID)[0];
      if (coll) await win.ZoteroPane.collectionsView.selectByID(`C${coll.id}`);
    } else if (art) await win.ZoteroPane.selectItem(art.id);
    // Re-open its menu so the plugin's own popupshowing code sees the selection, then click.
    const fresh = (await openedMenus(win)).find((i) => i.key === item.key);
    const target = fresh?.el ?? item.el;
    // Later, so a modal prompt it opens doesn't block this loop.
    win.setTimeout(() => {
      try {
        target.doCommand();
      } catch (e) {
        out.menuClicks.push({ key: item.key, error: String(e) });
      }
    }, 0);
    await delay(6000);
    const opened = openWindows().filter((w) => !before.has(w));
    out.menuClicks.push({ key: item.key, windows: opened.map((w) => w.document?.documentURI) });
    for (const w of opened) {
      try {
        w.close();
      } catch {}
    }
  }
}

function openWindows() {
  return [...Services.wm.getEnumerator(null)];
}

async function addons() {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  );
  const list = await AddonManager.getAllAddons();
  return list
    .filter((a) => a.type === "extension")
    .map((a) => ({
      id: a.id,
      name: a.name,
      version: a.version,
      isActive: a.isActive,
      appDisabled: a.appDisabled,
      userDisabled: a.userDisabled,
      isCompatible: a.isCompatible,
      rootURI: a.getResourceURI?.("").spec ?? null,
    }));
}

function consoleMessages() {
  return Services.console
    .getMessageArray()
    .slice(-3000)
    .map((m) => {
      const e = m instanceof Ci.nsIScriptError ? m : null;
      return e
        ? {
            message: e.errorMessage,
            source: e.sourceName,
            line: e.lineNumber,
            warning: !!(e.flags & Ci.nsIScriptError.warningFlag),
            category: e.category,
            time: e.timeStamp,
          }
        : { message: m.message, time: m.timeStamp };
    });
}

/**
 * Link check (ATLAS_MODE=links), for Install Link Blocker: tries zotero-plugin-toolkit's two
 * links, by both routes Zotero hands a zotero:// address to its handlers (the window's link
 * handling, and loading the address), with the blocker on, off, disabled and enabled again.
 * An install attempt is recorded and cancelled before anything downloads (its address is on
 * .invalid, which never resolves); the debug link's test code only sets a setting.
 */
const BLOCKER_ID = "install-link-blocker@zoteroplugins.org";
const BLOCKER_PREF = "extensions.install-link-blocker.state";
const RAN_PREF = "extensions.atlas-links.ran";
const INSTALL_LINK = `zotero://plugin/?action=install&url=${encodeURIComponent("https://blocker-test.invalid/test.xpi")}`;
const DEBUG_LINK = `zotero://ztoolkit-debug/?run=${encodeURIComponent(`Zotero.Prefs.set("${RAN_PREF}", "yes", true)`)}&app=atlas-sandbox`;

async function checkLinks() {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  );
  const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
  const attempts = [];
  AddonManager.addInstallListener({
    onNewInstall(install) {
      attempts.push(install.sourceURI?.spec ?? "");
      try {
        install.cancel();
      } catch {}
    },
  });
  const notices = [];
  const onWindow = (win, topic) => {
    if (topic !== "domwindowopened") return;
    win.addEventListener(
      "load",
      () =>
        win.setTimeout(() => {
          if (/progressWindow/.test(win.document.documentURI))
            notices.push(win.document.documentElement.textContent.replace(/\s+/g, " ").trim());
        }, 300),
      { once: true },
    );
  };
  Services.ww.registerNotification(onWindow);
  const table = Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions;
  const shape = (key) => {
    const d = Object.getOwnPropertyDescriptor(table, key);
    return !d ? "none" : d.get ? "accessor" : "value";
  };
  const trial = async (label) => {
    const result = {
      label,
      pref: Services.prefs.getStringPref(BLOCKER_PREF, ""),
      installHandler: shape("zotero://plugin"),
      debugHandler: shape("zotero://ztoolkit-debug"),
    };
    // Loading the address throws once the handler has run (Zotero returns a cancelled channel),
    // so what the handler did is counted either way.
    const route = async (fn) => {
      const before = attempts.length;
      const seen = notices.length;
      let error;
      try {
        fn();
      } catch (e) {
        error = String(e).slice(0, 160);
      }
      await delay(2500);
      return { installAttempts: attempts.length - before, notices: notices.slice(seen), error };
    };
    const pane = Zotero.getMainWindow().ZoteroPane;
    result.installViaWindow = await route(() => pane.loadURI(INSTALL_LINK));
    result.installViaLoad = await route(() =>
      NetUtil.newChannel({ uri: INSTALL_LINK, loadUsingSystemPrincipal: true }),
    );
    Services.prefs.clearUserPref(RAN_PREF);
    const promptsBefore = out.prompts?.length ?? 0;
    result.debugViaWindow = await route(() => pane.loadURI(DEBUG_LINK));
    await delay(1500);
    result.debugRan = Services.prefs.getStringPref(RAN_PREF, "") === "yes";
    result.debugPrompts = (out.prompts?.length ?? 0) - promptsBefore;
    out.linkTrials.push(result);
  };
  out.linkTrials = [];
  const blocker = await AddonManager.getAddonByID(BLOCKER_ID);
  out.blockerPresent = !!blocker?.isActive;
  await trial("as started");
  if (blocker) {
    Services.prefs.setStringPref(BLOCKER_PREF, "off");
    await delay(500);
    await trial("off");
    Services.prefs.setStringPref(BLOCKER_PREF, "on");
    await delay(500);
    await trial("on again");
    await blocker.disable();
    await delay(1500);
    await trial("blocker disabled");
    await blocker.enable();
    await delay(3000);
    await trial("blocker enabled again");
  }
  Services.ww.unregisterNotification(onWindow);
}

/**
 * Click check (ATLAS_MODE=clicks): does a user's click on a toolkit link inside Zotero itself run
 * it, and does anything ask first? The same two links as the link check go in a note (in the item
 * pane's note editor) and on a PDF page (in the reader, beside an ordinary https link as a
 * control). Each user action is a real (trusted) mouse click, measured on its own: the add-on
 * installs that started (each cancelled at once; the address is on .invalid), whether the debug
 * link's test code ran, and every prompt, window and link popup that appeared.
 */
async function checkClicks() {
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  );
  const attempts = [];
  AddonManager.addInstallListener({
    onNewInstall(install) {
      attempts.push(install.sourceURI?.spec ?? "");
      try {
        install.cancel();
      } catch {}
    },
  });
  const windows = [];
  const onWindow = (w, topic) => {
    if (topic !== "domwindowopened") return;
    w.addEventListener(
      "load",
      () =>
        w.setTimeout(() => {
          windows.push({
            uri: w.document.documentURI,
            text: (w.document.documentElement?.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 300),
          });
        }, 300),
      { once: true },
    );
  };
  Services.ww.registerNotification(onWindow);
  const table = Services.io.getProtocolHandler("zotero").wrappedJSObject._extensions;
  out.handlers = {
    install: !!Object.getOwnPropertyDescriptor(table, "zotero://plugin"),
    debug: !!Object.getOwnPropertyDescriptor(table, "zotero://ztoolkit-debug"),
  };
  out.clickTrials = [];

  // Every document in a window, through iframes and browsers.
  const docsOf = (doc, acc = []) => {
    if (!doc) return acc;
    acc.push(doc);
    for (const f of doc.querySelectorAll("iframe, browser")) {
      try {
        docsOf(f.contentDocument, acc);
      } catch {}
    }
    return acc;
  };
  const find = (selector) => {
    for (const d of docsOf(Zotero.getMainWindow().document)) {
      const el = d.querySelector(selector);
      if (el) return el;
    }
    return null;
  };
  const popupText = () =>
    docsOf(Zotero.getMainWindow().document)
      .flatMap((d) => [...d.querySelectorAll(".link-popup, [role='dialog'], [role='tooltip']")])
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => `${el.className}: ${el.textContent.replace(/\s+/g, " ").trim().slice(0, 160)}`)
      .slice(0, 5);
  const realClick = async (el, modifiers) => {
    el.scrollIntoView?.({ block: "center" });
    await delay(400);
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 12);
    const y = r.top + r.height / 2;
    el.ownerGlobal.focus();
    el.ownerGlobal.windowUtils.sendMouseEvent("mousedown", x, y, 0, 1, modifiers);
    el.ownerGlobal.windowUtils.sendMouseEvent("mouseup", x, y, 0, 1, modifiers);
  };
  // One user action, measured on its own.
  const act = async (where, link, how, el, modifiers = 0) => {
    const result = { where, link, how, found: !!el, html: el?.outerHTML?.slice(0, 300) ?? null };
    if (el) {
      Services.prefs.clearUserPref(RAN_PREF);
      const a0 = attempts.length;
      const p0 = out.prompts?.length ?? 0;
      const w0 = windows.length;
      await realClick(el, modifiers);
      await delay(3000);
      result.popups = popupText();
      result.installAttempts = attempts.length - a0;
      result.debugRan = Services.prefs.getStringPref(RAN_PREF, "") === "yes";
      result.prompts = (out.prompts ?? []).slice(p0);
      result.windows = windows.slice(w0);
    }
    out.clickTrials.push(result);
    return result;
  };
  // Close new windows; re-select the note so its editor starts fresh (closing any link popup).
  const win = Zotero.getMainWindow();
  const reset = async (noteID, otherID) => {
    for (const w of [...Services.wm.getEnumerator(null)]) {
      if (w !== win) {
        try {
          w.close();
        } catch {}
      }
    }
    if (noteID) {
      await win.ZoteroPane.selectItem(otherID);
      await delay(1500);
      await win.ZoteroPane.selectItem(noteID);
      await delay(4000);
    }
    await delay(1500);
  };

  const lib = Zotero.Libraries.userLibraryID;
  const art = (await Zotero.Items.getAll(lib, true, false, false)).find(
    (i) => i.getField("title") === "Deep learning",
  );

  // A note with both links, in the item pane's note editor.
  mark("clicks-note");
  const note = new Zotero.Item("note");
  note.setNote(
    `<p><a href="${INSTALL_LINK}">Install link</a></p><p><a href="${DEBUG_LINK}">Debug link</a></p>`,
  );
  note.parentID = art.id;
  await note.saveTx();
  out.noteAsStored = note.getNote();
  for (const [link, prefix] of [
    ["install", "zotero://plugin"],
    ["debug", "zotero://ztoolkit-debug"],
  ]) {
    const inNote = () => find(`.ProseMirror a[href^="${prefix}"]`);
    await reset(note.id, art.id);
    const first = await act("note editor", link, "click on the link", inNote());
    if (first.popups?.length)
      await act(
        "note editor",
        link,
        "then click the address in the link popup",
        find(".link-popup a"),
      );
    await reset(note.id, art.id);
    await act("note editor", link, "ctrl+click on the link", inNote(), 0x02);
  }
  await reset(null);

  // A PDF linking to both, plus an ordinary https link as a control, in the reader.
  mark("clicks-pdf");
  const path = PathUtils.join(PathUtils.tempDir, "links.pdf");
  await IOUtils.write(path, new TextEncoder().encode(linkPdf()));
  const att = await Zotero.Attachments.importFromFile({ file: path, parentItemID: art.id });
  const reader = await Zotero.Reader.open(att.id);
  out.pdfReaderOpened = !!reader;
  await delay(10000);
  const readerDocs = docsOf(win.document);
  out.pdfDocs = readerDocs.map((d) => d.documentURI).filter((u) => /reader|pdf/i.test(u));
  out.pdfTextFound = readerDocs.some((d) =>
    /Install link/.test(d.querySelector(".textLayer")?.textContent ?? ""),
  );
  const sections = readerDocs.flatMap((d) => [
    ...d.querySelectorAll(".annotationLayer section.linkAnnotation"),
  ]);
  out.pdfLinkElements = sections.map((el) => el.outerHTML.slice(0, 240));
  // Zotero's reader handles link clicks itself, by where on the page the click lands, so click the
  // words the link covers (the text layer sits over them) rather than a link element.
  const spans = readerDocs.flatMap((d) => [...d.querySelectorAll(".textLayer span")]);
  for (const [label, link] of [
    ["Install link", "install"],
    ["Debug link", "debug"],
    ["Control link", "https control"],
  ]) {
    const span = spans.find((el) => el.textContent.trim() === label) ?? null;
    await act("PDF reader", link, "click on the link", span);
    await act("PDF reader", link, "ctrl+click on the link", span, 0x02);
    await reset(null);
  }
  if (reader?.tabID) win.Zotero_Tabs.close(reader.tabID);
  Services.ww.unregisterNotification(onWindow);
}

/** A one-page PDF with three link annotations: install link, debug link, an https control. */
function linkPdf() {
  const esc = (t) => t.replace(/[()\\]/g, (c) => `\\${c}`);
  const text =
    "BT /F1 14 Tf 72 700 Td (Install link) Tj ET\nBT /F1 14 Tf 72 650 Td (Debug link) Tj ET\nBT /F1 14 Tf 72 600 Td (Control link) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R 7 0 R 8 0 R] >>",
    `<< /Length ${text.length} >>\nstream\n${text}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /Annot /Subtype /Link /Rect [70 695 220 715] /Border [0 0 1] /A << /S /URI /URI (${esc(INSTALL_LINK)}) >> >>`,
    `<< /Type /Annot /Subtype /Link /Rect [70 645 220 665] /Border [0 0 1] /A << /S /URI /URI (${esc(DEBUG_LINK)}) >> >>`,
    "<< /Type /Annot /Subtype /Link /Rect [70 595 220 615] /Border [0 0 1] /A << /S /URI /URI (https://link-control.invalid/) >> >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

/** The test library: two articles (one with a PDF and a note), a book, a collection, tags. */
async function seed() {
  const coll = new Zotero.Collection();
  coll.name = "Sandbox test";
  await coll.saveTx();

  const art = new Zotero.Item("journalArticle");
  art.setField("title", "Deep learning");
  art.setCreators([
    { firstName: "Yann", lastName: "LeCun", creatorType: "author" },
    { firstName: "Yoshua", lastName: "Bengio", creatorType: "author" },
    { firstName: "Geoffrey", lastName: "Hinton", creatorType: "author" },
  ]);
  for (const [k, v] of [
    ["publicationTitle", "Nature"],
    ["date", "2015-05-28"],
    ["volume", "521"],
    ["issue", "7553"],
    ["pages", "436-444"],
    ["DOI", "10.1038/nature14539"],
    ["url", "https://www.nature.com/articles/nature14539"],
    ["abstractNote", "Deep learning allows computational models to learn representations of data."],
  ])
    art.setField(k, v);
  art.addTag("machine learning");
  art.setCollections([coll.id]);
  await art.saveTx();

  const note = new Zotero.Item("note");
  note.setNote("<p>A test note about <b>deep learning</b>.</p>");
  note.parentID = art.id;
  await note.saveTx();

  await Zotero.Attachments.importFromFile({ file: "/sandbox/test.pdf", parentItemID: art.id });

  const book = new Zotero.Item("book");
  book.setField("title", "The Structure of Scientific Revolutions");
  book.setCreators([{ firstName: "Thomas S.", lastName: "Kuhn", creatorType: "author" }]);
  book.setField("publisher", "University of Chicago Press");
  book.setField("date", "1962");
  book.setField("ISBN", "9780226458083");
  book.addTag("philosophy of science");
  await book.saveTx();

  const zh = new Zotero.Item("journalArticle");
  zh.setField("title", "深度学习研究综述");
  zh.setCreators([{ lastName: "张三", creatorType: "author", fieldMode: 1 }]);
  zh.setField("publicationTitle", "计算机学报");
  zh.setField("date", "2020");
  zh.setField("language", "zh-CN");
  zh.setCollections([coll.id]);
  await zh.saveTx();
}

let finished = false;
async function finish(data) {
  if (finished) return;
  finished = true;
  Services.ww.unregisterNotification(answerPrompts);
  Object.assign(out, data, { endedAt: Date.now(), console: consoleMessages() });
  if (!out.addons) out.addons = await within(5000, addons()).catch(() => out.addonsAtStart ?? []);
  try {
    await IOUtils.writeJSON(env("ATLAS_RESULTS", "/results/harness.json"), out);
  } finally {
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  }
}
