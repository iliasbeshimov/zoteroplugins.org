-- The whole schema, for a new database. The live one was made from an earlier version and is
-- brought up to date by migrations/ (wrangler d1 execute ... --file migrations/<file>).

-- One row per reporting install (a random ID the plugin made), what it last told us about itself.
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  zotero TEXT,
  os TEXT,
  atlas TEXT
);
-- The plugins that install has, as of its last report. A plugin gone from the list is kept, with
-- removed_at, for 30 days; first_seen is when it first appeared (or reappeared) in the list.
CREATE TABLE IF NOT EXISTS plugins (
  install_id TEXT NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  addon_id TEXT NOT NULL,
  version TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT,
  removed_at TEXT,
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

-- Ratings and reviews. source 'atlas': from the plugin, rater = the scrambled ID of that
-- Zotero. source 'web': from zoteroplugins.org, rater = the fingerprint of the confirmed address.
-- One per rater, plugin and version; rating again replaces it and it's checked again.
-- status: new (not checked yet), published, held (waiting for a person), dropped.
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  rater TEXT NOT NULL,
  slug TEXT NOT NULL,
  addon_id TEXT,
  version TEXT NOT NULL,
  stars INTEGER NOT NULL,
  text TEXT,
  name TEXT,
  zotero TEXT,
  os TEXT,
  atlas TEXT,
  install_id TEXT,
  install_claimed INTEGER NOT NULL DEFAULT 0,
  used_since TEXT,
  used_until TEXT,
  posted_at TEXT NOT NULL,
  first_posted_at TEXT NOT NULL,
  net TEXT,
  net_month TEXT,
  net_org TEXT,
  net_asn INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  reasons TEXT,
  scored_at TEXT,
  UNIQUE (source, rater, slug, version)
);
CREATE INDEX IF NOT EXISTS ratings_status ON ratings(status);
CREATE INDEX IF NOT EXISTS ratings_slug ON ratings(slug);
CREATE INDEX IF NOT EXISTS ratings_net ON ratings(net, posted_at);
CREATE INDEX IF NOT EXISTS ratings_rater ON ratings(rater);
CREATE INDEX IF NOT EXISTS ratings_install ON ratings(install_id);
-- Website reviews waiting for their confirmation link. The link's token is kept only as a hash.
CREATE TABLE IF NOT EXISTS review_pending (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  email_fp TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  stars INTEGER NOT NULL,
  text TEXT,
  name TEXT,
  net TEXT,
  net_month TEXT,
  net_org TEXT,
  net_asn INTEGER
);
CREATE INDEX IF NOT EXISTS review_pending_email ON review_pending(email_fp, created_at);
CREATE INDEX IF NOT EXISTS review_pending_net ON review_pending(net, created_at);
-- The month's secret key for network codes. Deleted with the codes it made, after which they
-- can't be matched to any address.
CREATE TABLE IF NOT EXISTS netkeys (
  month TEXT PRIMARY KEY,
  key TEXT NOT NULL
);
