# zoteroatlas.com/api/v1

The server behind the plugin's "Share my plugin list" box (ticked from the start since 1.4.0) and
its ratings: a Cloudflare Worker
with a D1 database. The routes are in `worker.js`, its checks and conversions in `lib.js` (tested
by `node --test test.mjs test-guides.mjs`), the tables in `schema.sql`.

**Plugin lists.** Per reporting install: the random ID the plugin made, the Zotero version, the
operating system, the plugin's version, and the installed plugins (ID, version, enabled), replaced
on every report except that a plugin gone from the list is kept, marked removed, for 30 days (so a
rating can say how long it was used); and the date and reason of every report (`events`). Nothing
else from the request is kept: no IP address, no user agent. The nightly job deletes all of it for
an install not heard from for 180 days. `DELETE /api/v1/plugins/<id>` (sent when the user unticks
the box) removes all of it at once; that install's ratings stay, unlinked. Removing Zotero Atlas
sends the same request with `?reason=removed` (from Atlas 1.6.0, only while sharing is on and
Zotero is online): the record is deleted the same way, and one is added to `removals`, a count
per day, plugin version and how long the install was there (day, week, month, longer), with no ID
and no plugin list.

**Ratings and reviews** (`POST /api/v1/ratings` from the plugin; `POST /api/v1/reviews` and
`/api/v1/reviews/confirm` from zoteroplugins.org's form, which confirms an email address by a
link). Per rating: the plugin and version, stars, review text with links removed, the Zotero
version, OS and plugin version, the rater (a slow hash the plugin makes from Zotero's own database
key; for the website, a keyed fingerprint of the confirmed address, which itself is never stored),
the install's ID when it shares its plugin list, and, for 31 days, a code made from the sender's
address with a secret key replaced every month, plus the network operator's name. Never an IP
address, and nothing here logs request headers. Every rating waits as `new` until a separate,
private check publishes, holds or drops it; how fake reviews are spotted isn't published, so it
can't be gamed.

Published: `GET /api/v1/ratings.json`, the published ratings per plugin and version (count,
average, spread) and the reviews with text. The plugin lists are not published in any form; only
the owner reads them, from the database:

```sh
wrangler d1 execute zotero-atlas --remote --command "SELECT COUNT(*) FROM installs WHERE last_seen > datetime('now', '-30 days')"
wrangler d1 execute zotero-atlas --remote --command "SELECT addon_id, COUNT(*) AS n FROM plugins WHERE removed_at IS NULL GROUP BY 1 ORDER BY n DESC"
wrangler d1 execute zotero-atlas --remote --command "SELECT zotero, os, COUNT(*) AS n FROM installs GROUP BY 1, 2 ORDER BY n DESC"
```

**Library guides** (`guides.js`; zoteroplugins.org/librarians/check and the box on /librarians).
`POST /api/v1/guides/check` reads a public guide page and reports on every plugin it links or
names, from zoteroplugins.org/data/guide-index.json; GitHub is asked about repositories the index
doesn't know (renamed ones redirect). `/watch`, `/confirm` and `/stop` run the email alerts: a
watch keeps the guide's address, the email address, the stop link's token and what was last
found, and is deleted by the stop link or after two weeks the guide can't be read. Every 10
minutes the oldest guide not checked for 20 hours is checked; a problem is emailed only when it's
seen on two runs in a row. `GET zoteroplugins.org/api/v1/box.json?pack=…` serves the box's picks
(zoteroplugins.org/data/box.json) and counts views per website by host name only. Owner's view:

```sh
wrangler d1 execute zotero-atlas --remote --command "SELECT host, url, checks, plugins, attention, first_checked FROM guide_reports WHERE checks > 0 ORDER BY first_checked DESC"
wrangler d1 execute zotero-atlas --remote --command "SELECT url, created_at, last_ok, alerts FROM guide_watches"
wrangler d1 execute zotero-atlas --remote --command "SELECT host, SUM(n) AS views FROM box_views GROUP BY host ORDER BY views DESC"
```

Deploy:

```sh
cd server
# a new database
wrangler d1 create zotero-atlas            # paste the database_id into wrangler.toml
wrangler d1 execute zotero-atlas --remote --file schema.sql
# the live database, once per file in migrations/, in order
wrangler d1 execute zotero-atlas --remote --file migrations/0002-ratings.sql
wrangler d1 execute zotero-atlas --remote --file migrations/0003-guides.sql
# website reviews (without these the form answers that reviews aren't open yet)
wrangler secret put TURNSTILE_SECRET       # the zoteroplugins.org Turnstile widget's secret
wrangler secret put EMAIL_KEY              # 64 hex characters, made once and kept
wrangler secret put MAIL_API_KEY           # the mail service's key
# and in wrangler.toml [vars]: MAIL_PROVIDER ("resend" or "postmark") and MAIL_FROM
wrangler deploy
```

Test locally: `wrangler d1 execute zotero-atlas --local --file schema.sql`, then `wrangler dev
--local --test-scheduled` and `curl "http://localhost:8787/__scheduled"` for the nightly job.
