/* global Services, ADDON_UNINSTALL */
// A made-up plugin that does nothing: Zotero Atlas's walk-through shows how it marks a plugin
// it can't check, and a known security problem. It has one setting, which it deletes when it's
// removed (as some plugins do), so the walk-through can show what Undo brings back and what not.
const SETTING = "extensions.lab-tools.setting";
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function install() {}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function uninstall(_data, reason) {
  if (reason === ADDON_UNINSTALL) Services.prefs.clearUserPref(SETTING);
}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function startup() {
  if (!Services.prefs.prefHasUserValue(SETTING)) Services.prefs.setStringPref(SETTING, "new");
}
// biome-ignore lint/correctness/noUnusedVariables: Zotero calls it
function shutdown() {}
