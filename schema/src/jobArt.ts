/**
 * The tile a plugin without its own icon gets: its main job's symbol on that job's colour. Used
 * by the site's plugin icons and, copied, by Zotero Atlas (zotero-atlas/src/content/findlib.js;
 * site/test/job-art.test.ts keeps the two the same). The colours keep clear of the grades' green,
 * yellow and red, so a tile never reads as a grade. Symbols are 24×24 paths drawn with a 2 px
 * round stroke; `fill` draws one solid.
 */
export interface JobArt {
  path: string;
  fill?: boolean;
  /** [background, symbol] on a light page. */
  light: [string, string];
  /** [background, symbol] on a dark page. */
  dark: [string, string];
}

export const JOB_ART: Record<string, JobArt> = {
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
export const tileJob = (jobs: readonly string[]): string | null =>
  jobs.find((j) => j in JOB_ART) ?? null;
