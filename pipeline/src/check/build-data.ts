import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { buildCheckDataFile } from "./data.ts";

/** `build-data.ts <repository root> <out file.json.gz>`: the tables the check ships with. */
const [root, out] = process.argv.slice(2);
if (!root || !out) throw new Error("usage: build-data <repository root> <out file>");
const file = await buildCheckDataFile(root);
await writeFile(out, gzipSync(JSON.stringify(file), { level: 9 }));
console.log(
  `${out}: tables of ${file.builtAt.slice(0, 10)}, ${Object.keys(file.libraries.sets).length} libraries, ` +
    `${Object.keys(file.reviews.findings).length + Object.keys(file.reviews.network).length} reviewed plugins`,
);
