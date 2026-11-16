-- 2026-11: library guides (zoteroplugins.org/librarians/check) and the self-updating box.
-- Run once on the live database: wrangler d1 execute zotero-atlas --remote --file migrations/0003-guides.sql

-- The last report for each guide someone checked (guides are public pages). checks: how many
-- times the check was run on the site; nightly runs for watches don't count.
CREATE TABLE IF NOT EXISTS guide_reports (
  url TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  report TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  first_checked TEXT NOT NULL,
  checks INTEGER NOT NULL DEFAULT 0,
  plugins INTEGER NOT NULL DEFAULT 0,
  attention INTEGER NOT NULL DEFAULT 0
);

-- A watch waiting for its confirmation link (24 hours). Only the token's hash is kept.
CREATE TABLE IF NOT EXISTS guide_watch_pending (
  token_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- A confirmed watch: deleted by its stop link, or after two weeks the guide can't be read.
-- snapshot: the problems already emailed and those seen once (see guides.js).
CREATE TABLE IF NOT EXISTS guide_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  email TEXT NOT NULL,
  stop_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_run TEXT,
  last_ok TEXT,
  fails INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL,
  alerts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (url, email)
);
CREATE INDEX IF NOT EXISTS guide_watches_due ON guide_watches (last_run);

-- Daily counts for rate limits, by a keyed code of the network or the address; kept two days.
CREATE TABLE IF NOT EXISTS guide_limits (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (key, day)
);

-- GitHub's answer for repositories a guide links that the catalogue doesn't know: target is the
-- owner/name a renamed or transferred repository now redirects to. Asked again after 30 days.
CREATE TABLE IF NOT EXISTS repo_lookups (
  repo TEXT PRIMARY KEY,
  target TEXT,
  status INTEGER NOT NULL,
  checked_at TEXT NOT NULL
);

-- How often the box was shown, per day, website (its host name only) and pack.
CREATE TABLE IF NOT EXISTS box_views (
  day TEXT NOT NULL,
  host TEXT NOT NULL,
  pack TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, host, pack)
);
