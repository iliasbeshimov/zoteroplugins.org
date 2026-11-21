import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginCurated } from "@atlas/schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  isCardResponse,
  MAX_TEXT,
  NOTE_MARK,
  noteFor,
  parseForm,
  REPLY_MARK,
  replyFrom,
  responseText,
  setReply,
  shouldRead,
  slugFor,
  upsertResponse,
  verifyMaintainer,
} from "../src/responses/intake.ts";

const issue9 = readFileSync(join(import.meta.dirname, "fixtures/responses/issue-9.md"), "utf8");
const slugs = { "alexplaka/zocrates": "zocrates", "tenglvjun/mktero": "mktero" };
const URL9 = "https://github.com/iliasbeshimov/zoteroplugins.org/issues/9";

describe("a developer's response from the issue form", () => {
  it("reads the form's fields (issue 9)", () => {
    const f = parseForm(issue9);
    expect(f).toMatchObject({
      plugin: "https://github.com/alexplaka/Zocrates",
      about: "capabilities",
      version: null,
      maintainerTicked: true,
    });
    expect(f.text.startsWith("# Conditional download of executable from `aka.ms`")).toBe(true);
    // Its own ### headings stay in the response; the form's next field doesn't.
    expect(f.text).toContain("### 1. What is the Microsoft executable for?");
    expect(f.text).not.toContain("### Evidence");
    expect(f.text).not.toContain("I maintain this plugin's repository");
  });

  it("finds the plugin from its repository or its page, in any case", () => {
    expect(slugFor("https://github.com/alexplaka/Zocrates", slugs)).toBe("zocrates");
    expect(slugFor("https://github.com/alexplaka/Zocrates/issues/3", slugs)).toBe("zocrates");
    expect(slugFor("https://zoteroplugins.org/p/mktero", slugs)).toBe("mktero");
    expect(slugFor("tenglvjun/Mktero", slugs)).toBe("mktero");
    expect(slugFor("https://github.com/someone/else", slugs)).toBeNull();
    expect(slugFor(null, slugs)).toBeNull();
  });

  it("trims line ends and cuts a very long response at a paragraph, pointing to the issue", () => {
    expect(responseText("One.   \n\n\n\nTwo.\t\n", URL9)).toBe("One.\n\nTwo.");
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(60)}`).join(
      "\n\n",
    );
    const cut = responseText(long, URL9);
    expect(cut.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(cut.endsWith(`[The rest of this response is in the issue: ${URL9}]`)).toBe(true);
    expect(cut).toMatch(/word\n\n\[The rest/);
  });
});

describe("publishing a response", () => {
  const response = {
    date: "2026-11-12",
    from: "alexplaka",
    about: "capabilities" as const,
    text: "First paragraph.\n\nSecond, with `code`.",
    url: URL9,
    status: "open" as const,
  };
  const base = { slug: "zocrates", repo: "alexplaka/zocrates" };

  it("starts a plugin's file, valid against the schema", () => {
    const out = upsertResponse(null, base, response) as string;
    const doc = PluginCurated.parse(parse(out));
    expect(doc.responses).toEqual([response]);
    expect(out).toContain('date: "2026-11-12"');
    expect(out).toContain("text: |-\n");
  });

  it("adds to an existing file, keeping what's there", () => {
    const existing = `schemaVersion: 1\nslug: zocrates\nrepo: alexplaka/zocrates\nstatus: listed\n# kept\nnotices: []\n`;
    const out = upsertResponse(existing, base, response) as string;
    expect(out).toContain("# kept");
    expect(PluginCurated.parse(parse(out)).responses).toHaveLength(1);
  });

  it("follows an edited issue until we reply, then leaves the text alone", () => {
    const first = upsertResponse(null, base, response) as string;
    expect(upsertResponse(first, base, response)).toBeNull();
    const edited = upsertResponse(first, base, { ...response, text: "Edited." }) as string;
    expect(PluginCurated.parse(parse(edited)).responses[0]?.text).toBe("Edited.");
    const replied = edited.replace("status: open", "status: corrected\n    reply: Thanks.");
    expect(upsertResponse(replied, base, { ...response, text: "Edited again." })).toBeNull();
  });
});

describe("who counts as a maintainer", () => {
  const get =
    (answers: Record<string, { status: number; data: unknown }>) => async (path: string) =>
      answers[path] ?? { status: 404, data: null };

  it("the repository's owner, whatever the case", async () => {
    expect((await verifyMaintainer(get({}), "alexplaka/zocrates", "AlexPlaka")).ok).toBe(true);
  });

  it("someone who published one of its releases", async () => {
    const v = await verifyMaintainer(
      get({
        "/repos/org/tool/releases?per_page=30": {
          status: 200,
          data: [{ author: { login: "github-actions[bot]" } }, { author: { login: "dev" } }],
        },
      }),
      "org/tool",
      "dev",
    );
    expect(v).toEqual({ ok: true, how: "published releases of org/tool" });
  });

  it("a public member of the owning organisation; nobody else", async () => {
    const member = get({ "/orgs/org/members/dev": { status: 204, data: null } });
    expect((await verifyMaintainer(member, "org/tool", "dev")).ok).toBe(true);
    expect((await verifyMaintainer(get({}), "org/tool", "stranger")).ok).toBe(false);
  });

  it("is told in the note on the issue", () => {
    expect(noteFor("dev", "zocrates", { ok: true, how: "" })).toContain(
      "https://zoteroplugins.org/p/zocrates#developer-response",
    );
    expect(noteFor("dev", "zocrates", { ok: false, how: "" })).toContain("check by hand");
    expect(noteFor("dev", null, null)).toContain("couldn't tell which listed plugin");
    expect(noteFor("dev", null, null).startsWith(NOTE_MARK)).toBe(true);
  });
});

