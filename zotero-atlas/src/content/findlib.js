/* global window */
// The parts of Find plugins that don't touch the page: the jobs, the tile for a plugin without
// its own icon, and Best match. Kept apart so `node test.cjs`, and the directory's own tests on the
// real catalogue, run exactly this code (in a vm context whose `window` is a plain object).
(() => {
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

  /**
   * A plugin without its own icon gets its first job's symbol on that job's colour, the same as on
   * zoteroplugins.org (schema/src/jobArt.ts there). Colours keep clear of the grades' green,
   * yellow and red. [background, symbol] for light and dark; `fill` draws the symbol solid.
   */
  const JOB_ART = {
    reading: {
      path: "M2 6c3-1.5 6-1.5 10 1c4-2.5 7-2.5 10-1v13c-3-1.5-6-1.5-10 1c-4-2.5-7-2.5-10-1z M12 7v13",
      light: ["#d3efff", "#265b8d"],
      dark: ["#1c354d", "#a3cffe"],
    },
    citing: {
      path: "M10 6c-3 1-5 3.5-5 7v4h5v-5H5z M19 6c-3 1-5 3.5-5 7v4h5v-5h-5z",
      fill: true,
      light: ["#e4e8ff", "#4e508e"],
      dark: ["#2d2f4e", "#c0c5ff"],
    },
    ai: {
      path: "M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z M18.5 14.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z",
      light: ["#f4e3ff", "#674689"],
      dark: ["#3a2a4b", "#d8bcfa"],
    },
    translation: {
      path: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
      light: ["#cbf3fe", "#006477"],
      dark: ["#0f3942", "#93d7e8"],
    },
    organising: {
      path: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
      light: ["#ffdef0", "#803f60"],
      dark: ["#472737", "#f4b5d2"],
    },
    metadata: {
      path: "M3 4.5V11l9.5 9.5a1.5 1.5 0 0 0 2 0l6-6a1.5 1.5 0 0 0 0-2L11 3H4.5A1.5 1.5 0 0 0 3 4.5z M7.5 7.5h.01",
      light: ["#f1e7f3", "#625166"],
      dark: ["#382f3a", "#d4c4d8"],
    },
    interface: {
      path: "M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z M3 9h18 M9 9v11",
      light: ["#e6ebf7", "#4f586b"],
      dark: ["#2e333c", "#c2cbdd"],
    },
    files: {
      path: "M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7",
      light: ["#f5e8df", "#685342"],
      dark: ["#3b3028", "#dbc6b7"],
    },
  };
  /** The job whose tile a plugin without an icon gets: its first job that has one. */
  const tileJob = (e) => (e.jobs || []).find((j) => JOB_ART[j]) || null;

  const lineOf = (e) => e.line || (e.summary || "").split(/(?<=\.)\s/)[0] || "";
  const useOf = (e) => (typeof e.inUse === "number" ? e.inUse : null);

  /** Best match leans a little towards better grades: worth about a third of a tenfold in use. */
  const GRADE_NUDGE = { "A+": 6, A: 6, B: 2, C: -8, "–": -4 };
  // Words a search can leave out: "find duplicates" means "duplicates".
  const STOP = new Set(
    "a an the in on of for to with and or my me i want can how do get find from into by zotero plugin plugins".split(
      " ",
    ),
  );
  /** A word's stem, so "summarise", "summarize" and "summaries" all find "summar…". */
  function stem(w) {
    let s = w.replace(/(is|iz)(e|es|ed|er|ing)$/, "").replace(/ies$/, "y");
    if (s === w && s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
    return s.length >= 3 ? s : w;
  }
  /** A search's words, stemmed, without the ones that say nothing about which plugin is meant. */
  function words(q) {
    const all = String(q || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const kept = all.filter((w) => !STOP.has(w));
    return (kept.length ? kept : all).map(stem);
  }

  /** Everything a search looks in: a plugin matches when every word is somewhere in here. */
  const haystack = (e) =>
    [
      e.name,
      lineOf(e),
      e.summary || "",
      e.slug,
      ...(e.jobs || []).map((j) => JOB_TITLE[j] || j),
      ...(e.ask || []),
    ]
      .join(" ")
      .toLowerCase();

  /**
   * Best match: how well the words match (the name counts most, then the one-line description,
   * then the ways people ask for it, then the jobs), blended with how many people use the plugin,
   * so a widely used plugin isn't buried under small namesakes and an exact name still comes first.
   * One way of asking that holds every word says what the search means, not a stray word in a
   * summary, so it counts nearly as much as the name.
   */
  function score(e, ws) {
    const name = e.name.toLowerCase();
    const line = lineOf(e).toLowerCase();
    const jobs = (e.jobs || []).map((j) => (JOB_TITLE[j] || j).toLowerCase()).join(" ");
    const asks = (e.ask || []).map((a) => a.toLowerCase());
    const phrase = ws.join(" ");
    let s = name === phrase ? 60 : name.includes(phrase) ? 30 : 0;
    for (const w of ws) {
      if (name.includes(w)) s += 12;
      if (line.includes(w)) s += 8;
      if (asks.some((a) => a.includes(w))) s += 6;
      if (jobs.includes(w)) s += 3;
    }
    if (asks.some((a) => ws.every((w) => a.includes(w)))) s += 20;
    // Every word in the name or the one-line description, not only somewhere in the summary.
    if (ws.every((w) => name.includes(w) || line.includes(w))) s += 15;
    const n = useOf(e) ?? Math.round((e.downloads || 0) / 20);
    return s + Math.log10(n + 1) * 12 + (GRADE_NUDGE[e.grade] ?? 0);
  }

  window.ZoteroAtlasLib = {
    JOBS,
    JOB_TITLE,
    JOB_ART,
    tileJob,
    lineOf,
    useOf,
    stem,
    words,
    haystack,
    score,
  };
})();
