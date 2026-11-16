// node --test test-guides.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alertMail,
  buildReport,
  cardOf,
  htmlToParts,
  nextSnapshot,
  parseGuideUrl,
  problemText,
  repoOf,
  startSnapshot,
  unplaced,
} from "./guides.js";

const index = {
  generatedAt: "2026-11-16T00:00:00Z",
  currentMajor: 10,
  moved: { "olduser/zotero-thing": "zotero-thing" },
  plugins: [
    {
      s: "zotfile",
      n: "ZotFile",
      r: "jlegewie/zotfile",
      g: "C",
      b: "a settings button downloads a tool over http",
      st: "z6",
      w: "6",
      d: 2100000,
      al: ["ZotFile", "Zotfile", "zotfile"],
    },
    {
      s: "zotmoov",
      n: "ZotMoov",
      r: "wileyyugioh/zotmoov",
      g: "A",
      b: "every code check came out low",
      st: "ok",
      w: "7–10",
      d: 1000000,
      al: ["ZotMoov"],
    },
    {
      s: "zotero-better-notes",
      n: "Better Notes for Zotero",
      r: "windingwind/zotero-better-notes",
      g: "A",
      b: "low",
      st: "ok",
      w: "8–10",
      d: 12000000,
      al: ["Better Notes"],
    },
    {
      s: "zotero-actions-tags",
      n: "Actions and Tags for Zotero",
      r: "windingwind/zotero-actions-tags",
      g: "A",
      b: "low",
      st: "ok",
      w: "10",
      d: 2200000,
      al: ["Actions & Tags"],
    },
    {
      s: "zotero-pdf-background",
      n: "Zotero PDF Background",
      r: "wangqian06/zotero-pdf-background",
      g: "A",
      b: "low",
      st: "notcur",
      w: "7–9",
      d: 35000,
      ar: 1,
    },
    {
      s: "zotero-thing",
      n: "Zotero Thing",
      r: "newuser/zotero-thing",
      g: "B",
      b: "it launches programs",
      st: "ok",
      w: "7–10",
      d: 900,
    },
    {
      s: "zotero-plugins",
      n: "ZoteroPreview",
      r: "dcartertod/zotero-plugins",
      g: "A",
      b: "low",
      st: "ok",
      w: "7–10",
      d: 63000,
      mp: 1,
    },
    {
      s: "zotero-gpt",
      n: "Awesome GPT",
      r: "muisedestiny/zotero-gpt",
      g: "C",
      b: "runs encrypted code we can't read",
      st: "ok",
      w: "10–11 beta",
      d: 600000,
      al: ["Zotero-GPT"],
    },
  ],
};

const html = `<!doctype html><html><head><title>Zotero: Plugins &amp; add-ons - LibGuides</title>
<script>var x = "https://github.com/evil/notaplugin";</script></head><body>
<h1>Plugins</h1>
<p>See the <a href="https://www.zotero.org/support/plugins">official list</a>.</p>
<p><a href='https://github.com/jlegewie/zotfile/releases'>ZotFile</a> renames PDFs.</p>
<p><a href="https://github.com/q77190858/zotero-pdf-background/releases">PDF Background</a></p>
<p><a href="https://github.com/OldUser/zotero-thing">Thing</a> and <a href="/local/page">local</a>.</p>
<p>Try Better Notes for notes; take better notes in general. Zotero-GPT is an AI helper.</p>
<p>Actions &amp; Tags manages tags. ZotMoovers isn't a plugin. <a href="https://github.com/topics/zotero">topics</a></p>
<p><a href="https://zoteroplugins.org/p/zotmoov">ZotMoov on zoteroplugins.org</a></p>
<p><a href="https://github.com/someone/not-in-catalogue">Other</a></p>
<p><a href="https://github.com/dcartertod/zotero-plugins/tree/main/ZoteroAbstractCleaner">Zotero Abstract Cleaner</a></p>
<!-- <a href="https://github.com/hidden/comment">x</a> -->
</body></html>`;

test("parseGuideUrl accepts guide addresses and refuses the rest", () => {
  assert.equal(
    parseGuideUrl("libguides.example.edu/zotero/plugins")?.href,
    "https://libguides.example.edu/zotero/plugins",
  );
  assert.equal(parseGuideUrl("https://a.example.edu/x#frag")?.href, "https://a.example.edu/x");
  for (const bad of [
    "ftp://a.example.edu",
    "https://user:pw@a.example.edu",
    "http://localhost/x",
    "http://10.0.0.1/",
    "https://a.example.edu:8443/",
    "javascript:alert(1)",
    "",
    5,
  ])
    assert.equal(parseGuideUrl(bad), null, String(bad));
});

test("repoOf and cardOf read links", () => {
  assert.equal(
    repoOf("https://github.com/Wileyyugioh/ZotMoov/releases/tag/1.0"),
    "wileyyugioh/zotmoov",
  );
  assert.equal(repoOf("https://github.com/topics/zotero"), null);
  assert.equal(repoOf("https://github.com/jlegewie"), null);
  assert.equal(
    repoOf("https://retorque.re/zotero-better-bibtex/installation/"),
    "retorquere/zotero-better-bibtex",
  );
  assert.equal(repoOf("https://example.com/github.com/a/b"), null);
  assert.equal(cardOf("https://zoteroplugins.org/p/zotmoov"), "zotmoov");
  assert.equal(cardOf("https://zoteroplugins.org/p/zotmoov/review"), null);
});

