// "yes" or "no": share the plugin list. Empty only until the first start, which sets "yes";
// an update keeps what was there, "no" included.
pref("extensions.zotero-atlas.usage", "");
// "hold" (updates wait until the directory has checked them) or "off", answered on the first-run
// screen; "ask" until then (not holding). "" is left from before 1.0 and means not holding.
pref("extensions.zotero-atlas.updates", "");
// The random ID made on this computer, only while usage is "yes".
pref("extensions.zotero-atlas.id", "");
// JSON: when the catalogue was fetched, what was last sent, the grades last seen, held updates.
pref("extensions.zotero-atlas.state", "{}");
