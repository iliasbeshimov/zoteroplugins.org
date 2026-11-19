/* global Zotero, Services, ChromeUtils, IOUtils */
/*
 * Zotero Atlas's walk-through in the sandbox (sandbox/run.sh atlas). Beside Atlas and the test
 * plugins from sandbox/atlas/prepare.py, it answers the first-run screen (one question, holding
 * updates; sharing starts on without one, and the first report is answered by the sandbox proxy,
 * so it never reaches zoteroatlas.com), lets Zotero check for updates (one is graded lower in the
 * test catalogue, so Atlas holds it), and takes pictures of what Atlas adds: the button and its
 * dot, the bar, the Tools menu, Tools → Plugins, and the Atlas window, About last, where it
 * unticks "Share my plugin list". Pictures go to /results/shots, what it saw to
 * /results/atlas.json. Then it tells the harness it's done.
 */
const XHTML = "http://www.w3.org/1999/xhtml";
const ADDONS = "chrome://mozapps/content/extensions/aboutaddons.html";
const SHOTS = "/results/shots";
const out = { steps: [], errors: [] };

// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function install() {}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function uninstall() {}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function shutdown() {}

// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function startup() {
  // What Atlas "remembers" from before: Delete Item with Attachment was at 0.5.0 last time, so
  // it shows as updated, with a way back.
  Services.prefs.setStringPref(
    "extensions.zotero-atlas.state",
    JSON.stringify({
      ...state(),
      seen: {
        "delitemwithatt@redleaf.me": {
          grade: "A",
          version: "0.5.1",
          slug: "delitemwithatt",
          name: "Delete Item with Attachment",
          installed: "0.5.0",
        },
      },
    }),
  );
  run()
    .catch((e) => out.errors.push(String(e?.stack || e)))
    .finally(done);
}

const delay = (ms) =>
  new Promise((r) =>
    ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(r, ms),
  );
const step = (s) => {
  out.steps.push({ s, at: Date.now() });
  Zotero.debug(`[atlas-driver] ${s}`);
};

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = fn();
      if (v) return v;
    } catch (_e) {
      // not yet
    }
    await delay(250);
  }
  return null;
}

function windowAt(part) {
  for (const w of Services.wm.getEnumerator(null))
    if (w.location?.href?.includes(part) && !w.closed) return w;
  return null;
}

async function snap(win, name) {
  try {
    const w = win.innerWidth;
    const h = win.innerHeight;
    const canvas = win.document.createElementNS(XHTML, "canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawWindow(
      win,
      0,
      0,
      w,
      h,
      "rgb(255,255,255)",
      ctx.DRAWWINDOW_DRAW_VIEW | ctx.DRAWWINDOW_USE_WIDGET_LAYERS,
    );
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    await IOUtils.write(`${SHOTS}/${name}.png`, new Uint8Array(await blob.arrayBuffer()));
    step(`shot ${name} ${w}x${h}`);
  } catch (e) {
    out.errors.push(`snap ${name}: ${e}`);
  }
}

