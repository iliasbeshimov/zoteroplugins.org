// Builds the plugin check as files that run with plain `node` (24 or later) and nothing installed:
//   check.mjs            the analyzer, the scoring and the report, bundled into one file
//   check-data.json.gz   the hosts table, library index and hand reviews, as of today
// plus the action's own files (action.yml, package.json, README.md, LICENSE).
//
//   node pipeline/check-action/build.mjs <out dir>
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: build.mjs <out dir>");
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "warning",
};

// The check itself. `yaml` and `zod` are ESM-safe; the banner covers any CommonJS `require`.
await build({
  ...common,
  entryPoints: [join(root, "pipeline", "src", "check", "bin.ts")],
  outfile: join(out, "check.mjs"),
  minify: true,
  legalComments: "none",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module";const require = __cr(import.meta.url);',
  },
});
chmodSync(join(out, "check.mjs"), 0o755);

// The data builder runs once, here, and is not shipped.
const tmp = mkdtempSync(join(tmpdir(), "check-build-"));
await build({
  ...common,
  entryPoints: [join(root, "pipeline", "src", "check", "build-data.ts")],
  outfile: join(tmp, "build-data.mjs"),
  banner: {
    js: 'import { createRequire as __cr } from "node:module";const require = __cr(import.meta.url);',
  },
});
const run = spawnSync(
  process.execPath,
  [join(tmp, "build-data.mjs"), root, join(out, "check-data.json.gz")],
  { stdio: "inherit" },
);
if (run.status !== 0) throw new Error("building the data file failed");

for (const f of ["action.yml", "package.json", "README.md"])
  copyFileSync(join(here, f), join(out, f));
copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));

const size = (f) => statSync(join(out, f)).size;
console.log(
  `check.mjs ${(size("check.mjs") / 1024).toFixed(0)} KB, check-data.json.gz ${(size("check-data.json.gz") / 1024).toFixed(0)} KB`,
);
