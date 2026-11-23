import { main } from "./run.ts";

process.exitCode = await main(process.argv.slice(2));
