/* global Zotero, Services, IOUtils, ChromeUtils, Ci, FileUtils */
// Policy-test harness: records AddonManager state, tries installs, writes JSON, quits.
// PHASE=1 (no policy, only loads plugins) or PHASE=2 (policy in place; tries installs).
function install() {}
function uninstall() {}
function shutdown() {}
const env = (k, d) => Services.env.get(k) || d;
const delay = (ms) => new Promise((r) => ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(r, ms));
const out = { phase: env("POLICY_PHASE", "2"), scenario: env("POLICY_SCENARIO", "") , events: []};
const log = (m) => { out.events.push(m); Zotero.debug("[policytest] " + m); dump("[policytest] " + m + "\n"); };

function startup() { run().catch((e) => { out.harnessError = String(e?.stack || e); finish(); }); }

async function finish() {
  try { await IOUtils.writeJSON(env("POLICY_OUT", "/results/out.json"), out); } catch (e) { dump("write failed " + e + "\n"); }
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}

async function snapshot(AddonManager) {
  const list = await AddonManager.getAllAddons();
  return list.filter((a) => a.type === "extension").map((a) => ({
    id: a.id, version: a.version, isActive: a.isActive, appDisabled: a.appDisabled,
    userDisabled: a.userDisabled, blocklistState: a.blocklistState,
    canUninstall: !!(a.permissions & AddonManager.PERM_CAN_UNINSTALL),
    canDisable: !!(a.permissions & AddonManager.PERM_CAN_DISABLE),
    scope: a.scope, startupFlag: Services.prefs.getBoolPref("policytest.started." + a.id, false),
  }));
}

function tryInstall(AddonManager, mk, label) {
  return new Promise(async (resolve) => {
    const rec = { label };
    let done = false;
    const fin = (why) => { if (done) return; done = true; rec.result = why; resolve(rec); };
    try {
      const inst = await mk();
      if (!inst) { rec.nullInstall = true; return fin("getInstall returned null"); }
      rec.stateAfterGet = inst.state; rec.errorAfterGet = inst.error;
      inst.addListener({
        onDownloadFailed(i) { rec.downloadFailed = i.error; fin("onDownloadFailed error=" + i.error); },
        onInstallFailed(i) { rec.installFailed = i.error; fin("onInstallFailed error=" + i.error); },
        onInstallEnded(i, a) { rec.installedId = a?.id; fin("onInstallEnded " + a?.id); },
        onInstallCancelled() { fin("onInstallCancelled"); },
        onInstallBlocked() { fin("onInstallBlocked"); },
      });
      try { await inst.install(); rec.installResolved = true; } catch (e) { rec.installThrew = String(e); }
      rec.stateAfterInstall = inst.state; rec.errorAfterInstall = inst.error;
      setTimeoutish(() => fin("timeout state=" + inst.state + " error=" + inst.error), 15000);
    } catch (e) { rec.threw = String(e?.stack || e); fin("threw"); }
  });
}
function setTimeoutish(f, ms) { ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(f, ms); }

async function run() {
  await Zotero.initializationPromise;
  if (Zotero.uiReadyPromise) await Zotero.uiReadyPromise;
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  await AddonManager.readyPromise;
  out.zotero = Zotero.version;
  out.policiesStatus = Services.policies ? Services.policies.status : "no Services.policies";
  try { out.activePolicies = Services.policies.getActivePolicies(); } catch (e) { out.activePoliciesError = String(e); }
  out.isInstallEnabled = AddonManager.isInstallEnabled("application/x-xpinstall");
  try { out.isInstallAllowed = AddonManager.isInstallAllowed("application/x-xpinstall", Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI("https://example.org/"), {})); } catch (e) { out.isInstallAllowedErr = String(e); }
  await delay(8000);
  out.addonsAtStart = await snapshot(AddonManager);
  if (out.phase === "2") {
    out.installs = [];
    for (const n of ["file", "bfile"]) {
      out.installs.push(await tryInstall(AddonManager, () => AddonManager.getInstallForFile(new FileUtils.File(`/in/plugins/${n}.xpi`), "application/x-xpinstall"), "fromFile:" + n));
    }
    for (const n of ["url", "burl"]) {
      out.installs.push(await tryInstall(AddonManager, () => AddonManager.getInstallForURL(`http://127.0.0.1:8099/${n}.xpi`, { telemetryInfo: { source: "policytest" } }), "fromURL:" + n));
    }
    await delay(5000);
    out.addonsAfterInstalls = await snapshot(AddonManager);
    // Disable / uninstall of an already installed add-on, programmatically (what the Plugins window buttons call).
    const pre = await AddonManager.getAddonByID("pre@policytest.invalid");
    if (pre) {
      try { await pre.disable(); out.disablePre = { userDisabled: pre.userDisabled, isActive: pre.isActive }; } catch (e) { out.disablePre = { threw: String(e) }; }
      try { await pre.enable(); } catch (e) {}
    }
    // The Plugins window: does it open?
    try {
      const w = Services.ww.openWindow(null, "about:addons", "_blank", "chrome,dialog=no,resizable,width=900,height=600", null);
      await delay(6000);
      out.aboutAddons = { documentURI: w.document?.documentURI, title: w.document?.title, readyState: w.document?.readyState, closed: w.closed };
      try { w.close(); } catch (e) {}
    } catch (e) { out.aboutAddons = { threw: String(e) }; }
  }
  out.addonsAtEnd = await snapshot(AddonManager);
  await finish();
}
