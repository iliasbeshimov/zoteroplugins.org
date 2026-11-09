import { describe, expect, it } from "vitest";
import type { CensusRow } from "../src/census/run.ts";
import { maintenanceFor, releaseApiPath } from "../src/profile/run.ts";

describe("the release behind an update address's file", () => {
  it("finds the GitHub release a download link belongs to", () => {
    expect(
      releaseApiPath(
        "https://github.com/POBrien333/citationstyler-client-sync/releases/download/v1.0.8/citation-styler-client-sync.xpi",
      ),
    ).toBe("/repos/POBrien333/citationstyler-client-sync/releases/tags/v1.0.8");
    expect(releaseApiPath("https://github.com/a/p/releases/latest/download/p.xpi")).toBe(
      "/repos/a/p/releases/latest",
    );
    expect(releaseApiPath("https://github.com/a/p/releases/download/release%2F1.2/p.xpi")).toBe(
      "/repos/a/p/releases/tags/release%2F1.2",
    );
    expect(releaseApiPath("https://raw.githubusercontent.com/a/p/main/p.xpi")).toBeNull();
    expect(releaseApiPath("https://example.org/p.xpi")).toBeNull();
  });
});

describe("maintenance, up to date with the release the card offers", () => {
  const now = Date.parse("2026-11-06T11:00:00Z");
  // The census read GitHub before v1.0.8 came out: it still says v1.0.7, from May.
  const row = {
    maintenance: "active",
    latestReleaseAt: "2026-05-22T07:56:44Z",
    lastCommitAt: "2026-08-10T19:31:33Z",
    lastActivityAt: "2026-08-10T19:31:33Z",
    archived: false,
  } as Pick<
    CensusRow,
    "maintenance" | "latestReleaseAt" | "lastCommitAt" | "lastActivityAt" | "archived"
  >;

  it("takes a newer release found at the update address as the last release", () => {
    const m = maintenanceFor(row, { publishedAt: "2026-11-06T09:14:07Z", prerelease: false }, now);
    expect(m.lastReleaseAt).toBe("2026-11-06T09:14:07Z");
    expect(m.lastActivityAt).toBe("2026-11-06T09:14:07Z");
    expect(m.lastCommitAt).toBe(row.lastCommitAt);
    expect(m.status).toBe("active");
  });

  it("never says the last release is older than the one it offers", () => {
    for (const publishedAt of [
      "2026-05-22T07:56:44Z",
      "2026-03-01T00:00:00Z",
      "2026-11-06T09:14:07Z",
    ]) {
      const m = maintenanceFor(row, { publishedAt, prerelease: false }, now);
      expect(Date.parse(m.lastReleaseAt ?? "")).toBeGreaterThanOrEqual(Date.parse(publishedAt));
    }
  });

  it("wakes a dormant plugin whose new release the census hadn't seen", () => {
    const old = {
      ...row,
      maintenance: "dormant" as const,
      latestReleaseAt: "2023-01-01T00:00:00Z",
      lastCommitAt: "2023-01-01T00:00:00Z",
      lastActivityAt: "2023-01-01T00:00:00Z",
    };
    expect(
      maintenanceFor(old, { publishedAt: "2026-11-06T09:14:07Z", prerelease: false }, now).status,
    ).toBe("active");
  });

  it("keeps the census's facts for the same release, a prerelease, or no release", () => {
    const same = {
      status: row.maintenance,
      lastReleaseAt: row.latestReleaseAt,
      lastCommitAt: row.lastCommitAt,
      lastActivityAt: row.lastActivityAt,
    };
    expect(
      maintenanceFor(row, { publishedAt: row.latestReleaseAt, prerelease: false }, now),
    ).toEqual(same);
    expect(
      maintenanceFor(row, { publishedAt: "2026-11-06T09:14:07Z", prerelease: true }, now),
    ).toEqual(same);
    expect(maintenanceFor(row, null, now)).toEqual(same);
    expect(
      maintenanceFor(
        { ...row, archived: true, maintenance: "archived" },
        { publishedAt: "2026-11-06T09:14:07Z", prerelease: false },
        now,
      ).status,
    ).toBe("archived");
  });
});
