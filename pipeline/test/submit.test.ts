import { describe, expect, it } from "vitest";
import { fileKey, type SubmissionRecord } from "../src/submit/records.ts";
import { decide, repoFromInput } from "../src/submit/run.ts";

describe("submitted addresses", () => {
  it("reduces every spelling of a repository to one owner/name", () => {
    for (const s of [
      "https://github.com/Owner/Plugin",
      "github.com/owner/plugin.git",
      "  https://www.github.com/OWNER/plugin/releases/tag/v1.0  ",
      "http://github.com/owner/plugin#readme",
      "owner/plugin",
    ])
      expect(repoFromInput(s)).toBe("owner/plugin");
  });

  it("turns down what isn't a repository address", () => {
    for (const s of [
      "",
      "plugin",
      "https://gitlab.com/owner/plugin",
      "https://github.com/topics/zotero",
      "https://github.com/owner",
    ])
      expect(repoFromInput(s)).toBeNull();
  });

  it("names files so owner and name can't run together", () => {
    expect(fileKey("Owner/My_Plugin")).toBe("owner__my_plugin");
  });
});

describe("what a queued submission does", () => {
  const record = (status: SubmissionRecord["status"]): SubmissionRecord => ({
    schemaVersion: 1,
    repo: "owner/plugin",
    status,
    reason: null,
    checkedTag: "v1.0",
    slug: "plugin",
    name: "Plugin",
    submittedAt: "2026-09-30T00:00:00Z",
    decidedAt: "2026-09-30T00:00:00Z",
    addedAt: null,
  });
  const base = { listed: false, record: undefined, acceptedToday: 0, cap: 20 };

  it("drops a repo we already list or are already checking, whatever the cap", () => {
    expect(decide({ ...base, listed: true, acceptedToday: 99 })).toEqual({
      action: "drop",
      why: "listed",
    });
    expect(decide({ ...base, record: record("in-review") })).toEqual({
      action: "drop",
      why: "in-review",
    });
    expect(decide({ ...base, record: record("added") })).toEqual({ action: "drop", why: "added" });
  });

  it("measures a new repo, and one rejected before (the release decides)", () => {
    expect(decide(base)).toEqual({ action: "measure" });
    expect(decide({ ...base, record: record("rejected") })).toEqual({ action: "measure" });
  });

  it("waits once the day's cap is reached", () => {
    expect(decide({ ...base, acceptedToday: 20 })).toEqual({ action: "wait" });
  });
});