/** The whole screen (menus included), from Xvfb's framebuffer file: XWD, 32 bits a pixel. */
async function snapScreen(name) {
  try {
    const buf = await IOUtils.read("/tmp/fb/Xvfb_screen0");
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const f = (i) => dv.getUint32(i * 4, false);
    const [headerSize, width, height, bpp, bpl, ncolors] = [f(0), f(4), f(5), f(11), f(12), f(19)];
    const lsb = f(7) === 0;
    const start = headerSize + ncolors * 12;
    const win = Zotero.getMainWindow();
    const canvas = win.document.createElementNS(XHTML, "canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);
    const px = bpp / 8;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = start + y * bpl + x * px;
        const p = (y * width + x) * 4;
        img.data[p] = lsb ? buf[o + 2] : buf[o + 1];
        img.data[p + 1] = lsb ? buf[o + 1] : buf[o + 2];
        img.data[p + 2] = lsb ? buf[o] : buf[o + 3];
        img.data[p + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    await IOUtils.write(`${SHOTS}/${name}.png`, new Uint8Array(await blob.arrayBuffer()));
    step(`screen ${name}`);
  } catch (e) {
    out.errors.push(`screen ${name}: ${e}`);
  }
}

const state = () => JSON.parse(Services.prefs.getStringPref("extensions.zotero-atlas.state", "{}"));

async function run() {
  await Zotero.uiReadyPromise;
  await IOUtils.makeDirectory(SHOTS, { ignoreExisting: true });
  out.zotero = Zotero.version;

  // 1. A new install: one question on the first-run screen, holding updates (ticked); nothing
  // about sharing, which starts on by itself. Done keeps the tick. The first report goes with
  // the first check (answered by the sandbox proxy, not passed on).
  const A = await waitFor(() => Zotero.ZoteroAtlas, 10000);
  out.prefsBefore = {
    usage: Services.prefs.getStringPref("extensions.zotero-atlas.usage", ""),
    updates: Services.prefs.getStringPref("extensions.zotero-atlas.updates", ""),
  };
  const fr = await waitFor(() => windowAt("firstrun.xhtml"), 30000);
  out.firstRun = Boolean(fr);
  if (fr) {
    await delay(1200);
    await snap(fr, "01-first-run");
    const d = fr.document;
    const text = d.body.textContent.replace(/\s+/g, " ");
    out.firstRunScreen = {
      holdTicked: d.getElementById("hold")?.checked,
      inputs: d.querySelectorAll("input").length,
      mentionsSharing: /plugin list|send|shar/i.test(text),
    };
    d.getElementById("done").click();
  }
  await delay(1500);
  out.prefs = {
    usage: Services.prefs.getStringPref("extensions.zotero-atlas.usage", ""),
    updates: Services.prefs.getStringPref("extensions.zotero-atlas.updates", ""),
  };
  out.firstReport = Boolean(await waitFor(() => state().sentAt, 40000));
  out.idAfterReport = A.usage.id();

  // 2. Zotero checks for plugin updates; ZotMoov 1.2.34 is graded lower in the test catalogue.
  step("update check");
  Services.prefs.setBoolPref("extensions.update.enabled", true);
  await A.review(false);
  const { AddonManagerPrivate } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  );
  await AddonManagerPrivate.backgroundUpdateCheck();
  out.held = await waitFor(() => state().held?.["zotmoov@wileyy.com"], 90000);
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  );
  out.zotmoovAfterCheck = (await AddonManager.getAddonByID("zotmoov@wileyy.com"))?.version;
  await A.review(false);
  await delay(2000);

  // 3. The main window: the button and its dot, the bar.
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const popup = doc.getElementById("menu_ToolsPopup");
  const kids = [...popup.children];
  const menu = doc.getElementById("zotero-atlas-menu");
  out.menu = {
    present: Boolean(menu),
    afterPlugins: kids[kids.indexOf(menu) - 1]?.id === "menu_addons",
    label: menu?.getAttribute("label"),
    image: menu?.getAttribute("image"),
  };
  const tb = doc.getElementById("zotero-atlas-tb");
  out.button = {
    present: Boolean(tb),
    beforeSync: tb?.nextElementSibling?.id,
    attention: tb?.getAttribute("attention"),
    tooltip: tb?.getAttribute("tooltiptext"),
    width: tb?.getBoundingClientRect().width,
  };
  const banner = doc.getElementById("zotero-atlas-banner-container");
  out.banner = {
    shown: banner && banner.getAttribute("collapsed") !== "true",
    text: doc.getElementById("zotero-atlas-banner")?.textContent,
  };
  await snap(win, "02-main-window");

  // 4. The Tools menu, opened.
  try {
    popup.parentNode.open = true;
    await delay(1200);
    await snapScreen("03-tools-menu");
    popup.parentNode.open = false;
  } catch (e) {
    out.errors.push(`menu: ${e}`);
  }

  // 5. Tools → Plugins.
  step("plugins window");
  Zotero.openInViewer(ADDONS, { onLoad: win.ZoteroStandalone?.updateAddonsPane });
  const viewer = await waitFor(() => windowAt("basicViewer"), 10000);
  await delay(5000);
  if (viewer) {
    const pdoc = viewer.document.querySelector("browser")?.contentDocument;
    out.plugins = {
      find: Boolean(pdoc?.querySelector(".zotero-atlas-find")),
      pills: [...(pdoc?.querySelectorAll("addon-card") || [])].map((c) => ({
        id: c.addon?.id,
        pill: c.querySelector(".zotero-atlas-grade")?.textContent ?? null,
        line: c.querySelector(".zotero-atlas-line .text")?.textContent ?? null,
      })),
    };
    await snap(viewer, "04-plugins-window");
    viewer.close();
  }

  // 6. The Atlas window, on Your plugins; going back, asked in place; then Find plugins.
  step("atlas window");
  A.openWindow("mine");
  const aw = await waitFor(() => windowAt("zotero-atlas/content/atlas.xhtml"), 10000);
  await delay(5000);
  if (aw) {
    await snap(aw, "05-your-plugins");
    // A rating's message, built in the Atlas window but not sent: the scrambled ID needs
    // crypto.subtle there, which only a real Zotero shows.
    try {
      const body = await A.ratings.payload(
        {
          slug: "delitemwithatt",
          addon: "delitemwithatt@redleaf.me",
          version: "0.5.1",
          stars: 5,
          text: "",
        },
        aw,
      );
      out.rating = { rater: /^[0-9a-f]{64}$/.test(body.rater), fields: Object.keys(body).sort() };
    } catch (e) {
      out.rating = { error: String(e) };
    }
    const back = [...aw.document.querySelectorAll("button.linkish")].find((b) =>
      /^Go back to/.test(b.textContent),
    );
    out.goBack = back?.textContent ?? null;
    if (back) {
      back.click();
      await delay(600);
      await snap(aw, "06-go-back-asked");
    }
    const scroller = aw.document.getElementById("mine");
    scroller.scrollTop = scroller.scrollHeight;
    await delay(500);
    await snap(aw, "07-your-plugins-bottom");
    aw.document.getElementById("tab-find").click();
    await delay(4000);
    await snap(aw, "08-find-plugins");
    out.dotAfterLooking = tb?.getAttribute("attention") ?? null;
    await findViews(aw);
    await removing(aw);
    await about(aw, A);
    aw.close();
    // Closing the window deletes what was removed in it; then it's listed to rate.
    await delay(3000);
    out.remove.afterClose = {
      gone: (await AddonManager.getAddonByID("delitemwithatt@redleaf.me")) === null,
      zotmoov: Boolean(await AddonManager.getAddonByID("zotmoov@wileyy.com")),
    };
    A.openWindow("mine");
    const again = await waitFor(() => windowAt("zotero-atlas/content/atlas.xhtml"), 10000);
    if (again) {
      await delay(4000);
      const gone = again.document.getElementById("gone");
      out.remove.afterClose.listed = gone.textContent.includes("Item With Attachment");
      gone.scrollIntoView();
      await delay(400);
      await snap(again, "12-removed-listed");
      again.close();
    }
  }

  // 7. "Turn it off" from the bar.
  step("turn it off");
  const off = [...(doc.getElementById("zotero-atlas-banner")?.querySelectorAll("a") || [])].find(
    (a) => a.textContent === "Turn it off",
  );
  if (off) {
    off.click();
    await delay(3000);
    out.labToolsAfter = (await AddonManager.getAddonByID("lab-tools@example.org"))?.isActive;
  }
  await delay(2000);
  await snap(win, "09-main-after");
}

