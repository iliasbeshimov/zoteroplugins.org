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
 *                                 With ?reason=removed (sent when Zotero Atlas is removed), one is
 *                                 added to the count of removals for that day, plugin version and
 *                                 how long the install was there (day, week, month, longer); the
 *                                 count has no ID and no plugin list.
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
  alertMail,
  buildReport,
  checkLink,
  confirmMail,
  htmlToParts,
  MAX_GUIDE_BYTES,
  MAX_LOOKUPS,
  nextSnapshot,
  parseGuideUrl,
  refsOf,
  repoOf,
  startSnapshot,
  unplaced,
  unreachableMail,
} from "./guides.js";
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
  usedBucket,
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
    // On zoteroplugins.org this worker serves only the library box's data.
    if (url.hostname === "zoteroplugins.org" || url.hostname === "www.zoteroplugins.org") {
      if (path === "/api/v1/box.json" && m === "OPTIONS") return reply(204, null, boxCors);
      if (path === "/api/v1/box.json" && m === "GET") return box(request, env, url);
      return reply(404, "Not found");
    }
    if (GUIDE_ROUTES.has(path)) {
      if (m === "OPTIONS") return reply(204, null, cors);
      if (m !== "POST") return reply(405, "Method not allowed");
      if (request.headers.get("Origin") !== SITE) return answer(403, { error: "forbidden" });
      return guides(request, env, path);
    }
    if (m === "GET" && path === "/api/v1/ratings.json") return ratingsFile(env);
    if (m === "POST" && path === "/api/v1/plugins") return report(request, env);
    const del = path.match(/^\/api\/v1\/plugins\/([0-9a-f-]{36})$/);
    if (m === "DELETE" && del)
      return forget(del[1], env, url.searchParams.get("reason") === "removed");
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

  async scheduled(event, env) {
    // Every 10 minutes: one watched library guide. Once a night (below): the clean-up.
    if (event.cron === "*/10 * * * *") {
      if (guidesOpen(env)) await runWatches(env, 1);
      return;
    }
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
      // Library guides: unconfirmed watches after a day, rate-limit codes after two.
      env.DB.prepare("DELETE FROM guide_watch_pending WHERE expires_at < datetime('now')"),
      env.DB.prepare("DELETE FROM guide_limits WHERE day < date('now', '-2 days')"),
      env.DB.prepare("DELETE FROM repo_lookups WHERE checked_at < datetime('now', '-60 days')"),
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

async function forget(id, env, removed = false) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return reply(400, "Bad request");
  const counted = [];
  if (removed) {
    const row = await env.DB.prepare("SELECT first_seen, atlas FROM installs WHERE id = ?1")
      .bind(id)
      .first();
    const now = new Date().toISOString();
    const used = row && usedBucket(row.first_seen, now);
    if (used)
      counted.push(
        env.DB.prepare(
          "INSERT INTO removals (day, atlas, used, n) VALUES (?1, ?2, ?3, 1) " +
            "ON CONFLICT (day, atlas, used) DO UPDATE SET n = n + 1",
        ).bind(now.slice(0, 10), row.atlas || "unknown", used),
      );
  }
  await env.DB.batch([
    ...counted,
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

async function sendMail(env, to, subject, text, opts = {}) {
  const from = opts.from ?? env.MAIL_FROM;
  const replyTo = opts.replyTo ?? null;
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
        ...(replyTo ? { ReplyTo: replyTo } : {}),
      }),
    });
    return res.ok;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MAIL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
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

// ---------------------------------------------------------------------------------------------
// Library guides (zoteroplugins.org/librarians): the guide check, alerts for watched guides, and
// the self-updating box. See guides.js for what a report says and how alerts are decided.
//
// - POST /api/v1/guides/check     {url, turnstile}: the report for a guide (cached 30 minutes).
// - POST /api/v1/guides/watch     {url, email, turnstile}: mails a link to confirm the watch.
// - POST /api/v1/guides/confirm   {token}: the watch starts; a "you're set" mail with the stop link.
// - POST /api/v1/guides/stop      {token}: deletes the watch: the address and the guide's link.
// - GET  zoteroplugins.org/api/v1/box.json?pack=…   the packs' picks for the box, counted by the
//   website it's shown on (its host name only: no cookies, nothing about the reader).
// Every 10 minutes the oldest watched guide not checked for 20 hours is checked again.
//
// Stored: for a watch, the guide's address, the email address it goes to, the stop link's token
// and what was last found; deleted when its owner stops it, or after two weeks the guide can't be
// read. For checks, the guide's address and its last report (guides are public pages). For rate
// limits, a keyed code of the network and of the address, for two days.

