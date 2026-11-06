// Offline checks of the server's helpers: node server/test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanText,
  daysBetween,
  emailParts,
  hmacHex,
  netPrefix,
  parseRating,
  parseWebReview,
  previousMonth,
  publicRatings,
} from "./lib.js";

const rater = "a".repeat(64);
const rating = (o = {}) => ({
  rater,
  slug: "notero",
  addon: "notero@vanoni.me",
  version: "2.1.0",
  stars: 4,
  os: "mac",
  zotero: "10.0.7",
  atlas: "0.2.0",
  ...o,
});

test("a rating: the fields we keep, and nothing else", () => {
  const r = parseRating({ ...rating(), text: "Fine.", extra: "dropped" });
  assert.deepEqual(r, {
    rater,
    install: null,
    slug: "notero",
    addon: "notero@vanoni.me",
    version: "2.1.0",
    stars: 4,
    text: "Fine.",
    os: "mac",
    zotero: "10.0.7",
    atlas: "0.2.0",
  });
  assert.equal(
    parseRating(rating({ install: "4c9d3b2e-0000-4000-8000-000000000000" })).install,
    "4c9d3b2e-0000-4000-8000-000000000000",
  );
});

test("a rating: refused when a field is wrong", () => {
  for (const bad of [
    { stars: 0 },
    { stars: 6 },
    { stars: 4.5 },
    { stars: "5" },
    { rater: "abc" },
    { rater: "A".repeat(64) },
    { slug: "Notero" },
    { slug: "x" },
    { slug: "-x-" },
    { version: "" },
    { os: "beos" },
    { install: "not-a-uuid" },
    { text: 5 },
    { text: "x".repeat(2001) },
  ])
    assert.equal(parseRating(rating(bad)), null, JSON.stringify(bad));
  assert.equal(parseRating(null), null);
  assert.equal(parseRating("x"), null);
});

test("review text: links removed, blank lines squeezed, length capped", () => {
  assert.equal(
    cleanText("Great! See https://example.com/x and www.spam.top now"),
    "Great! See and now",
  );
  assert.equal(cleanText("Try [this](https://bad.example) instead"), "Try this instead");
  assert.equal(cleanText("buy at cheap-plugins.shop.xyz/deal today"), "buy at today");
  assert.equal(cleanText("a\n\n\n\nb"), "a\n\nb");
  assert.equal(cleanText("   "), null);
  assert.equal(cleanText("https://only.a.link"), null);
  assert.equal(cleanText("x".repeat(1500)).length, 1000);
  assert.equal(cleanText("Version 2.1.0 works in Zotero 10."), "Version 2.1.0 works in Zotero 10.");
  assert.equal(cleanText("zero​width"), "zerowidth");
});

test("email: one inbox, one key; throwaway services refused", () => {
  assert.equal(emailParts("Priya.S+zotero@GMail.com").key, "priyas@gmail.com");
  assert.equal(emailParts("p.r.i.y.a.s@googlemail.com").key, "priyas@gmail.com");
  assert.equal(emailParts("j.doe+x@uni.edu").key, "j.doe@uni.edu");
  assert.equal(emailParts("J.Doe@Uni.EDU").address, "j.doe@uni.edu");
  assert.equal(emailParts("x@mailinator.com").throwaway, true);
  assert.equal(emailParts("x@eu.yopmail.com").throwaway, true);
  assert.equal(emailParts("x@yopmail.fr").key, null);
  for (const bad of ["", "no-at", "a@b", "a b@c.com", "<a@b.com>", "@x.com", "+tag@x.com"])
    assert.equal(emailParts(bad), null, bad);
});

test("a website review: fields checked, name kept short", () => {
  const ok = parseWebReview({
    slug: "notero",
    version: "2.1.0",
    stars: 5,
    text: "Good",
    name: "Priya\nS.",
    email: "p@uni.edu",
    turnstile: "t",
  });
  assert.equal(ok.name, "Priya S.");
  assert.equal(ok.text, "Good");
  assert.equal(parseWebReview({ ...ok, turnstile: undefined }), null);
  assert.equal(
    parseWebReview({
      slug: "notero",
      version: "1",
      stars: 5,
      email: "p@uni.edu",
      turnstile: "t",
      name: "x".repeat(200),
    }).name.length,
    60,
  );
});

