import { JOBS } from "@atlas/schema";
import type { APIRoute } from "astro";
import { allPlugins, fmtDate, shownPlugins } from "../lib/atlas.ts";
import { GUIDES } from "../lib/guides.ts";
import { SITE } from "../lib/links.ts";
import { jobTitle } from "../lib/meta.ts";

/**
 * /llms.txt (llmstxt.org): a plain-text map of the site for language models: what the grades mean,
 * where the lists, guides and open data are, and the most-downloaded plugins with their grades.
 */
export const GET: APIRoute = () => {
  const shown = shownPlugins();
  const n = shown.length.toLocaleString("en-GB");
  const checked = fmtDate(allPlugins()[0]?.checkedAt);
  const link = (title: string, path: string, note: string) =>
    `- [${title}](${SITE}${path}): ${note}`;
  const text = [
    "# Zotero Plugins Atlas",
    "",
    `> Every Zotero plugin, graded from a check of its code: what it does, what it needs from you and where it sends your data, with the evidence. ${n} plugins, re-checked daily from GitHub (last on ${checked}). Non-commercial: no ads, no paid listings, and no one can pay for a better grade.`,
    "",
    "Every plugin gets a Zotero Plugins grade, from A+ to C: A+ is recommended and was also tested installed in a live Zotero; A is recommended (every code check came out low); B is use with care (read why before installing); C is not recommended (a serious problem); a dash means not graded yet. Each plugin page states its grade, the reason, which Zotero versions it works with, and the evidence (file and line). The data is CC BY 4.0 and the code MIT.",
    "",
    "## Start here",
    "",
    link(
      "Find a plugin for the job",
      "/browse",
      `search and filter all ${n} plugins by job, Zotero version, API keys and grade`,
    ),
    link("How we grade", "/how-we-grade", "what the checks look for and how a grade is set"),
    link("How to install a Zotero plugin", "/install", "step by step, with pictures"),
    link("Grade log", "/log", "every grade change, up or down"),
    link("About", "/about", "who runs it, how it's made and where AI is used"),
    "",
    "## Guides",
    "",
    ...GUIDES.map((g) => `- [${g.name}](${SITE}${g.path})`),
    "",
    "## Plugins by job",
    "",
    ...JOBS.map((j) => {
      const k = shown.filter((p) => p.jobs.includes(j.slug)).length;
      return link(jobTitle(j, k).replace(/ · .*$/, ""), `/c/${j.slug}`, j.lead);
    }),
    "",
    "## Open data",
    "",
    link(
      "All plugins as JSON",
      "/api/plugins.json",
      "one row per plugin: name, repository, version, grade and the reason, Zotero compatibility, jobs",
    ),
    `- Each plugin page has a JSON version at ${SITE}/p/<slug>.json with the full profile.`,
    "",
    "## Most-downloaded plugins",
    "",
    ...shown
      .slice(0, 40)
      .map((p) =>
        link(
          p.name,
          `/p/${p.slug}`,
          `${p.grade === "–" ? "not graded yet" : `grade ${p.grade} (${p.gradeWord.toLowerCase()})`}. ${p.oneLiner}`,
        ),
      ),
    "",
  ].join("\n");
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
