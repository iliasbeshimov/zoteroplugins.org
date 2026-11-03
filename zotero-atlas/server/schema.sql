-- One row per reporting install (a random ID the plugin made), what it last told us about itself.
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  zotero TEXT,
  os TEXT,
  atlas TEXT
);
-- The plugins that install has, as of its last report.
CREATE TABLE IF NOT EXISTS plugins (
  install_id TEXT NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  addon_id TEXT NOT NULL,
  version TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (install_id, addon_id)
);
CREATE INDEX IF NOT EXISTS plugins_addon ON plugins(addon_id);
-- When each install reported, and why (first-run, changed, weekly).
CREATE TABLE IF NOT EXISTS events (
  at TEXT NOT NULL,
  install_id TEXT NOT NULL,
  event TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_install ON events(install_id);
