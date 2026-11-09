// zoteroatlas.com: the search example on the home page, and the download on /install.
// Nothing here talks to a server. The example's rows are real catalogue entries (grade, reason,
// version, downloads) copied from zoteroplugins.org's catalog.json.
(() => {
  "use strict";

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
  const DATA = {
    translate: {
      q: "translate a PDF",
      rows: [
        ["B", "Translate for Zotero", "2.4.8", "11.5M", "Translates text as you select it in the PDF, EPUB or web reader, plus titles, abstracts, annotations and notes, using 20+ services.", "it sends your text or keys unencrypted (http://) to api.fanyi.baidu.com, api.interpreter.caiyunai.com and 2 more"],
        ["B", "Zotero PDF2zh", "4.1.8", "827K", "Translates entire PDFs with PDFMathTranslate, keeping equations and layout intact, and attaches bilingual copies to the item.", "a zotero:// link (a web page can open one) can make it install add-ons without asking you, and 1 more finding"],
        ["A+", "PDF Translate", "1.2.0", "3K", "Shows a translate button when you select text in the PDF or EPUB reader and opens a floating translation card beside it.", "every code check came out low, and our live test in Zotero found nothing unexpected"],
      ],
    },
    dup: {
      q: "merge duplicates",
      rows: [
        ["A", "Linter for Zotero", "4.0.4", "3.2M", "Lints item metadata: sentence-case titles, journal abbreviations, dates, DOIs and pages, and duplicate warnings on import.", "every code check came out low"],
        ["A+", "Zoplicate", "5.1.1", "1.0M", "Catches duplicates the moment you import and asks whether to keep the new copy, the old one or both, then merges without losing attachments or notes.", "every code check came out low, and our live test in Zotero found nothing unexpected"],
        ["A", "Attachment Scanner", "0.6.1", "45K", "Scans your library for items with missing, absent or duplicate attachments and tags them.", "every code check came out low"],
      ],
    },
    notes: {
      q: "notes in Notion or Obsidian",
      rows: [
        ["A+", "Notero", "2.1.0", "1.1M", "Syncs items from chosen Zotero collections into a Notion database, one page per item with its metadata, and optionally its notes and annotations.", "every code check came out low, and our live test in Zotero found nothing unexpected"],
        ["B", "MarkDB-Connect", "0.2.4", "302K", "Scans a folder of Markdown notes for citation keys or Zotero item keys and adds a coloured tag to the matching items.", "a zotero:// link (a web page can open one) can make it install add-ons without asking you, and 1 more finding"],
        ["A", "ZotLit", "2.2.2", "41K", "Connects Zotero to Obsidian: creates Markdown literature notes from items using your templates and inserts citations.", "every code check came out low"],
      ],
    },
    chat: {
      q: "chat with a PDF",
      rows: [
        ["C", "llm-for-zotero", "3.9.16", "873K", "An AI assistant in the reader: chat with a PDF, selection, figures or several papers, with citations that jump to the source passage.", "it installs and runs npm or PyPI packages without a fixed version, and 1 more finding"],
        ["C", "Awesome GPT", "3.1.200", "614K", "A floating GPT chat window: ask about the open PDF or selected text, summarize papers and search your library.", "it runs encrypted code we can't read, and 2 more findings"],
        ["A", "Zotero ChatGPT", "1.7", "45K", "Puts ChatGPT inside Zotero with a right-click menu and a reader pane for questions with streamed answers.", "every code check came out low"],
      ],
    },
  };
  const ORDER = ["translate", "dup", "notes", "chat"];
  const CLS = { "A+": "gAp", A: "gA", B: "gB", C: "gC" };
  const qEl = document.getElementById("q-text");
  const list = document.getElementById("results");
  const chips = Array.from(document.querySelectorAll("[data-q]"));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let current = "translate";
  let run = 0;
  let paused = false;

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const row = ([g, name, ver, dl, sum, why]) => {
    const act =
      g === "C"
        ? '<button class="ui-btn" type="button">Install</button><small>Serious concerns found: read the card first</small>'
        : '<button class="ui-btn primary" type="button">Install</button>';
    return (
      `<li class="res"><div class="res-main"><div class="res-name"><span class="pill ${CLS[g]}">${g}</span>` +
      `<b>${esc(name)}</b><small>${ver} · ${dl} downloads</small></div>` +
      `<p class="res-sum">${esc(sum)}</p><p class="res-why">Grade ${g}: ${esc(why)}.</p>` +
      '<p class="res-links"><span>Full card on zoteroplugins.org</span><span>GitHub</span></p></div>' +
      `<div class="res-act">${act}</div></li>`
    );
  };
  const render = (key) => {
    list.innerHTML = DATA[key].rows.map(row).join("");
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
