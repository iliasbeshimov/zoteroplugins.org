/**
 * zoteroatlas.com/api/v1: the opt-in usage data from the Zotero Atlas plugin.
 *
 * - POST   /api/v1/plugins        one report: a random ID, Zotero version, OS, plugin version,
 *                                 and the installed plugins (ID, version, enabled). Replaces
 *                                 what was known for that ID.
 * - DELETE /api/v1/plugins/<id>   forget everything about that ID.
 * - GET    /api/v1/totals.json    how many installs reported in the last 30 days, and how many
 *                                 of them have each plugin. Public, cached for an hour.
 *
 * Nothing from the request but the validated body is stored: no IP address, no user agent, no
 * headers. Cloudflare, which runs this, sees the request like any web host; we keep none of it.
 * Each report's date and reason go in `events`. Installs not heard from for 180 days are deleted
 * nightly, with their plugin lists and events.
 */

const MAX_BODY = 64 * 1024;
const MAX_PLUGINS = 400;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENTS = new Set(["first-run", "changed", "weekly"]);
const OS = new Set(["windows", "mac", "linux"]);
const MIN_GAP_MS = 10 * 60 * 1000;

const str = (v, max) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const reply = (status, body, headers = {}) =>
  new Response(body ?? null, { status, headers: { "Cache-Control": "no-store", ...headers } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (request.method === "GET" && path === "/api/v1/totals.json") return totals(env);
    if (request.method === "POST" && path === "/api/v1/plugins") return report(request, env);
    const m = path.match(/^\/api\/v1\/plugins\/([0-9a-f-]{36})$/);
    if (request.method === "DELETE" && m) return forget(m[1], env);
    return reply(404, "Not found");
  },

  // Everything about an install not heard from for 180 days. events has no foreign key, and
  // plugins is cleared here too rather than relying on the cascade.
  async scheduled(_event, env) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM installs WHERE last_seen < datetime('now', '-180 days')"),
      env.DB.prepare("DELETE FROM plugins WHERE install_id NOT IN (SELECT id FROM installs)"),
      env.DB.prepare("DELETE FROM events WHERE install_id NOT IN (SELECT id FROM installs)"),
    ]);
  },
};

/** The body, validated field by field, or null. Unknown fields are dropped. */
function parse(body) {
  if (!body || typeof body !== "object") return null;
  const id = str(body.id, 36);
  if (!id || !ID_RE.test(id)) return null;
  const event = str(body.event, 20);
  if (!event || !EVENTS.has(event)) return null;
  const os = str(body.os, 10);
  if (!os || !OS.has(os)) return null;
  const zotero = str(body.zotero, 40);
  const atlas = str(body.atlas, 40);
  if (!zotero || !atlas || !Array.isArray(body.plugins) || body.plugins.length > MAX_PLUGINS)
    return null;
  const plugins = [];
  const seen = new Set();
  for (const p of body.plugins) {
    const pid = p && str(p.id, 200);
    if (!pid || seen.has(pid) || typeof p.enabled !== "boolean") return null;
    seen.add(pid);
    plugins.push({ id: pid, version: str(p.version, 100) ?? "", enabled: p.enabled });
  }
  return { id, event, os, zotero, atlas, plugins };
}

async function report(request, env) {
  // A web page can't send this: browsers add Origin to cross-site requests, the plugin doesn't.
  if (request.headers.get("Origin")) return reply(403, "Forbidden");
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY) return reply(413, "Too large");
  const text = await request.text();
  if (text.length > MAX_BODY) return reply(413, "Too large");
  let body;
  try {
    body = parse(JSON.parse(text));
  } catch (_e) {
    body = null;
  }
  if (!body) return reply(400, "Bad request");

  const now = new Date().toISOString();
  const last = await env.DB.prepare("SELECT last_seen FROM installs WHERE id = ?1")
    .bind(body.id)
    .first("last_seen");
  // The plugin sends at most a few reports a week; anything faster is a bug or a replay. 429, not
  // a success: the plugin keeps a report it couldn't deliver and sends it at the next check.
  if (last && body.event !== "first-run" && Date.now() - Date.parse(last) < MIN_GAP_MS)
    return reply(429, "Too soon");

  // Four statements whatever the number of plugins: D1 limits queries per request on the free
  // plan, so the plugin list goes in as one JSON array.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO installs (id, first_seen, last_seen, zotero, os, atlas) VALUES (?1, ?2, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, zotero = excluded.zotero, os = excluded.os, atlas = excluded.atlas",
    ).bind(body.id, now, body.zotero, body.os, body.atlas),
    env.DB.prepare("DELETE FROM plugins WHERE install_id = ?1").bind(body.id),
    env.DB.prepare(
      "INSERT INTO plugins (install_id, addon_id, version, enabled) " +
        "SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.version'), json_extract(value, '$.enabled') " +
        "FROM json_each(?2)",
    ).bind(
      body.id,
      JSON.stringify(
        body.plugins.map((p) => ({ id: p.id, version: p.version, enabled: p.enabled ? 1 : 0 })),
      ),
    ),
    env.DB.prepare("INSERT INTO events (at, install_id, event) VALUES (?1, ?2, ?3)").bind(
      now,
      body.id,
      body.event,
    ),
  ]);
  return reply(204);
}

async function forget(id, env) {
  if (!ID_RE.test(id)) return reply(400, "Bad request");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugins WHERE install_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM events WHERE install_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM installs WHERE id = ?1").bind(id),
  ]);
  return reply(204);
}

async function totals(env) {
  const installs = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM installs WHERE last_seen > datetime('now', '-30 days')",
  ).first("n");
  const rows = await env.DB.prepare(
    "SELECT p.addon_id AS id, COUNT(*) AS n, SUM(p.enabled) AS enabled FROM plugins p " +
      "JOIN installs i ON i.id = p.install_id WHERE i.last_seen > datetime('now', '-30 days') " +
      "GROUP BY p.addon_id ORDER BY n DESC",
  ).all();
  const plugins = {};
  for (const r of rows.results) plugins[r.id] = { installs: r.n, enabled: r.enabled };
  return reply(
    200,
    JSON.stringify({ generatedAt: new Date().toISOString(), window: "30 days", installs, plugins }),
    {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  );
}