test("network prefix: IPv4 whole, IPv6 by its first 64 bits", () => {
  assert.equal(netPrefix("203.0.113.7"), "203.0.113.7");
  assert.equal(netPrefix("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(netPrefix("2001:db8:85a3:12::8a2e:370:7334"), "2001:0db8:85a3:0012");
  assert.equal(netPrefix("2001:db8::1"), "2001:0db8:0000:0000");
  assert.equal(netPrefix("2001:db8::1"), netPrefix("2001:db8:0:0:ffff:1:2:3"));
  for (const bad of [null, "", "999.1.1.1", "1.2.3", "2001:db8:::1", "hello", "1:2:3:4:5:6:7:8:9"])
    assert.equal(netPrefix(bad), null, String(bad));
});

test("network code: same key and address, same code; another key, another code", async () => {
  const k1 = "11".repeat(32);
  const k2 = "22".repeat(32);
  assert.equal(await hmacHex(k1, "203.0.113.7"), await hmacHex(k1, "203.0.113.7"));
  assert.notEqual(await hmacHex(k1, "203.0.113.7"), await hmacHex(k2, "203.0.113.7"));
  assert.match(await hmacHex(k1, "x"), /^[0-9a-f]{64}$/);
});

test("months and days", () => {
  assert.equal(previousMonth("2026-01"), "2025-12");
  assert.equal(previousMonth("2026-11"), "2026-10");
  assert.equal(daysBetween("2026-11-01T00:00:00Z", "2026-11-04T23:00:00Z"), 3);
  assert.equal(daysBetween("2026-11-01T00:00:00Z", "2026-11-01T00:10:00Z"), 0);
  assert.equal(daysBetween(null, "2026-11-01T00:00:00Z"), null);
});

test("the public file: per version, spread, reviews with text only, who wrote them", () => {
  const row = (o) => ({
    source: "atlas",
    slug: "notero",
    version: "2.1.0",
    stars: 5,
    text: null,
    name: null,
    zotero: "10.0.7",
    used_since: null,
    used_until: null,
    posted_at: "2026-11-05T10:00:00Z",
    ...o,
  });
  const out = publicRatings(
    [
      row({ stars: 5, text: "Great", used_since: "2025-09-01T00:00:00Z" }),
      row({ stars: 3 }),
      row({ stars: 4, version: "2.0.2", posted_at: "2026-10-01T00:00:00Z" }),
      row({
        source: "web",
        stars: 2,
        text: "Slow",
        name: null,
        zotero: null,
        posted_at: "2026-11-06T00:00:00Z",
      }),
      row({
        slug: "zoplicate",
        stars: 1,
        text: "Crashed",
        used_since: "2026-11-05T09:50:00Z",
        used_until: "2026-11-05T09:55:00Z",
      }),
    ],
    "2026-11-07T00:00:00Z",
  );
  const n = out.plugins.notero;
  assert.deepEqual(n.all, { count: 4, average: 3.5, stars: [0, 1, 1, 1, 1] });
  assert.deepEqual(n.versions["2.1.0"], { count: 3, average: 3.3, stars: [0, 1, 1, 0, 1] });
  assert.equal(n.reviews.length, 2);
  assert.deepEqual(
    n.reviews.map((r) => [r.by, r.from, r.posted]),
    [
      ["Anonymous", "website", "2026-11-06"],
      ["Zotero Atlas user", "zotero-atlas", "2026-11-05"],
    ],
  );
  assert.equal(n.reviews[1].usedDays, 430);
  assert.equal(n.reviews[0].zotero, null);
  assert.equal(out.plugins.zoplicate.reviews[0].usedDays, 0);
  assert.deepEqual(Object.keys(out.plugins), ["notero", "zoplicate"]);
});
