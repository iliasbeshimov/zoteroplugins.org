/**
 * POST /api/idea: an idea sent with the site's suggestion box (src/components/IdeaBox.astro).
 * After the Turnstile check it starts .github/workflows/idea.yml with the text and the page it
 * was sent from, which posts it as a public issue labelled `idea`. Nothing else is sent or kept:
 * no name and no email address (Turnstile is given the IP address to tell bots, as on /submit).
 * Secrets: TURNSTILE_SECRET, GH_DISPATCH_TOKEN (it can only start this repository's workflows).
 */

interface Env {
  TURNSTILE_SECRET?: string;
  GH_DISPATCH_TOKEN?: string;
}

const REPO = "iliasbeshimov/zoteroplugins.org";
const WORKFLOW = "idea.yml";
const UA = "zoteroplugins.org ideas (+https://zoteroplugins.org/about)";
export const MIN_CHARS = 10;
export const MAX_CHARS = 2000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** The idea as it will be posted: line endings made plain, no control characters, trimmed. */
export function cleanText(input: unknown): string {
  if (typeof input !== "string") return "";
  return (
    input
      .replace(/\r\n?/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .trim()
  );
}

/** The site page it was sent from: a path on this site, or "" for anything else. */
export function cleanPage(input: unknown): string {
  if (typeof input !== "string") return "";
  const p = input.trim();
  return /^\/(?!\/)[A-Za-z0-9/._~%+-]{0,200}$/.test(p) ? p : "";
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  let body: { text?: unknown; page?: unknown; token?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ status: "invalid", message: "Write your idea first." }, 400);
  }
  const text = cleanText(body.text);
  if (text.length < MIN_CHARS)
    return json(
      { status: "invalid", message: "Tell us a little more: a sentence is enough." },
      400,
    );
  if (text.length > MAX_CHARS)
    return json(
      {
        status: "invalid",
        message: `Please keep it under ${MAX_CHARS.toLocaleString("en-US")} characters.`,
      },
      400,
    );
  const page = cleanPage(body.page);
  const token = typeof body.token === "string" ? body.token.slice(0, 2048) : "";

  if (!env.TURNSTILE_SECRET || !env.GH_DISPATCH_TOKEN)
    return json({ status: "error", message: "The suggestion box isn't open yet." }, 503);
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);
  const tv = (await (
    await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    })
  ).json()) as { success?: boolean };
  if (!tv.success)
    return json(
      {
        status: "invalid",
        message: "The check that you're not a bot didn't pass. Please try again.",
      },
      403,
    );

  const d = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": UA,
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { text, page } }),
    },
  );
  if (d.status !== 204)
    return json(
      {
        status: "error",
        message: "We couldn't send it just now. Please try again in a few minutes.",
      },
      502,
    );
  return json({ status: "sent" });
};

export const onRequest = () => json({ status: "invalid", message: "Use POST." }, 405);
