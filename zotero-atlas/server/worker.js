/**
 * zoteroatlas.com/api/v1: the plugin lists Zotero Atlas sends ("Send my plugin list"), and the
 * ratings and reviews people post.
 *
 * Plugin lists
 * - POST   /api/v1/plugins        one report: a random ID, Zotero version, OS, plugin version,
 *                                 and the installed plugins (ID, version, enabled). Replaces
 *                                 what was known for that ID; a plugin no longer in the list is
 *                                 kept, marked removed, for 30 days, so a rating can say how long
 *                                 it was used.
 * - DELETE /api/v1/plugins/<id>   forget everything about that ID (its ratings stay, unlinked).
 * Nothing about plugin lists is published: there is no public endpoint for them. The owner reads
 * the database with wrangler (see README.md).
 *
 * Ratings and reviews
 * - POST   /api/v1/ratings        stars and an optional review from the plugin. No account.
 * - POST   /api/v1/reviews        a review from zoteroplugins.org's form: sends a confirmation
 *                                 link to the address given; nothing is posted until it's opened.
 * - POST   /api/v1/reviews/confirm   the link's token: the review goes in.
 * - GET    /api/v1/ratings.json   published ratings: per plugin and version, counts, averages and
 *                                 the spread, and the reviews with text. Public, cached an hour.
 *
 * A rating is published only after a check that isn't part of this code: how fake reviews are
 * spotted isn't published, so it can't be gamed. Until then it's held, and its poster sees it.
 *
 * What's stored: nothing from a request but the validated fields. Never an IP address. For ratings
 * and reviews only, a code made from the sender's address with a secret key that's replaced every
 * month, and the name of the network's operator (as Cloudflare reports it); codes older than 31
 * days are cleared, and the old keys deleted, so after that nothing can match them. Nothing here
 * logs request headers. Installs not heard from for 180 days are deleted nightly, with their
 * plugin lists and events.
 *
 * Secrets (wrangler secret put): TURNSTILE_SECRET (the same Turnstile widget as zoteroplugins.org's
 * forms), EMAIL_KEY (64 hex characters; makes the fingerprint kept of a review's address),
 * MAIL_API_KEY. Variables: MAIL_PROVIDER ("resend" or "postmark"), MAIL_FROM. Without them the
 * website's review form answers that reviews aren't open yet; ratings from the plugin still work.
 */

import {
  emailParts,
  hmacHex,
  monthOf,
  netPrefix,
  parseRating,
  parseReport,
  parseWebReview,
  previousMonth,
  publicRatings,
  randomHex,
  randomToken,
  sha256Hex,
} from "./lib.js";

const MAX_BODY = 64 * 1024;
const MAX_RATING_BODY = 8 * 1024;
const MIN_GAP_MS = 10 * 60 * 1000;
const SITE = "https://zoteroplugins.org";
const RATINGS_PER_NETWORK_HOUR = 20;
const REVIEWS_PER_NETWORK_HOUR = 5;
const REVIEWS_PER_ADDRESS_DAY = 3;
const CONFIRM_HOURS = 24;

const reply = (status, body, headers = {}) =>
  new Response(body ?? null, { status, headers: { "Cache-Control": "no-store", ...headers } });
const cors = {
  "Access-Control-Allow-Origin": SITE,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};
const answer = (status, body) =>
  reply(status, JSON.stringify(body), { "Content-Type": "application/json", ...cors });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const m = request.method;
    if (m === "GET" && path === "/api/v1/ratings.json") return ratingsFile(env);
    if (m === "POST" && path === "/api/v1/plugins") return report(request, env);
    const del = path.match(/^\/api\/v1\/plugins\/([0-9a-f-]{36})$/);
    if (m === "DELETE" && del) return forget(del[1], env);
    if (m === "POST" && path === "/api/v1/ratings") return rate(request, env);
    if (path === "/api/v1/reviews" || path === "/api/v1/reviews/confirm") {
      if (m === "OPTIONS") return reply(204, null, cors);
      if (m === "POST" && request.headers.get("Origin") !== SITE)
        return answer(403, { error: "forbidden" });
      if (m === "POST" && path === "/api/v1/reviews") return review(request, env);
      if (m === "POST") return confirm(request, env);
    }
    return reply(404, "Not found");
  },

  async scheduled(_event, env) {
    const month = monthOf(new Date());
    await env.DB.batch([
      // Installs not heard from for 180 days, with everything about them. events has no foreign
      // key, and plugins is cleared here rather than relying on the cascade.
      env.DB.prepare("DELETE FROM installs WHERE last_seen < datetime('now', '-180 days')"),
      env.DB.prepare("DELETE FROM plugins WHERE install_id NOT IN (SELECT id FROM installs)"),
      env.DB.prepare("DELETE FROM events WHERE install_id NOT IN (SELECT id FROM installs)"),
      env.DB.prepare(
        "UPDATE ratings SET install_id = NULL WHERE install_id IS NOT NULL AND install_id NOT IN (SELECT id FROM installs)",
      ),
      // A removed plugin is remembered for 30 days, for "used for".
      env.DB.prepare(
        "DELETE FROM plugins WHERE removed_at IS NOT NULL AND removed_at < datetime('now', '-30 days')",
      ),
      // Network codes live 31 days; the keys that made them go with them.
      env.DB.prepare(
        "UPDATE ratings SET net = NULL, net_month = NULL WHERE net IS NOT NULL AND posted_at < datetime('now', '-31 days')",
      ),
      env.DB.prepare("DELETE FROM netkeys WHERE month < ?1").bind(previousMonth(month)),
      env.DB.prepare("DELETE FROM review_pending WHERE expires_at < datetime('now')"),
    ]);
  },
};