// SITE_DATA (a variable) points these at a local build when testing with wrangler dev.
const dataUrl = (env, file) => `${env.SITE_DATA ?? SITE}/data/${file}`;
const GUIDE_CACHE_MINUTES = 30;
const CHECKS_PER_NETWORK_DAY = 40;
const WATCHES_PER_NETWORK_DAY = 10;
const WATCHES_PER_ADDRESS_DAY = 5;
const WATCH_EVERY_HOURS = 20;
const WATCH_GIVE_UP_FAILS = 14;
const GUIDES_FROM = "zoteroplugins.org <guides@zoteroplugins.org>";
const GUIDES_REPLY_TO = "hello@zoteroplugins.org";
const USER_AGENT = "zoteroplugins.org guide check (+https://zoteroplugins.org/librarians/check)";

const guidesOpen = (env) =>
  Boolean(env.TURNSTILE_SECRET && /^[0-9a-f]{64}$/.test(env.EMAIL_KEY ?? ""));
const watchesOpen = (env) => guidesOpen(env) && reviewsOpen(env);

/** Module-level caches: one isolate serves many requests. */
const memo = { index: null, indexAt: 0, box: null, boxAt: 0 };

async function guideIndexData(env) {
  if (memo.index && Date.now() - memo.indexAt < 10 * 60 * 1000) return memo.index;
  const res = await fetch(dataUrl(env, "guide-index.json"), { cf: { cacheTtl: 600 } });
  if (!res.ok) throw new Error(`guide index ${res.status}`);
  memo.index = await res.json();
  memo.indexAt = Date.now();
  return memo.index;
}

