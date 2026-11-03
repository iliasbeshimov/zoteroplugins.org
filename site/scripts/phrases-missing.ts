/**
 * Lists the shown plugins that have no "ways people ask" phrases yet, with the text the phrases
 * are written from, as JSON on stdout. New phrases go into data/search/phrases.json, keyed by the
 * listed `repo`. Run with `pnpm -C site phrases:missing`.
 */
import { shownPlugins } from "../src/lib/atlas.ts";

const missing = shownPlugins()
  .filter((p) => !p.search.ask)
  .sort((a, b) => b.search.dl - a.search.dl)
  .map(({ search: s }) => ({
    repo: s.repo,
    name: s.name,
    desc: s.desc,
    does: s.does,
    topics: s.topics,
    jobs: s.jobs,
  }));
process.stdout.write(`${JSON.stringify(missing, null, 1)}\n`);
