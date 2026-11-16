/**
 * The guide check for libraries (zoteroplugins.org/librarians/check): read a library guide, find
 * the Zotero plugins it links or names, and say what our catalogue knows about each one today.
 * Pure functions, no I/O: worker.js fetches the page, the catalogue's short index
 * (zoteroplugins.org/data/guide-index.json) and GitHub's answer for repositories we don't know.
 *
 * Accuracy over recall: a plugin is matched by its repository link, a link to its card, or one of
 * a few hand-checked names (the index's `al`). Nothing is guessed from partial words.
 */

export const MAX_GUIDE_BYTES = 3_000_000;
export const MAX_LOOKUPS = 8;
export const SITE = "https://zoteroplugins.org";

/** Problems, in the order a report lists them. "ok" isn't one. */
export const PROBLEMS = [
  "removed",
  "retired",
  "z6",
  "notcur",
  "norelease",
  "moved",
  "notrec",
  "archived",
];

/** A guide address we'll fetch: http(s), a real host name, no user name or password, no odd port. */
export function parseGuideUrl(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2000) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return null;
  u.hash = "";
  return u;
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n =
        e[1] === "x" || e[1] === "X"
          ? Number.parseInt(e.slice(2), 16)
          : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The page's title, its links (absolute) and its visible text. */
export function htmlToParts(html, base) {
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const t = clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = t ? decodeEntities(t[1].replace(/\s+/g, " ").trim()).slice(0, 300) : "";
  const links = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const raw = decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
    let href;
    try {
      href = new URL(raw, base).href;
    } catch {
      continue;
    }
    const text = decodeEntities(
      m[4]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    ).slice(0, 200);
    links.push({ href, text });
    if (links.length >= 5000) break;
  }
  const body = clean.replace(/<head\b[\s\S]*?<\/head\s*>/i, " ");
  const text = decodeEntities(body.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  return { title, links, text };
}

/** GitHub paths that aren't repositories. */
const NOT_OWNERS = new Set(
  "about apps blog collections contact customer-stories enterprise events explore features issues login marketplace new notifications orgs pricing pulls readme search security settings site sponsors topics trending users signup codespaces".split(
    " ",
  ),
);

/** Plugin home pages that aren't on GitHub, by host and path prefix. */
const HOMEPAGES = [
  ["retorque.re", "/zotero-better-bibtex", "retorquere/zotero-better-bibtex"],
  ["zotfile.com", "", "jlegewie/zotfile"],
  ["www.zotfile.com", "", "jlegewie/zotfile"],
];

/** owner/name from a link to a GitHub repository (or a file in one), lower case; null otherwise. */
export function repoOf(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "github.com" || host === "www.github.com") {
    if (parts.length < 2) return null;
    const owner = parts[0].toLowerCase();
    if (NOT_OWNERS.has(owner)) return null;
    const name = parts[1].replace(/\.git$/i, "").toLowerCase();
    if (!/^[a-z0-9-]+$/.test(owner) || !/^[a-z0-9._-]+$/.test(name)) return null;
    return `${owner}/${name}`;
  }
  if (host === "raw.githubusercontent.com" && parts.length >= 2)
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  for (const [h, prefix, repo] of HOMEPAGES)
    if (host === h && (prefix === "" || u.pathname.toLowerCase().startsWith(prefix))) return repo;
  return null;
}