/** The guide's HTML, at most MAX_GUIDE_BYTES; or an error code. */
async function fetchGuide(u) {
  let res;
  try {
    res = await fetch(u.href, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch (_e) {
    return { error: "unreachable" };
  }
  if (!res.ok) return { error: "status", status: res.status };
  const type = res.headers.get("Content-Type") ?? "";
  if (type && !/html|xml/i.test(type)) return { error: "not-html" };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_GUIDE_BYTES) {
      await reader.cancel();
      return { error: "too-large" };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return { html: new TextDecoder().decode(all), finalUrl: res.url || u.href };
}

/** What GitHub says about repositories we don't know: renamed (its new owner/name) or not. */
async function lookUpRepos(env, repos) {
  const out = {};
  if (!repos.length) return out;
  const list = repos.slice(0, 50);
  const known = await env.DB.prepare(
    `SELECT repo, target FROM repo_lookups WHERE checked_at > datetime('now', '-30 days') AND repo IN (${list.map((_, i) => `?${i + 1}`).join(",")})`,
  )
    .bind(...list)
    .all();
  const seen = new Set();
  for (const r of known.results ?? []) {
    seen.add(r.repo);
    if (r.target) out[r.repo] = r.target;
  }
  const ask = list.filter((r) => !seen.has(r)).slice(0, MAX_LOOKUPS);
  const now = new Date().toISOString();
  const writes = [];
  for (const repo of ask) {
    let target = null;
    let status = 0;
    try {
      const res = await fetch(`https://github.com/${repo}`, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      status = res.status;
      if (status === 301 || status === 302) {
        const to = repoOf(new URL(res.headers.get("Location") ?? "", "https://github.com").href);
        if (to && to !== repo) target = to;
      }
    } catch (_e) {
      continue;
    }
    if (target) out[repo] = target;
    writes.push(
      env.DB.prepare(
        "INSERT INTO repo_lookups (repo, target, status, checked_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(repo) DO UPDATE SET target = excluded.target, status = excluded.status, checked_at = excluded.checked_at",
      ).bind(repo, target, status, now),
    );
  }
  if (writes.length) await env.DB.batch(writes);
  return out;
}

/** Fetch, read and report on a guide; { report } or { error, status }. */
async function checkGuide(env, u) {
  const page = await fetchGuide(u);
  if (page.error) return page;
  const index = await guideIndexData(env);
  const parts = htmlToParts(page.html, page.finalUrl);
  const refs = refsOf(parts);
  const resolved = await lookUpRepos(env, unplaced(refs, index));
  const report = buildReport({
    url: u.href,
    title: parts.title,
    parts,
    index,
    resolved,
    checkedAt: new Date().toISOString(),
  });
  return { report };
}

async function saveReport(env, report, counted) {
  await env.DB.prepare(
    "INSERT INTO guide_reports (url, host, report, checked_at, first_checked, checks, plugins, attention) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7) " +
      "ON CONFLICT(url) DO UPDATE SET report = excluded.report, checked_at = excluded.checked_at, checks = checks + excluded.checks, plugins = excluded.plugins, attention = excluded.attention",
  )
    .bind(
      report.url,
      new URL(report.url).hostname,
      JSON.stringify(report),
      report.checkedAt,
      counted ? 1 : 0,
      report.counts.plugins,
      report.counts.attention,
    )
    .run();
}

/** Counts one use against a daily limit; false when the limit is reached. */
async function underLimit(env, key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "INSERT INTO guide_limits (key, day, n) VALUES (?1, ?2, 1) ON CONFLICT(key, day) DO UPDATE SET n = n + 1 RETURNING n",
  )
    .bind(key, day)
    .first();
  return (row?.n ?? 1) <= limit;
}

async function netCode(request, env) {
  const prefix = netPrefix(request.headers.get("CF-Connecting-IP"));
  return prefix
    ? `net:${(await hmacHex(env.EMAIL_KEY, `guides:${prefix}`)).slice(0, 32)}`
    : "net:unknown";
}

const GUIDE_ROUTES = new Set([
  "/api/v1/guides/check",
  "/api/v1/guides/watch",
  "/api/v1/guides/confirm",
  "/api/v1/guides/stop",
]);

async function guides(request, env, path) {
  if (!guidesOpen(env)) return answer(503, { error: "not-open" });
  const body = await readJson(request, 8 * 1024);
  if (body === undefined) return answer(413, { error: "too-large" });
  if (!body || typeof body !== "object") return answer(400, { error: "invalid" });
  if (path === "/api/v1/guides/check") return guideCheck(request, env, body);
  if (path === "/api/v1/guides/watch") return guideWatch(request, env, body);
  if (path === "/api/v1/guides/confirm") return guideConfirm(env, body);
  return guideStop(env, body);
}

async function guideCheck(request, env, body) {
  const u = parseGuideUrl(body.url);
  if (!u) return answer(400, { error: "url" });
  if (!(await verifyTurnstile(String(body.turnstile ?? ""), request, env)))
    return answer(403, { error: "turnstile" });
  if (!(await underLimit(env, await netCode(request, env), CHECKS_PER_NETWORK_DAY)))
    return answer(429, { error: "too-many" });
  const cached = await env.DB.prepare(
    `SELECT report FROM guide_reports WHERE url = ?1 AND checked_at > datetime('now', '-${GUIDE_CACHE_MINUTES} minutes')`,
  )
    .bind(u.href)
    .first("report");
  if (cached) {
    await env.DB.prepare("UPDATE guide_reports SET checks = checks + 1 WHERE url = ?1")
      .bind(u.href)
      .run();
    return answer(200, { report: JSON.parse(cached) });
  }
  const out = await checkGuide(env, u);
  if (out.error) return answer(422, { error: out.error, status: out.status ?? null });
  await saveReport(env, out.report, true);
  return answer(200, { report: out.report });
}

async function guideWatch(request, env, body) {
  if (!watchesOpen(env)) return answer(503, { error: "not-open" });
  const u = parseGuideUrl(body.url);
  if (!u) return answer(400, { error: "url" });
  const email = emailParts(body.email);
  if (!email) return answer(400, { error: "email" });
  if (email.throwaway) return answer(400, { error: "throwaway" });
  if (!(await verifyTurnstile(String(body.turnstile ?? ""), request, env)))
    return answer(403, { error: "turnstile" });
  const mailKey = `mail:${(await hmacHex(env.EMAIL_KEY, `guides:${email.key}`)).slice(0, 32)}`;
  if (
    !(await underLimit(env, await netCode(request, env), WATCHES_PER_NETWORK_DAY)) ||
    !(await underLimit(env, mailKey, WATCHES_PER_ADDRESS_DAY))
  )
    return answer(429, { error: "too-many" });
  const already = await env.DB.prepare("SELECT 1 FROM guide_watches WHERE url = ?1 AND email = ?2")
    .bind(u.href, email.address)
    .first();
  // The same answer either way, so the form can't be used to learn who watches what.
  if (already) return answer(202, { ok: true });
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO guide_watch_pending (token_hash, url, email, expires_at) VALUES (?1, ?2, ?3, datetime('now', '+24 hours'))",
  )
    .bind(await sha256Hex(token), u.href, email.address)
    .run();
  const mail = confirmMail(u.href, token);
  if (
    !(await sendMail(env, email.address, mail.subject, mail.text, {
      from: GUIDES_FROM,
      replyTo: GUIDES_REPLY_TO,
    }))
  )
    return answer(502, { error: "mail" });
  return answer(202, { ok: true });
}

async function guideConfirm(env, body) {
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return answer(400, { error: "invalid" });
  const hash = await sha256Hex(token);
  const p = await env.DB.prepare(
    "SELECT url, email FROM guide_watch_pending WHERE token_hash = ?1 AND expires_at > datetime('now')",
  )
    .bind(hash)
    .first();
  if (!p) return answer(404, { error: "expired" });
  await env.DB.prepare("DELETE FROM guide_watch_pending WHERE token_hash = ?1").bind(hash).run();
  const last = await env.DB.prepare("SELECT report FROM guide_reports WHERE url = ?1")
    .bind(p.url)
    .first("report");
  const report = last ? JSON.parse(last) : null;
  const snapshot = report ? startSnapshot(report) : { alerted: {}, pending: {} };
  const stop = randomToken();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO guide_watches (url, email, stop_token, created_at, last_run, snapshot) VALUES (?1, ?2, ?3, ?4, ?4, ?5) ON CONFLICT(url, email) DO NOTHING",
  )
    .bind(p.url, p.email, stop, now, JSON.stringify(snapshot))
    .run();
  const counts = report?.counts ?? null;
  const summary = counts
    ? `Today we found ${counts.plugins} plugin${counts.plugins === 1 ? "" : "s"} on it; ${counts.attention} need${counts.attention === 1 ? "s" : ""} attention. The full report: ${checkLink(p.url)}`
    : `The full report: ${checkLink(p.url)}`;
  await sendMail(
    env,
    p.email,
    "You're set: we're watching your Zotero guide",
    `Hello,

We're now watching this guide:
${p.url}

${summary}

We'll check it every day and email you only when something changes: a plugin it names stops working with the current Zotero, is removed from GitHub, moves to a new address, or drops to a C grade. Anything already on the report won't be emailed again.

To stop at any time (this deletes your address and the guide from our list): ${SITE}/librarians/check?stop=${stop}

zoteroplugins.org is a free, non-commercial catalogue that checks the code of Zotero plugins. Questions or corrections: reply to this email.
`,
    { from: GUIDES_FROM, replyTo: GUIDES_REPLY_TO },
  );
  return answer(200, { ok: true, url: p.url, counts });
}

