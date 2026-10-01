/**
 * Writes schema/json/<name>.schema.json from the zod schemas.
 * With --check, exits non-zero if any committed file is out of date (used in CI).
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { documentSchemas } from "../src/index.ts";

const outDir = new URL("../json/", import.meta.url);
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const [name, schema] of Object.entries(documentSchemas)) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
  const doc = {
    $id: `https://github.com/iliasacademia/zoteroatlas/schema/json/${name}.schema.json`,
    title: name,
    ...json,
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const file = new URL(`${name}.schema.json`, outDir);

  if (check) {
    const current = await readFile(file, "utf8").catch(() => "");
    if (current !== text) stale.push(fileURLToPath(file));
  } else {
    await writeFile(file, text);
  }
}

if (stale.length > 0) {
  console.error(`JSON Schema out of date; run \`pnpm schema:generate\`:\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
if (!check) console.log(`Wrote ${Object.keys(documentSchemas).length} schemas to schema/json/`);