/**
 * Find plugins: Discover scrolled down, a search, a plugin's page and its install sheet
 * (cancelled: nothing is installed), a pack, Escape going back, and the narrowest window.
 */
async function findViews(aw) {
  const d = aw.document;
  const F = aw.zoteroAtlasFind;
  const fs = d.getElementById("find");
  const texts = (sel, n = 12) => [...d.querySelectorAll(sel)].slice(0, n).map((x) => x.textContent);
  const icons = () => {
    const imgs = [...d.querySelectorAll("#fview img.icon")];
    return {
      img: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    };
  };
  out.find = {
    shelves: texts(".shelf-head h2"),
    picks: texts(".pick .sname"),
    used: texts(".cols .sname"),
    tiles: d.querySelectorAll("#fview .icon.tile").length,
    icons: icons(),
  };
  step("find: scroll");
  fs.scrollTop = 760;
  await delay(1500);
  await snap(aw, "08b-find-shelves");
  fs.scrollTop = fs.scrollHeight;
  await delay(1500);
  await snap(aw, "08c-find-bottom");

  step("find: search");
  const q = d.getElementById("q");
  q.value = "translate pdfs";
  q.dispatchEvent(new aw.Event("input"));
  await delay(2500);
  await snap(aw, "08d-search");
  const top = async (text) => {
    q.value = text;
    q.dispatchEvent(new aw.Event("input"));
    await delay(400);
    return texts(".rrow .rname", 4);
  };
  out.find.searches = {};
  for (const text of ["find duplicates", "cite in word", "summarise a paper", "better notes"])
    out.find.searches[text] = await top(text);
  q.value = "translate pdfs";
  q.dispatchEvent(new aw.Event("input"));
  await delay(800);
  out.find.search = {
    view: F.view.name,
    count: d.querySelector(".count-line")?.textContent,
    first: texts(".rrow .rname", 6),
  };

  step("find: plugin page");
  F.showPlugin("zotero-pdf-translate");
  await delay(2500);
  await snap(aw, "08e-plugin-page");
  fs.scrollTop = 640;
  await delay(800);
  await snap(aw, "08f-plugin-page-lower");
  const hero = d.querySelector(".hero .ibtn");
  out.find.plugin = { title: d.querySelector(".who h1")?.textContent, button: hero?.textContent };
  if (hero && !hero.disabled) {
    hero.click();
    await delay(800);
    await snap(aw, "08g-install-sheet");
    out.find.sheet = d.getElementById("sheet")?.textContent?.slice(0, 500) ?? null;
    out.find.sheetFocus = d.activeElement?.textContent ?? null;
    d.querySelector(".sheet-act button")?.click(); // Cancel
    await delay(400);
    out.find.sheetClosed = d.getElementById("sheet")?.hidden ?? null;
  }

  step("find: back");
  F.home();
  await delay(800);
  d.querySelector(".pack-link")?.click();
  await delay(2500);
  await snap(aw, "08h-pack");
  out.find.pack = {
    title: d.querySelector(".pack-head h1")?.textContent,
    rows: texts(".pk-row .sname", 8),
    bar: d.querySelector(".pack-bar")?.textContent,
  };
  F.escape({ target: d.body });
  await delay(600);
  out.find.afterEscape = F.view.name;

  step("find: narrow");
  aw.resizeTo(600, aw.outerHeight);
  await delay(1500);
  F.home();
  await delay(2000);
  await snap(aw, "08i-narrow");
  fs.scrollTop = 820;
  await delay(1000);
  await snap(aw, "08j-narrow-lower");
  F.showPlugin("zoplicate");
  await delay(2000);
  await snap(aw, "08k-narrow-plugin");
  out.find.iconsEnd = icons();
}

