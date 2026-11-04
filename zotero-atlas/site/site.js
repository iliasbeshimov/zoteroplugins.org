// Shows the published totals once the usage-data server exists. Nothing is sent: a GET to this
// site's own /api/v1/totals.json, which the privacy page describes.
(async () => {
  const el = document.getElementById("numbers");
  if (!el) return;
  try {
    const r = await fetch("/api/v1/totals.json", { cache: "no-store" });
    if (!r.ok) return;
    const t = await r.json();
    const installs = typeof t.installs === "number" ? t.installs : t.installs?.n;
    if (typeof installs !== "number") return;
    el.querySelector("[data-installs]").textContent = installs.toLocaleString("en");
    el.querySelector("[data-plugins]").textContent = Object.keys(
      t.plugins || {},
    ).length.toLocaleString("en");
    el.querySelector("[data-at]").textContent = new Date(t.generatedAt).toLocaleDateString(
      "en-GB",
      {
        day: "numeric",
        month: "short",
        year: "numeric",
      },
    );
    el.hidden = false;
  } catch {
    /* no server yet, or offline: the section stays hidden */
  }
})();
