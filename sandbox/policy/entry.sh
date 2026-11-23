#!/bin/bash
# Policy test, inside the container: phase 1 (no policy) loads "pre"; phase 2 puts policies.json
# in place, sideloads more, and the harness tries installs. Same profile for both phases.
set -u
P=/tmp/profile; D=/tmp/data; R=/results
mkdir -p "$P/extensions" "$D"
[ -f /template/data.tar ] && tar -xf /template/data.tar -C "$D"
printf '%s' /policy/harness/ > "$P/extensions/policy-harness@zoteroplugins.invalid"
cat > "$P/prefs.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$D");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.update.enabled", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("devtools.console.stdout.chrome", true);
user_pref("browser.dom.window.dump.enabled", true);
PREFS
export MOZ_CRASHREPORTER_DISABLE=1 DISPLAY=:99
Xvfb :99 -screen 0 1400x900x24 -nolisten tcp > /dev/null 2>&1 &
sleep 1
(cd /in/plugins && python3 -m http.server 8099 --bind 127.0.0.1 > /dev/null 2>&1 &)
rm -f /opt/zotero/distribution/policies.json

[ -f /in/flag-p1policy ] && cp /in/policy.json /opt/zotero/distribution/policies.json
# Phase 1: no policy (unless flag-p1policy); "pre" is sideloaded and loads.
cp /in/plugins/pre.xpi "$P/extensions/pre@policytest.invalid.xpi"
cp /in/plugins/bpre.xpi "$P/extensions/bpre@policytest.invalid.xpi"
POLICY_PHASE=1 POLICY_OUT=$R/phase1.json timeout --kill-after=10 90 /opt/zotero/zotero -profile "$P" -no-remote -datadir "$D" -ZoteroDebugText > "$R/zotero1.log" 2>&1
echo "phase1 exit $?" > $R/status.txt
ls -la "$P/extensions" > "$R/ext-after-phase1.txt"

# Phase 2: policy (if any) + sideload.
if [ -f /in/policy.json ]; then
  cp /in/policy.json /opt/zotero/distribution/policies.json
fi
cp /in/plugins/side.xpi "$P/extensions/side@policytest.invalid.xpi"
cp /in/plugins/bside.xpi "$P/extensions/bside@policytest.invalid.xpi"
[ -f /in/flag-rescan ] && rm -f "$P/extensions.json"
ls -la "$P/extensions" > "$R/ext-before-phase2.txt"
POLICY_PHASE=2 POLICY_OUT=$R/phase2.json timeout --kill-after=10 150 /opt/zotero/zotero -profile "$P" -no-remote -datadir "$D" -ZoteroDebugText > "$R/zotero2.log" 2>&1
echo "phase2 exit $?" >> $R/status.txt
ls -la "$P/extensions" > "$R/ext-after-phase2.txt"
cp "$P/extensions.json" "$R/extensions.json" 2>/dev/null
[ -f /opt/zotero/distribution/policies.json ] && cp /opt/zotero/distribution/policies.json "$R/policies.used.json"

# Phase 3: restart with the same policy, no new actions: what survived?
POLICY_PHASE=3 POLICY_OUT=$R/phase3.json timeout --kill-after=10 90 /opt/zotero/zotero -profile "$P" -no-remote -datadir "$D" -ZoteroDebugText > "$R/zotero3.log" 2>&1
echo "phase3 exit $?" >> $R/status.txt
ls -la "$P/extensions" > "$R/ext-after-phase3.txt"