/** A link to a plugin card on zoteroplugins.org: its slug, or null. */
export function cardOf(href) {
  const m = href.match(/^https?:\/\/(?:www\.)?zoteroplugins\.org\/p\/([a-z0-9-]+)\/?(?:[?#].*)?$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Links to Zotero's own plugins page, which no longer lists plugins. */
export const isZoteroPluginList = (href) =>
  /^https?:\/\/(?:www\.)?zotero\.org\/support\/plugins\/?(?:[?#].*)?$/i.test(href);

/** One pass over the index: lookups by repository, slug and name. Cached per index object. */
const prepared = new WeakMap();
export function prepareIndex(index) {
  const hit = prepared.get(index);
  if (hit) return hit;
  const byRepo = new Map();
  const bySlug = new Map();
  const byAlias = new Map();
  for (const p of index.plugins) {
    byRepo.set(p.r, p);
    bySlug.set(p.s, p);
    for (const a of p.al ?? []) {
      const was = byAlias.get(a);
      if (!was || p.d > was.d) byAlias.set(a, p);
    }
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const aliases = [...byAlias.keys()].sort((a, b) => b.length - a.length);
  // Whole words only: not next to a letter, digit, hyphen or underscore.
  const nameRe = aliases.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_-])(${aliases.map(esc).join("|")})(?![\\p{L}\\p{N}_-])`, "gu")
    : null;
  const out = { byRepo, bySlug, byAlias, nameRe, moved: index.moved ?? {} };
  prepared.set(index, out);
  return out;
}

/**
 * What the page refers to: GitHub repositories (with the link text), plugin cards, names in the
 * text, and whether it sends readers to Zotero's old plugin list.
 */
export function refsOf(parts) {
  const repos = new Map();
  const cards = new Set();
  let zoteroList = false;
  for (const l of parts.links) {
    const r = repoOf(l.href);
    if (r && !repos.has(r)) repos.set(r, l.text);
    const c = cardOf(l.href);
    if (c) cards.add(c);
    if (isZoteroPluginList(l.href)) zoteroList = true;
  }
  if (/zotero\.org\/support\/plugins(?![\w/-])/i.test(parts.text)) zoteroList = true;
  return { repos, cards, zoteroList };
}

/** Repositories on the page we couldn't place from the index alone, to ask GitHub about. */
export function unplaced(refs, index) {
  const ix = prepareIndex(index);
  return [...refs.repos.keys()].filter((r) => !ix.byRepo.has(r) && !ix.moved[r]);
}

/** The problems a plugin has today, worst first. `movedTo` when the page links its old address. */
export function problemsOf(p, movedTo) {
  const out = [];
  if (p.st !== "ok") out.push(p.st);
  if (movedTo) out.push("moved");
  // A plugin that can't be installed at all needs nothing more said about it.
  if (p.st === "removed" || p.st === "z6" || p.st === "norelease") return out;
  if (p.g === "C") out.push("notrec");
  if (p.ar) out.push("archived");
  return out;
}

/**
 * The report. `resolved` maps a repository GitHub redirected (renamed or transferred) to its new
 * owner/name; repositories still unknown after that are listed as not in the catalogue.
 */
export function buildReport({ url, title, parts, index, resolved = {}, checkedAt }) {
  const ix = prepareIndex(index);
  const refs = refsOf(parts);
  const found = new Map();
  const add = (p, how, extra = {}) => {
    const was = found.get(p.s);
    // A link beats a name; keep the first link's details.
    if (was && (was.how !== "name" || how === "name")) return;
    found.set(p.s, { p, how, ...extra });
  };
  const unknown = [];
  for (const [repo, text] of refs.repos) {
    let p = ix.byRepo.get(repo);
    // A repository holding several plugins: the link doesn't say which one we'd be reporting on.
    if (p?.mp) p = undefined;
    let movedTo = null;
    if (!p) {
      const viaIndex = ix.moved[repo];
      const viaGithub = resolved[repo];
      if (viaIndex) p = ix.bySlug.get(viaIndex);
      else if (viaGithub) p = ix.byRepo.get(viaGithub);
      if (p) movedTo = p.r;
    }
    if (p) add(p, "link", { linked: repo, movedTo, text });
    else unknown.push(repo);
  }
  for (const slug of refs.cards) {
    const p = ix.bySlug.get(slug);
    if (p) add(p, "card");
  }
  const names = new Map();
  if (ix.nameRe) {
    ix.nameRe.lastIndex = 0;
    for (let m = ix.nameRe.exec(parts.text); m; m = ix.nameRe.exec(parts.text)) {
      const p = ix.byAlias.get(m[1]);
      if (p && !names.has(p.s)) names.set(p.s, m[1]);
    }
  }
  for (const [slug, said] of names) {
    const p = ix.bySlug.get(slug);
    if (p) add(p, "name", { said });
  }
  const plugins = [...found.values()].map(
    ({ p, how, linked = null, movedTo = null, said = null }) => ({
      slug: p.s,
      name: p.n,
      how,
      linked,
      movedTo,
      said,
      status: p.st,
      grade: p.g,
      because: p.b,
      works: p.w,
      archived: Boolean(p.ar),
      alt: p.alt ?? null,
      problems: problemsOf(p, movedTo),
    }),
  );
  // The sentences, once, so the web report and the emails say the same thing.
  for (const x of plugins) {
    x.notes = x.problems.map((c) => problemText(c, x, index.currentMajor));
    if (!x.problems.length) x.okNote = okText(x);
  }
  const rank = (x) => (x.problems.length ? PROBLEMS.indexOf(x.problems[0]) : PROBLEMS.length);
  plugins.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return {
    url,
    title,
    checkedAt,
    currentMajor: index.currentMajor,
    indexDate: index.generatedAt,
    zoteroList: refs.zoteroList,
    plugins,
    unknown: unknown.slice(0, 50),
    counts: {
      plugins: plugins.length,
      attention: plugins.filter((x) => x.problems.length).length,
    },
  };
}

/** One sentence per problem, as the report and the emails say it. */
export function problemText(code, x, currentMajor) {
  switch (code) {
    case "removed":
      return "Removed from GitHub by its developer: it can't be installed or updated any more.";
    case "retired":
      return x.alt
        ? `Retired by its developer, who points to ${x.alt.n} instead.`
        : "Retired by its developer: it won't be updated.";
    case "z6":
      return "Made for Zotero 6: Zotero 7 and later can't load it.";
    case "notcur":
      return x.works
        ? `Doesn't work with the current Zotero (${currentMajor}); it works with Zotero ${x.works}.`
        : `Doesn't work with the current Zotero (${currentMajor}).`;
    case "norelease":
      return "Has no release file to install.";
    case "moved":
      return `Your link goes to its old address; it now lives at github.com/${x.movedTo}.`;
    case "notrec":
      return `Graded C, not recommended, because ${x.because}.`;
    case "archived":
      return "Its repository is archived: it may still work, but it won't get fixes.";
    default:
      return "";
  }
}

/** What a plugin is fine on, for the report's other list. */
export function okText(x) {
  const works = x.works ? `Works with Zotero ${x.works}. ` : "";
  return `${works}Graded ${x.grade} because ${x.because}.`;
}

/**
 * Snapshot for alerts: { alerted: {slug: [codes]}, pending: {slug: [codes]} }. A problem is
 * emailed when it's seen on two runs in a row, so a one-night glitch in our data (or in GitHub's)
 * doesn't send anyone to fix a guide that's fine. A problem that goes away is forgotten, so if it
 * comes back it's emailed again.
 */
export function startSnapshot(report) {
  const alerted = {};
  for (const x of report.plugins) if (x.problems.length) alerted[x.slug] = [...x.problems];
  return { alerted, pending: {} };
}

export function nextSnapshot(prev, report) {
  const alerted = {};
  const pending = {};
  const news = [];
  const put = (into, slug, code) => {
    if (!into[slug]) into[slug] = [];
    into[slug].push(code);
  };
  for (const x of report.plugins) {
    for (const code of x.problems) {
      const wasAlerted = prev.alerted?.[x.slug]?.includes(code);
      const wasPending = prev.pending?.[x.slug]?.includes(code);
      if (wasAlerted) put(alerted, x.slug, code);
      else if (wasPending) {
        put(alerted, x.slug, code);
        news.push({ x, code });
      } else put(pending, x.slug, code);
    }
  }
  return { snapshot: { alerted, pending }, news };
}

export const checkLink = (guideUrl) =>
  `${SITE}/librarians/check?url=${encodeURIComponent(guideUrl)}`;

const FOOTER =
  "zoteroplugins.org is a free, non-commercial catalogue that checks the code of Zotero plugins. Questions or corrections: reply to this email.";

export function confirmMail(guideUrl, token) {
  return {
    subject: "Confirm: watch your Zotero guide",
    text: `Hello,

Someone (we hope you) asked zoteroplugins.org to watch this guide and email this address when a Zotero plugin it names stops working, is removed, moves or gets a lower grade:

${guideUrl}

To start, open this link within 24 hours:
${SITE}/librarians/check?confirm=${token}

If you didn't ask for this, ignore this email and nothing happens.

${FOOTER}
`,
  };
}

export function alertMail(report, news, stopToken) {
  const n = new Set(news.map((e) => e.x.slug)).size;
  const lines = [];
  for (const { x, code } of news)
    lines.push(
      `- ${x.name}: ${problemText(code, x, report.currentMajor)}\n  Its page: ${SITE}/p/${x.slug}`,
    );
  return {
    subject:
      n === 1
        ? "Your Zotero guide: a plugin needs attention"
        : `Your Zotero guide: ${n} plugins need attention`,
    text: `Hello,

We checked your guide today${report.title ? `, "${report.title}"` : ""}:
${report.url}

What changed:

${lines.join("\n\n")}

The full report for your guide: ${checkLink(report.url)}

You get these emails because you asked us to watch this guide. To stop them (this deletes your address and the guide from our list): ${SITE}/librarians/check?stop=${stopToken}

${FOOTER}
`,
  };
}

export function unreachableMail(guideUrl) {
  return {
    subject: "We can't read your Zotero guide any more",
    text: `Hello,

For two weeks we couldn't open the guide you asked us to watch:
${guideUrl}

We've stopped watching it and deleted your address. If the guide has moved, you can watch its new address here: ${SITE}/librarians/check

(If you'd rather we kept trying, just reply to this email.)

${FOOTER}
`,
  };
}
