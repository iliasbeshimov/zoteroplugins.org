import { appendFile } from "node:fs/promises";
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
    .description("Zotero Plugins Atlas data pipeline")
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
      new Option(
        "--mode <mode>",
        "full: discover and measure; refresh: re-measure known repos and add new ones on the curated lists",
      )
        .choices(["full", "refresh"])
        .default("full"),
    )
    .option(
      "--only <repos>",
      "with --mode refresh: re-measure only these owner/name repos (comma-separated), keeping every other row",
    )
    .action(async (opts: { mode: "full" | "refresh"; only?: string }) => {
      const { runCensus } = await import("./census/run.ts");
      await runCensus(
        opts.mode,
        console.log,
        opts.only?.split(",").map((r) => r.trim()),
      );
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
    .option(
      "--offline",
      "rebuild from stored release files and cached .xpi blobs, with no GitHub calls (after a scanner or rules change)",
    )
    .action(
      async (opts: { plugin?: string; limit?: string; force?: boolean; offline?: boolean }) => {
        const { runProfile } = await import("./profile/run.ts");
        await runProfile({
          ...(opts.plugin ? { plugin: opts.plugin } : {}),
          ...(opts.limit ? { limit: Number(opts.limit) } : {}),
          force: Boolean(opts.force),
          offline: Boolean(opts.offline),
        });
      },
    );

  program
    .command("grade-log")
    .description(
      "log grade changes since the last run (data/generated/grade-log.json); --rebuild replays git history since launch",
    )
    .option("--rebuild", "rebuild the whole log from every committed snapshot of data/generated")
    .action(async (opts: { rebuild?: boolean }) => {
      const { loadAllProfiles } = await import("./profile/run.ts");
      const { rebuildGradeLog, updateGradeLog } = await import("./profile/gradeLog.ts");
      const profiles = await loadAllProfiles();
      const today = new Date().toISOString().slice(0, 10);
      if (opts.rebuild) await rebuildGradeLog(profiles, today);
      else await updateGradeLog(profiles, today);
    });

  program
    .command("catalog")
    .description(
      "write data/generated/catalog.json, what the Zotero Atlas plugin reads, from the profiles (no network)",
    )
    .action(async () => {
      const { loadAllProfiles } = await import("./profile/run.ts");
      const { writeCatalog } = await import("./profile/catalog.ts");
      await writeCatalog(await loadAllProfiles(), new Date().toISOString());
    });

  program
    .command("icons")
    .description(
      "write site/public/icons/<slug>.png from the icon each plugin declares in its graded release file (redoes changed files only)",
    )
    .addOption(pluginOption())
    .addOption(forceOption())
    .option("--no-fetch", "use only release files already in the blob cache")
    .action(async (opts: { plugin?: string; force?: boolean; fetch: boolean }) => {
      const { loadConfig } = await import("./config.ts");
      const { updateIcons } = await import("./profile/icons.ts");
      const config = loadConfig();
      const counts = await updateIcons({
        cacheDir: config.cacheDir,
        userAgent: config.userAgent,
        fetch: opts.fetch,
        force: opts.force,
        only: opts.plugin,
      });
      console.log(
        Object.entries(counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(", "),
      );
    });

  program
    .command("ratings")
    .description(
      "fetch the published ratings from zoteroatlas.com into data/generated/ratings.json, for the catalogue and the site",
    )
    .action(async () => {
      const { loadConfig } = await import("./config.ts");
      const { fetchRatings } = await import("./profile/ratings.ts");
      await fetchRatings(loadConfig().userAgent);
    });

  program
    .command("moved")
    .description(
      "cards whose repo left the census: redirect the ones that moved on GitHub to their new card, mark the ones whose repo is gone, and remove the ones in data/census/not-plugins.json (the nightly profile run does this too)",
    )
    .action(async () => {
      const { loadConfig, requireGithubToken } = await import("./config.ts");
      const { GitHub } = await import("./net/github.ts");
      const { DiskCache } = await import("./net/http.ts");
      const { join } = await import("node:path");
      const { prepare, followLostCards, dropNotPlugins, loadAllProfiles } = await import(
        "./profile/run.ts"
      );
      const { writeCatalog } = await import("./profile/catalog.ts");
      const config = loadConfig();
      const gh = new GitHub(
        requireGithubToken(config),
        config.userAgent,
        new DiskCache(join(config.cacheDir, "http")),
      );
      const prep = await prepare();
      await followLostCards(gh, prep.census.rows);
      await dropNotPlugins(prep.notPlugins);
      await writeCatalog(await loadAllProfiles(), new Date().toISOString());
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
      // The workflow deploys only when a plugin went into review.
      if (process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, `in-review=${accepted.length > 0}\n`);
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

  const libs = program
    .command("libs")
    .description("reference fingerprints of third-party libraries, built from their npm releases");
  libs
    .command("add <names...>")
    .description("download a library's releases from npm and record the calls they contain")
    .option("--max <n>", "newest releases to use", "30")
    .option(
      "--versions <list>",
      "use exactly these releases (comma separated), merged with the file",
    )
    .action(async (names: string[], opts: { max: string; versions?: string }) => {
      const { addLibrary } = await import("./libs/reference.ts");
      for (const name of names) {
        const ref = await addLibrary(name, {
          max: Number(opts.max),
          ...(opts.versions ? { versions: opts.versions.split(",") } : {}),
        });
        console.log(`${name}: ${ref.versions.length} releases, ${ref.calls.length} calls`);
      }
    });
  libs
    .command("list")
    .description("the libraries in the catalogue")
    .action(async () => {
      const { listLibraries } = await import("./libs/reference.ts");
      for (const l of listLibraries())
        console.log(
          `${l.name}\t${l.versions} releases\t${l.calls} calls\t${l.literals} strings\t${l.aliases.join(", ")}`,
        );
    });

  const reviews = program
    .command("reviews")
    .description("hand reviews of findings in data/reviews/<capability-id>/");
  reviews
    .command("fingerprint")
    .description("write each review's codeKey, from the release file it reviewed")
    .option("--force", "recompute reviews that already have one")
    .action(async (opts: { force?: boolean }) => {
      const { join } = await import("node:path");
      const { paths } = await import("./paths.ts");
      const { loadConfig } = await import("./config.ts");
      const { fingerprintReviews } = await import("./profile/fingerprint.ts");
      await fingerprintReviews({
        reviewsDir: join(paths.root, "data", "reviews"),
        dataDir: join(paths.root, "data"),
        cacheDir: loadConfig().cacheDir,
        force: Boolean(opts.force),
        log: console.log,
      });
    });

  program
    .command("queue")
    .description(
      "derive the investigation queue and the scanner-vs-sandbox report from data/ (writes docs/review/)",
    )
    .option("--out <dir>", "where to write queue.json, queue.md and queue-state.json")
    .option("--data <dir>", "the data folder to read")
    .action(async (opts: { out?: string; data?: string }) => {
      const { join, resolve } = await import("node:path");
      const { paths } = await import("./paths.ts");
      const { runQueue } = await import("./queue/run.ts");
      await runQueue({
        out: resolve(paths.root, opts.out ?? join("docs", "review")),
        dataDir: resolve(paths.root, opts.data ?? "data"),
      });
    });

  program
    .command("census-explorer")
    .description("build data/census/explorer.html from data/census/census.json")
    .action(async () => {
      const { buildExplorer } = await import("./census/explorer.ts");
      console.log(`Wrote ${await buildExplorer()}`);
    });

  return program;
}
