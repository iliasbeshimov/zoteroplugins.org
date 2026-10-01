import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_MODEL, loadConfig } from "../src/config.ts";
import { buildProgram, NotImplementedError } from "../src/program.ts";

describe("atlas CLI", () => {
  it("exposes every pipeline stage", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual([
      "ingest",
      "fetch",
      "analyze",
      "provenance",
      "enrich",
      "score",
      "build-data",
      "review",
      "zotero-version",
      "census",
      "scan",
      "profile",
      "submit",
      "regress",
      "census-explorer",
    ]);
  });

  it("reports unimplemented stages with their milestone", async () => {
    const program = buildProgram().exitOverride();
    await expect(program.parseAsync(["node", "atlas", "analyze"])).rejects.toThrow(
      NotImplementedError,
    );
    await expect(program.parseAsync(["node", "atlas", "analyze"])).rejects.toThrow(/M2/);
  });
});

describe("config", () => {
  it("defaults the model and leaves secrets unset", () => {
    const config = loadConfig({});
    expect(config.llmModel).toBe(DEFAULT_LLM_MODEL);
    expect(config.githubToken).toBeUndefined();
    expect(config.anthropicApiKey).toBeUndefined();
  });

  it("lets the model be overridden", () => {
    expect(loadConfig({ ATLAS_LLM_MODEL: "claude-opus-5" }).llmModel).toBe("claude-opus-5");
  });
});
