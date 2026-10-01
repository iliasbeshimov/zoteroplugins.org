import { existsSync } from "node:fs";
import { join } from "node:path";
import { CommanderError } from "commander";
import { paths } from "./paths.ts";
import { buildProgram, NotImplementedError } from "./program.ts";

const envFile = join(paths.root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

try {
  await buildProgram().exitOverride().parseAsync(process.argv);
} catch (error) {
  if (error instanceof NotImplementedError) {
    console.error(error.message);
    process.exit(2);
  }
  if (error instanceof CommanderError) process.exit(error.exitCode);
  throw error;
}
