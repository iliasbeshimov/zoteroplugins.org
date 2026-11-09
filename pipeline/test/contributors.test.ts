import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorsOf,
  contributorList,
  copyAuthors,
  copySources,
  countContributors,
  forkAuthors,
  type RepoFacts,
} from "../src/census/contributors.ts";
import type { RepoFull } from "../src/census/metadata.ts";
import { isManifestOnly, listedReleases } from "../src/census/metadata.ts";
import type { CensusRow } from "../src/census/run.ts";
import { GitHub, type RestResponse } from "../src/net/github.ts";
import { DiskCache } from "../src/net/http.ts";

/** A GitHub whose REST answers come from a table of paths (query string included). */
function fakeRest(answers: Record<string, unknown>, links: Record<string, string> = {}) {
  const asked: string[] = [];
  const rest = async <T>(path: string): Promise<RestResponse<T>> => {
    asked.push(path);
    const data = answers[path];
    return {
      status: data === undefined ? 404 : 200,
      data: (data ?? null) as T | null,
      link: links[path] ?? null,
      rateRemaining: null,
      rateReset: null,
    };
  };
  const restPaginate = async <T>(path: string): Promise<T[]> => {
    asked.push(path);
    return (answers[path] ?? []) as T[];
  };
  return { gh: { rest, restPaginate } as unknown as GitHub, asked };
}

const user = (login: string) => ({ login, type: "User" });
const commit = (sha: string, login: string | null, email = `${login}@example.org`) => ({
  sha,
  author: login ? { login, type: "User" } : null,
  commit: { author: { name: login ?? "someone", email } },
});

// zotero-plugin-template's authors, as GitHub lists them on every repository copied from it.
const TEMPLATE_PEOPLE = ["windingwind", "northword", "l0o0", "volatile-static", "muisedestiny"];

