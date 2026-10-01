/**
 * POST /api/submit: someone submits a GitHub repository. A Cloudflare Pages Function, so it
 * deploys with the site. It answers what it can at once and starts the workflow only for a public
 * repository we don't know yet that has a release with an .xpi file:
 * - already listed, or in review: a link to its page;
 * - turned down before, for the same release: the reason again;
 * - not found, or no .xpi release: the reason;
 * - otherwise: starts .github/workflows/submit.yml, which queues it (a repeat changes nothing there).
 * Bots are stopped by Cloudflare Turnstile. Secrets: TURNSTILE_SECRET, GH_DISPATCH_TOKEN (a
 * fine-grained token that can only start this repository's workflows; it also reads public repos).
 */

interface Env {
  TURNSTILE_SECRET?: string;
  GH_DISPATCH_TOKEN?: string;
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };
}
type Known =
  | { status: "listed" | "in-review"; slug: string; name: string }
  | { status: "rejected"; reason: string; checkedTag: string | null }
  | { status: "waiting" };

const REPO = "iliasbeshimov/zoteroplugins.org";
const WORKFLOW = "submit.yml";
const UA = "zoteroplugins.org submit (+https://zoteroplugins.org/about)";
const RESERVED = new Set([
  "about",
  "apps",
  "collections",
  "features",
  "login",
  "marketplace",
  "orgs",
  "pricing",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
  "users",
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function repoOf(input: string): string | null {
  const t = input.trim();
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)/i.exec(
      t,
    ) ?? /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(t);
  if (!m?.[1] || !m[2]) return null;
  const owner = m[1].toLowerCase();
  const name = m[2].toLowerCase().replace(/\.git$/, "");
  if (RESERVED.has(owner) || !name || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

async function gh(path: string, env: Env, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": UA,
      "x-github-api-version": "2022-11-28",
      ...(env.GH_DISPATCH_TOKEN ? { authorization: `Bearer ${env.GH_DISPATCH_TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

const answer = (k: Known | undefined) => {
  if (!k) return null;
  if (k.status === "listed" || k.status === "in-review")
    return json({ status: k.status, slug: k.slug, name: k.name });
  if (k.status === "waiting")
    return json({
      status: "queued-waiting",
      message:
        "It's queued. We add a limited number of new plugins a day, so it will be added within a day.",
    });
  return null;
};

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  let body: { url?: unknown; token?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ status: "invalid", message: "Send a GitHub repository address." }, 400);
  }
  const url = typeof body.url === "string" ? body.url.slice(0, 300) : "";
  const token = typeof body.token === "string" ? body.token.slice(0, 2048) : "";
  const key = repoOf(url);
  if (!key)
    return json(
      {
        status: "invalid",
        message:
          "That doesn't look like a GitHub repository address, such as https://github.com/owner/plugin.",
      },
      400,
    );

  // Bots first: the Turnstile token is single-use.
  if (!env.TURNSTILE_SECRET)
    return json({ status: "error", message: "Submissions aren't open yet." }, 503);
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

  const knownRes = await env.ASSETS.fetch(new URL("/api/known.json", request.url).toString());
  const known = (
    knownRes.ok ? ((await knownRes.json()) as { repos: Record<string, Known> }).repos : {}
  ) as Record<string, Known>;
  const early = answer(known[key]);
  if (early) return early;

  // GitHub's own name for it: follows renames and transfers.
  const r = await gh(`/repos/${key}`, env);
  if (r.status === 404 || r.status === 451)
    return json({
      status: "rejected",
      message: "We couldn't find a public GitHub repository at that address.",
    });
  if (!r.ok)
    return json(
      { status: "error", message: "GitHub didn't answer. Please try again in a few minutes." },
      502,
    );
  const repo = (await r.json()) as { full_name: string; private?: boolean };
  if (repo.private)
    return json({
      status: "rejected",
      message: "We couldn't find a public GitHub repository at that address.",
    });
  const canonical = repo.full_name.toLowerCase();
  const again = answer(known[canonical]);
  if (again) return again;

  // A release with an .xpi file: the latest non-prerelease one that has one, as the census picks.
  const rel = await gh(`/repos/${canonical}/releases?per_page=30`, env);
  const releases = rel.ok
    ? ((await rel.json()) as {
        tag_name: string;
        prerelease: boolean;
        assets: { name: string }[];
      }[])
    : [];
  const withXpi = releases.filter((x) =>
    x.assets.some((a) => a.name.toLowerCase().endsWith(".xpi")),
  );
  const latest = withXpi.find((x) => !x.prerelease) ?? withXpi[0];
  if (!latest)
    return json({
      status: "rejected",
      message: "It has no GitHub release with a plugin file (.xpi).",
    });
  const k = known[canonical] ?? known[key];
  if (k?.status === "rejected" && k.checkedTag === latest.tag_name)
    return json({ status: "rejected", message: k.reason });

  if (!env.GH_DISPATCH_TOKEN)
    return json({ status: "error", message: "Submissions aren't open yet." }, 503);
  const d = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, env, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { repo: repo.full_name } }),
  });
  if (d.status !== 204)
    return json(
      {
        status: "error",
        message: "We couldn't queue it just now. Please try again in a few minutes.",
      },
      502,
    );
  return json({ status: "queued", repo: repo.full_name });
};

export const onRequest = () => json({ status: "invalid", message: "Use POST." }, 405);
