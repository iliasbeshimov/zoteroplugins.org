# zoteroatlas.com/api/v1

The server behind the plugin's "Send my plugin list" choice: a Cloudflare Worker with a D1
database. All of it is in `worker.js`; the tables are in `schema.sql`.

What it stores, per reporting install: the random ID the plugin made, the Zotero version, the
operating system, the plugin's version, and the installed plugins (ID, version, enabled),
replaced on every report; and the date and reason of every report (`events`). Nothing else from
the request is kept: no IP address, no user agent. Cloudflare, which runs the Worker, sees
requests like any web host; we keep none of that. The nightly job deletes all of it for an install
not heard from for 180 days. `DELETE /api/v1/plugins/<id>` (sent when the user picks "Don't send";
uninstalling sends nothing) removes all of it at once.

Published: `GET /api/v1/totals.json`, how many installs reported in the last 30 days and how many
of them have each plugin. Only counts.

Deploy:

```sh
cd server
wrangler d1 create zotero-atlas            # paste the database_id into wrangler.toml
wrangler d1 execute zotero-atlas --remote --file schema.sql
wrangler deploy
```