const d0 = (root, text) =>
  [...(root?.querySelectorAll("button") || [])].find((b) => b.textContent === text) || null;

/**
 * Your plugins: Turn off and on; then Remove… on Del Item With Attachment: Cancel, Escape, Remove
 * and Undo, Remove and Done (its line keeps Undo; Zotero deletes it when the window closes, after
 * About). Lab Tools from its Needs you card: removed, its setting is deleted at once (it deletes
 * it in uninstall), and Undo brings the plugin back but not the setting.
 */
async function removing(aw) {
  const d = aw.document;
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs",
  );
  const DEL = "delitemwithatt@redleaf.me";
  const addon = () => AddonManager.getAddonByID(DEL);
  const pending = (a) => Boolean(a && a.pendingOperations & AddonManager.PENDING_UNINSTALL);
  const row = () =>
    [...d.querySelectorAll("#all .prow")].find((r) => /Item With Attachment/i.test(r.textContent));
  const acts = () =>
    [...(row()?.querySelectorAll(".pacts button") || [])].map((b) => b.textContent);
  const sheet = () => d.querySelector(".sheet-back:not(#sheet) .sheet");
  const sheetButtons = () =>
    [...(sheet()?.querySelectorAll(".sheet-act button") || [])].map((b) => b.textContent);
  const openAll = () => {
    const all = d.querySelector("#all details");
    if (all) all.open = true;
  };
  step("remove");
  aw.resizeTo(1000, aw.outerHeight);
  d.getElementById("tab-mine").click();
  await delay(1500);
  openAll();
  out.remove = { acts: acts() };
  const r = out.remove;

  d0(row(), "Turn off")?.click();
  await delay(3000);
  openAll();
  r.off = {
    active: (await addon())?.isActive,
    acts: acts(),
    ver: row()?.querySelector(".ver")?.textContent,
  };
  d0(row(), "Turn on")?.click();
  await delay(3000);
  openAll();
  r.on = { active: (await addon())?.isActive, acts: acts() };

  // Asked first; Cancel and Escape change nothing.
  row()?.scrollIntoView();
  d0(row(), "Remove…")?.click();
  await delay(600);
  r.ask = {
    title: sheet()?.querySelector("h2")?.textContent,
    text: [...(sheet()?.querySelectorAll("p") || [])].map((p) => p.textContent),
    buttons: sheetButtons(),
    focus: d.activeElement?.textContent,
  };
  await snap(aw, "11-remove-ask");
  d0(sheet(), "Cancel")?.click();
  await delay(600);
  r.cancel = { sheet: Boolean(sheet()), active: (await addon())?.isActive };
  d0(row(), "Remove…")?.click();
  await delay(500);
  sheet()?.dispatchEvent(new aw.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await delay(600);
  r.escape = { sheet: Boolean(sheet()), windowOpen: !aw.closed, pending: pending(await addon()) };

  // Removed: stopped at once, Undo and a rating offered; Undo puts it back.
  d0(row(), "Remove…")?.click();
  await delay(500);
  d0(sheet(), "Remove")?.click();
  await delay(1500);
  let a = await addon();
  r.removed = {
    title: sheet()?.querySelector("h2")?.textContent,
    stars: sheet()?.querySelectorAll(".star").length ?? 0,
    buttons: sheetButtons(),
    pending: pending(a),
    active: a?.isActive,
  };
  await snap(aw, "11b-removed");
  aw.resizeTo(600, aw.outerHeight);
  await delay(800);
  await snap(aw, "11c-removed-narrow");
  aw.resizeTo(1000, aw.outerHeight);
  await delay(500);
  d0(sheet(), "Undo")?.click();
  await delay(3000);
  openAll();
  a = await addon();
  r.undo = { sheet: Boolean(sheet()), pending: pending(a), active: a?.isActive, acts: acts() };

  // Remove, then Done: still there until the window closes, its line showing Undo.
  d0(row(), "Remove…")?.click();
  await delay(500);
  d0(sheet(), "Remove")?.click();
  await delay(1000);
  d0(sheet(), "Done")?.click();
  await delay(3000);
  openAll();
  a = await addon();
  r.done = {
    sheet: Boolean(sheet()),
    pending: pending(a),
    status: d.getElementById("status").textContent,
    ver: row()?.querySelector(".ver")?.textContent,
    acts: acts(),
  };
  row()?.scrollIntoView();
  await delay(400);
  await snap(aw, "11d-removed-line");

  // Lab Tools, from its card: its setting goes at Remove, and Undo doesn't bring it back.
  const SETTING = "extensions.lab-tools.setting";
  const setting = () => Services.prefs.getStringPref(SETTING, "(none)");
  Services.prefs.setStringPref(SETTING, "mine");
  const card = [...d.querySelectorAll("#needs .card")].find((c) =>
    c.textContent.includes("Lab Tools"),
  );
  r.lab = { card: Boolean(card), before: setting() };
  d0(card, "Remove…")?.click();
  await delay(500);
  r.lab.offInstead = sheetButtons().includes("Turn off instead");
  d0(sheet(), "Remove")?.click();
  await delay(1500);
  r.lab.removed = setting();
  r.lab.rating = (sheet()?.querySelectorAll(".star").length ?? 0) > 0;
  d0(sheet(), "Undo")?.click();
  await delay(3000);
  const lab = await AddonManager.getAddonByID("lab-tools@example.org");
  r.lab.undo = { active: lab?.isActive, pending: pending(lab), setting: setting() };

  // About runs at the narrowest window, as before.
  aw.resizeTo(600, aw.outerHeight);
  await delay(800);
}

