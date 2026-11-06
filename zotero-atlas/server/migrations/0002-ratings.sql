-- 2026-11: ratings and reviews, and removed plugins remembered for 30 days.
-- Run once on the live database: wrangler d1 execute zotero-atlas --remote --file migrations/0002-ratings.sql
ALTER TABLE plugins ADD COLUMN first_seen TEXT;
ALTER TABLE plugins ADD COLUMN removed_at TEXT;
-- Rows from before this have only the install's first report to go on.
UPDATE plugins SET first_seen = (SELECT first_seen FROM installs WHERE installs.id = plugins.install_id)
  WHERE first_seen IS NULL;

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
