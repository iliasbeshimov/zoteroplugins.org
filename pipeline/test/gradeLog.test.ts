import type { PluginProfile } from "@atlas/schema";
import { describe, expect, it } from "vitest";
import { type GradeState, recordGrades } from "../src/profile/gradeLog.ts";

/** Just the fields the grade and its reason read. */
function profile(o: {
  version?: string;
  label?: string;
  reasons?: string[];
  tested?: string | null;
  hidden?: boolean;
  rules?: string;
}): PluginProfile {
  const version = o.version ?? "1.0.0";
  return {
    slug: "demo",
    listing: { kind: "plugin", hiddenByDefault: o.hidden ?? false, hiddenReason: null },
    install: { version },
    scan: { status: "analyzed", reason: null },
    trust: {
      overall: { label: o.label ?? "low-concern", reasons: o.reasons ?? [] },
      inputs: { currentZotero: "10.0.7", analyzerVersion: "0.13.0" },
      tested: o.tested ? { verdict: "as-described", zotero: o.tested } : null,
      appliesTo: { version },
      rulesVersion: o.rules ?? "0.9.0",
    },
  } as unknown as PluginProfile;
}

const B = { label: "review-details", reasons: ["Launches programs on your computer"] };

describe("grade log", () => {
  it("logs a plugin's first grade as new, with the card's reason", () => {
    const state: Record<string, GradeState> = {};
    const [e] = recordGrades([profile(B)], state, "2026-11-01");
    expect(e).toMatchObject({ slug: "demo", from: null, to: "B", version: "1.0.0" });
    expect(e?.why).toBe("It launches programs on your computer.");
  });

  it("logs nothing when the grade stays, nor when it's briefly missing", () => {
    const state: Record<string, GradeState> = {};
    recordGrades([profile(B)], state, "2026-11-01");
    expect(recordGrades([profile(B)], state, "2026-11-02")).toEqual([]);
    expect(recordGrades([profile({ label: "checking" })], state, "2026-11-03")).toEqual([]);
    expect(recordGrades([profile(B)], state, "2026-11-04")).toEqual([]);
  });

  it("says a new release lost the A+ only because it isn't tested yet", () => {
    const state: Record<string, GradeState> = {};
    recordGrades([profile({ tested: "10.0.3" })], state, "2026-11-01");
    const [e] = recordGrades([profile({ version: "1.1.0" })], state, "2026-11-02");
    expect(e).toMatchObject({ from: "A+", to: "A", version: "1.1.0" });
    expect(e?.why).toBe("New release, not yet tested in Zotero; every code check came out low.");
  });

  it("credits a live test that moves the same release to A+", () => {
    const state: Record<string, GradeState> = {};
    recordGrades([profile({})], state, "2026-11-01");
    const [e] = recordGrades([profile({ tested: "10.0.3" })], state, "2026-11-02");
    expect(e).toMatchObject({ from: "A", to: "A+" });
    expect(e?.why).toBe("Tested in Zotero 10.0.3: it did only what its card says.");
  });

  it("names a change in our checks when the release didn't change", () => {
    const state: Record<string, GradeState> = {};
    recordGrades([profile(B)], state, "2026-11-01");
    const [e] = recordGrades([profile({ rules: "0.10.0" })], state, "2026-11-02");
    expect(e).toMatchObject({ from: "B", to: "A" });
    expect(e?.why).toBe("Our checks changed: every code check came out low.");
  });

  it("keeps hidden plugins out of the log but remembers their grade", () => {
    const state: Record<string, GradeState> = {};
    expect(recordGrades([profile({ ...B, hidden: true })], state, "2026-11-01")).toEqual([]);
    expect(recordGrades([profile(B)], state, "2026-11-02")).toEqual([]);
  });
});

describe("grade log reasons", () => {
  it("blames a new finding, not the live test, when an A+ release drops to B", () => {
    const state: Record<string, GradeState> = {};
    recordGrades([profile({ tested: "10.0.3" })], state, "2026-11-01");
    const [e] = recordGrades([profile({ ...B, tested: "10.0.3" })], state, "2026-11-02");
    expect(e).toMatchObject({ from: "A+", to: "B" });
    expect(e?.why).toBe("Rechecked: it launches programs on your computer.");
  });

  it("names a replaced release file even when our rules changed the same day", () => {
    const state: Record<string, GradeState> = {};
    recordGrades([profile({})], state, "2026-11-01");
    const replaced = {
      label: "review-details",
      reasons: ["Release file replaced after publication"],
    };
    const [e] = recordGrades([profile({ ...replaced, rules: "0.10.0" })], state, "2026-11-02");
    expect(e?.why).toBe("Its release file was replaced after publication.");
  });
});