describe("which issues a run reads", () => {
  const dev = { login: "Marco0431" };
  const note = [{ body: `${NOTE_MARK}\nThanks, @Marco0431.` }];
  it("every open one", () => {
    expect(shouldRead({ state: "open", user: dev }, [])).toBe(true);
  });
  it("a closed one its author closed as completed before any run reached it", () => {
    expect(shouldRead({ state: "closed", user: dev, closed_by: { login: "marco0431" } }, [])).toBe(
      true,
    );
  });
  it("not one we closed after replying (#3), nor one already noted (#9)", () => {
    const owner = { login: "iliasbeshimov" };
    expect(shouldRead({ state: "closed", user: dev, closed_by: owner }, [])).toBe(false);
    expect(shouldRead({ state: "closed", user: dev, closed_by: owner }, note)).toBe(false);
    expect(shouldRead({ state: "closed", user: dev, closed_by: dev }, note)).toBe(false);
    expect(shouldRead({ state: "closed", user: dev, closed_by: null }, [])).toBe(false);
  });
  it("not one its author closed as not planned or as a duplicate", () => {
    for (const state_reason of ["not_planned", "duplicate"])
      expect(shouldRead({ state: "closed", user: dev, closed_by: dev, state_reason }, [])).toBe(
        false,
      );
    expect(
      shouldRead({ state: "closed", user: dev, closed_by: dev, state_reason: "completed" }, []),
    ).toBe(true);
  });
});

describe("our reply, from the owner's comment", () => {
  const mark = (status: string) => `<!-- zoteroplugins:reply status=${status} -->`;
  const owner = { login: "iliasbeshimov" };
  const at = "2026-11-19T06:50:00Z";
  it("is the owner's last comment with the mark, without the mark", () => {
    const r = replyFrom(
      [
        { user: owner, created_at: at, body: `First.\n${mark("noted")}` },
        { user: owner, created_at: at, body: "Just talking, no mark." },
        { user: owner, created_at: at, body: `We checked 1.3.1.\n\n${mark("fixed")}` },
      ],
      "#11",
    );
    expect(r).toEqual({ status: "fixed", text: "We checked 1.3.1.", date: "2026-11-19" });
  });
  it("never a developer's comment, even with the mark", () => {
    const dev = { login: "Marco0431" };
    expect(replyFrom([{ user: dev, created_at: at, body: `Ours!\n${mark("fixed")}` }], "#11")).toBe(
      null,
    );
  });
  it("fails loudly when too long for the page or the status is unknown", () => {
    const long = `${"x".repeat(2001)}\n${mark("noted")}`;
    expect(() => replyFrom([{ user: owner, created_at: at, body: long }], "#14")).toThrow(/2001/);
    expect(() => replyFrom([{ user: owner, created_at: at, body: mark("open") }], "#14")).toThrow(
      /unknown/,
    );
    expect(REPLY_MARK.test(mark("finding-stands"))).toBe(true);
  });
  it("is written onto the response once", () => {
    const url = "https://github.com/iliasbeshimov/zoteroplugins.org/issues/11";
    const yaml = `schemaVersion: 1\nslug: askgpt-zotero\nrepo: marco0431/askgpt-zotero\nstatus: listed\nresponses:\n  - date: "2026-11-15"\n    from: Marco0431\n    about: capabilities\n    text: |-\n      1.3.1 removes it.\n    url: ${url}\n    status: open\n`;
    const reply = { status: "fixed" as const, text: "We checked 1.3.1.", date: "2026-11-19" };
    const out = setReply(yaml, url, reply);
    expect(out).toContain("status: fixed");
    expect(out).toContain('repliedAt: "2026-11-19"');
    expect(setReply(out ?? "", url, reply)).toBe(null);
    expect(setReply(yaml, "https://github.com/x/y/issues/1", reply)).toBe(null);
  });
});

describe("which issues are responses to a card", () => {
  const form =
    "### Plugin\n\nhttps://zoteroplugins.org/p/zusia\n\n### Your response\n\nTwo corrections.";
  it("one with the form's label", () => {
    expect(isCardResponse({ labels: [{ name: "card-response" }], title: "x", body: "" })).toBe(
      true,
    );
  });
  it("one filed through the API, where GitHub dropped the label (#18)", () => {
    expect(
      isCardResponse({ labels: [], title: "[card] Zusia: no API key needed", body: form }),
    ).toBe(true);
  });
  it('not a "[card]" title without the form, nor the form without the title', () => {
    expect(isCardResponse({ labels: [], title: "[card] hello", body: "just text" })).toBe(false);
    expect(isCardResponse({ labels: [], title: "Update my listing", body: form })).toBe(false);
  });
});
