/* global Zotero, Services, ChromeUtils, IOUtils */
/*
 * Zotero Atlas's walk-through in the sandbox (sandbox/run.sh atlas). Beside Atlas and the test
 * plugins from sandbox/atlas/prepare.py, it answers the first-run screen, lets Zotero check for
 * updates (one is graded lower in the test catalogue, so Atlas holds it), and takes pictures of
 * what Atlas adds: the button and its dot, the bar, the Tools menu, Tools → Plugins, and the
 * Atlas window. Pictures go to /results/shots, what it saw to /results/atlas.json. Then it tells
 * the harness it's done.
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

  // 1. The first-run screen: "Don't send" (no sandbox record on zoteroatlas.com), keep holding.
  const fr = await waitFor(() => windowAt("firstrun.xhtml"), 30000);
  out.firstRun = Boolean(fr);
  if (fr) {
    await delay(1200);
    await snap(fr, "01-first-run");
    const d = fr.document;
    out.firstRunDefaults = {
      hold: d.getElementById("hold").checked,
      send: d.getElementById("yes").checked,
    };
    d.getElementById("no").click();
    await delay(300);
    d.getElementById("done").click();
  }
  await delay(1500);
  const A = await waitFor(() => Zotero.ZoteroAtlas, 10000);
  out.prefs = {
    usage: Services.prefs.getStringPref("extensions.zotero-atlas.usage", ""),
    updates: Services.prefs.getStringPref("extensions.zotero-atlas.updates", ""),
  };

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
    await delay(1500);
    await snap(aw, "08-find-plugins");
    out.dotAfterLooking = tb?.getAttribute("attention") ?? null;
    aw.close();
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

async function done() {
  try {
    await IOUtils.writeJSON("/results/atlas.json", out);
  } finally {
    Services.prefs.setBoolPref("atlas-sandbox.done", true);
  }
}
