/**
 * The server's checks and conversions, with no database and no network, so they can be tested on
 * their own (test.mjs). worker.js does the rest.
 */

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RATER_RE = /^[0-9a-f]{64}$/;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const EVENTS = new Set(["first-run", "changed", "weekly"]);
const OS = new Set(["windows", "mac", "linux"]);
const MAX_PLUGINS = 400;
export const MAX_TEXT = 1000;
const MAX_NAME = 60;

export const str = (v, max) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

/** A plugin-list report, validated field by field, or null. Unknown fields are dropped. */
export function parseReport(body) {
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

/**
 * Review text as it will be published: links removed (an address in a review is nearly always an
 * advert), runs of blank lines and spaces squeezed, at most MAX_TEXT characters. Null when nothing
 * is left.
 */
export function cleanText(v) {
  if (typeof v !== "string") return null;
  const t = v
    .replace(/\r\n?/g, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's removed
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(
      /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|cn|top|xyz|app|dev|site|link|me)(?:\/\S*)?/gi,
      "",
    )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t ? t.slice(0, MAX_TEXT).trim() : null;
}

/** A rating from the plugin, or null. */
export function parseRating(body) {
  if (!body || typeof body !== "object") return null;
  const rater = str(body.rater, 64);
  if (!rater || !RATER_RE.test(rater)) return null;
  const slug = str(body.slug, 100);
  if (!slug || slug.length < 2 || !SLUG_RE.test(slug)) return null;
  const addon = str(body.addon, 200);
  const version = str(body.version, 100);
  if (!addon || !version) return null;
  const stars = body.stars;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return null;
  if (body.text !== undefined && body.text !== null && typeof body.text !== "string") return null;
  if (typeof body.text === "string" && body.text.length > MAX_TEXT * 2) return null;
  const os = str(body.os, 10);
  if (!os || !OS.has(os)) return null;
  const zotero = str(body.zotero, 40);
  const atlas = str(body.atlas, 40);
  if (!zotero || !atlas) return null;
  let install = null;
  if (body.install !== undefined && body.install !== null) {
    install = str(body.install, 36);
    if (!install || !ID_RE.test(install)) return null;
  }
  return {
    rater,
    install,
    slug,
    addon,
    version,
    stars,
    text: cleanText(body.text),
    os,
    zotero,
    atlas,
  };
}

/** A review from the website's form, or null. The email is checked separately (emailParts). */
export function parseWebReview(body) {
  if (!body || typeof body !== "object") return null;
  const slug = str(body.slug, 100);
  if (!slug || slug.length < 2 || !SLUG_RE.test(slug)) return null;
  const version = str(body.version, 100);
  if (!version) return null;
  const stars = body.stars;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return null;
  if (body.text !== undefined && body.text !== null && typeof body.text !== "string") return null;
  if (typeof body.text === "string" && body.text.length > MAX_TEXT * 2) return null;
  if (body.name !== undefined && body.name !== null && typeof body.name !== "string") return null;
  const email = str(body.email, 254);
  const token = str(body.turnstile, 4096);
  if (!email || !token) return null;
  const name = cleanText(typeof body.name === "string" ? body.name.replace(/\n/g, " ") : null);
  return {
    slug,
    version,
    stars,
    text: cleanText(body.text),
    name: name ? name.slice(0, MAX_NAME).trim() : null,
    email,
    token,
  };
}

// Throwaway mailbox services: a review confirmed from one of these proves nothing.
const THROWAWAY = new Set(
  [
    "10minutemail.com",
    "20minutemail.com",
    "33mail.com",
    "burnermail.io",
    "discard.email",
    "dispostable.com",
    "emailondeck.com",
    "fakeinbox.com",
    "getairmail.com",
    "getnada.com",
    "guerrillamail.com",
    "guerrillamail.net",
    "guerrillamail.org",
    "guerrillamailblock.com",
    "harakirimail.com",
    "inboxkitten.com",
    "mail.tm",
    "maildrop.cc",
    "mailinator.com",
    "mailnesia.com",
    "mailpoof.com",
    "mintemail.com",
    "mohmal.com",
    "moakt.com",
    "mytemp.email",
    "sharklasers.com",
    "spamgourmet.com",
    "temp-mail.io",
    "temp-mail.org",
    "tempail.com",
    "tempmail.dev",
    "tempmail.net",
    "tempmailo.com",
    "tempr.email",
    "throwawaymail.com",
    "trashmail.com",
    "trashmail.de",
    "yopmail.com",
    "yopmail.fr",
  ].map((d) => d.toLowerCase()),
);

/**
 * The address split and normalised the way one inbox sees it, or null when it isn't an address
 * we'll write to. Letter case and a +tag never make another inbox; for Gmail neither do dots.
 */
export function emailParts(raw) {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  const m = /^([^\s@"<>()[\]\\,;:]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(e);
  if (!m) return null;
  let [, local, domain] = m;
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (!local) return null;
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++)
    if (THROWAWAY.has(labels.slice(i).join("."))) return { address: e, key: null, throwaway: true };
  return { address: e, key: `${local}@${domain}`, throwaway: false };
}

/**
 * The part of an address that stands for one connection: an IPv4 address whole, an IPv6 address
 * by its first 64 bits (one device keeps changing the rest). Null for anything else.
 */
export function netPrefix(ip) {
  if (typeof ip !== "string" || !ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1].split(".").every((n) => Number(n) <= 255) ? v4[1] : null;
  if (!ip.includes(":") || !/^[0-9a-f:]+$/i.test(ip)) return null;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups
    .slice(0, 4)
    .map((g) => g.padStart(4, "0"))
    .join(":");
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 of `text` under a key given as hex, as hex. */
export async function hmacHex(keyHex, text) {
  const raw = new Uint8Array(keyHex.match(/../g).map((h) => Number.parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export function randomHex(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A token for a link: 32 random bytes, URL-safe. */
export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** "2026-11" for a date. Network codes are made with that month's key. */
export const monthOf = (d) => d.toISOString().slice(0, 7);

/** The month before `month` ("2026-01" → "2025-12"). */
export function previousMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Whole days between two ISO times, or null when the first is missing. */
export function daysBetween(from, to) {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 86400000) : null;
}

const summary = () => ({ count: 0, average: null, stars: [0, 0, 0, 0, 0] });
const add = (s, stars) => {
  s.count++;
  s.stars[stars - 1]++;
};
const finish = (s) => {
  const total = s.stars.reduce((sum, n, i) => sum + n * (i + 1), 0);
  s.average = s.count ? Math.round((total / s.count) * 10) / 10 : null;
  return s;
};

/**
 * The published ratings as the public file: per plugin, every version's count, average and
 * spread (stars[0] is the number of 1-star ratings), and the reviews that have text, newest first.
 * `rows` are published ratings only.
 */
export function publicRatings(rows, generatedAt, maxReviews = 100) {
  const plugins = {};
  for (const r of rows) {
    if (!plugins[r.slug]) plugins[r.slug] = { all: summary(), versions: {}, reviews: [] };
    const p = plugins[r.slug];
    if (!p.versions[r.version]) p.versions[r.version] = summary();
    add(p.all, r.stars);
    add(p.versions[r.version], r.stars);
    if (r.text)
      p.reviews.push({
        stars: r.stars,
        version: r.version,
        text: r.text,
        by: r.source === "web" ? r.name || "Anonymous" : "Zotero Atlas user",
        from: r.source === "web" ? "website" : "zotero-atlas",
        zotero: r.source === "web" ? null : r.zotero,
        usedDays: daysBetween(r.used_since, r.used_until ?? r.posted_at),
        posted: r.posted_at.slice(0, 10),
      });
  }
  const out = {};
  for (const slug of Object.keys(plugins).sort()) {
    const p = plugins[slug];
    finish(p.all);
    for (const v of Object.values(p.versions)) finish(v);
    p.reviews.sort((a, b) => b.posted.localeCompare(a.posted));
    p.reviews = p.reviews.slice(0, maxReviews);
    out[slug] = p;
  }
  return { generatedAt, plugins: out };
}
