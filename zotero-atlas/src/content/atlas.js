/* global Zotero, window, document */
// The Zotero Atlas window: the catalogue and the plugins installed here. Everything it knows
// comes from Zotero.ZoteroAtlas (bootstrap.js); this file only draws it.
(() => {
  const A = Zotero.ZoteroAtlas;
  const JOBS = [
    ["reading", "Reading & PDFs"],
    ["citing", "Citing & writing"],
    ["ai", "AI & summaries"],
    ["translation", "Translation"],
    ["organising", "Organising & tags"],
    ["metadata", "Import & metadata"],
    ["interface", "Interface & look"],
    ["files", "Files, sync & backup"],
  ];
  const JOB_TITLE = Object.fromEntries(JOBS);
  const FLAG_TEXT = {
    blocked: "Blocked by Zotero's blocklist",
    "worse-update": "The update offered is graded worse",
    "grade-drop": "Grade dropped",
    "disabled-fix": "Disabled by Zotero: not for this version. A version that works is listed",
    disabled: "Disabled by Zotero: no listed version works with this Zotero",
    outdated: "A newer version is listed",
    "not-listed": "Not in the directory",
  };
  const LOUD = new Set(["blocked", "worse-update"]);
  const PAGE = 150;

  const zv = Zotero.version;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const link = (text, url) => {
    const a = el("a", "", text);
    a.href = "#";
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      A.openPage(url);
    });
    return a;
  };
  const num = (n) =>
    n === null || n === undefined
      ? ""
      : n >= 1000
        ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
        : String(n);
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString() : "");

  let data = null; // the catalogue
  let items = []; // the review of installed plugins
  let byId = new Map(); // addon ID → review item
  let shown = PAGE;

  function status(text) {
    $("status").textContent = text;
  }

  function gradePill(g) {
    return el("span", `grade g-${g === "–" ? "none" : g}`, g === "–" ? "?" : g);
  }

  function installedFor(entry) {
    return entry.id ? byId.get(entry.id) : undefined;
  }

  /** The row's button: what clicking Install would do for this Zotero. */
  function action(entry) {
    const build = A.fileFor(entry, zv);
    const mine = installedFor(entry);
    const btn = el("button", "", "Install");
    const note = el("span", "note");
    if (mine?.same) {
      btn.textContent = "Installed";
      btn.disabled = true;
    } else if (!build) {
      btn.textContent = "Not for your Zotero";
      btn.disabled = true;
      note.textContent = entry.supports.length
        ? `Works with Zotero ${entry.supports.join(", ")}`
        : "Zotero won't install this release";
    } else if (!build.sha256) {
      btn.textContent = "Not analysed";
      btn.disabled = true;
      note.textContent = "We haven't checked this file";
    } else {
      btn.textContent = mine ? `Update to ${entry.version}` : "Install";
      btn.className = entry.grade === "C" ? "" : "primary";
      if (entry.grade === "C") note.textContent = "Serious concerns found: read the card first";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Installing…";
        const r = await A.install(entry, build, window);
        if (r.ok) status(r.message);
        else if (!r.cancelled) Zotero.alert(window, "Zotero Atlas", r.message);
        await refreshInstalled();
      });
    }
    const act = el("div", "act");
    act.append(btn);
    if (note.textContent) act.append(note);
    return act;
  }

  function needsLine(entry) {
    const n = entry.needs;
    const parts = [];
    if (n.apiKey === "required")
      parts.push(`needs an API key${n.services.length ? ` (${n.services.join(", ")})` : ""}`);
    else if (n.apiKey === "optional")
      parts.push(`API key optional${n.services.length ? ` (${n.services.join(", ")})` : ""}`);
    else if (n.services.length) parts.push(`can use ${n.services.join(", ")}`);
    if (n.localModel) parts.push("can use a local model");
    if (n.launchesPrograms) parts.push("launches programs");
    return parts.join(" · ");
  }

  /** "★ 4.6 (96 ratings of 2.1.0)" once the listed version has 10, "too few ratings yet" before. */
  function ratingText(entry) {
    const r = entry.ratings;
    if (!r?.count) return "";
    const v = r.version;
    if (v && v.count >= 10)
      return `★ ${v.average.toFixed(1)} (${v.count} ratings of ${entry.version})`;
    return "too few ratings yet";
  }

  const SENT =
    "Sent to zoteroatlas.com when you click Post: the plugin and version, your stars and review, " +
    "your Zotero version and operating system, and a scrambled ID for this Zotero, so rating " +
    "again replaces your rating. Never your library, your Zotero account or your email. We never " +
    "store your IP address: a scrambled code made from it is kept for 30 days to catch fake reviews.";

  /** Stars and an optional review for one installed (or recently removed) version. */
  function rateBox(target) {
    const box = el("div", "rate");
    const closed = () => {
      box.textContent = "";
      const mine = A.ratings.rated(target.slug, target.version);
      const open = el(
        "button",
        "linkish",
        mine
          ? `You rated ${target.version} ${"★".repeat(mine.stars)}. Change your rating`
          : `Rate ${target.version}`,
      );
      open.type = "button";
      open.addEventListener("click", () => form(mine?.stars ?? 0));
      box.append(open);
    };
    const form = (start) => {
      box.textContent = "";
      let stars = start;
      const group = el("div", "stars");
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", `Your rating of ${target.name} ${target.version}`);
      const buttons = [];
      const paint = () =>
        buttons.forEach((b, i) => {
          b.classList.toggle("on", i < stars);
          b.textContent = i < stars ? "★" : "☆";
          b.setAttribute("aria-checked", String(i + 1 === stars));
        });
      for (let n = 1; n <= 5; n++) {
        const b = el("button", "star", "★");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-label", `${n} star${n === 1 ? "" : "s"}`);
        b.addEventListener("click", () => {
          stars = n;
          paint();
        });
        buttons.push(b);
        group.append(b);
      }
      paint();
      const text = document.createElement("textarea");
      text.rows = 3;
      text.maxLength = 1000;
      text.placeholder = "A review, if you'd like: what you used it for, what worked, what didn't";
      text.setAttribute("aria-label", "Your review (optional)");
      const msg = el("p", "note");
      const post = el("button", "primary", "Post");
      post.type = "button";
      const cancel = el("button", "", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", closed);
      post.addEventListener("click", async () => {
        if (!stars) {
          msg.textContent = "Choose from one to five stars first.";
          return;
        }
        post.disabled = true;
        msg.textContent = "Sending…";
        const r = await A.ratings.rate({ ...target, stars, text: text.value }, window);
        if (!r.ok) {
          post.disabled = false;
          msg.textContent = r.message;
          return;
        }
        closed();
        box.prepend(el("p", "note", r.message));
      });
      const act = el("div", "rate-actions");
      act.append(post, cancel);
      box.append(
        group,
        text,
        el(
          "p",
          "note",
          "Public, shown as “Zotero Atlas user” with your Zotero version. Links are removed.",
        ),
        act,
        msg,
        el("p", "note fine", SENT),
      );
    };
    closed();
    return box;
  }

  function row(entry, flags) {
    const r = el("div", "row");
    const main = el("div", "main");
    const title = el("div", "title");
    title.append(
      gradePill(entry.grade),
      link(entry.name, entry.page),
      el("span", "ver", entry.version),
    );
    const meta = [];
    if (entry.downloads) meta.push(`${num(entry.downloads)} downloads`);
    const rating = ratingText(entry);
    if (rating) meta.push(rating);
    if (entry.jobs.length) meta.push(entry.jobs.map((j) => JOB_TITLE[j] || j).join(", "));
    if (entry.lastReleaseAt) meta.push(`updated ${date(entry.lastReleaseAt)}`);
    title.append(el("span", "meta", meta.join(" · ")));
    main.append(title);
    if (entry.summary) main.append(el("p", "summary", entry.summary));
    const why = el("div", "why");
    why.append(
      el(
        "span",
        "",
        `${entry.grade === "–" ? "Not graded yet" : `Grade ${entry.grade}`}: ${entry.because}.`,
      ),
    );
    const needs = needsLine(entry);
    if (needs) why.append(el("span", "", ` ${needs[0].toUpperCase()}${needs.slice(1)}.`));
    if (entry.tested)
      why.append(
        el(
          "span",
          "",
          ` Live test in Zotero ${entry.tested.zotero}: ${entry.tested.verdict.replace(/-/g, " ")}.`,
        ),
      );
    why.append(
      el("br"),
      link("Full card on zoteroplugins.org", entry.page),
      link("GitHub", entry.repo),
    );
    if (entry.ratings?.count) why.append(link("Reviews", `${entry.page}#reviews`));
    main.append(why);
    for (const f of flags || []) {
      if (f === "outdated") continue;
      main.append(el("span", `flag ${LOUD.has(f) ? "loud" : "quiet"}`, FLAG_TEXT[f] || f));
    }
    r.append(main, action(entry));
    return r;
  }

  function filtered() {
    const q = $("q").value.trim().toLowerCase();
    const job = $("job").value;
    const fit = $("fit").checked;
    const sort = $("sort").value;
    let list = data.plugins;
    if (fit) list = list.filter((p) => A.fileFor(p, zv));
    if (job) list = list.filter((p) => p.jobs.includes(job));
    if (q) {
      const words = q.split(/\s+/);
      list = list.filter((p) => {
        const hay = `${p.name} ${p.summary || ""} ${p.slug} ${p.jobs.join(" ")}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    if (sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "updated")
      list = [...list].sort((a, b) => (b.lastReleaseAt || "").localeCompare(a.lastReleaseAt || ""));
    else if (sort === "grade")
      list = [...list].sort(
        (a, b) => A.RANK[b.grade] - A.RANK[a.grade] || (b.downloads || 0) - (a.downloads || 0),
      );
    return list;
  }

  function renderFind() {
    if (!data) return;
    const list = $("list");
    list.textContent = "";
    const all = filtered();
    if (!all.length) list.append(el("div", "empty", "No plugins match."));
    for (const p of all.slice(0, shown)) list.append(row(p, installedFor(p)?.flags));
    $("more").hidden = all.length <= shown;
    $("more").textContent = `Show more (${all.length - Math.min(shown, all.length)} left)`;
    $("foot").textContent =
      `${all.length} of ${data.plugins.length} plugins · catalogue from ${date(data.generatedAt)}, graded for Zotero ${data.currentZotero} · you run Zotero ${zv} · usage data: ${A.usage.choice() === "yes" ? "on" : "off"} (Zotero settings → Zotero Atlas)`;
  }

  function renderMine() {
    const list = $("mine-list");
    list.textContent = "";
    const worth = items.filter((i) => i.flags.some((f) => f !== "outdated" && f !== "not-listed"));
    $("mine-count").textContent = worth.length ? String(worth.length) : "";
    $("mine-lead").textContent = items.length
      ? `${items.length} plugins installed. ${worth.length ? `${worth.length} worth a look.` : "Nothing needs your attention."}`
      : "No other plugins are installed.";
    const order = (i) =>
      i.flags.some((f) => LOUD.has(f))
        ? 0
        : i.flags.some((f) => f !== "outdated" && f !== "not-listed")
          ? 1
          : i.entry
            ? 2
            : 3;
    for (const i of [...items].sort(
      (a, b) => order(a) - order(b) || a.addon.name.localeCompare(b.addon.name),
    )) {
      if (i.entry) {
        const r = row(i.entry, i.flags);
        const ver = r.querySelector(".ver");
        ver.textContent = i.same
          ? `${i.addon.version} installed`
          : `${i.addon.version} installed · ${i.entry.version} listed`;
        if (!i.same)
          r.querySelector(".why").prepend(
            el("span", "", `The grade is for version ${i.entry.version}. `),
          );
        if (!i.addon.enabled) r.querySelector(".title").append(el("span", "meta", "disabled"));
        r.querySelector(".main").append(
          rateBox({
            slug: i.entry.slug,
            addon: i.addon.id,
            version: i.addon.version,
            name: i.entry.name,
          }),
        );
        list.append(r);
      } else {
        const r = el("div", "row");
        const main = el("div", "main");
        const title = el("div", "title");
        title.append(
          gradePill("–"),
          el("span", "name", i.addon.name),
          el("span", "ver", `${i.addon.version} installed`),
        );
        main.append(
          title,
          el("span", "flag quiet", "Not in the directory, so nothing is known about it."),
        );
        const why = el("div", "why");
        why.append(link("Submit it to zoteroplugins.org", `${A.SITE}/submit`));
        main.append(why);
        r.append(main);
        list.append(r);
      }
    }
    // Removed in the last month: still worth a rating, above all from someone who removed it fast.
    const gone = A.ratings.removed().sort((a, b) => b.at - a.at);
    if (gone.length) list.append(el("h3", "sub", "Removed in the last 30 days"));
    for (const g of gone) {
      const r = el("div", "row");
      const main = el("div", "main");
      const title = el("div", "title");
      title.append(
        gradePill("–"),
        el("span", "name", g.name),
        el("span", "ver", `${g.version} · removed ${new Date(g.at).toLocaleDateString()}`),
      );
      main.append(title, rateBox({ slug: g.slug, addon: g.id, version: g.version, name: g.name }));
      r.append(main);
      list.append(r);
    }
  }

  async function refreshInstalled(force) {
    const rv = await A.review(Boolean(force));
    items = rv.items;
    byId = new Map(items.filter((i) => i.entry).map((i) => [i.addon.id, i]));
    renderMine();
    renderFind();
  }

  async function load(force) {
    status(force ? "Fetching the catalogue…" : "Loading…");
    $("refresh").disabled = true;
    try {
      data = await A.catalog(Boolean(force));
      await refreshInstalled(false);
      status("");
    } catch (e) {
      status(String(e.message || e));
    }
    $("refresh").disabled = false;
  }

  function showTab(which) {
    $("find").hidden = which !== "find";
    $("mine").hidden = which !== "mine";
    $("tab-find").classList.toggle("on", which === "find");
    $("tab-mine").classList.toggle("on", which === "mine");
  }

  window.addEventListener("load", () => {
    for (const [slug, title] of JOBS) {
      const o = document.createElement("option");
      o.value = slug;
      o.textContent = title;
      $("job").append(o);
    }
    $("fit-label").textContent = `Works with Zotero ${zv}`;
    $("tab-find").addEventListener("click", () => showTab("find"));
    $("tab-mine").addEventListener("click", () => showTab("mine"));
    $("refresh").addEventListener("click", () => load(true));
    for (const id of ["q", "job", "sort", "fit"]) {
      $(id).addEventListener("input", () => {
        shown = PAGE;
        renderFind();
      });
      $(id).addEventListener("change", () => {
        shown = PAGE;
        renderFind();
      });
    }
    $("more").addEventListener("click", () => {
      shown += PAGE;
      renderFind();
    });
    load(false);
  });
})();