describe("contributors: who committed to the plugin", () => {
  it("leaves bots out and keeps people known only by their email", () => {
    const who = authorsOf([
      commit("a", "Alice"),
      commit("b", "alice"),
      commit("c", "dependabot[bot]"),
      commit("d", null, "bob@example.org"),
      {
        sha: "e",
        author: null,
        commit: {
          author: {
            name: "github-actions[bot]",
            email: "41898282+github-actions[bot]@users.noreply.github.com",
          },
        },
      },
      // A version bump pushed by a workflow (wwsh123/zotero-zotadata).
      {
        sha: "f",
        author: { login: "actions-user" },
        commit: { author: { name: "GitHub Action", email: "action@github.com" } },
      },
    ]);
    expect([...who].sort()).toEqual(["@alice", "bob@example.org"]);
  });

  it("counts GitHub's list without bots, anonymous authors included", async () => {
    const { gh } = fakeRest({
      "/repos/a/p/contributors?per_page=100&anon=true": [
        user("Alice"),
        { login: "dependabot[bot]", type: "Bot" },
        { type: "Anonymous", name: "Bob", email: "bob@example.org" },
      ],
    });
    const list = await contributorList(gh, "a/p");
    expect(list?.total).toBe(3);
    expect(list?.people).toBe(2);
    expect([...(list?.logins ?? [])]).toEqual(["alice"]);
  });

  it("suspects a copied history from three shared contributors besides the owner, in older repos only", () => {
    const facts = (
      repo: string,
      createdAt: string,
      logins: string[],
      isFork = false,
    ): RepoFacts => ({
      repo,
      createdAt,
      isFork,
      logins: new Set(logins),
    });
    const template = facts(
      "windingwind/zotero-plugin-template",
      "2022-01-01T00:00:00Z",
      TEMPLATE_PEOPLE,
    );
    const sources = copySources(
      [
        facts("someone/copy", "2026-03-10T00:00:00Z", ["someone", ...TEMPLATE_PEOPLE]),
        // windingwind's own plugin: the shared people are windingwind's collaborators, and it's older.
        facts("windingwind/zotero-pdf-translate", "2020-06-01T00:00:00Z", [...TEMPLATE_PEOPLE]),
        // Two shared people: not enough.
        facts("other/plugin", "2026-01-01T00:00:00Z", ["other", "windingwind", "northword"]),
        // Forks are compared with their parent instead.
        facts("someone/fork", "2026-04-01T00:00:00Z", TEMPLATE_PEOPLE, true),
      ],
      [template],
    );
    // The template first, whatever else shares as many people.
    expect(sources.get("someone/copy")).toEqual([
      "windingwind/zotero-plugin-template",
      "windingwind/zotero-pdf-translate",
    ]);
    expect(sources.has("windingwind/zotero-pdf-translate")).toBe(false);
    expect(sources.has("other/plugin")).toBe(false);
    expect(sources.has("someone/fork")).toBe(false);
  });

  it("counts a copy by the commits that aren't the template's", async () => {
    const { gh } = fakeRest({
      "/repos/someone/copy/commits?per_page=100&page=1": [
        commit("own2", "someone"),
        commit("own1", "someone"),
        commit("t2", "windingwind"),
        commit("t1", "northword"),
      ],
    });
    const own = await copyAuthors(gh, "someone/copy", new Set(["t1", "t2"]));
    expect([...(own ?? [])]).toEqual(["@someone"]);
    // No commit in common: the shared people were a coincidence, so no answer from here.
    expect(await copyAuthors(gh, "someone/copy", new Set(["x"]))).toBeNull();
  });

  it("counts a fork by the commits ahead of its parent", async () => {
    const { gh, asked } = fakeRest({
      "/repos/windingwind/zotero-plugin-template/compare/main...POBrien333%3Amain?per_page=100&page=1":
        {
          ahead_by: 3,
          commits: [
            commit("a", "POBrien333"),
            commit("b", "POBrien333"),
            commit("c", "dependabot[bot]"),
          ],
        },
    });
    const own = await forkAuthors(
      gh,
      "POBrien333/citationstyler-client-sync",
      "main",
      "windingwind/zotero-plugin-template",
      "main",
    );
    expect([...(own ?? [])]).toEqual(["@pobrien333"]);
    expect(asked).toHaveLength(1);
  });

  it("sets each plugin's count: fork, copy, an ordinary repository with a bot, never 0", async () => {
    const templateList = TEMPLATE_PEOPLE.map(user);
    const { gh } = fakeRest({
      "/repos/windingwind/zotero-plugin-template": { created_at: "2022-01-01T00:00:00Z" },
      "/repos/windingwind/zotero-plugin-template/contributors?per_page=100&anon=true": templateList,
      "/repos/windingwind/zotero-plugin-template/commits": [{ sha: "t2" }, { sha: "t1" }],
      // The fork: GitHub lists the template's people and its own.
      "/repos/POBrien333/citationstyler-client-sync/contributors?per_page=100&anon=true": [
        ...templateList,
        user("POBrien333"),
        { login: "dependabot[bot]", type: "Bot" },
      ],
      "/repos/windingwind/zotero-plugin-template/compare/main...POBrien333%3Amain?per_page=100&page=1":
        {
          ahead_by: 1,
          commits: [commit("p1", "POBrien333")],
        },
      // The copy: not a fork on GitHub, but the template's history is in it.
      "/repos/hyfaust/zotero-roam/contributors?per_page=100&anon=true": [
        ...templateList,
        user("hyfaust"),
      ],
      "/repos/hyfaust/zotero-roam/commits?per_page=100&page=1": [
        commit("h1", "hyfaust"),
        commit("t2", "windingwind"),
        commit("t1", "northword"),
      ],
      // A fork released from another branch: nothing ahead of its parent on its default branch.
      "/repos/234pk/gene-search/contributors?per_page=100&anon=true": templateList,
      "/repos/windingwind/zotero-plugin-template/compare/main...234pk%3Amain?per_page=100&page=1": {
        ahead_by: 0,
        commits: [],
      },
      // Commits without a usable email: GitHub's list comes back empty.
      "/repos/jwingnut/zotero-batch-open/contributors?per_page=100&anon=true": [],
      // Ordinary: two people and dependabot.
      "/repos/yhmtsai/KeepZotero/contributors?per_page=100&anon=true": [
        user("yhmtsai"),
        user("helper"),
        { login: "dependabot[bot]", type: "Bot" },
      ],
    });
    const row = (repo: string, createdAt: string, isFork = false, parent: string | null = null) =>
      ({ repo, createdAt, isFork, parent, contributors: null }) as unknown as CensusRow;
    const rows = [
      row(
        "POBrien333/citationstyler-client-sync",
        "2026-03-10T00:00:00Z",
        true,
        "windingwind/zotero-plugin-template",
      ),
      row("hyfaust/zotero-roam", "2026-05-01T00:00:00Z"),
      row("yhmtsai/KeepZotero", "2022-06-01T00:00:00Z"),
      row("234pk/gene-search", "2025-11-18T00:00:00Z", true, "windingwind/zotero-plugin-template"),
      row("jwingnut/zotero-batch-open", "2026-09-03T00:00:00Z"),
    ];
    const full = new Map<string, RepoFull | null>([
      [
        "pobrien333/citationstyler-client-sync",
        {
          nameWithOwner: "POBrien333/citationstyler-client-sync",
          defaultBranch: "main",
          parentDefaultBranch: "main",
        } as RepoFull,
      ],
      [
        "234pk/gene-search",
        {
          nameWithOwner: "234pk/gene-search",
          defaultBranch: "main",
          parentDefaultBranch: "main",
        } as RepoFull,
      ],
    ]);
    await countContributors(gh, rows, full, () => {});
    // Someone published each of them, so never 0.
    expect(rows.map((r) => r.contributors)).toEqual([1, 1, 2, 1, 1]);
  });
});