/** About, at the narrowest window and then wider; then "Share my plugin list" unticked. */
async function about(aw, A) {
  const d = aw.document;
  step("about");
  d.getElementById("tab-about").click();
  await delay(1200);
  const tabs = [...d.querySelectorAll(".tabs .tab")];
  const head = d.querySelector("header").getBoundingClientRect();
  out.about = {
    tabs: tabs.map((t) => t.textContent.trim()),
    tabsFit: tabs.every((t) => t.getBoundingClientRect().right <= head.right),
    width: aw.innerWidth,
    version: d.getElementById("about-version").textContent,
    hold: d.getElementById("hold").checked,
    checked: d.getElementById("share").checked,
    status: d.getElementById("share-status").textContent,
    links: [...d.querySelectorAll("#about a[data-url]")].map((a) => a.dataset.url),
  };
  await snap(aw, "10-about-narrow");
  aw.resizeTo(1000, aw.outerHeight);
  await delay(1200);
  await snap(aw, "10b-about");
  d.getElementById("share-show").click();
  await delay(800);
  out.about.shown = d.getElementById("share-json").textContent.slice(0, 400);
  const page = d.getElementById("about");
  page.scrollTop = page.scrollHeight;
  await delay(500);
  await snap(aw, "10c-about-sent");
  d.getElementById("share").click();
  await delay(3000);
  out.about.after = {
    checked: d.getElementById("share").checked,
    usage: A.usage.choice(),
    id: A.usage.id(),
    status: d.getElementById("share-status").textContent,
    foot: d.getElementById("mine-foot")?.textContent ?? null,
  };
  await snap(aw, "10d-about-off");
}

async function done() {
  try {
    await IOUtils.writeJSON("/results/atlas.json", out);
  } finally {
    Services.prefs.setBoolPref("atlas-sandbox.done", true);
  }
}
