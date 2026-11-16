/* global window, document */
// Find plugins: the Discover page, search results, a plugin's page, a plugin pack, and the sheet
// every install goes through. Drawn from the catalogue Zotero.ZoteroAtlas fetched; atlas.js owns
// the window and hands over what it knows (the catalogue, what's installed, its helpers).
window.ZoteroAtlasFind = (ctx) => {
  const { A, zv, el, gradePill, status, JOBS, JOB_TITLE } = ctx;
  const $ = (id) => document.getElementById(id);
  const major = String(zv).split(".")[0];

  const GRADE_LONG = {
    "A+": "Recommended, tested in Zotero",
    A: "Recommended",
    B: "Use with care",
    C: "Not recommended",
    "–": "Not graded yet",
  };
  const PICK_GRADES = new Set(["A+", "A"]);
  const JOB_EG = {
    reading: "Outlines, highlights, reader tools",
    citing: "Word, LibreOffice, LaTeX, Markdown",
    ai: "Summaries, outlines, chat with papers",
    translation: "PDFs, metadata, notes",
    organising: "Tags, collections, duplicates",
    metadata: "DOIs, journals, retractions",
    interface: "Columns, themes, shortcuts",
    files: "Attachments, storage, export",
  };
  const TRIES = ["cite in Word", "translate PDFs", "summarise a paper", "find duplicates"];
  const PAGE = 60;
  const NO_PAID =
    "No ads and no paid listings: nobody can buy a place on these shelves or a better grade.";

  let view = { name: "home" };
  const stack = []; // earlier views, with where they were scrolled to
  let shown = PAGE;
  let closeSheet = null;
  let cache = { data: null, bySlug: new Map(), hay: new Map() };

  // -------------------------------------------------------------------------------------------
  // The catalogue and what's installed

  function catalogue() {
    const d = ctx.getData();
    if (d !== cache.data) {
      cache = {
        data: d,
        bySlug: new Map((d?.plugins || []).map((e) => [e.slug, e])),
        hay: new Map(),
      };
    }
    return d;
  }
  const entry = (slug) => (catalogue(), cache.bySlug.get(slug));
  const fits = (e) => Boolean(A.fileFor(e, zv));
  const good = (e) => fits(e) && !e.blocked;
  const mine = (e) => ctx.installedFor(e);
  const use = (e) => (typeof e.inUse === "number" ? e.inUse : null);
  const byUse = (a, b) =>
    (use(b) ?? -1) - (use(a) ?? -1) || (b.downloads || 0) - (a.downloads || 0);
  const owner = (e) => (e.repo || "").replace(/^https:\/\/github\.com\//, "").split("/")[0];
  const lineOf = (e) => e.line || (e.summary || "").split(/(?<=\.)\s/)[0] || "";

  /** 572,471 → "570k", 1,234,567 → "1.2M", 840 → "840": two significant figures, as on the site. */
  function fmtUse(n) {
    if (n < 1000) return String(n < 100 ? n : Math.round(n / 10) * 10);
    const r = Number(n.toPrecision(2));
    return r >= 1e6 ? `${r / 1e6}M` : `${r / 1000}k`;
  }
  const fmtStars = (n) =>
    n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;
  const day = (iso) =>
    iso
      ? new Date(iso).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";
  const short = (list, n = 2) =>
    list.length <= n
      ? list.join(", ")
      : `${list.slice(0, n).join(", ")} and ${list.length - n} more`;

  const gradeText = (e) =>
    e.grade === "–" ? "Not graded yet." : `${GRADE_LONG[e.grade]}: ${e.because}.`;

  /** What it needs from you, as sentences for the sheet and the plugin's page. */
  function needs(e) {
    const n = e.needs || {};
    const svc = n.services || [];
    const out = [];
    if (n.apiKey === "required")
      out.push(`Needs your own API key${svc.length ? ` (${short(svc, 3)})` : ""}.`);
    else if (n.apiKey === "optional")
      out.push(
        svc.length
          ? `Works without an API key; some services need yours (${short(svc, 3)}).`
          : "Works without an API key; some features need one.",
      );
    else if (svc.length) out.push(`Can use ${short(svc, 3)}.`);
    if (n.localModel) out.push("Can use a model on this computer.");
    if (n.launchesPrograms) out.push("Launches programs on your computer.");
    if (e.docsChineseOnly) out.push("Its instructions are in Chinese.");
    return out;
  }

  /** The same, as short labels under a search result. */
  function needChips(e) {
    const n = e.needs || {};
    const svc = n.services || [];
    const out = [];
    if (n.apiKey === "required") out.push(`API key needed${svc.length ? `: ${short(svc)}` : ""}`);
    else if (n.apiKey === "optional")
      out.push(`API key optional${svc.length ? `: ${short(svc)}` : ""}`);
    else if (svc.length) out.push(`Can use ${short(svc)}`);
    if (n.localModel) out.push("Local model");
    if (n.launchesPrograms) out.push("Launches programs");
    if (e.docsChineseOnly) out.push("Docs in Chinese");
    return out;
  }

  /** "★ 4.6 (96 ratings of 2.1.0)" once the listed version has 10; "" before. */
  function ratingText(e) {
    const v = e.ratings?.version;
    return v && v.count >= 10 && v.average != null
      ? `★ ${v.average.toFixed(1)} (${v.count} ratings of ${e.version})`
      : "";
  }

  // -------------------------------------------------------------------------------------------
  // Small pieces

  /** A link that opens another view of Find plugins. */
  function viewLink(child, next, cls = "") {
    const a = el("a", cls);
    a.href = "#";
    if (typeof child === "string") a.textContent = child;
    else a.append(child);
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      go(next);
    });
    return a;
  }
  const pluginLink = (child, e, cls) => viewLink(child, { name: "plugin", slug: e.slug }, cls);

  /** The plugin's own icon from the directory's repository, or its initial on a tint. */
  function icon(e, size) {
    const tile = () => {
      let h = 0;
      for (const c of e.slug || "") h = (h * 31 + c.charCodeAt(0)) % 6;
      const t = el("span", `icon tile t${h}`, (e.name || "?").trim().charAt(0).toUpperCase());
      t.style.width = `${size}px`;
      t.style.height = `${size}px`;
      t.style.fontSize = `${Math.round(size * 0.42)}px`;
      t.setAttribute("aria-hidden", "true");
      return t;
    };
    const url = A.iconURL(e);
    if (!url) return tile();
    const img = document.createElement("img");
    img.className = "icon";
    img.width = size;
    img.height = size;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => img.replaceWith(tile()), { once: true });
    img.src = url;
    return img;
  }

  function section(title, sub, more) {
    const s = el("div", "shelf");
    const head = el("div", "shelf-head");
    const t = el("div", "shelf-title");
    t.append(el("h2", "", title));
    if (sub) t.append(el("p", "", sub));
    head.append(t);
    if (more) head.append(viewLink("See all", more, "see-all"));
    s.append(head);
    return s;
  }

  /**
   * The install button for one plugin, in whichever state applies: Installed, Update to X,
   * Install (never the blue one for a C), Not for this Zotero, Not checked yet.
   */
  function action(e, { big = false, compact = false } = {}) {
    const wrap = el("div", big ? "act big" : "act");
    const build = A.fileFor(e, zv);
    const have = mine(e);
    const b = el("button", "ibtn", "Install");
    b.type = "button";
    let note = "";
    if (have?.same) {
      b.textContent = have.addon.enabled ? "Installed" : "Turned off";
      b.disabled = true;
      b.classList.add("done");
    } else if (!build) {
      b.textContent = `Not for Zotero ${major}`;
      b.disabled = true;
      note = e.supports?.length
        ? `Works with Zotero ${e.supports.join(", ")}`
        : "Zotero won't install this release";
    } else if (!build.sha256) {
      b.textContent = "Not checked yet";
      b.disabled = true;
      note = "We haven't analysed this file";
    } else {
      b.textContent = have ? `Update to ${e.version}` : "Install";
      if (e.grade === "C") note = "Serious concerns: read why first";
      else b.classList.add(big ? "primary" : "soft");
      b.addEventListener("click", () =>
        sheet([e], b, async () => {
          b.disabled = true;
          b.textContent = "Installing…";
          const r = await A.installChecked(e, build);
          if (r.ok) status(r.message);
          else if (!r.cancelled) ctx.alert(r.message);
          await ctx.refreshInstalled();
        }),
      );
    }
    if (big) note = note || (b.disabled ? "" : `The file we checked · for Zotero ${major}`);
    wrap.append(b);
    // Shelves say why a C is a C in the row itself; there the note is the button's tooltip.
    if (note && !compact) wrap.append(el("span", "note", note));
    else if (note) b.title = note;
    return wrap;
  }

  /** Name, line, grade, in use: a compact row for the Discover shelves. */
  function shelfRow(e, { rank, extra } = {}) {
    const r = el("div", "srow");
    if (rank) r.append(el("span", "rank", String(rank)));
    const main = el("span", "smain");
    const text = el("span", "stext");
    text.append(el("span", "sname", e.name), el("span", "sline", lineOf(e)));
    const meta = el("span", "smeta");
    meta.append(gradePill(e.grade));
    if (use(e) != null) meta.append(el("span", "", `${fmtUse(use(e))} in use`));
    if (extra) meta.append(el("span", "", extra));
    else if (e.stars) meta.append(el("span", "", `GitHub ${fmtStars(e.stars)}`));
    text.append(meta);
    if (e.grade === "C") text.append(el("span", "swhy", `Not recommended: ${e.because}.`));
    main.append(icon(e, 40), text);
    r.append(pluginLink(main, e, "slink"), action(e, { compact: true }));
    return r;
  }

  // -------------------------------------------------------------------------------------------
  // Views and going between them

  function go(next) {
    stack.push({ view, scroll: $("find").scrollTop });
    view = next;
    shown = PAGE;
    if (next.name === "list") $("q").value = next.q || "";
    else if (next.name === "home") $("q").value = "";
    render();
    $("find").scrollTop = 0;
  }

  function back() {
    const prev = stack.pop();
    if (!prev) return false;
    view = prev.view;
    $("q").value = view.name === "list" ? view.q || "" : "";
    shown = PAGE;
    render();
    $("find").scrollTop = prev.scroll;
    return true;
  }

  function home() {
    stack.length = 0;
    view = { name: "home" };
    $("q").value = "";
    render();
    $("find").scrollTop = 0;
  }

  /** Typing in the search box opens the results; emptying it goes back to where you were. */
  function onSearch() {
    const q = $("q").value;
    if (view.name === "list") {
      view.q = q;
      if (!q.trim() && view.typed && !view.job) {
        back();
        return;
      }
      if (q.trim() && view.sort === "used" && view.typed) view.sort = "match";
      shown = PAGE;
      render();
    } else if (q.trim()) {
      go({
        name: "list",
        q,
        job: "",
        sort: "match",
        fit: true,
        grade: "",
        nokey: false,
        typed: true,
      });
    }
  }

  function render() {
    const box = $("fview");
    if (!box) return;
    const d = catalogue();
    $("back").hidden = stack.length === 0;
    box.textContent = "";
    if (!d) {
      box.append(el("div", "empty", "Loading the catalogue…"));
      return;
    }
    box.className = `fview v-${view.name}`;
    if (view.name === "list") renderList(box, d);
    else if (view.name === "plugin") renderPlugin(box, d);
    else if (view.name === "pack") renderPack(box, d);
    else renderHome(box, d);
  }

  /** Redraw in place (new install, new catalogue), keeping where you'd scrolled to. */
  function refresh() {
    const top = $("find").scrollTop;
    render();
    $("find").scrollTop = top;
  }

  // -------------------------------------------------------------------------------------------
  // Discover

  function renderHome(box, d) {
    const S = d.shelves || null;
    const fitting = d.plugins.filter(good);
    const tries = el("div", "tries");
    tries.append(el("span", "muted", "Try"));
    for (const t of TRIES) {
      const c = el("button", "chip", t);
      c.type = "button";
      c.addEventListener("click", () =>
        go({
          name: "list",
          q: t,
          job: "",
          sort: "match",
          fit: true,
          grade: "",
          nokey: false,
          typed: true,
        }),
      );
      tries.append(c);
    }
    tries.append(
      el("span", "spacer"),
      el("span", "muted", `Everything here works with your Zotero ${zv}`),
    );
    box.append(tries);

    const onShelf = new Set();

    // Our picks: the first three you haven't installed.
    const picks = (S?.picks || [])
      .map((k) => ({ k, e: entry(k.slug) }))
      .filter(({ e }) => e && PICK_GRADES.has(e.grade) && good(e) && !mine(e))
      .slice(0, 3);
    if (picks.length) {
      const s = section(
        "Our picks",
        "Well made, well graded, and easy to see what they do. Chosen by us; nobody pays to be here.",
      );
      const grid = el("div", "picks");
      for (const { k, e } of picks) {
        onShelf.add(e.slug);
        const card = el("div", "pick");
        const shot = A.assetURL(k.shot);
        if (shot) {
          const img = document.createElement("img");
          img.src = shot;
          img.alt = k.alt;
          img.loading = "lazy";
          const frame = pluginLink(img, e, "shot");
          // A picture that can't be loaded takes its frame with it.
          img.addEventListener("error", () => frame.remove(), { once: true });
          card.append(frame);
        }
        // Icon, name and line on top; grade, in use and Install along the bottom.
        const body = el("div", "pbody");
        const text = el("span", "stext");
        text.append(el("span", "sname", e.name), el("span", "pline", lineOf(e)));
        const main = el("span", "smain top");
        main.append(icon(e, 40), text);
        const foot = el("div", "pfoot");
        const meta = el("span", "smeta");
        meta.append(gradePill(e.grade));
        if (use(e) != null) meta.append(el("span", "", `${fmtUse(use(e))} in use`));
        if (e.stars) meta.append(el("span", "", `GitHub ${fmtStars(e.stars)}`));
        foot.append(meta, action(e, { compact: true }));
        body.append(pluginLink(main, e, "slink"), foot);
        card.append(body);
        grid.append(card);
      }
      s.append(grid);
      box.append(s);
    }

    // Most used, among the plugins that work with your Zotero.
    const hasUse = fitting.some((e) => use(e) != null);
    const used = [...fitting].sort(byUse).slice(0, 10);
    if (used.length) {
      const s = section(
        hasUse ? "Most used" : "Most downloaded",
        hasUse
          ? `About how many copies of Zotero have each one. All ${used.length} work with your Zotero.`
          : `All ${used.length} work with your Zotero.`,
        listView({ sort: "used" }),
      );
      const cols = el("div", "cols");
      const half = Math.ceil(used.length / 2);
      for (const part of [used.slice(0, half), used.slice(half)]) {
        const col = el("div", "col");
        for (const e of part) {
          onShelf.add(e.slug);
          col.append(shelfRow(e, { rank: used.indexOf(e) + 1 }));
        }
        cols.append(col);
      }
      s.append(cols);
      box.append(s);
    }

    // Plugin packs.
    const packs = (S?.packs || [])
      .map((p) => ({ p, picks: resolvePack(p) }))
      .filter((x) => x.picks.length);
    if (packs.length) {
      const s = section(
        "Start with a pack",
        "Checked plugins for each stage of academic work. Install the whole pack, or the ones you want.",
      );
      const grid = el("div", "packs");
      for (const { p, picks: ps } of packs) {
        const card = el("span", "pack");
        const top = el("span", "pack-top");
        top.append(el("strong", "", p.name), el("span", "muted", `${ps.length} plugins`));
        const pills = el("span", "pack-pills");
        for (const k of ps) pills.append(gradePill(k.entry.grade));
        card.append(top, el("span", "pack-who", p.who), pills, el("span", "see", "See the pack"));
        grid.append(viewLink(card, { name: "pack", slug: p.slug }, "pack-link"));
      }
      s.append(grid);
      box.append(s);
    }

    // Rising, and New and catching on, side by side.
    const shelf = (rows, title, sub, extra) => {
      const list = rows
        .map((x) => ({ ...x, e: entry(x.slug) }))
        .filter((x) => x.e && good(x.e) && !onShelf.has(x.e.slug))
        .slice(0, 3);
      if (!list.length) return null;
      const s = section(title, sub);
      for (const x of list) {
        onShelf.add(x.e.slug);
        s.append(shelfRow(x.e, { extra: extra(x) }));
      }
      return s;
    };
    const pair = el("div", "pair");
    const rising = shelf(
      S?.rising || [],
      "Rising",
      "Most new GitHub stars in six weeks, downloads up too, B or better",
      (x) => `+${x.stars} stars`,
    );
    const fresh = shelf(
      S?.new || [],
      "New and catching on",
      "First published in the last 90 days, B or better, most used first",
      (x) =>
        `since ${new Date(x.since).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`,
    );
    for (const s of [rising, fresh]) if (s) pair.append(s);
    if (pair.childNodes.length) box.append(pair);

    // Browse by job.
    const s = section("Browse by job");
    const grid = el("div", "jobs");
    for (const [slug, title] of JOBS) {
      const n = fitting.filter((e) => e.jobs.includes(slug)).length;
      const tile = el("span", "job");
      tile.append(
        el("strong", "", title),
        el("span", "muted", `${n} plugins · ${JOB_EG[slug] || ""}`),
      );
      grid.append(viewLink(tile, listView({ job: slug, sort: "used" }), "job-link"));
    }
    s.append(grid);
    box.append(s);
    box.append(footer(d, fitting.length));
  }

  function footer(d, fitting) {
    const f = el("footer", "ffoot");
    f.append(
      el(
        "p",
        "",
        `${d.plugins.length.toLocaleString()} plugins, ${fitting.toLocaleString()} of them work with your Zotero ${zv} · catalogue from ${day(d.generatedAt)}, graded for Zotero ${d.currentZotero}`,
      ),
      el("p", "", NO_PAID),
    );
    return f;
  }

  const listView = (o) => ({
    name: "list",
    q: "",
    job: "",
    sort: "used",
    fit: true,
    grade: "",
    nokey: false,
    typed: false,
    ...o,
  });

  // -------------------------------------------------------------------------------------------
  // Search results and job lists

  /** Best match leans a little towards better grades: worth about a third of a tenfold in use. */
  const GRADE_NUDGE = { "A+": 6, A: 6, B: 2, C: -8, "–": -4 };
  // Words a search can leave out: "find duplicates" means "duplicates".
  const STOP = new Set(
    "a an the in on of for to with and or my me i want can how do get find from into by zotero plugin plugins".split(
      " ",
    ),
  );
  /** A word's stem, so "summarise", "summarize" and "summaries" all find "summar…". */
  function stem(w) {
    let s = w.replace(/(is|iz)(e|es|ed|er|ing)$/, "").replace(/ies$/, "y");
    if (s === w && s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
    return s.length >= 3 ? s : w;
  }
  function words(q) {
    const all = q.toLowerCase().split(/\s+/).filter(Boolean);
    const kept = all.filter((w) => !STOP.has(w));
    return (kept.length ? kept : all).map(stem);
  }

  function hay(e) {
    let h = cache.hay.get(e.slug);
    if (!h) {
      h =
        `${e.name} ${e.line || ""} ${e.summary || ""} ${e.slug} ${e.jobs.map((j) => JOB_TITLE[j] || j).join(" ")}`.toLowerCase();
      cache.hay.set(e.slug, h);
    }
    return h;
  }

  /**
   * Best match: how well the words match (the name counts most, then the one-line description,
   * then the jobs), blended with how many people use the plugin, so a widely used plugin isn't
   * buried under small namesakes and an exact name still comes first.
   */
  function score(e, ws) {
    const name = e.name.toLowerCase();
    const line = lineOf(e).toLowerCase();
    const jobs = e.jobs.map((j) => (JOB_TITLE[j] || j).toLowerCase()).join(" ");
    const phrase = ws.join(" ");
    let s = name === phrase ? 60 : name.includes(phrase) ? 30 : 0;
    for (const w of ws) {
      if (name.includes(w)) s += 12;
      if (line.includes(w)) s += 8;
      if (jobs.includes(w)) s += 3;
    }
    // Every word in the name or the one-line description, not only somewhere in the summary.
    if (ws.every((w) => name.includes(w) || line.includes(w))) s += 15;
    const n = use(e) ?? Math.round((e.downloads || 0) / 20);
    return s + Math.log10(n + 1) * 12 + (GRADE_NUDGE[e.grade] ?? 0);
  }

  function matching(v, fit) {
    const d = catalogue();
    const ws = words(v.q || "");
    let list = d.plugins;
    if (fit) list = list.filter(fits);
    if (v.job) list = list.filter((e) => e.jobs.includes(v.job));
    if (v.grade) list = list.filter((e) => A.RANK[e.grade] >= A.RANK[v.grade]);
    if (v.nokey) list = list.filter((e) => ["none", "optional"].includes(e.needs?.apiKey));
    if (ws.length) list = list.filter((e) => ws.every((w) => hay(e).includes(w)));
    const sort = v.sort === "match" && !ws.length ? "used" : v.sort;
    if (sort === "match") {
      const sc = new Map(list.map((e) => [e.slug, score(e, ws)]));
      list = [...list].sort((a, b) => sc.get(b.slug) - sc.get(a.slug) || byUse(a, b));
    } else if (sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "updated")
      list = [...list].sort((a, b) => (b.lastReleaseAt || "").localeCompare(a.lastReleaseAt || ""));
    else if (sort === "grade")
      list = [...list].sort((a, b) => A.RANK[b.grade] - A.RANK[a.grade] || byUse(a, b));
    else list = [...list].sort(byUse);
    return list;
  }

  function select(id, label, options, value, onChange) {
    const wrap = el("label", "sel");
    wrap.append(el("span", "vh", label));
    const s = document.createElement("select");
    s.id = id;
    for (const [v, t] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = t;
      s.append(o);
    }
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    wrap.append(s);
    return wrap;
  }

  function toggle(id, text, on, onChange) {
    const b = el("button", on ? "chip on" : "chip", text);
    b.type = "button";
    b.id = id;
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", () => onChange(!on));
    return b;
  }

  function renderList(box) {
    const v = view;
    const set = (k) => (val) => {
      v[k] = val;
      shown = PAGE;
      refresh();
    };
    const bar = el("div", "filters");
    bar.append(
      toggle("fit", `Works with Zotero ${zv}`, v.fit, set("fit")),
      select("job", "Job", [["", "All jobs"], ...JOBS], v.job, set("job")),
      select(
        "grade",
        "Grade",
        [
          ["", "Any grade"],
          ["A", "A or better"],
          ["B", "B or better"],
        ],
        v.grade,
        set("grade"),
      ),
      toggle("nokey", "No API key needed", v.nokey, set("nokey")),
      el("span", "spacer"),
    );
    const sorts = [
      ["used", "Most used"],
      ["grade", "Best grade"],
      ["updated", "Recently updated"],
      ["name", "Name"],
    ];
    if (words(v.q || "").length) sorts.unshift(["match", "Best match"]);
    const sortValue = v.sort === "match" && !words(v.q || "").length ? "used" : v.sort;
    bar.append(select("sort", "Sort", sorts, sortValue, set("sort")));
    box.append(bar);

    const all = matching(v, v.fit);
    const count = el("p", "count-line");
    const what = v.job ? ` for ${JOB_TITLE[v.job]}` : "";
    count.append(el("span", "", `${all.length} plugin${all.length === 1 ? "" : "s"}${what}`));
    if (v.fit) {
      const others = matching(v, false).length - all.length;
      count.append(el("span", "", ` work with your Zotero`));
      if (others > 0) {
        count.append(el("span", "", " · "));
        const a = el("a", "", `${others} more don't: show them`);
        a.href = "#";
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          set("fit")(false);
        });
        count.append(a);
      }
    }
    box.append(count);

    const list = el("div", "results");
    if (!all.length) list.append(el("div", "empty", "No plugins match."));
    for (const e of all.slice(0, shown)) list.append(resultRow(e));
    box.append(list);
    if (all.length > shown) {
      const more = el("button", "more", `Show more (${all.length - shown} left)`);
      more.type = "button";
      more.addEventListener("click", () => {
        shown += PAGE;
        refresh();
      });
      const row = el("div", "more-row");
      row.append(more);
      box.append(row);
    }
    box.append(footer(catalogue(), catalogue().plugins.filter(good).length));
  }

  function resultRow(e) {
    const r = el("div", "rrow");
    const main = el("span", "rmain");
    const text = el("span", "rtext");
    const top = el("span", "rtop");
    top.append(el("span", "rname", e.name), el("span", "ver", e.version));
    const g = el("span", "rgrade");
    g.append(gradePill(e.grade), el("span", "", gradeText(e)));
    const meta = [];
    if (use(e) != null) meta.push(`${fmtUse(use(e))} in use`);
    if (e.stars) meta.push(`GitHub ${fmtStars(e.stars)}`);
    const rating = ratingText(e);
    if (rating) meta.push(rating);
    if (e.lastReleaseAt) meta.push(`updated ${day(e.lastReleaseAt)}`);
    if (e.tested)
      meta.push(`live test in Zotero ${e.tested.zotero}: ${e.tested.verdict.replace(/-/g, " ")}`);
    text.append(top, el("span", "rline", lineOf(e)), g, el("span", "rmeta", meta.join(" · ")));
    const chips = needChips(e);
    if (chips.length) {
      const c = el("span", "needs");
      for (const t of chips) c.append(el("span", "need", t));
      text.append(c);
    }
    for (const al of mine(e)?.alerts || [])
      if (al.level !== "info") text.append(el("span", `flag ${al.level}`, al.text));
    main.append(icon(e, 48), text);
    r.append(pluginLink(main, e, "rlink"), action(e));
    return r;
  }

  // -------------------------------------------------------------------------------------------
  // A plugin's page

  function stat(label, value, sub, extra) {
    const c = el("div", "stat");
    c.append(el("span", "lab", label));
    const v = el("span", "val");
    if (extra) v.append(extra);
    v.append(document.createTextNode(value));
    c.append(v);
    if (sub) c.append(el("span", "sub", sub));
    return c;
  }

  function renderPlugin(box, d) {
    const e = entry(view.slug);
    if (!e) {
      box.append(el("div", "empty", "This plugin isn't in the catalogue any more."));
      return;
    }
    const crumbs = el("p", "crumbs muted");
    crumbs.append(
      document.createTextNode(`Find plugins${e.jobs[0] ? ` / ${JOB_TITLE[e.jobs[0]] || ""}` : ""}`),
    );
    box.append(crumbs);

    const hero = el("div", "hero");
    const who = el("div", "who");
    who.append(el("h1", "", e.name), el("p", "pline big", lineOf(e)));
    who.append(el("p", "muted", `${owner(e)} · ${(e.repo || "").replace(/^https:\/\//, "")}`));
    hero.append(icon(e, 72), who, action(e, { big: true }));
    box.append(hero);

    const have = mine(e);
    if (have) {
      const note = el("div", "have");
      note.append(
        el(
          "span",
          "",
          have.same
            ? `You have ${have.addon.version}, the version listed here.`
            : `You have ${have.addon.version}; the listed version is ${e.version}.`,
        ),
      );
      for (const al of have.alerts || [])
        if (al.level !== "info") note.append(el("span", `flag ${al.level}`, al.text));
      box.append(note);
    }

    const strip = el("div", "stats");
    const pill = gradePill(e.grade);
    pill.classList.add("big");
    strip.append(stat("Grade", ` ${GRADE_LONG[e.grade]}`, "", pill));
    strip.append(stat("In use", use(e) != null ? fmtUse(use(e)) : "–", "an estimate"));
    const rv = e.ratings?.version;
    if (rv && rv.count >= 10 && rv.average != null)
      strip.append(
        stat("Ratings", `★ ${rv.average.toFixed(1)}`, `${rv.count} ratings of ${e.version}`),
      );
    else strip.append(stat("GitHub", e.stars != null ? fmtStars(e.stars) : "–", "stars"));
    strip.append(
      stat(
        "Works with",
        e.supports?.length ? `Zotero ${e.supports.join(", ")}` : "–",
        fits(e) ? `including your ${zv}` : `not your ${zv}`,
      ),
    );
    strip.append(stat("Updated", day(e.lastReleaseAt) || "–", `version ${e.version}`));
    box.append(strip);

    const pick = (d.shelves?.picks || []).find((k) => k.slug === e.slug);
    const shot = pick && A.assetURL(pick.shot);
    if (shot) {
      const s = el("div", "shots");
      s.append(el("h2", "", "Screenshot"));
      const img = document.createElement("img");
      img.src = shot;
      img.alt = pick.alt;
      img.addEventListener("error", () => s.remove(), { once: true });
      s.append(img);
      box.append(s);
    }

    const cols = el("div", "pcols");
    const left = el("div", "pleft");
    const right = el("div", "pright");

    const what = el("div", "psec");
    what.append(el("h2", "", "What it does"), el("p", "", e.summary || lineOf(e) || ""));
    left.append(what);

    const found = el(
      "div",
      `psec found found-${e.grade === "–" ? "none" : e.grade.replace("+", "plus")}`,
    );
    const fh = el("div", "found-head");
    const fp = gradePill(e.grade);
    fp.classList.add("big");
    fh.append(fp, el("h2", "", `What we found: ${GRADE_LONG[e.grade].toLowerCase()}`));
    found.append(fh);
    if (e.grade !== "–") found.append(el("p", "", `Because ${e.because}.`));
    const facts = el("dl", "facts");
    const fact = (k, v) => facts.append(el("dt", "", k), el("dd", "", v));
    for (const n of needs(e)) fact(n.startsWith("Its instructions") ? "Docs" : "Needs", n);
    if (e.blocked) fact("Blocked", `Zotero's blocklist blocks this version: ${e.blocked}`);
    fact(
      "Live test",
      e.tested
        ? `In Zotero ${e.tested.zotero}: ${e.tested.verdict.replace(/-/g, " ")}.`
        : "Not run for this version yet.",
    );
    if (e.update?.version)
      fact(
        "Update",
        `Its update address offers ${e.update.version}, graded ${e.update.grade === "–" ? "not yet" : e.update.grade}.`,
      );
    const build = A.fileFor(e, zv);
    if (build?.sha256)
      fact("Install", "Atlas installs only the file we checked, matched by its SHA-256.");
    found.append(facts);
    const ev = el("a", "", "Every finding, with the evidence, on zoteroplugins.org");
    ev.href = "#";
    ev.addEventListener("click", (x) => {
      x.preventDefault();
      A.openPage(e.page);
    });
    found.append(ev);
    left.append(found);

    const rate = el("div", "psec");
    rate.append(el("h2", "", "Ratings and reviews"));
    const r = e.ratings;
    if (rv && rv.count >= 10 && rv.average != null)
      rate.append(
        el(
          "p",
          "",
          `★ ${rv.average.toFixed(1)} from ${rv.count} ratings of ${e.version}${r.count > rv.count ? `, ${r.count} of every version` : ""}.`,
        ),
      );
    else if (r?.count)
      rate.append(
        el(
          "p",
          "",
          `Too few to show an average yet: ${r.count} so far. Averages show from 10 ratings of a version.`,
        ),
      );
    else
      rate.append(
        el(
          "p",
          "",
          "No ratings yet. Atlas asks people who have used a plugin for two weeks how it's working.",
        ),
      );
    if (r?.count)
      rate.append(ctx.link("Read the reviews on zoteroplugins.org", `${e.page}#reviews`));
    left.append(rate);

    const info = el("div", "psec");
    info.append(el("h2", "", "Information"));
    const dl = el("dl", "info");
    const row = (k, v) => v && dl.append(el("dt", "", k), el("dd", "", v));
    row("Developer", owner(e));
    row("Version", `${e.version}${e.publishedAt ? `, ${day(e.publishedAt)}` : ""}`);
    row("Works with", e.supports?.length ? `Zotero ${e.supports.join(", ")}` : "No Zotero version");
    row("Jobs", e.jobs.map((j) => JOB_TITLE[j] || j).join(", "));
    row("Docs", e.docsChineseOnly ? "Chinese" : "English");
    row("Maintenance", e.maintenance);
    row("Add-on ID", e.id || "");
    info.append(dl);
    right.append(info);

    const versions = el("div", "psec");
    versions.append(el("h2", "", "Versions we checked"));
    const vrow = (ver, note, g) => {
      const x = el("div", "vrow");
      x.append(el("strong", "", ver), el("span", "muted", note), gradePill(g));
      versions.append(x);
    };
    vrow(e.version, "listed", e.grade);
    for (const p of e.previous || []) vrow(p.version, "earlier", p.grade);
    right.append(versions);

    const links = el("div", "psec links");
    links.append(el("h2", "", "Links"));
    links.append(
      ctx.link("Full card on zoteroplugins.org", e.page),
      ctx.link("GitHub repository", e.repo),
      ctx.link("Releases", `${e.repo}/releases`),
    );
    right.append(links);

    cols.append(left, right);
    box.append(cols);

    const job = e.jobs[0];
    if (job) {
      const alike = d.plugins
        // Like Rising and New, a shelf of suggestions shows B or better.
        .filter(
          (x) =>
            x.slug !== e.slug && x.jobs.includes(job) && good(x) && A.RANK[x.grade] >= A.RANK.B,
        )
        .sort(byUse)
        .slice(0, 3);
      if (alike.length) {
        const s = section(`More for ${JOB_TITLE[job] || job}`, "", listView({ job }));
        const grid = el("div", "alike");
        for (const x of alike) {
          const card = el("span", "smain");
          const text = el("span", "stext");
          const meta = el("span", "smeta");
          meta.append(gradePill(x.grade));
          if (use(x) != null) meta.append(el("span", "", `${fmtUse(use(x))} in use`));
          text.append(el("span", "sname", x.name), el("span", "sline", lineOf(x)), meta);
          card.append(icon(x, 40), text);
          grid.append(pluginLink(card, x, "alike-card"));
        }
        s.append(grid);
        box.append(s);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Plugin packs

  /** The first plugin for a task that works with your Zotero and is graded B or better. */
  function firstFit(slugs) {
    for (const s of slugs || []) {
      const e = entry(s);
      if (e && good(e) && A.RANK[e.grade] >= A.RANK.B) return e;
    }
    return null;
  }

  function resolvePack(p) {
    return (p.picks || []).flatMap((k) => {
      const e = firstFit(k.plugins);
      if (!e) return [];
      const o = k.or ? firstFit(k.or.plugins) : null;
      return [
        {
          task: k.task,
          why: k.why,
          ifYou: k.ifYou,
          entry: e,
          or: k.or && o ? { ...k.or, entry: o } : null,
        },
      ];
    });
  }

  const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

  function renderPack(box, d) {
    const p = (d.shelves?.packs || []).find((x) => x.slug === view.slug);
    if (!p) {
      box.append(el("div", "empty", "This pack isn't in the catalogue any more."));
      return;
    }
    const picks = resolvePack(p);
    view.skip = view.skip || new Set();
    const head = el("div", "pack-head");
    const t = el("div", "");
    t.append(el("span", "lab", "Plugin pack"), el("h1", "", p.name));
    const n = WORDS[picks.length] ?? String(picks.length);
    t.append(el("p", "pline big", `${n[0].toUpperCase()}${n.slice(1)} plugins ${p.lead}`));
    head.append(t);
    const links = el("div", "pack-links");
    links.append(
      ctx.link("The one-page PDF, to print or share", `${A.SITE}/for/${p.slug}.pdf`),
      ctx.link("The pack on zoteroplugins.org", `${A.SITE}/for/${p.slug}`),
    );
    head.append(links);
    box.append(head);

    const rows = el("div", "pack-rows");
    const todo = [];
    const states = new Map();
    for (const k of picks) {
      const e = k.entry;
      const build = A.fileFor(e, zv);
      const have = mine(e);
      const can = Boolean(build?.sha256) && !have?.same;
      const r = el("div", "pk-row");
      const box2 = el("span", "pk-check");
      if (can) {
        const c = document.createElement("input");
        c.type = "checkbox";
        c.checked = !view.skip.has(e.slug);
        c.setAttribute("aria-label", `Install ${e.name}`);
        c.addEventListener("change", () => {
          if (c.checked) view.skip.delete(e.slug);
          else view.skip.add(e.slug);
          updateBar();
        });
        box2.append(c);
        todo.push({ e, build, c });
      } else box2.append(el("span", "tick", have?.same ? "✓" : ""));
      const text = el("span", "pk-text");
      text.append(el("span", "lab", k.task + (k.ifYou ? ` · if you ${k.ifYou}` : "")));
      const nm = el("span", "pk-name");
      nm.append(pluginLink(e.name, e, "sname"), gradePill(e.grade), el("span", "muted", lineOf(e)));
      text.append(nm, el("span", "pk-why", k.why));
      if (k.or) {
        const o = el("span", "pk-or");
        o.append(
          document.createTextNode(`Or, if you ${k.or.ifYou}: `),
          pluginLink(k.or.entry.name, k.or.entry),
          document.createTextNode(` (${k.or.entry.grade})`),
        );
        text.append(o);
      }
      const state = el(
        "span",
        "pk-state",
        have?.same
          ? "Installed"
          : !build
            ? `Not for Zotero ${major}`
            : !build.sha256
              ? "Not checked yet"
              : have
                ? `Update to ${e.version}`
                : "",
      );
      states.set(e.slug, state);
      r.append(box2, icon(e, 44), text, state);
      rows.append(r);
    }
    box.append(rows);

    const bar = el("div", "pack-bar");
    const say = el("span", "pack-say");
    const go2 = el("button", "ibtn primary big", "Install");
    go2.type = "button";
    const updateBar = () => {
      const chosen = todo.filter((x) => x.c.checked);
      const already = picks.filter((k) => mine(k.entry)?.same).length;
      say.textContent = `${chosen.length} selected${already ? ` · ${already} already installed` : ""}`;
      go2.textContent = chosen.length
        ? `Install ${chosen.length} plugin${chosen.length === 1 ? "" : "s"}`
        : "Nothing to install";
      go2.disabled = !chosen.length;
    };
    go2.addEventListener("click", () => {
      const chosen = todo.filter((x) => x.c.checked);
      sheet(
        chosen.map((x) => x.e),
        go2,
        async () => {
          go2.disabled = true;
          for (const x of chosen) x.c.disabled = true;
          let ok = 0;
          for (const x of chosen) {
            states.get(x.e.slug).textContent = "Installing…";
            const r = await A.installChecked(x.e, x.build);
            states.get(x.e.slug).textContent = r.ok ? "Installed" : r.message;
            if (r.ok) ok++;
          }
          status(`${ok} of ${chosen.length} installed.`);
          await ctx.refreshInstalled();
        },
      );
    });
    updateBar();
    bar.append(say, go2);
    box.append(bar);
  }

  // -------------------------------------------------------------------------------------------
  // The install sheet: the grade and its reason first, then what it needs, then the checked file

  function sheet(entries, opener, onConfirm) {
    const back = $("sheet");
    back.textContent = "";
    const box = el("div", "sheet");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "sheet-h");
    const anyC = entries.some((e) => e.grade === "C");
    const one = entries.length === 1 ? entries[0] : null;
    const h = el("h2", "", one ? `Install ${one.name}?` : `Install ${entries.length} plugins?`);
    h.id = "sheet-h";
    if (one) {
      const head = el("div", "sheet-head");
      const t = el("div", "");
      t.append(h, el("span", "muted", `Version ${one.version} · ${owner(one)}`));
      head.append(icon(one, 44), t);
      box.append(head);
      const g = el("div", `sheet-grade${one.grade === "C" ? " warn" : ""}`);
      g.append(gradePill(one.grade), el("span", "", gradeText(one)));
      box.append(g);
      const ul = el("ul", "sheet-list");
      for (const n of needs(one)) ul.append(el("li", "", n));
      const build = A.fileFor(one, zv);
      ul.append(
        el(
          "li",
          "",
          `Zotero downloads ${build.name} from GitHub and installs it only if it matches the file we analysed (SHA-256 ${build.sha256.slice(0, 12)}…).`,
        ),
      );
      box.append(ul);
    } else {
      box.append(h);
      const list = el("div", "sheet-rows");
      for (const e of entries) {
        const r = el("div", "sheet-row");
        const t = el("span", "");
        t.append(el("strong", "", `${e.name} ${e.version}`), el("span", "muted", gradeText(e)));
        r.append(icon(e, 32), gradePill(e.grade), t);
        list.append(r);
      }
      box.append(
        list,
        el(
          "p",
          "muted",
          "Zotero downloads each file from GitHub and installs it only if it matches the file we analysed, one at a time.",
        ),
      );
    }
    const acts = el("div", "sheet-act");
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    const ok = el(
      "button",
      anyC ? "" : "primary",
      one ? "Install" : `Install ${entries.length} plugins`,
    );
    ok.type = "button";
    acts.append(cancel, ok);
    box.append(acts);
    back.append(box);
    back.hidden = false;
    const close = () => {
      back.hidden = true;
      back.textContent = "";
      closeSheet = null;
      if (opener?.isConnected) opener.focus();
    };
    closeSheet = close;
    cancel.addEventListener("click", close);
    ok.addEventListener("click", () => {
      close();
      onConfirm();
    });
    back.addEventListener("click", (ev) => {
      if (ev.target === back) close();
    });
    // Tab stays inside the sheet.
    box.addEventListener("keydown", (ev) => {
      if (ev.key !== "Tab") return;
      const f = [...box.querySelectorAll("button, a[href]")];
      const i = f.indexOf(document.activeElement);
      const j = ev.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
      ev.preventDefault();
      f[j]?.focus();
    });
    (anyC ? cancel : ok).focus();
  }

  // -------------------------------------------------------------------------------------------

  /** Escape: closes the sheet, then empties the search, then goes back. True if it did one. */
  function onEscape(ev) {
    if (closeSheet) {
      closeSheet();
      return true;
    }
    const q = $("q");
    if (ev.target === q && q.value) {
      q.value = "";
      onSearch();
      return true;
    }
    if (ev.target?.localName === "textarea") return false;
    return back();
  }

  $("q").addEventListener("input", onSearch);
  $("back").addEventListener("click", () => back());

  return {
    icon,
    render: refresh,
    home,
    showPlugin: (slug) => go({ name: "plugin", slug }),
    showList: (o) => go(listView(o || {})),
    escape: onEscape,
    get view() {
      return view;
    },
  };
};