describe("releases that aren't versions", () => {
  it("knows the template's update-manifest release from a version", () => {
    expect(isManifestOnly("release", ["update.json", "update-beta.json"])).toBe(true);
    expect(isManifestOnly("release", [])).toBe(true);
    expect(isManifestOnly("updates", ["update.rdf"])).toBe(true);
    expect(isManifestOnly("v1.0.8", ["plugin.xpi", "update.json"])).toBe(false);
    // An old version whose file was deleted is still a version.
    expect(isManifestOnly("v0.1.0", [])).toBe(false);
    expect(isManifestOnly("v0.1.0", ["notes.pdf"])).toBe(false);
  });

  it("leaves the update-manifest release out of the census's count, on any page", async () => {
    const asset = (name: string) => ({
      name,
      size: 1,
      downloadCount: 5,
      updatedAt: "",
      downloadUrl: "",
    });
    const rel = (tagName: string, ...names: string[]) => ({
      tagName,
      publishedAt: "2026-11-06T09:14:07Z",
      isPrerelease: false,
      isDraft: false,
      releaseAssets: { nodes: names.map(asset) },
    });
    const gh = {
      graphql: async (query: string) =>
        query.includes("after:")
          ? // The older page: the template's "release" tag, created first.
            {
              data: {
                repository: {
                  releases: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [rel("release", "update.json", "update-beta.json")],
                  },
                },
              },
              errors: [],
            }
          : {
              data: {
                r0: {
                  nameWithOwner: "POBrien333/citationstyler-client-sync",
                  url: "",
                  stargazerCount: 0,
                  forkCount: 0,
                  isFork: true,
                  isArchived: false,
                  pushedAt: null,
                  createdAt: "2026-03-10T00:00:00Z",
                  description: null,
                  homepageUrl: null,
                  parent: {
                    nameWithOwner: "windingwind/zotero-plugin-template",
                    defaultBranchRef: { name: "main" },
                  },
                  licenseInfo: null,
                  repositoryTopics: { nodes: [] },
                  defaultBranchRef: { name: "main", target: {} },
                  // Ordered, GitHub also returns a release whose tag was deleted; its list doesn't.
                  listed: { totalCount: 3 },
                  releases: {
                    totalCount: 4,
                    pageInfo: { hasNextPage: true, endCursor: "c" },
                    nodes: [rel("v1.0.8", "p.xpi"), rel("v1.0.7", "p.xpi")],
                  },
                },
              },
              errors: [],
            },
    } as unknown as GitHub;
    const { fetchFull } = await import("../src/census/metadata.ts");
    const full = await fetchFull(gh, ["pobrien333/citationstyler-client-sync"], () => {});
    const repo = full.get("pobrien333/citationstyler-client-sync");
    expect(repo?.releaseCount).toBe(2);
    expect(repo?.totalXpiDownloads).toBe(10);
    expect(repo?.defaultBranch).toBe("main");
    expect(repo?.parentDefaultBranch).toBe("main");
  });

  it("counts the releases GitHub lists, past its 1,000 cap too", () => {
    expect(listedReleases(15, 32)).toBe(15);
    expect(listedReleases(1000, 1042)).toBe(1042);
  });
});

describe("GraphQL answers are reused only by the run that fetched them", () => {
  const before = process.env.GITHUB_RUN_ID;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (before === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = before;
  });

  it("asks GitHub again in a later run, even within hours", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ data: { n: calls } }), { status: 200 });
    });
    const gh = new GitHub("t", "test", new DiskCache(await mkdtemp(join(tmpdir(), "gql-"))));
    process.env.GITHUB_RUN_ID = "100";
    expect((await gh.graphql<{ n: number }>("query { x }")).data?.n).toBe(1);
    // A re-run of the same workflow run reuses the answer.
    expect((await gh.graphql<{ n: number }>("query { x }")).data?.n).toBe(1);
    // The next run (the Sunday refresh an hour after the full run) doesn't.
    process.env.GITHUB_RUN_ID = "101";
    expect((await gh.graphql<{ n: number }>("query { x }")).data?.n).toBe(2);
    expect(calls).toBe(2);
  });
});
