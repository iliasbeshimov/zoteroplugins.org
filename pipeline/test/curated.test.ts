import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PluginCurated } from "@atlas/schema";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { paths } from "../src/paths.ts";

/** data/plugins/<slug>.yaml is edited by hand; a bad file would stop the nightly profile run. */
describe("curated plugin files", () => {
  it("all match the schema and name their own slug", async () => {
    const files = (await readdir(paths.curated)).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const parsed = PluginCurated.safeParse(
        parseYaml(await readFile(join(paths.curated, file), "utf8")),
      );
      expect(parsed.success, `${file}: ${parsed.error?.issues[0]?.message}`).toBe(true);
      expect(parsed.data?.slug, file).toBe(file.replace(/\.yaml$/, ""));
    }
  });
});
