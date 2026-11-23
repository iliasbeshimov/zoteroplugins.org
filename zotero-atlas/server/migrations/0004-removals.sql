-- 2026-11: a count of Zotero Atlas removals, kept when a removed install's record is deleted.
-- Run once on the live database: wrangler d1 execute zotero-atlas --remote --file migrations/0004-removals.sql

-- One row per day, plugin version and how long the install was there (day, week, month, longer).
-- No ID, no plugin list.
CREATE TABLE IF NOT EXISTS removals (
  day TEXT NOT NULL,
  atlas TEXT NOT NULL,
  used TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, atlas, used)
);
