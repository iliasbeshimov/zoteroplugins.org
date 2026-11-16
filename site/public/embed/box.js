/*
 * zoteroplugins.org: the self-updating box for library guides. https://zoteroplugins.org/librarians
 *
 * Finds <div data-zoteroplugins-box="<pack>"> and fills its [data-zoteroplugins-list] element with
 * that plugin pack's current picks, which we rebuild every night. If anything fails, the box keeps
 * the text and link the guide already has.
 *
 * Privacy: this script sets no cookies, stores nothing in the browser and loads nothing else. Its
 * one request goes to zoteroplugins.org, which counts how often the box is shown on each website
 * (the site's name only) and nothing about the reader.
 */
(() => {
  const API = "https://zoteroplugins.org/api/v1/box.json";
  const CSS =
    ".zpbox-lead{margin:0 0 .4em}" +
    ".zpbox-list{list-style:none;padding:0;margin:0 0 .6em}" +
    ".zpbox-list li{margin:0 0 .5em}" +
    ".zpbox-task{display:block;font-size:.85em;opacity:.8}" +
    ".zpbox-meta{font-size:.85em;opacity:.8;white-space:nowrap}" +
    ".zpbox-foot{margin:0;font-size:.85em;opacity:.8}";

  function addCss() {
    if (document.getElementById("zpbox-css")) return;
    const s = document.createElement("style");
    s.id = "zpbox-css";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function a(href, text) {
    const e = el("a", "", text);
    // Only our own pages: anything else in the data is ignored.
    if (/^https:\/\/zoteroplugins\.org\//.test(href)) e.href = href;
    return e;
  }
  function day(iso) {
    const d = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        });
  }

  function render(box, data) {
    const pack = data?.packs?.[0];
    if (!pack?.picks?.length) return;
    const wrap = el("div", "zpbox");
    const lead = el("p", "zpbox-lead");
    lead.append(
      a(pack.url, pack.title),
      document.createTextNode(`, checked ${day(data.updated)}:`),
    );
    const list = el("ul", "zpbox-list");
    for (const p of pack.picks) {
      const li = el("li");
      li.append(el("span", "zpbox-task", p.task), a(p.url, p.name));
      li.append(
        document.createTextNode(" "),
        el("span", "zpbox-meta", `grade ${p.grade}, Zotero ${p.works}`),
      );
      list.append(li);
    }
    const foot = el("p", "zpbox-foot");
    foot.append(
      document.createTextNode("Updated every night by "),
      a("https://zoteroplugins.org/", "zoteroplugins.org"),
      document.createTextNode("."),
    );
    wrap.append(lead, list, foot);
    const slot = box.querySelector("[data-zoteroplugins-list]");
    if (slot) slot.replaceWith(wrap);
    else box.append(wrap);
  }

  /** Inside our own framed page, the website showing it is the frame's referrer. */
  function via() {
    if (location.hostname !== "zoteroplugins.org" || window.self === window.top) return "";
    try {
      return new URL(document.referrer).hostname;
    } catch (_e) {
      return "";
    }
  }

  const boxes = document.querySelectorAll("[data-zoteroplugins-box]");
  if (!boxes.length || !window.fetch) return;
  addCss();
  for (const box of boxes) {
    if (box.getAttribute("data-zoteroplugins-done")) continue;
    box.setAttribute("data-zoteroplugins-done", "1");
    const pack = box.getAttribute("data-zoteroplugins-box") || "";
    const v = via();
    const q = `?pack=${encodeURIComponent(pack)}${v ? `&via=${encodeURIComponent(v)}` : ""}`;
    fetch(API + q, { credentials: "omit", referrerPolicy: "origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) render(box, d);
      })
      .catch(() => {});
  }
})();