// ---------------------------------------------------------------------------------------------
// Plugin lists

async function report(request, env) {
  // A web page can't send this: browsers add Origin to cross-site requests, the plugin doesn't.
  if (request.headers.get("Origin")) return reply(403, "Forbidden");
  const body = await readJson(request, MAX_BODY);
  if (body === undefined) return reply(413, "Too large");
  const r = parseReport(body);
  if (!r) return reply(400, "Bad request");

  const now = new Date().toISOString();
  const last = await env.DB.prepare("SELECT last_seen FROM installs WHERE id = ?1")
    .bind(r.id)
    .first("last_seen");
  // The plugin sends at most a few reports a week; anything faster is a bug or a replay. 429, not
  // a success: the plugin keeps a report it couldn't deliver and sends it at the next check.
  if (last && r.event !== "first-run" && Date.now() - Date.parse(last) < MIN_GAP_MS)
    return reply(429, "Too soon");

  // Four statements whatever the number of plugins: D1 limits queries per request on the free
  // plan, so the plugin list goes in as one JSON array.
  const list = JSON.stringify(
    r.plugins.map((p) => ({ id: p.id, version: p.version, enabled: p.enabled ? 1 : 0 })),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO installs (id, first_seen, last_seen, zotero, os, atlas) VALUES (?1, ?2, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, zotero = excluded.zotero, os = excluded.os, atlas = excluded.atlas",
    ).bind(r.id, now, r.zotero, r.os, r.atlas),
    // Gone from the list: marked removed, not deleted, so a rating can say how long it was used.
    env.DB.prepare(
      "UPDATE plugins SET removed_at = ?3 WHERE install_id = ?1 AND removed_at IS NULL " +
        "AND addon_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?2))",
    ).bind(r.id, list, now),
    // Still there: version and enabled updated, first_seen kept. Back after a removal: counted
    // from now.
    env.DB.prepare(
      "INSERT INTO plugins (install_id, addon_id, version, enabled, first_seen, removed_at) " +
        "SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.version'), json_extract(value, '$.enabled'), ?3, NULL " +
        "FROM json_each(?2) WHERE true " +
        "ON CONFLICT(install_id, addon_id) DO UPDATE SET version = excluded.version, enabled = excluded.enabled, " +
        "first_seen = CASE WHEN plugins.removed_at IS NOT NULL OR plugins.first_seen IS NULL THEN excluded.first_seen ELSE plugins.first_seen END, " +
        "removed_at = NULL",
    ).bind(r.id, list, now),
    env.DB.prepare("INSERT INTO events (at, install_id, event) VALUES (?1, ?2, ?3)").bind(
      now,
      r.id,
      r.event,
    ),
  ]);
  return reply(204);
}

async function forget(id, env) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return reply(400, "Bad request");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugins WHERE install_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM events WHERE install_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM installs WHERE id = ?1").bind(id),
    // Ratings stay, without the link to the plugin list.
    env.DB.prepare("UPDATE ratings SET install_id = NULL WHERE install_id = ?1").bind(id),
  ]);
  return reply(204);
}

// ---------------------------------------------------------------------------------------------
// Ratings and reviews

/** The body as JSON, null when it isn't JSON, undefined when it's too large. */
async function readJson(request, max) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > max) return undefined;
  const text = await request.text();
  if (text.length > max) return undefined;
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

