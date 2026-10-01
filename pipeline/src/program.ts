import { Command, Option } from "commander";

export class NotImplementedError extends Error {
  constructor(
    readonly command: string,
    readonly milestone: string,
  ) {
    super(`\`atlas ${command}\` is not implemented yet (planned for ${milestone}).`);
  }
}

const stub = (command: string, milestone: string) => () => {
  throw new NotImplementedError(command, milestone);
};

const pluginOption = () =>
  new Option("-p, --plugin <slug>", "run for a single plugin instead of all of them");
const forceOption = () =>
  new Option("--force", "ignore cached results and recompute even if inputs are unchanged");

/**
 * Every stage is idempotent: it reads data/ and .cache/, writes data/, and skips work whose
 * input hash hasn't changed unless --force is given.
 */
export function buildProgram(): Command {
  const program = new Command("atlas")
    .description("Zotero Plugin Atlas data pipeline")
    .showHelpAfterError();

  program
    .command("ingest")
    .description("merge the Add-on Market data, the research sheet and GitHub topic search")
    .addOption(pluginOption())
    .action(stub("ingest", "M1"));

  program
    .command("fetch")
    .description("fetch GitHub repository metadata and release .xpi files")
    .addOption(pluginOption())
    .addOption(
      new Option("--only <what>", "limit to one kind of fetch").choices(["meta", "artifacts"]),
    )
    .addOption(forceOption())
    .action(stub("fetch", "M1 (meta), M2 (artifacts)"));

  program
    .command("analyze")
    .description("static analysis of fetched .xpi files, plus diffs against the previous version")
    .addOption(pluginOption())
    .addOption(forceOption())
    .action(stub("analyze", "M2"));

  program
    .command("provenance")
    .description("check whether released code matches the tagged public source")
    .addOption(pluginOption())
    .addOption(forceOption())
    .action(stub("provenance", "M4"));

  program
    .command("enrich")
    .description("draft descriptions, requirements and data-flow statements with the Anthropic API")
    .addOption(pluginOption())
    .addOption(forceOption())
    .option("--estimate", "count tokens and report estimated cost without calling the model")
    .action(stub("enrich", "M3"));

  program
    .command("score")
    .description("compute Trust Cards from analysis, provenance, requirements and reviews")
    .addOption(pluginOption())
    .action(stub("score", "M2 (partial), M5 (full)"));

  program
    .command("build-data")
    .description("write the site's data files and the public /api/*.json outputs")
    .action(stub("build-data", "M1"));

  program
    .command("review")
    .description("review LLM drafts for one plugin and record approvals in its YAML file")
    .argument("<slug>", "plugin to review")
    .action(stub("review", "M3"));

  program
    .command("zotero-version")
    .description("detect the current Zotero release, beta and dev versions")
    .action(async () => {
      const { loadConfig, requireGithubToken } = await import("./config.ts");
      const { DiskCache } = await import("./net/http.ts");
      const { GitHub } = await import("./net/github.ts");
      const { detectZoteroVersions } = await import("./zotero-version.ts");
      const config = loadConfig();
      const cache = new DiskCache(`${config.cacheDir}/http`);
      const gh = new GitHub(requireGithubToken(config), config.userAgent, cache);
      console.log(JSON.stringify(await detectZoteroVersions(gh, config.userAgent), null, 2));
    });

  program
    .command("census")
    .description(
      "find every Zotero plugin on GitHub and record stars, downloads, activity and compatibility (no LLM)",
    )
    .addOption(
      new Option("--mode <mode>", "full: discover and measure; refresh: re-measure known repos")
        .choices(["full", "refresh"])
        .default("full"),
    )
    .action(async (opts: { mode: "full" | "refresh" }) => {
      const { runCensus } = await import("./census/run.ts");
      await runCensus(opts.mode);
    });

  program
    .command("scan")
    .description(
      "static analysis of the latest release of top plugins plus a sample of 2026 plugins (no LLM)",
    )
    .option("--top <n>", "number of top plugins by downloads", "100")
    .option("--sample <n>", "number of plugins sampled from those created in 2026", "100")
    .action(async (opts: { top: string; sample: string }) => {
      const { runScan } = await import("./scan/run.ts");
      await runScan({ top: Number(opts.top), sample: Number(opts.sample) });
    });

  program
    .command("profile")
    .description(
      "build data/generated/<slug>/profile.json for every listed plugin: code scan, scorecard, compatibility, languages (no LLM)",
    )
    .option("-p, --plugin <slug-or-repo>", "profile one plugin, e.g. zotero-pdf-translate")
    .option("--limit <n>", "profile only the first n plugins by downloads")
    .addOption(forceOption())
    .action(async (opts: { plugin?: string; limit?: string; force?: boolean }) => {
      const { runProfile } = await import("./profile/run.ts");
      await runProfile({
        ...(opts.plugin ? { plugin: opts.plugin } : {}),
        ...(opts.limit ? { limit: Number(opts.limit) } : {}),
        force: Boolean(opts.force),
      });
    });

  const submit = program
    .command("submit")
    .description("plugins people submit on the site: queue, decide, profile");
  submit
    .command("enqueue <url>")
    .description("queue a GitHub repository address (a repeat changes nothing)")
    .action(async (url: string) => {
      const { enqueueSubmission } = await import("./submit/run.ts");
      console.log(await enqueueSubmission(url));
    });
  submit
    .command("process")
    .description("decide every queued repo: Zotero plugins go in review, the rest are rejected")
    .option("--cap <n>", "most new plugins accepted per day", "20")
    .action(async (opts: { cap: string }) => {
      const { processQueue } = await import("./submit/run.ts");
      const accepted = await processQueue({ cap: Number(opts.cap) });
      console.log(`${accepted.length} new in review`);
    });
  submit
    .command("check")
    .description("profile and grade every plugin in review, then mark it added")
    .action(async () => {
      const { checkInReview } = await import("./submit/run.ts");
      const added = await checkInReview();
      console.log(`${added.length} added`);
    });

  program
    .command("regress")
    .description(
      "regression check: rebuild every profile offline from cached .xpi files with the current code and list what changed (writes only to .cache/regress)",
    )
    .option("-p, --plugin <slug-or-repo>", "check one plugin")
    .option("--limit <n>", "check only the first n plugins by downloads")
    .option("-j, --jobs <n>", "worker processes", "8")
    .option("--shard <i/n>", "internal: the worker's share of plugins")
    .option("--out <file>", "internal: where a worker writes its results")
    .action(
      async (opts: {
        plugin?: string;
        limit?: string;
        jobs: string;
        shard?: string;
        out?: string;
      }) => {
        const { runRegress } = await import("./profile/regress.ts");
        await runRegress({
          ...(opts.plugin ? { plugin: opts.plugin } : {}),
          ...(opts.limit ? { limit: Number(opts.limit) } : {}),
          jobs: Number(opts.jobs),
          ...(opts.shard ? { shard: opts.shard } : {}),
          ...(opts.out ? { out: opts.out } : {}),
        });
      },
    );

  program
    .command("census-explorer")
    .description("build data/census/explorer.html from data/census/census.json")
    .action(async () => {
      const { buildExplorer } = await import("./census/explorer.ts");
      console.log(`Wrote ${await buildExplorer()}`);
    });

  return program;
}