async function guideStop(env, body) {
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return answer(400, { error: "invalid" });
  const row = await env.DB.prepare("DELETE FROM guide_watches WHERE stop_token = ?1 RETURNING url")
    .bind(token)
    .first();
  return row ? answer(200, { ok: true, url: row.url }) : answer(404, { error: "gone" });
}

/** The next watched guide due for its daily check; alerts for problems seen two runs in a row. */
async function runWatches(env, limit) {
  const due = await env.DB.prepare(
    `SELECT id, url, email, stop_token, snapshot, fails FROM guide_watches WHERE last_run IS NULL OR last_run < datetime('now', '-${WATCH_EVERY_HOURS} hours') ORDER BY last_run LIMIT ?1`,
  )
    .bind(limit)
    .all();
  for (const w of due.results ?? []) {
    const now = new Date().toISOString();
    const u = parseGuideUrl(w.url);
    const out = u ? await checkGuide(env, u) : { error: "url" };
    if (out.error) {
      if (w.fails + 1 >= WATCH_GIVE_UP_FAILS) {
        const mail = unreachableMail(w.url);
        await sendMail(env, w.email, mail.subject, mail.text, {
          from: GUIDES_FROM,
          replyTo: GUIDES_REPLY_TO,
        });
        await env.DB.prepare("DELETE FROM guide_watches WHERE id = ?1").bind(w.id).run();
      } else
        await env.DB.prepare(
          "UPDATE guide_watches SET last_run = ?1, fails = fails + 1 WHERE id = ?2",
        )
          .bind(now, w.id)
          .run();
      continue;
    }
    const { snapshot, news } = nextSnapshot(JSON.parse(w.snapshot), out.report);
    let sent = 0;
    if (news.length) {
      const mail = alertMail(out.report, news, w.stop_token);
      sent = (await sendMail(env, w.email, mail.subject, mail.text, {
        from: GUIDES_FROM,
        replyTo: GUIDES_REPLY_TO,
      }))
        ? 1
        : 0;
    }
    // If the mail failed, keep the old snapshot: the next run finds the same news and tries again.
    const keep = news.length && !sent ? w.snapshot : JSON.stringify(snapshot);
    await env.DB.prepare(
      "UPDATE guide_watches SET last_run = ?1, last_ok = ?1, fails = 0, snapshot = ?2, alerts = alerts + ?3 WHERE id = ?4",
    )
      .bind(now, keep, sent, w.id)
      .run();
    await saveReport(env, out.report, false);
  }
}