/** This month's key for network codes, made the first time it's needed. */
async function netKey(env, month) {
  const have = await env.DB.prepare("SELECT key FROM netkeys WHERE month = ?1")
    .bind(month)
    .first("key");
  if (have) return have;
  await env.DB.prepare("INSERT OR IGNORE INTO netkeys (month, key) VALUES (?1, ?2)")
    .bind(month, randomHex(32))
    .run();
  return env.DB.prepare("SELECT key FROM netkeys WHERE month = ?1").bind(month).first("key");
}

/**
 * Where a request came from, without keeping its address: a code made from the address with
 * this month's key, and the network's operator and number as Cloudflare reports them.
 */
async function network(request, env, now) {
  const month = monthOf(now);
  const prefix = netPrefix(request.headers.get("CF-Connecting-IP"));
  const net = prefix ? (await hmacHex(await netKey(env, month), prefix)).slice(0, 32) : null;
  const cf = request.cf ?? {};
  return {
    net,
    month: net ? month : null,
    org: typeof cf.asOrganization === "string" ? cf.asOrganization.slice(0, 120) : null,
    asn: Number.isInteger(cf.asn) ? cf.asn : null,
  };
}

const RATING_COLUMNS =
  "(source, rater, slug, addon_id, version, stars, text, name, zotero, os, atlas, install_id, install_claimed, " +
  "used_since, used_until, posted_at, first_posted_at, net, net_month, net_org, net_asn, status)";
const RATING_UPSERT =
  "ON CONFLICT(source, rater, slug, version) DO UPDATE SET addon_id = excluded.addon_id, stars = excluded.stars, " +
  "text = excluded.text, name = excluded.name, zotero = excluded.zotero, os = excluded.os, atlas = excluded.atlas, " +
  "install_id = excluded.install_id, install_claimed = excluded.install_claimed, used_since = excluded.used_since, " +
  "used_until = excluded.used_until, posted_at = excluded.posted_at, net = excluded.net, net_month = excluded.net_month, " +
  "net_org = excluded.net_org, net_asn = excluded.net_asn, status = 'new', reasons = NULL, scored_at = NULL";

async function rate(request, env) {
  // Like the plugin lists: the plugin sends no Origin, a web page always does.
  if (request.headers.get("Origin")) return reply(403, "Forbidden");
  const body = await readJson(request, MAX_RATING_BODY);
  if (body === undefined) return reply(413, "Too large");
  const r = parseRating(body);
  if (!r) return reply(400, "Bad request");

  const now = new Date();
  const at = now.toISOString();
  const where = await network(request, env, now);
  if (where.net) {
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ratings WHERE net = ?1 AND posted_at > ?2",
    )
      .bind(where.net, new Date(now.getTime() - 3600000).toISOString())
      .first("n");
    if (recent >= RATINGS_PER_NETWORK_HOUR) return reply(429, "Too many");
  }

  // How long this install has had the plugin, from its own reports, when it shares them.
  let install = null;
  let used = null;
  if (r.install) {
    const known = await env.DB.prepare("SELECT 1 AS ok FROM installs WHERE id = ?1")
      .bind(r.install)
      .first("ok");
    if (known) {
      install = r.install;
      used = await env.DB.prepare(
        "SELECT first_seen, removed_at FROM plugins WHERE install_id = ?1 AND addon_id = ?2",
      )
        .bind(r.install, r.addon)
        .first();
    }
  }

  await env.DB.prepare(
    `INSERT INTO ratings ${RATING_COLUMNS} VALUES ('atlas', ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15, ?16, ?17, ?18, 'new') ${RATING_UPSERT}`,
  )
    .bind(
      r.rater,
      r.slug,
      r.addon,
      r.version,
      r.stars,
      r.text,
      r.zotero,
      r.os,
      r.atlas,
      install,
      r.install && !install ? 1 : 0,
      used?.first_seen ?? null,
      used?.removed_at ?? null,
      at,
      where.net,
      where.month,
      where.org,
      where.asn,
    )
    .run();
  return reply(204);
}

async function verifyTurnstile(token, request, env) {
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const out = await res.json();
    return out.success === true;
  } catch (_e) {
    return false;
  }
}

async function sendMail(env, to, subject, text) {
  const from = env.MAIL_FROM;
  if (env.MAIL_PROVIDER === "postmark") {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": env.MAIL_API_KEY,
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject,
        TextBody: text,
        MessageStream: "outbound",
      }),
    });
    return res.ok;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MAIL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  return res.ok;
}

const reviewsOpen = (env) =>
  Boolean(
    env.TURNSTILE_SECRET &&
      env.MAIL_API_KEY &&
      env.MAIL_FROM &&
      /^[0-9a-f]{64}$/.test(env.EMAIL_KEY ?? "") &&
      (env.MAIL_PROVIDER === "resend" || env.MAIL_PROVIDER === "postmark"),
  );

