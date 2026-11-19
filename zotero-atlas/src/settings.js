/* global Zotero, document, window, setTimeout */
// The settings pane's buttons, the "Share my plugin list" box and the line about the ID. The
// holding radios bind to their setting themselves (preference="…"); the box is a yes/no string
// setting, so it's wired here. The plugin reacts to either change in bootstrap.js.
(() => {
  const A = Zotero.ZoteroAtlas;
  function init() {
    const open = document.getElementById("zotero-atlas-open");
    if (!open || open.dataset.wired) return;
    open.dataset.wired = "1";
    open.addEventListener("command", () => A.openWindow());
    document
      .getElementById("zotero-atlas-move")
      ?.addEventListener("command", () => A.openWindow("move"));
    document
      .getElementById("zotero-atlas-about")
      ?.addEventListener("command", () => A.openWindow("about"));
    const line = document.getElementById("zotero-atlas-id-line");
    const share = document.getElementById("zotero-atlas-share");
    const refresh = () => {
      share.checked = A.usage.choice() === "yes";
      const id = A.usage.id();
      const sent = A.usage.lastSent();
      line.textContent = !share.checked
        ? "Off: nothing is sent."
        : id
          ? `Your random ID: ${id}. Last sent: ${sent ? new Date(sent).toLocaleString() : "not yet"}.`
          : "Nothing sent yet: the first report goes with Zotero Atlas's next check.";
    };
    refresh();
    share.addEventListener("command", () => {
      A.usage.set(share.checked ? "yes" : "no");
      setTimeout(refresh, 1500);
    });
    document.getElementById("zotero-atlas-preview").addEventListener("command", async () => {
      const out = document.getElementById("zotero-atlas-preview-out");
      out.textContent = JSON.stringify(await A.usage.payload("preview"), null, 2);
      out.hidden = false;
    });
  }
  if (document.getElementById("zotero-atlas-open")) init();
  else window.addEventListener("load", init, { once: true });
})();
