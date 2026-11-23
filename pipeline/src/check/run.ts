import { existsSync } from "node:fs";
import { appendFile, glob, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { type CheckResult, checkXpi } from "./check.ts";
import { buildCheckDataFile, type CheckData, type CheckDataFile, loadCheckData } from "./data.ts";
import { type FailOn, failsOn, renderReport } from "./report.ts";

/** The data file's name beside the bundle (see scripts/publish-check.sh). */
export const DATA_FILE = "check-data.json.gz";

const USAGE = `Usage: zotero-plugin-check [--repo owner/name] [--fail-on B|C] <file.xpi | glob>...

Checks built Zotero plugin files (.xpi) the way zoteroplugins.org's code checks would, and writes
a Markdown report to $GITHUB_STEP_SUMMARY when it is set, else to the terminal. Nothing about the
plugin is sent anywhere.

  --repo owner/name   the plugin's GitHub repository (default: $GITHUB_REPOSITORY)
  --fail-on B|C       exit 1 when the grade from the code is that or worse (default: never)
`;

export interface Args {
  files: string[];
  repo: string | undefined;
  failOn: FailOn | undefined;
  help: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const files: string[] = [];
  let repo: string | undefined;
  let failOn: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string) => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      i++;
      const v = argv[i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--repo" || a.startsWith("--repo=")) repo = value("--repo");
    else if (a === "--fail-on" || a.startsWith("--fail-on=")) failOn = value("--fail-on");
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else files.push(a);
  }
  // As a GitHub Action: inputs arrive as INPUT_<NAME> environment variables.
  if (!files.length && env.INPUT_XPI) files.push(...env.INPUT_XPI.split(/\r?\n/).filter(Boolean));
  if (!files.length && !help) files.push("**/*.xpi");
  failOn ??= env["INPUT_FAIL-ON"] || undefined;
  if (failOn && failOn.toLowerCase() === "none") failOn = undefined;
  if (failOn && !/^[BC]$/i.test(failOn)) throw new Error(`--fail-on takes B or C, not "${failOn}"`);
  repo ||= env.INPUT_REPO || env.GITHUB_REPOSITORY || undefined;
  return {
    files,
    repo,
    failOn: failOn?.toUpperCase() as FailOn | undefined,
    help,
  };
}

const hasGlob = (p: string) => /[*?[\]{}]/.test(p);

/** Each argument as the files it names: a path as it is, a pattern as what it matches. */
export async function expandFiles(patterns: string[], cwd = process.cwd()): Promise<string[]> {
  const out = new Set<string>();
  for (const p of patterns) {
    if (!hasGlob(p)) {
      out.add(resolve(cwd, p));
      continue;
    }
    for await (const f of glob(p, {
      cwd,
      exclude: (name) => name === "node_modules" || name === ".git",
    }))
      if (f.toLowerCase().endsWith(".xpi")) out.add(resolve(cwd, f));
  }
  return [...out].sort();
}

/** The tables: from the file beside the bundle, else read from the repository this runs in. */
export async function readCheckData(env: NodeJS.ProcessEnv = process.env): Promise<CheckData> {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = env.ATLAS_CHECK_DATA || join(here, DATA_FILE);
  if (existsSync(beside)) {
    const raw = await readFile(beside);
    const text = beside.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    return loadCheckData(JSON.parse(text) as CheckDataFile);
  }
  const root = resolve(here, "..", "..", "..");
  if (existsSync(join(root, "pipeline", "data", "hosts.yaml")))
    return loadCheckData(await buildCheckDataFile(root));
  throw new Error(`The check's data file (${DATA_FILE}) is missing next to it.`);
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Runs the check; returns the exit code (0, 1 when --fail-on trips, 2 when it couldn't run). */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) },
  cwd = process.cwd(),
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv, env);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  const files = await expandFiles(args.files, cwd);
  if (!files.length) {
    io.err(`No .xpi file found for ${args.files.join(", ")}. Build the plugin first.\n`);
    return 2;
  }
  const data = await readCheckData(env);
  const results: CheckResult[] = [];
  for (const file of files) {
    try {
      const rel = file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
      results.push(
        await checkXpi(rel, new Uint8Array(await readFile(file)), data, {
          ...(args.repo ? { repo: args.repo } : {}),
        }),
      );
    } catch (e) {
      io.err(`${(e as Error).message}\n`);
      return 2;
    }
  }
  const report = renderReport(results, data);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, report);
    io.out(`Zotero Plugins check: ${results.map((r) => `${r.name} ${r.grade}`).join(", ")}\n`);
  } else io.out(report);
  if (env.GITHUB_OUTPUT)
    await writeFile(env.GITHUB_OUTPUT, `grade=${worstGrade(results)}\n`, { flag: "a" });
  return results.some((r) => failsOn(r.grade, args.failOn)) ? 1 : 0;
}

const ORDER = ["C", "B", "A", "–"] as const;
export function worstGrade(results: CheckResult[]): CheckResult["grade"] {
  return ORDER.find((g) => results.some((r) => r.grade === g)) ?? "–";
}
