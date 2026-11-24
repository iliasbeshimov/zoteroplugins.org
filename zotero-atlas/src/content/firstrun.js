/* global Zotero, window, document */
// The first-run screen: what Zotero is used for (a plugin pack to open, or "Just looking"), and
// whether to hold plugin updates until they're checked, starting at the recommended choice.
// bootstrap.js passes an object in window.arguments and reads the answers back when the screen
// closes; closing it any other way keeps the tick and opens no pack.
(() => {
  const A = Zotero.ZoteroAtlas;
  const $ = (id) => document.getElementById(id);
  const answer = window.arguments?.[0]?.wrappedJSObject ?? window.arguments?.[0] ?? {};

  const picks = () => [...document.querySelectorAll('input[name="start"]')];

  function paint() {
    $("hold-opt").classList.toggle("on", $("hold").checked);
    answer.updates = $("hold").checked ? "hold" : "off";
    for (const r of picks()) r.closest("label").classList.toggle("on", r.checked);
    answer.start = picks().find((r) => r.checked)?.value || "";
  }

  window.addEventListener("load", () => {
    $("hold").addEventListener("change", paint);
    for (const r of picks()) r.addEventListener("change", paint);
    paint();
    $("done").addEventListener("click", () => {
      paint();
      answer.done = true;
      window.close();
    });
    window.addEventListener("keydown", (ev) => {
      // localName: in an XHTML page tagName is lower case, so "BUTTON" never matched.
      if (ev.key === "Enter" && ev.target?.localName !== "button") $("done").click();
    });
    $("done").focus();
    window.sizeToContent?.();
    // On a small screen the page scrolls instead of running off it.
    window.setTimeout(() => A.keepOnScreen?.(window));
  });
})();
