/* global Zotero, window, document */
// The Zotero Atlas window: the catalogue, and the plugins installed here. Everything it knows
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
  const PAGE = 150;
  const CHIP = {
    blocked: ["Blocked by Zotero", "red"],
    advisory: ["Known security problem", "red"],
    held: ["Update held", "amber"],
    "worse-update": ["Worse update offered", "amber"],
    "grade-drop": ["Grade dropped", "amber"],
    "disabled-fix": ["Turned off by Zotero", "amber"],
    stuck: ["Not updated", "amber"],
  };

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
  const button = (text, cls, fn) => {
    const b = el("button", cls || "", text);
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await fn(b);
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    });
    return b;
  };
  const num = (n) =>
    n === null || n === undefined
      ? ""
      : n >= 1000
        ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
        : String(n);
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString() : "");
  const ago = (t) => {
    if (!t) return "";
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 2) return "just now";
    if (m < 60) return `${m} minutes ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
    return `${Math.round(h / 24)} days ago`;
  };

  let data = null; // the catalogue
  let rv = null; // the latest review of installed plugins
  let byId = new Map(); // addon ID → review item
  let shown = PAGE;
  let tab = "find";

  function status(text) {
    $("status").textContent = text;
  }

  function gradePill(g, listed = true) {
    if (!listed) {
      const p = el("span", "grade g-none", "Not listed");
      p.title = "Not on zoteroplugins.org, so Zotero Atlas can't check it or hold its updates";
      return p;
    }
    const pill = el("span", `grade g-${g === "–" ? "none" : g}`, g === "–" ? "?" : g);
    if (g !== "–") pill.title = `Zotero Plugins grade ${g}`;
    return pill;
  }

  function installedFor(entry) {
    return entry.id ? byId.get(entry.id) : undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Find plugins

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

  function row(entry) {
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
    for (const al of installedFor(entry)?.alerts || [])
      if (al.level !== "info") main.append(el("span", `flag ${al.level}`, al.text));
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
    for (const p of all.slice(0, shown)) list.append(row(p));
    $("more").hidden = all.length <= shown;
    $("more").textContent = `Show more (${all.length - Math.min(shown, all.length)} left)`;
    $("foot").textContent =
      `${all.length} of ${data.plugins.length} plugins · catalogue from ${date(data.generatedAt)}, graded for Zotero ${data.currentZotero} · you run Zotero ${zv}`;
  }

  // -------------------------------------------------------------------------------------------
  // Your plugins

  const SENT =
    "Sent to zoteroatlas.com when you click Post: the plugin and version, your stars and review, " +
    "your Zotero version and operating system, and a scrambled ID for this Zotero, so rating " +
    "again replaces your rating. Never your library, your Zotero account or your email. We never " +
    "store your IP address: a scrambled code made from it is kept for 30 days to catch fake reviews.";

  /**
   * Five star buttons, as a radio group. `onPick(n)` runs on a click; `stars` is how many show
   * filled. Returns the group and a way to repaint it.
   */
  function starGroup(target, stars, onPick) {
    const group = el("div", "stars");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", `Your rating of ${target.name} ${target.version}`);
    const buttons = [];
    const paint = (n) =>
      buttons.forEach((b, i) => {
        b.classList.toggle("on", i < n);
        b.textContent = i < n ? "★" : "☆";
        b.setAttribute("aria-checked", String(i + 1 === n));
      });
    for (let n = 1; n <= 5; n++) {
      const b = el("button", "star", "★");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", `${n} star${n === 1 ? "" : "s"}`);
      b.addEventListener("click", () => onPick(n));
      buttons.push(b);
      group.append(b);
    }
    paint(stars);
    return { group, paint };
  }

  /**
   * Stars and an optional review for one installed (or recently removed) version. Closed, it's a
   * "Rate 1.2.0" link; with `ask`, it's five stars, and a click on one opens the review with that
   * many chosen.
   */
  function rateBox(target, ask = false) {
    const box = el("div", "rate");
    const closed = () => {
      box.textContent = "";
      if (ask) {
        const row = el("div", "ask-stars");
        row.append(
          starGroup(target, 0, (n) => form(n)).group,
          el("span", "note", "Click a star to rate it. Nothing is sent until you click Post."),
        );
        box.append(row);
        return;
      }
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
      const sg = starGroup(target, stars, (n) => {
        stars = n;
        sg.paint(n);
      });
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
        if (ask) {
          box.textContent = "";
          box.append(el("p", "note done", r.message));
          return;
        }
        closed();
        box.prepend(el("p", "note", r.message));
      });
      const act = el("div", "rate-actions");
      act.append(post, cancel);
      box.append(
        sg.group,
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
      if (ask) text.focus();
    };
    closed();
    return box;
  }

  /** "in use for 3 weeks", or "3 weeks or more" for one that was there before Atlas. */
  function inUse(i) {
    const days = (Date.now() - i.since) / 86400000;
    const span =
      days < 60
        ? `${Math.max(1, Math.floor(days / 7))} weeks`
        : `${Math.floor(days / 30.4)} months`;
    return `in use for ${span}${i.early ? " or more" : ""}`;
  }

  /** How is it working? Five stars on the card; "Not now" and Atlas doesn't ask again. */
  function askCard(i) {
    const card = el("div", "card ask");
    const head = el("div", "card-head");
    const name = link(i.entry.name, i.entry.page);
    name.className = "card-name";
    head.append(
      name,
      el("span", "card-ver", `${i.addon.version} · ${inUse(i)}`),
      el("span", "spacer"),
    );
    const later = el("button", "linkish", "Not now");
    later.type = "button";
    later.addEventListener("click", () => A.ratings.later(i.entry.slug));
    head.append(later);
    card.append(
      head,
      rateBox(
        {
          slug: i.entry.slug,
          addon: i.addon.id,
          version: i.addon.version,
          name: i.entry.name,
        },
        true,
      ),
    );
    return card;
  }

  const nameOf = (i) => i.entry?.name || i.addon.name;

  /** One thing that needs you: a card with what happened and what you can do. */
  function needCard(i, al) {
    const card = el("div", `card level-${al.level}`);
    const head = el("div", "card-head");
    head.append(el("b", "card-name", nameOf(i)));
    if (al.flag === "held" && al.held)
      head.append(
        el("span", "card-ver", `${al.held.from || i.addon.version} → ${al.held.version}`),
      );
    else head.append(el("span", "card-ver", i.addon.version));
    const chip = CHIP[al.flag];
    if (chip) head.append(el("span", `chip ${chip[1]}`, chip[0]));
    head.append(el("span", "spacer"));
    if (i.entry && al.flag === "held") head.append(link("Releases", `${i.entry.repo}/releases`));
    card.append(head, el("p", "card-text", al.text));
    const act = el("div", "card-actions");
    const done = (r) => {
      if (r && r.ok === false && r.message) Zotero.alert(window, "Zotero Atlas", r.message);
    };
    if (al.off) act.append(button("Turn it off", "danger", () => A.decide.off(i.addon.id)));
    if (al.url) act.append(button("What we know", "", () => A.openPage(al.url)));
    if (al.flag === "held") {
      act.append(button("Update anyway", "", () => A.decide.update(i.addon.id)));
      act.append(
        button(`Keep ${al.held?.from || i.addon.version}`, "primary", () =>
          A.decide.keep(i.addon.id),
        ),
      );
      act.prepend(
        el(
          "span",
          "card-note",
          `Held since ${new Date(al.held?.at || Date.now()).toLocaleDateString()}. Without Atlas, Zotero would have installed it.`,
        ),
      );
    }
    if (al.flag === "worse-update")
      act.append(
        button("Hold updates until they're checked", "primary", () => A.updates.set("hold")),
      );
    if (al.flag === "grade-drop" && i.entry)
      act.append(button("See why", "", () => A.openPage(i.entry.page)));
    if (al.install)
      act.append(
        button(`Install ${al.install.entry.version}`, "primary", async () => {
          done(await A.install(al.install.entry, al.install.build, window));
        }),
      );
    if (act.childNodes.length) card.append(act);
    return card;
  }

  /** "Go back to 9.0.76?" asked in place, then done. */
  function goBack(i, rowEl) {
    const ask = el("div", "confirm");
    ask.append(
      el(
        "span",
        "",
        `Go back to ${i.back.version}? Atlas installs the ${i.back.version} file we checked, and holds updates for it until you say so.`,
      ),
      button("Cancel", "", () => ask.remove()),
      button("Go back", "primary", async () => {
        const r = await A.decide.back(i, window);
        if (!r.ok) {
          if (r.message) Zotero.alert(window, "Zotero Atlas", r.message);
          return;
        }
        ask.replaceWith(el("div", "confirm done", `${nameOf(i)} ${i.back.version} is installed.`));
      }),
    );
    rowEl.after(ask);
  }

  function updateRow(i, al) {
    const r = el("div", "urow");
    r.append(el("b", "", nameOf(i)));
    const ver =
      al.flag === "updated"
        ? `${i.updated.from} → ${i.updated.to}`
        : al.held?.version
          ? `${al.held.from || i.addon.version} → ${al.held.version}`
          : i.addon.version;
    r.append(el("span", "uver", ver));
    if (i.entry) r.append(gradePill(i.entry.grade));
    else r.append(el("span", ""));
    r.append(el("span", "utext", al.text));
    const act = el("span", "uact");
    if (al.flag === "updated" && i.back) {
      const b = el("button", "linkish", `Go back to ${i.back.version}`);
      b.type = "button";
      b.addEventListener("click", () => {
        if (r.nextSibling?.classList?.contains("confirm")) return;
        goBack(i, r);
      });
      act.append(b);
    }
    if (al.flag === "kept")
      act.append(button("Update anyway", "", () => A.decide.update(i.addon.id)));
    if (al.flag === "pinned") act.append(button("Update", "", () => A.decide.unpin(i.addon.id)));
    r.append(act);
    return r;
  }

  function section(title, count) {
    const s = el("div", "block");
    const h = el("h2", "h", title);
    if (count !== undefined) h.append(el("span", "h-count", ` ${count}`));
    s.append(h);
    return s;
  }

  function renderMine() {
    const items = rv?.items || [];
    const attention = items.flatMap((i) =>
      i.alerts.filter((a) => a.level !== "info").map((a) => [i, a]),
    );
    const order = { critical: 0, important: 1 };
    attention.sort((a, b) => order[a[1].level] - order[b[1].level]);
    $("mine-count").textContent = attention.length ? String(attention.length) : "";
    $("mine-lead").textContent = !rv
      ? "Loading…"
      : items.length
        ? `${items.length} plugin${items.length === 1 ? "" : "s"}. ${
            attention.length
              ? `${attention.length} need${attention.length === 1 ? "s" : ""} you; the rest are fine.`
              : "Nothing needs you."
          }`
        : "No other plugins are installed.";

    // Holding updates, offered once to people who used Atlas before it could.
    const offer = $("offer");
    offer.textContent = "";
    if (A.updates.choice() === "") {
      const o = el("div", "offer");
      o.append(
        el("span", "", "New: Zotero Atlas can hold plugin updates until they're checked. "),
        button("Turn on", "linkish", () => A.updates.set("hold")),
        el("span", "", " · "),
        button("No thanks", "linkish", () => A.updates.set("off")),
      );
      offer.append(o);
    }

    const needs = $("needs");
    needs.textContent = "";
    if (attention.length) {
      const s = section("Needs you");
      for (const [i, al] of attention) s.append(needCard(i, al));
      needs.append(s);
    }

    // Plugins you've had a couple of weeks: how are they working?
    const ask = $("ask");
    ask.textContent = "";
    const asking = A.ratings.asking();
    ask.hidden = !asking.length; // empty, it would still add a gap to the page
    if (asking.length) {
      const s = section("How are they working?");
      s.append(
        el(
          "p",
          "ask-lead",
          `You've had ${asking.length === 1 ? "this one" : "these"} a couple of weeks. A rating helps other Zotero users choose, and the developer see what works.`,
        ),
      );
      for (const i of asking) s.append(askCard(i));
      ask.append(s);
    }

    const updates = $("updates");
    updates.textContent = "";
    const ups = items.flatMap((i) =>
      i.alerts
        .filter((a) => ["updated", "waiting", "kept", "pinned"].includes(a.flag))
        .map((a) => [i, a]),
    );
    if (ups.length) {
      const s = section("Updates");
      const box = el("div", "box");
      for (const [i, al] of ups) box.append(updateRow(i, al));
      s.append(box);
      updates.append(s);
    }

    const all = $("all");
    all.textContent = "";
    if (items.length) {
      const det = el("details", "block");
      det.open = attention.length + ups.length === 0 || items.length <= 12;
      const sum = el("summary", "h", `All your plugins `);
      sum.append(el("span", "h-count", String(items.length)));
      det.append(sum);
      const box = el("div", "box");
      for (const i of [...items].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
        const r = el("div", "prow");
        const top = el("div", "ptop");
        top.append(gradePill(i.entry?.grade ?? "–", Boolean(i.entry)));
        top.append(i.entry ? link(nameOf(i), i.entry.page) : el("b", "", nameOf(i)));
        top.append(el("span", "ver", i.addon.version + (i.addon.enabled ? "" : " · turned off")));
        r.append(top);
        const quiet = i.alerts.filter(
          (a) => a.level === "info" && !["updated", "waiting", "kept", "pinned"].includes(a.flag),
        );
        for (const a of quiet) r.append(el("div", "pline", a.text));
        if (!i.entry) {
          const l = el("div", "pline");
          l.append(
            el(
              "span",
              "",
              "Not on zoteroplugins.org, so Atlas can't check it or hold its updates. ",
            ),
            link("Submit it", `${A.SITE}/submit`),
          );
          r.append(l);
        } else if (i.entry.grade !== "–" && !quiet.length && !i.same) {
          r.append(el("div", "pline", `The grade is for version ${i.entry.version}.`));
        }
        if (i.entry)
          r.append(
            rateBox({
              slug: i.entry.slug,
              addon: i.addon.id,
              version: i.addon.version,
              name: i.entry.name,
            }),
          );
        box.append(r);
      }
      det.append(box);
      all.append(det);
    }

    // Removed in the last month: still worth a rating, above all from someone who removed it fast.
    const gone = $("gone");
    gone.textContent = "";
    const removed = A.ratings.removed().sort((a, b) => b.at - a.at);
    if (removed.length) {
      const s = section("Removed in the last 30 days");
      const box = el("div", "box");
      for (const g of removed) {
        const r = el("div", "prow");
        const top = el("div", "ptop");
        top.append(
          el("b", "", g.name),
          el("span", "ver", `${g.version} · removed ${new Date(g.at).toLocaleDateString()}`),
        );
        r.append(top, rateBox({ slug: g.slug, addon: g.id, version: g.version, name: g.name }));
        box.append(r);
      }
      s.append(box);
      gone.append(s);
    }

    const foot = $("mine-foot");
    foot.textContent = "";
    const hold = A.updates.choice() === "hold";
    foot.append(
      el("span", "", `Updates: ${hold ? "held until they're checked" : "left to Zotero"} · `),
      button(hold ? "Stop holding" : "Hold them", "linkish", () =>
        A.updates.set(hold ? "off" : "hold"),
      ),
      el(
        "span",
        "",
        ` · Checked against Zotero's blocklist and our list of known security problems${rv?.fetchedAt ? `, ${ago(Math.max(rv.fetchedAt, rv.advisoriesAt || 0))}` : ""} · Usage data: ${A.usage.choice() === "yes" ? "on" : "off"}`,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Move to another computer: save a list here, open it there

  let movePlan = null; // { plan, settings, exportedAt } from the file opened

  function say(id, text, bad) {
    const o = $(id);
    o.textContent = text || "";
    o.hidden = !text;
    o.classList.toggle("bad", Boolean(bad));
  }

  function syncSecrets() {
    const on = $("move-settings").checked;
    $("move-secrets").disabled = !on;
    if (!on) $("move-secrets").checked = false;
  }

  async function exportTo(path) {
    const opts = { settings: $("move-settings").checked, secrets: $("move-secrets").checked };
    try {
      const r = await A.move.write(path, opts);
      let t = `Saved ${r.plugins} plugin${r.plugins === 1 ? "" : "s"} to ${r.path}.`;
      if (opts.settings) t += ` ${r.settings} setting${r.settings === 1 ? "" : "s"} included.`;
      if (r.leftOut)
        t += ` ${r.leftOut} that look${r.leftOut === 1 ? "s" : ""} like a key or password left out.`;
      say("move-export-out", t);
      return r;
    } catch (e) {
      say("move-export-out", `The file couldn't be saved: ${e.message || e}`, true);
      return null;
    }
  }

  async function importFrom(path) {
    const r = await A.move.read(path);
    if (r.error) {
      movePlan = null;
      say("move-import-out", r.error, true);
    } else {
      movePlan = r;
      say("move-import-out", `${path}${r.exportedAt ? `, saved ${date(r.exportedAt)}` : ""}`);
    }
    renderPlan();
    return r;
  }

  function renderPlan() {
    const box = $("move-plan");
    box.textContent = "";
    if (!movePlan) return;
    const plan = movePlan.plan;
    const go = plan.filter((p) => p.action === "install" || p.action === "newer");
    const s = el("div", "block plan");
    const list = el("div", "box");
    const rows = new Map();
    for (const p of plan) {
      const r = el("div", `prow${go.includes(p) ? " go" : ""}`);
      const top = el("div", "ptop");
      top.append(gradePill(p.grade ?? p.currentGrade ?? "–", Boolean(p.page)));
      top.append(p.page ? link(p.name, p.page) : el("b", "", p.name));
      if (p.wanted) top.append(el("span", "ver", p.wanted));
      top.append(el("span", "ptext", p.text));
      r.append(top);
      rows.set(p.id, r);
      list.append(r);
    }
    s.append(list);
    const act = el("div", "plan-act");
    const note = el("span", "mnote");
    if (go.length) {
      const withSettings = go.some((p) => Object.keys(movePlan.settings?.[p.id] || {}).length);
      note.textContent = withSettings ? "Then it sets their settings from the file." : "";
      const b = button(
        `Install ${go.length} plugin${go.length === 1 ? "" : "s"}`,
        "primary",
        async () => {
          for (const p of go) rows.get(p.id).querySelector(".ptext").textContent = "Waiting…";
          note.textContent = "Installing…";
          const r = await A.move.install(plan, movePlan.settings, (item, res) => {
            const row = rows.get(item.id);
            row.classList.remove("go");
            row.classList.add(res.ok ? "ok" : "bad");
            row.querySelector(".ptext").textContent = res.ok
              ? `Installed ${item.version}`
              : res.message;
          });
          b.remove();
          let t = `${r.installed} installed.`;
          if (r.failed.length) t += ` ${r.failed.length} couldn't be installed.`;
          t += r.applied
            ? ` ${r.applied} setting${r.applied === 1 ? "" : "s"} set: restart Zotero so the plugins start with them.`
            : " No restart needed.";
          note.textContent = t;
          await refreshInstalled();
        },
      );
      act.append(b, note);
    } else {
      note.textContent = "Nothing to install here.";
      act.append(note);
    }
    s.append(act);
    box.append(s);
  }

  async function refreshInstalled(force) {
    rv = await A.review(Boolean(force));
    show();
  }

  function show() {
    rv = A.last() || rv;
    byId = new Map((rv?.items || []).filter((i) => i.entry).map((i) => [i.addon.id, i]));
    renderMine();
    renderFind();
    if (tab === "mine") A.ack();
  }

  async function load(force) {
    status(force ? "Fetching the catalogue…" : "Loading…");
    $("refresh").disabled = true;
    try {
      data = await A.catalog(Boolean(force));
      await refreshInstalled(force);
      status("");
    } catch (e) {
      status(String(e.message || e));
    }
    $("refresh").disabled = false;
  }

  function showTab(which) {
    tab = ["mine", "move"].includes(which) ? which : "find";
    for (const t of ["find", "mine", "move"]) {
      $(t).hidden = tab !== t;
      $(`tab-${t}`).classList.toggle("on", tab === t);
    }
    if (tab === "mine" && rv) A.ack();
  }
  window.zoteroAtlasShow = showTab;
  window.zoteroAtlasMove = { exportTo, importFrom };

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
    $("tab-move").addEventListener("click", () => showTab("move"));
    $("move-settings").addEventListener("change", syncSecrets);
    $("move-export").addEventListener("click", async () => {
      const b = $("move-export");
      b.disabled = true;
      try {
        const path = await A.move.pickSave(window);
        if (path) await exportTo(path);
      } catch (e) {
        say("move-export-out", String(e.message || e), true);
      } finally {
        b.disabled = false;
      }
    });
    $("move-import").addEventListener("click", async () => {
      const b = $("move-import");
      b.disabled = true;
      try {
        const path = await A.move.pickOpen(window);
        if (path) await importFrom(path);
      } catch (e) {
        say("move-import-out", String(e.message || e), true);
      } finally {
        b.disabled = false;
      }
    });
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
    // Zotero places the window after this load event; then make sure its title bar is on screen.
    window.setTimeout(() => A.keepOnScreen(window));
    A.closeOnEscape(window, (ev) => {
      const t = ev.target;
      // Escape empties the search box first, and never throws away a review being written.
      if (t?.id === "q" && t.value) {
        t.value = "";
        shown = PAGE;
        renderFind();
        return true;
      }
      return t?.localName === "textarea" && t.value.trim() !== "";
    });
    const args = window.arguments?.[0]?.wrappedJSObject ?? window.arguments?.[0];
    showTab(args?.tab || "find");
    const off = A.subscribe(() => {
      if (data) show();
    });
    window.addEventListener("unload", off, { once: true });
    load(false);
  });
})();
