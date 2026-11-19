import { describe, expect, it } from "vitest";
import { usedFor } from "../src/lib/ratings.ts";

/** How long a reviewer used the plugin: only what Zotero Atlas saw, so a lower bound. */
describe("used for", () => {
  it("says nothing without history or under a day, since they may have used it before Atlas saw it", () => {
    expect(usedFor(null)).toBeNull();
    expect(usedFor(0)).toBeNull();
    expect(usedFor(0.6)).toBeNull();
  });

  it("gives longer spans as a lower bound", () => {
    expect(usedFor(1.4)).toBe("used for at least 1 day");
    expect(usedFor(9)).toBe("used for at least 9 days");
    expect(usedFor(45)).toBe("used for at least 6 weeks");
    expect(usedFor(200)).toBe("used for at least 7 months");
    expect(usedFor(800)).toBe("used for at least 2 years");
  });
});
