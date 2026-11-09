/* global Zotero, window, document */
// The first-run screen: two answers, both starting at the recommended choice. bootstrap.js
// passes an object in window.arguments and reads the answers back when the screen closes.
(() => {
  const A = Zotero.ZoteroAtlas;
  const $ = (id) => document.getElementById(id);
  const answer = window.arguments?.[0]?.wrappedJSObject ?? window.arguments?.[0] ?? {};

  function paint() {
    $("hold-opt").classList.toggle("on", $("hold").checked);
    $("yes-opt").classList.toggle("on", $("yes").checked);
    $("no-opt").classList.toggle("on", $("no").checked);
    answer.updates = $("hold").checked ? "hold" : "off";
    answer.usage = $("no").checked ? "no" : "yes";
  }

  window.addEventListener("load", () => {
    for (const id of ["hold", "yes", "no"]) $(id).addEventListener("change", paint);
    paint();
    $("show").addEventListener("click", async () => {
      const out = $("sent");
      if (!out.hidden) {
        out.hidden = true;
        return;
      }
      try {
        out.textContent = JSON.stringify(await A.usage.payload("first-run"), null, 2);
      } catch (_e) {
        out.textContent = "The list couldn't be read.";
      }
      out.hidden = false;
      window.sizeToContent?.();
    });
    $("done").addEventListener("click", () => {
      paint();
      answer.done = true;
      window.close();
    });
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target?.tagName !== "BUTTON") $("done").click();
    });
    $("done").focus();
    window.sizeToContent?.();
  });
})();
