import { describe, expect, it } from "vitest";
import { becauseClause } from "../src/lib/atlas.ts";

describe("becauseClause", () => {
  it("reads the AI agent labels as the rest of 'because …'", () => {
    expect(becauseClause("Its AI agent can run commands on your computer without asking you")).toBe(
      "its AI agent can run commands on your computer without asking you",
    );
    expect(
      becauseClause("Its AI agent can run code it writes inside Zotero after you approve each one"),
    ).toBe("its AI agent can run code it writes inside Zotero after you approve each one");
    expect(becauseClause("Downloads a program and runs it")).toBe(
      "it downloads a program and runs it",
    );
  });
});