test("the report finds linked, carded and named plugins, and nothing from scripts or comments", () => {
  const parts = htmlToParts(html, "https://libguides.example.edu/zotero/plugins");
  assert.equal(parts.title, "Zotero: Plugins & add-ons - LibGuides");
  assert.deepEqual(
    unplaced(
      { repos: new Map(parts.links.map((l) => [repoOf(l.href), ""]).filter(([r]) => r)) },
      index,
    ).sort(),
    ["q77190858/zotero-pdf-background", "someone/not-in-catalogue"],
  );
  const r = buildReport({
    url: "https://libguides.example.edu/zotero/plugins",
    title: parts.title,
    parts,
    index,
    resolved: { "q77190858/zotero-pdf-background": "wangqian06/zotero-pdf-background" },
    checkedAt: "2026-11-16T10:00:00Z",
  });
  const by = Object.fromEntries(r.plugins.map((x) => [x.slug, x]));
  assert.equal(r.zoteroList, true);
  assert.deepEqual(by.zotfile.problems, ["z6"]); // C isn't added for a plugin that can't load
  assert.equal(by.zotfile.how, "link");
  assert.deepEqual(by["zotero-pdf-background"].problems, ["notcur", "moved", "archived"]);
  assert.equal(by["zotero-pdf-background"].movedTo, "wangqian06/zotero-pdf-background");
  assert.deepEqual(by["zotero-thing"].problems, ["moved"]); // moved via the index's list
  assert.equal(by["zotero-better-notes"].how, "name"); // "Better Notes", not "better notes"
  assert.equal(by["zotero-actions-tags"].how, "name"); // matched after &amp; is decoded
  assert.deepEqual(by["zotero-gpt"].problems, ["notrec"]);
  assert.deepEqual(by["zotero-gpt"].notes, [
    "Graded C, not recommended, because runs encrypted code we can't read.",
  ]);
  assert.equal(
    by.zotmoov.okNote,
    "Works with Zotero 7–10. Graded A because every code check came out low.",
  );
  assert.equal(by.zotmoov.how, "card"); // "ZotMoovers" isn't a match, the card link is
  assert.deepEqual(r.unknown, ["someone/not-in-catalogue", "dcartertod/zotero-plugins"]);
  assert.ok(!by["zotero-plugins"]); // several plugins share that repository: not reported as one
  assert.ok(!r.plugins.some((x) => x.slug === "notaplugin"));
  assert.equal(r.counts.plugins, 7);
  assert.equal(r.counts.attention, 4);
  // Worst first: z6 before notcur before moved before notrec.
  assert.deepEqual(
    r.plugins.slice(0, 4).map((x) => x.slug),
    ["zotfile", "zotero-pdf-background", "zotero-thing", "zotero-gpt"],
  );
});

test("alerts need two runs in a row, and a problem that clears is forgotten", () => {
  const mk = (problems) => ({
    url: "https://g.example.edu/x",
    title: "Guide",
    currentMajor: 10,
    plugins: [{ slug: "a", name: "A", works: "7–9", grade: "A", because: "", problems }],
  });
  let snap = startSnapshot(mk([]));
  let step = nextSnapshot(snap, mk(["notcur"]));
  assert.equal(step.news.length, 0);
  step = nextSnapshot(step.snapshot, mk(["notcur"]));
  assert.equal(step.news.length, 1);
  step = nextSnapshot(step.snapshot, mk(["notcur"]));
  assert.equal(step.news.length, 0); // already sent
  step = nextSnapshot(step.snapshot, mk([]));
  step = nextSnapshot(step.snapshot, mk(["notcur"]));
  assert.equal(step.news.length, 0); // back again: pending first
  snap = startSnapshot(mk(["z6"]));
  assert.equal(nextSnapshot(snap, mk(["z6"])).news.length, 0); // known when the watch started
});

test("problem sentences and the alert email", () => {
  const x = {
    slug: "a",
    name: "A",
    works: "7–9",
    grade: "C",
    because: "it runs encrypted code",
    movedTo: "new/a",
    alt: null,
  };
  assert.equal(
    problemText("notcur", x, 10),
    "Doesn't work with the current Zotero (10); it works with Zotero 7–9.",
  );
  assert.equal(
    problemText("notrec", x, 10),
    "Graded C, not recommended, because it runs encrypted code.",
  );
  assert.equal(
    problemText("moved", x, 10),
    "Your link goes to its old address; it now lives at github.com/new/a.",
  );
  const m = alertMail(
    { url: "https://g.example.edu/x", title: "Zotero guide", currentMajor: 10 },
    [{ x, code: "notcur" }],
    "tok",
  );
  assert.equal(m.subject, "Your Zotero guide: a plugin needs attention");
  assert.match(m.text, /https:\/\/zoteroplugins\.org\/librarians\/check\?stop=tok/);
  assert.match(m.text, /https:\/\/zoteroplugins\.org\/p\/a/);
});
