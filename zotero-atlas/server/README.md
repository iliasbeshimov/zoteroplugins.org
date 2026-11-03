# zoteroatlas.com/api/v1

The server behind the plugin's "Send my plugin list" choice: a Cloudflare Worker with a D1
database. All of it is in `worker.js`; the tables are in `schema.sql`.

What it stores, per reporting install: the random ID the plugin made, when it first and last
reported, the Zotero version, the operating system, the plugin's version, and the installed
plugins (ID, version, enabled), replaced on every report. Nothing else from the request is kept:
no IP address, no user agent. Cloudflare, which runs the Worker, sees requests like any web host;
we keep none of that. An install not heard from for 180 days is deleted by the nightly job.

Published: `GET /api/v1/totals.json`, how many installs reported in the last 30 days and how many
of them have each plugin. Only counts.

Deploy:

```sh
cd server
wrangler d1 create zotero-atlas            # paste the database_id into wrangler.toml
wrangler d1 execute zotero-atlas --remote --file schema.sql
wrangler deploy
```