async function review(request, env) {
  if (!reviewsOpen(env)) return answer(503, { error: "not-open" });
  const body = await readJson(request, MAX_RATING_BODY);
  if (body === undefined) return answer(413, { error: "too-large" });
  const r = parseWebReview(body);
  if (!r) return answer(400, { error: "invalid" });
  const email = emailParts(r.email);
  if (!email) return answer(400, { error: "email" });
  if (email.throwaway) return answer(400, { error: "throwaway" });
  // Bots before anything else: no mail is sent for a request Turnstile doesn't pass.
  if (!(await verifyTurnstile(r.token, request, env))) return answer(403, { error: "turnstile" });

  const now = new Date();
  const where = await network(request, env, now);
  const fp = await hmacHex(env.EMAIL_KEY, email.key);
  const hourAgo = new Date(now.getTime() - 3600000).toISOString();
  const dayAgo = new Date(now.getTime() - 86400000).toISOString();
  // Nobody can use the form to fill someone's inbox: a few links per address a day, and per
  // network an hour.
  const [byNet, byAddress] = await Promise.all([
    where.net
      ? env.DB.prepare(
          "SELECT COUNT(*) AS n FROM review_pending WHERE net = ?1 AND created_at > ?2",
        )
          .bind(where.net, hourAgo)
          .first("n")
      : 0,
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM review_pending WHERE email_fp = ?1 AND created_at > ?2",
    )
      .bind(fp, dayAgo)
      .first("n"),
  ]);
  if (byNet >= REVIEWS_PER_NETWORK_HOUR || byAddress >= REVIEWS_PER_ADDRESS_DAY)
    return answer(429, { error: "too-many" });

  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO review_pending (token_hash, created_at, expires_at, email_fp, slug, version, stars, text, name, net, net_month, net_org, net_asn) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
  )
    .bind(
      await sha256Hex(token),
      now.toISOString(),
      new Date(now.getTime() + CONFIRM_HOURS * 3600000).toISOString(),
      fp,
      r.slug,
      r.version,
      r.stars,
      r.text,
      r.name,
      where.net,
      where.month,
      where.org,
      where.asn,
    )
    .run();
  // The mail says nothing that came from the form except the plugin's address on the site, so
  // the form can't be used to send anyone a message of someone else's choosing.
  const sent = await sendMail(
    env,
    email.address,
    "Confirm your review on zoteroplugins.org",
    [
      "Someone, hopefully you, wrote a review on zoteroplugins.org using this email address:",
      `${SITE}/p/${r.slug}`,
      "",
      `To post it, open this link within ${CONFIRM_HOURS} hours:`,
      `${SITE}/review/confirm#${token}`,
      "",
      "If it wasn't you, ignore this email. Nothing will be posted, and we won't write again.",
      "",
      "We keep only a fingerprint of your address, so one address gets one review per plugin.",
      "It's never shown and never used for anything else.",
    ].join("\n"),
  );
  if (!sent) return answer(502, { error: "mail" });
  return answer(202, { ok: true });
}

async function confirm(request, env) {
  const body = await readJson(request, 1024);
  const token = body && typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return answer(400, { error: "invalid" });
  const hash = await sha256Hex(token);
  const p = await env.DB.prepare(
    "SELECT * FROM review_pending WHERE token_hash = ?1 AND expires_at > ?2",
  )
    .bind(hash, new Date().toISOString())
    .first();
  if (!p) return answer(404, { error: "expired" });
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ratings ${RATING_COLUMNS} VALUES ('web', ?1, ?2, NULL, ?3, ?4, ?5, ?6, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?7, ?7, ?8, ?9, ?10, ?11, 'new') ${RATING_UPSERT}`,
    ).bind(
      p.email_fp,
      p.slug,
      p.version,
      p.stars,
      p.text,
      p.name,
      at,
      p.net,
      p.net_month,
      p.net_org,
      p.net_asn,
    ),
    env.DB.prepare("DELETE FROM review_pending WHERE token_hash = ?1").bind(hash),
  ]);
  return answer(200, { ok: true, slug: p.slug });
}

async function ratingsFile(env) {
  const rows = await env.DB.prepare(
    "SELECT source, slug, version, stars, text, name, zotero, used_since, used_until, posted_at " +
      "FROM ratings WHERE status = 'published' ORDER BY slug, posted_at",
  ).all();
  return reply(200, JSON.stringify(publicRatings(rows.results, new Date().toISOString())), {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
  });
}
