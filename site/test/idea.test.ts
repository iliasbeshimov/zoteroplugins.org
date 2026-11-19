import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanPage, cleanText, onRequestPost } from "../functions/api/idea.ts";

const env = { TURNSTILE_SECRET: "s", GH_DISPATCH_TOKEN: "g" };
const post = (body: unknown, e: Record<string, string> = env) =>
  onRequestPost({
    request: new Request("https://zoteroplugins.org/api/idea", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    env: e,
  });

/** Stands in for Turnstile and GitHub; records what was sent to GitHub. */
function mockFetch(turnstileOk = true, dispatchStatus = 204) {
  const sent: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.includes("turnstile")) return Response.json({ success: turnstileOk });
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: dispatchStatus });
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("suggestion box function", () => {
  it("cleans the text and keeps only a path on this site", () => {
    expect(cleanText("  a\r\nb\u0007c  ")).toBe("a\nbc");
    expect(cleanText(42)).toBe("");
    expect(cleanPage("/p/zotero-atlas")).toBe("/p/zotero-atlas");
    expect(cleanPage("//evil.example/x")).toBe("");
    expect(cleanPage("https://evil.example/")).toBe("");
    expect(cleanPage("/a b")).toBe("");
  });

  it("starts the idea workflow with the text and page after the bot check", async () => {
    const sent = mockFetch();
    const r = await post({
      text: "  Show release notes on plugin pages  ",
      page: "/p/x",
      token: "t",
    });
    expect(await r.json()).toEqual({ status: "sent" });
    expect(sent).toEqual([
      {
        url: "https://api.github.com/repos/iliasbeshimov/zoteroplugins.org/actions/workflows/idea.yml/dispatches",
        body: { ref: "main", inputs: { text: "Show release notes on plugin pages", page: "/p/x" } },
      },
    ]);
  });

  it("turns away short or long text, bots and a closed box, and says when GitHub fails", async () => {
    let sent = mockFetch();
    expect((await post({ text: "too short", token: "t" })).status).toBe(400);
    expect((await post({ text: "x".repeat(2001), token: "t" })).status).toBe(400);
    expect((await post({ text: "a long enough idea", token: "t" }, {})).status).toBe(503);
    expect(sent).toEqual([]);
    sent = mockFetch(false);
    expect((await post({ text: "a long enough idea", token: "t" })).status).toBe(403);
    expect(sent).toEqual([]);
    mockFetch(true, 422);
    expect((await post({ text: "a long enough idea", token: "t" })).status).toBe(502);
  });
});
