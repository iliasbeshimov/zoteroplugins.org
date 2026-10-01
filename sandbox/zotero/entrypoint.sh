#!/bin/bash
# Runs Zotero once with the harness and (unless seeding or taking a baseline) the plugin in
# /in/target.xpi, in a fresh profile, and leaves everything worth reading in /results.
#   ATLAS_MODE     seed | baseline | test | links (the link check for Install Link Blocker)
#                  | clicks (clicking those links inside a note and a PDF)
#   ATLAS_PROXY    host:port of the logging proxy (the only way out of this container)
#   ATLAS_TIMEOUT  seconds before Zotero is killed
set -u
MODE=${ATLAS_MODE:-test}
PROXY=${ATLAS_PROXY:?}
P=/tmp/profile
D=/tmp/data
R=/results
mkdir -p "$P/extensions" "$D"

# The library the plugin sees: seeded once per Zotero version, then copied for every run.
if [ "$MODE" != seed ] && [ -f /template/data.tar ]; then tar -xf /template/data.tar -C "$D"; fi

# The harness is a directory add-on; the plugin keeps its own file, named by its add-on ID.
printf '%s' /sandbox/harness/ > "$P/extensions/atlas-harness@zoteroplugins.invalid"
TARGET_ID=""
if [ "$MODE" = test ] || [ "$MODE" = links ] || [ "$MODE" = clicks ]; then
  TARGET_ID=$(python3 /sandbox/addon_id.py /in/target.xpi) || { echo '{"error":"no add-on ID"}' > "$R/entry.json"; exit 3; }
  cp /in/target.xpi "$P/extensions/$TARGET_ID.xpi"
fi
# Other add-ons installed beside it (Install Link Blocker, for the link check).
for x in /in/extra/*.xpi; do
  [ -f "$x" ] && cp "$x" "$P/extensions/$(python3 /sandbox/addon_id.py "$x").xpi"
done

HOST=${PROXY%:*}
PORT=${PROXY#*:}
cat > "$P/prefs.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$D");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.reportTranslationFailure", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.update.enabled", false);
user_pref("extensions.getAddons.cache.enabled", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("app.update.disabledForTesting", true);
user_pref("toolkit.telemetry.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
user_pref("devtools.console.stdout.chrome", true);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("network.proxy.type", 1);
user_pref("network.proxy.http", "$HOST");
user_pref("network.proxy.http_port", $PORT);
user_pref("network.proxy.ssl", "$HOST");
user_pref("network.proxy.ssl_port", $PORT);
user_pref("network.proxy.share_proxy_settings", true);
user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1");
PREFS
# The click check answers prompts itself, so they open as their own windows rather than inside the
# main window (how a prompt is shown, not whether it is).
[ "$MODE" = clicks ] && echo 'user_pref("prompts.windowPromptSubDialog", false);' >> "$P/prefs.js"
cp "$P/prefs.js" "$R/prefs.before.js"

# The proxy decrypts HTTPS so the log shows paths, not only host names; trusted in this profile only.
certutil -N -d "sql:$P" --empty-password
certutil -A -n atlas-sandbox-proxy -t "C,," -i /sandbox/proxy-ca.pem -d "sql:$P"

[ -f "$D/zotero.sqlite" ] && sqlite3 "$D/zotero.sqlite" .schema > "$R/schema.before.sql"

# Programs it starts get the proxy too; give the monitor a moment to attach first.
export HTTP_PROXY="http://$PROXY" HTTPS_PROXY="http://$PROXY" ALL_PROXY="http://$PROXY"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" NO_PROXY=localhost,127.0.0.1
export ATLAS_MODE="$MODE" ATLAS_TARGET_ID="$TARGET_ID" ATLAS_RESULTS="$R/harness.json"
export MOZ_CRASHREPORTER_DISABLE=1 DISPLAY=:99
sleep 3
Xvfb :99 -screen 0 1400x900x24 -nolisten tcp > /dev/null 2>&1 &
sleep 1

start=$(date +%s)
timeout --kill-after=10 "${ATLAS_TIMEOUT:-240}" /opt/zotero/zotero -profile "$P" -no-remote \
  -datadir "$D" -ZoteroDebugText > "$R/zotero.log" 2>&1
status=$?
end=$(date +%s)

cp "$P/prefs.js" "$R/prefs.after.js" 2> /dev/null
if [ -f "$D/zotero.sqlite" ]; then
  sqlite3 "$D/zotero.sqlite" .schema > "$R/schema.after.sql"
  sqlite3 "$D/zotero.sqlite" "SELECT 'items', COUNT(*) FROM items UNION ALL SELECT 'collections', COUNT(*) FROM collections UNION ALL SELECT 'tags', COUNT(*) FROM tags;" > "$R/counts.after.txt"
fi
[ "$MODE" = seed ] && tar -cf "$R/data.tar" -C "$D" .
printf '{"mode":"%s","targetId":"%s","exit":%d,"seconds":%d,"start":%d,"end":%d}\n' \
  "$MODE" "$TARGET_ID" "$status" "$((end - start))" "$start" "$end" > "$R/entry.json"
