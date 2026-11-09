// Google Analytics for this website, through Google Tag Manager. The Zotero Atlas plugin never
// loads it. In the EEA, the UK and Switzerland it loads only after the visitor accepts; elsewhere
// it loads unless the browser sends Global Privacy Control or the visitor has turned it off. The
// country comes from Cloudflare's /cdn-cgi/trace on this site (from the visitor's IP; only the
// country is read, and it's kept for the session). If the country can't be told, the visitor is
// asked.
//
// The answer is kept in localStorage, never a cookie. Turning it off while it's loaded deletes
// Google's cookies and reloads the page, so the tag is gone. Any element with data-consent-open
// reopens the question (the privacy page has one).
(() => {
  "use strict";
  const KEY = "za-analytics"; // "granted" or "denied"; absent until the visitor answers
  const GTM_ID = "GTM-KQT7N2CQ";
  // Where the visitor is asked first: the EEA (with the EU's outermost regions and Åland), the UK
  // with Gibraltar and the Crown Dependencies, and Switzerland.
  const ASK = new Set(
    (
      "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO " +
      "AX GF GP MQ RE YT MF GB GI GG JE IM CH"
    ).split(" "),
  );
  let loaded = false;
  let box = null;
  let head = null;

  // Storage can be blocked (the getter itself throws); then the answer holds for this page only.
  function store(area, key, value) {
    try {
      if (value === undefined) return window[area].getItem(key);
      window[area].setItem(key, value);
    } catch {
      // blocked
    }
    return null;
  }

  // Google's own snippet, run only when analytics may load.
  function load() {
    if (loaded) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    const dataLayer = window.dataLayer;
    function gtag() {
      // The Arguments object, not an array: that's what the tag reads.
      dataLayer.push(arguments);
    }
    gtag("js", new Date());
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`;
    document.head.append(s);
  }

  // Google Analytics' cookies, set on this host or a parent domain (GA picks the highest one the
  // browser accepts: .zoteroatlas.com here, .zoteroatlas.pages.dev on a preview).
  function clearCookies() {
    const parts = location.hostname.split(".");
    const domains = [""];
    for (let i = 0; i < parts.length - 1; i++)
      domains.push(`; domain=.${parts.slice(i).join(".")}`);
    for (const c of document.cookie.split(";")) {
      const name = c.split("=")[0].trim();
      if (!/^(_ga|_gid|_gat|_gcl)/.test(name)) continue;
      for (const d of domains)
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d}`;
    }
  }

  // The visitor's country as Cloudflare sees it, or "" when it can't be told.
  async function country() {
    const kept = store("sessionStorage", "za-loc");
    if (kept !== null) return kept;
    let loc = "";
    try {
      const r = await fetch("/cdn-cgi/trace", { cache: "no-store" });
      if (r.ok) loc = /^loc=([A-Z]{2})$/m.exec(await r.text())?.[1] ?? "";
    } catch {
      // Not on Cloudflare (a local copy) or blocked: ask.
    }
    if (loc === "XX" || loc === "T1") loc = ""; // unknown, or Tor
    store("sessionStorage", "za-loc", loc);
    return loc;
  }

  function banner() {
    if (box) return box;
    box = document.createElement("div");
    box.className = "consent";
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Analytics");
    box.hidden = true;
    box.innerHTML =
      "<p><strong data-consent-head>Google Analytics stays off unless you accept.</strong> " +
      "When it's on, it counts your visit to this website: Google gets your IP address, your " +
      "browser and the pages you view here, and sets its cookies. The plugin never uses it. " +
      '<a href="/privacy#website">More about this</a></p>' +
      '<div class="consent-actions">' +
      '<button type="button" class="btn" data-consent="denied">Decline</button>' +
      '<button type="button" class="btn" data-consent="granted">Accept</button>' +
      "</div>";
    head = box.querySelector("[data-consent-head]");
    box.addEventListener("click", (e) => {
      const v = e.target.closest("[data-consent]")?.dataset.consent;
      if (!v) return;
      store("localStorage", KEY, v);
      box.hidden = true;
      if (v === "granted") return load();
      clearCookies();
      if (loaded) location.reload();
    });
    document.body.append(box);
    return box;
  }

  function ask(text) {
    banner();
    if (text) head.textContent = text;
    box.hidden = false;
  }

  async function start() {
    const choice = store("localStorage", KEY);
    if (choice === "granted") return load();
    let on = false;
    if (choice !== "denied" && navigator.globalPrivacyControl !== true) {
      const loc = await country();
      if (!loc || ASK.has(loc)) ask();
      else on = true;
    }
    if (on) load();
    // Not loading: drop any Google cookies left over, such as one the tag rewrote while the page
    // that turned it off was unloading.
    else clearCookies();
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("[data-consent-open]")) return;
    e.preventDefault();
    ask(loaded ? "Google Analytics is on." : "Google Analytics is off.");
    box.querySelector("button").focus();
  });

  start();
})();
