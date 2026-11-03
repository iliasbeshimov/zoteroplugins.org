/* global Zotero, document, window, setTimeout */
// The settings pane's buttons and the line about the ID. The radios bind to the setting
// themselves (preference="…"); the plugin reacts to the change in bootstrap.js.
(() => {
  const A = Zotero.ZoteroAtlas;
  function init() {
    const open = document.getElementById("zotero-atlas-open");
    if (!open || open.dataset.wired) return;
    open.dataset.wired = "1";
    open.addEventListener("command", () => A.openWindow());
    const line = document.getElementById("zotero-atlas-id-line");
    const refresh = () => {
      const id = A.usage.id();
      const sent = A.usage.lastSent();
      line.textContent = id
        ? `Your random ID: ${id}. Last sent: ${sent ? new Date(sent).toLocaleString() : "not yet"}.`
        : "No ID has been created and nothing has been sent.";
    };
    refresh();
    document.getElementById("zotero-atlas-preview").addEventListener("command", async () => {
      const out = document.getElementById("zotero-atlas-preview-out");
      out.textContent = JSON.stringify(await A.usage.payload("preview"), null, 2);
      out.hidden = false;
    });
    document
      .querySelector('radiogroup[preference="extensions.zotero-atlas.usage"]')
      ?.addEventListener("command", () => setTimeout(refresh, 1500));
  }
  if (document.getElementById("zotero-atlas-open")) init();
  else window.addEventListener("load", init, { once: true });
})();
