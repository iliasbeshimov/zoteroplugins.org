// zoteroatlas.com: the search example on the home page, and the download on /install.
// Nothing here talks to a server. The example's rows are what Zotero Atlas shows for each search,
// made from zoteroplugins.org's catalog.json; only the plugin icons load from zoteroplugins.org.
(() => {
  // ── /install?start: start the download, then show the guide ──
  const link = document.getElementById("dl-link");
  if (link && new URLSearchParams(location.search).has("start")) {
    const ready = document.getElementById("dl-ready");
    const started = document.getElementById("dl-started");
    if (ready && started) {
      ready.hidden = true;
      started.hidden = false;
    }
    // Counted in Google Analytics (GTM tag "GA4 event - atlas_download") only once consent.js has
    // loaded Tag Manager: wait up to a minute for it, so the event comes after the Google tag
    // and a visitor who accepts the question meanwhile is counted. Nothing is queued otherwise.
    const version = link.dataset.version || "";
    let tries = 0;
    const count = () => {
      if (window.google_tag_manager && Array.isArray(window.dataLayer)) {
        window.dataLayer.push({ event: "atlas_download", atlas_version: version });
      } else if (++tries < 120) {
        setTimeout(count, 500);
      }
    };
    count();
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = link.href;
      a.download = "";
      document.body.append(a);
      a.click();
      a.remove();
    }, 350);
    // A reload shouldn't download it again.
    history.replaceState(null, "", location.pathname + location.hash);
  }

  // ── the search example ──
  const demo = document.getElementById("demo");
  if (!demo) return;
  // What Zotero Atlas 1.3.1's Best match shows for each search in Zotero 10.0.9: the top three of the
  // plugins that work with it, rows as Atlas draws them, from zoteroplugins.org's catalog.json
  // (16 Nov 2026). Icons come from zoteroplugins.org; a plugin without one gets its job's tile.
  const TILES = {
    translation: {
      path: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
      fill: false,
    },
    organising: {
      path: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
      fill: false,
    },
  };
  const DATA = {
    translate: {
      q: "translate a PDF",
      count: 144,
      more: 41,
      rows: [
        {
          g: "B",
          name: "Zotero PDF2zh",
          ver: "4.1.8",
          icon: "zotero-pdf2zh",
          tile: null,
          line: "Translate whole PDFs, layout and maths kept",
          why: "Use with care: a zotero:// link (a web page can open one) can make it install add-ons without asking you (from zotero-plugin-toolkit), and 1 more finding.",
          meta: "270k in use · GitHub 8.3k · updated Oct 30, 2026",
          needs: ["API key optional: OpenAI, DeepSeek and 2 more", "Local model"],
        },
        {
          g: "B",
          name: "Immersive Translate 沉浸式翻译",
          ver: "0.0.24",
          icon: null,
          tile: "translation",
          line: "Translate PDFs with Immersive Translate",
          why: "Use with care: it sends usage data to analytics.immersivetranslate.cn, analytics.immersivetranslate.com and www.google-analytics.com, and 2 more findings.",
          meta: "29k in use · GitHub 369 · updated Aug 20, 2026 · live test in Zotero 10.0.3: as described",
          needs: ["API key needed: Immersive Translate", "Docs in Chinese"],
        },
        {
          g: "B",
          name: "Full Text Translate",
          ver: "1.0.4",
          icon: "zotero-fulltext-translate",
          tile: null,
          line: "Translate PDFs to HTML via MinerU",
          why: "Use with care: a zotero:// link (a web page can open one) can make it install add-ons without asking you (from zotero-plugin-toolkit), and 1 more finding.",
          meta: "5k in use · GitHub 9 · updated Aug 17, 2026 · live test in Zotero 10.0.3: unexpected",
          needs: ["API key optional: MinerU"],
        },
      ],
    },
    dup: {
      q: "merge duplicates",
      count: 12,
      more: 8,
      rows: [
        {
          g: "A+",
          name: "Zoplicate",
          ver: "5.1.1",
          icon: "zoplicate",
          tile: null,
          line: "Merge duplicates as you import, keep notes",
          why: "Recommended, tested in Zotero: every code check came out low, and our live test in Zotero found nothing unexpected.",
          meta: "150k in use · GitHub 1k · updated Aug 27, 2026 · live test in Zotero 10.0.3: as described",
          needs: [],
        },
        {
          g: "A",
          name: "Merge All Duplicates",
          ver: "1.0.0",
          icon: null,
          tile: "organising",
          line: "Merge every duplicate set in one go",
          why: "Recommended: every code check came out low.",
          meta: "13 in use · updated Aug 27, 2026",
          needs: [],
        },
        {
          g: "B",
          name: "Duplicate Doctor for Zotero",
          ver: "0.2.0",
          icon: "zotero-duplicate-doctor",
          tile: null,
          line: "Merge webpage records into same-DOI articles",
          why: "Use with care: it keeps its own tables in Zotero's database.",
          meta: "140 in use · GitHub 1 · updated Jul 5, 2026 · live test in Zotero 10.0.3: as described",
          needs: [],
        },
      ],
    },
    notes: {
      q: "notes in Obsidian",
      count: 30,
      more: 20,
      rows: [
        {
          g: "A",
          name: "ZotLit",
          ver: "2.2.2",
          icon: "zotlit",
          tile: null,
          line: "Obsidian literature notes from your items",
          why: "Recommended: every code check came out low.",
          meta: "5.8k in use · GitHub 1.1k · updated Nov 9, 2026",
          needs: ["Local model"],
        },
        {
          g: "A+",
          name: "Zotero Obsidian Linker",
          ver: "0.2.9",
          icon: "zotero-obsidian-linker",
          tile: null,
          line: "Create linked Obsidian notes for items",
          why: "Recommended, tested in Zotero: every code check came out low, and our live test in Zotero found nothing unexpected.",
          meta: "170 in use · GitHub 4 · updated Jul 15, 2026 · live test in Zotero 10.0.3: as described",
          needs: [],
        },
        {
          g: "A+",
          name: "Obsidian Note for Zotero",
          ver: "1.0.3",
          icon: "zotlit--migueldlm",
          tile: null,
          line: "Zotero side of ZotLit for Obsidian",
          why: "Recommended, tested in Zotero: every code check came out low, and our live test in Zotero found nothing unexpected.",
          meta: "18 in use · GitHub 1 · updated Aug 18, 2026 · live test in Zotero 10.0.3: as described",
          needs: ["Local model", "Launches programs"],
        },
      ],
    },
    chat: {
      q: "chat with a PDF",
      count: 101,
      more: 54,
      rows: [
        {
          g: "B",
          name: "ChatPDF",
          ver: "0.10.2",
          icon: "zotero-chat-pdf",
          tile: null,
          line: "Chat with several PDFs, search your library",
          why: "Use with care: a zotero:// link (a web page can open one) can make it install add-ons without asking you (from zotero-plugin-toolkit), and 1 more finding.",
          meta: "160 in use · GitHub 3 · updated Oct 24, 2026",
          needs: ["API key needed: MinerU, DeepSeek"],
        },
        {
          g: "A",
          name: "ZoteroChat",
          ver: "0.2.2",
          icon: "zoterochat",
          tile: null,
          line: "Reader sidebar chat about the open PDF",
          why: "Recommended: every code check came out low.",
          meta: "140 in use · GitHub 17 · updated Oct 25, 2026",
          needs: ["API key needed: DeepSeek"],
        },
        {
          g: "C",
          name: "Awesome GPT",
          ver: "3.1.200",
          icon: "zotero-gpt",
          tile: null,
          line: "Floating GPT chat for PDFs and your library",
          why: "Not recommended: it runs encrypted code we can't read, and 2 more findings.",
          meta: "35k in use · GitHub 7.5k · updated Oct 28, 2026",
          needs: ["API key needed: OpenAI", "Launches programs", "Docs in Chinese"],
        },
      ],
    },
  };
  const ORDER = ["translate", "dup", "notes", "chat"];
  const CLS = { "A+": "gAp", A: "gA", B: "gB", C: "gC" };
  const qEl = document.getElementById("q-text");
  const list = document.getElementById("results");
  const countEl = document.getElementById("res-count");
  const chips = Array.from(document.querySelectorAll("[data-q]"));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let current = "translate";
  let run = 0;
  let paused = false;

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const icon = (r) => {
    if (r.icon)
      return `<img class="res-icon" src="https://zoteroplugins.org/icons/${r.icon}.png" alt="" width="44" height="44">`;
    const t = TILES[r.tile];
    return (
      `<span class="res-icon jtile j-${r.tile}"><svg width="26" height="26" viewBox="0 0 24 24" fill="${t.fill ? "currentColor" : "none"}" ` +
      `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${t.path}"/></svg></span>`
    );
  };
  // As Atlas draws a result: a C's Install is never the blue button, and says to read why first.
  const row = (r) => {
    const act =
      r.g === "C"
        ? '<button class="ui-btn" type="button">Install</button><small>Serious concerns: read why first</small>'
        : '<button class="ui-btn soft" type="button">Install</button>';
    const needs = r.needs.length
      ? `<p class="res-needs">${r.needs.map((n) => `<span>${esc(n)}</span>`).join("")}</p>`
      : "";
    return (
      `<li class="res">${icon(r)}<div class="res-main"><p class="res-name"><b>${esc(r.name)}</b><small>${esc(r.ver)}</small></p>` +
      `<p class="res-line">${esc(r.line)}</p>` +
      `<p class="res-why"><span class="pill ${CLS[r.g]}">${r.g}</span><span>${esc(r.why)}</span></p>` +
      `<p class="res-meta">${esc(r.meta)}</p>${needs}</div><div class="res-act">${act}</div></li>`
    );
  };
  const render = (key) => {
    const d = DATA[key];
    list.innerHTML = d.rows.map(row).join("");
    countEl.innerHTML = `${d.count} plugins work with your Zotero · <span>${d.more} more don't: show them</span>`;
    for (const c of chips) c.setAttribute("aria-pressed", String(c.dataset.q === key));
    current = key;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function typeTo(key, my) {
    list.classList.add("fading");
    let t = qEl.textContent;
    while (t.length) {
      t = t.slice(0, -1);
      qEl.textContent = t;
      await sleep(20);
      if (my !== run) return;
    }
    const target = DATA[key].q;
    for (let i = 1; i <= target.length; i++) {
      qEl.textContent = target.slice(0, i);
      await sleep(46);
      if (my !== run) return;
    }
    render(key);
    list.classList.remove("fading");
  }

  async function loop() {
    const my = ++run;
    while (my === run) {
      await sleep(4800);
      if (my !== run) return;
      while (paused || document.hidden) {
        await sleep(400);
        if (my !== run) return;
      }
      await typeTo(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length], my);
    }
  }

  for (const c of chips) {
    c.addEventListener("click", () => {
      run++; // a chosen search stops the slideshow
      qEl.textContent = DATA[c.dataset.q].q;
      render(c.dataset.q);
      list.classList.remove("fading");
    });
  }
  list.addEventListener("click", (e) => {
    const b = e.target.closest("button.ui-btn");
    if (!b || b.disabled) return;
    b.disabled = true;
    b.textContent = "Installing…";
    setTimeout(() => {
      b.className = "ui-btn done";
      b.textContent = "✓ Installed";
    }, 700);
  });
  for (const el of [demo, document.getElementById("try")]) {
    if (!el) continue;
    el.addEventListener("mouseenter", () => (paused = true));
    el.addEventListener("mouseleave", () => (paused = false));
    el.addEventListener("focusin", () => (paused = true));
    el.addEventListener("focusout", () => (paused = false));
  }
  if (!reduce) loop();
})();