// The box ----------------------------------------------------------------------------------------

const boxCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const OWN_HOSTS = new Set(["zoteroplugins.org", "www.zoteroplugins.org", "localhost", "127.0.0.1"]);

async function boxFile(env) {
  if (memo.box && Date.now() - memo.boxAt < 10 * 60 * 1000) return memo.box;
  const res = await fetch(dataUrl(env, "box.json"), { cf: { cacheTtl: 600 } });
  if (!res.ok) throw new Error(`box data ${res.status}`);
  memo.box = await res.json();
  memo.boxAt = Date.now();
  return memo.box;
}

/** The website showing the box: the Origin of a script's request, or `via` from the framed page. */
function boxHost(request, url) {
  let host = null;
  const origin = request.headers.get("Origin");
  if (origin && origin !== "null") {
    try {
      host = new URL(origin).hostname;
    } catch (_e) {}
  }
  if (!host || OWN_HOSTS.has(host)) {
    const via = (url.searchParams.get("via") ?? "").toLowerCase();
    host = /^[a-z0-9.-]{1,100}$/.test(via) ? via : host;
  }
  return host && !OWN_HOSTS.has(host) && /^[a-z0-9.-]{1,100}$/.test(host) ? host : null;
}

async function box(request, env, url) {
  let data;
  try {
    data = await boxFile(env);
  } catch (_e) {
    return reply(503, "Unavailable", boxCors);
  }
  const want = url.searchParams.get("pack");
  const pack = data.packs.find((k) => k.slug === want);
  const host = boxHost(request, url);
  if (host) {
    await env.DB.prepare(
      "INSERT INTO box_views (day, host, pack, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(day, host, pack) DO UPDATE SET n = n + 1",
    )
      .bind(new Date().toISOString().slice(0, 10), host, pack ? pack.slug : "all")
      .run();
  }
  return reply(200, JSON.stringify(pack ? { ...data, packs: [pack] } : data), {
    "Content-Type": "application/json",
    ...boxCors,
  });
}
