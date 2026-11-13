import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeveloperResponse, PluginCurated } from "@atlas/schema";
import { Document, isMap, isSeq, parseDocument, Scalar, YAMLSeq } from "yaml";
import type { z } from "zod";
import { paths } from "../paths.ts";

type Response = z.infer<typeof DeveloperResponse>;

/**
 * A developer's response to their plugin's card, from a "Respond to your plugin's card" issue
 * (.github/ISSUE_TEMPLATE/card-response.yml). When the issue's author maintains the plugin's
 * repository, the response goes on the plugin's page at once, marked "We're checking"
 * (data/plugins/<slug>.yaml and the profile the page reads), and the issue gets a note saying so.
 * Our reply and the final status are added by hand later, after the finding is re-checked: the
 * reply speaks for the site, and a corrected check changes the card of every plugin.
 */

export const SITE_REPO = "iliasbeshimov/zoteroplugins.org";
export const LABEL = "card-response";
/** Marks our note on an issue, so an edited issue doesn't get a second one. */
export const NOTE_MARK = "<!-- zoteroplugins:card-response -->";
/** Longer responses are cut at a paragraph and point to the issue for the rest. */
export const MAX_TEXT = 10000;

export interface ResponseForm {
  plugin: string | null;
  about: Response["about"];
  version: string | null;
  text: string;
  maintainerTicked: boolean;
}

const ABOUT: [RegExp, Response["about"]][] = [
  [/^source transparency/i, "source-transparency"],
  [/^data sharing/i, "data-sharing"],
  [/^capabilities/i, "capabilities"],
  [/^compatibility/i, "compatibility"],
];

/** The form's field headings, in order (card-response.yml). A response can have `###` headings too. */
const FIELDS = [
  "Plugin",
  "Which part of the card?",
  "Version",
  "Your response",
  "Evidence",
  "Maintainer",
];

/** The issue form's sections: `### Plugin`, `### Your response`, … ("_No response_" is empty). */
export function parseForm(body: string): ResponseForm {
  const sections = new Map<string, string>();
  const text = `\n${body.replace(/\r\n?/g, "\n")}`;
  // Each field starts at its own heading, found in order, so a heading inside the developer's
  // response ("### 1. What is the Microsoft executable for?") stays part of it.
  const starts: { name: string; at: number; end: number }[] = [];
  let from = 0;
  for (const name of FIELDS) {
    const at = text.indexOf(`\n### ${name}\n`, from);
    if (at < 0) continue;
    starts.push({ name, at, end: at + name.length + 6 });
    from = at + 1;
  }
  starts.forEach((s, i) => {
    const value = text.slice(s.end, starts[i + 1]?.at ?? text.length).trim();
    sections.set(s.name.toLowerCase(), value === "_No response_" ? "" : value);
  });
  const get = (name: string) => sections.get(name) || null;
  const aboutText = get("which part of the card?") ?? "";
  return {
    plugin: get("plugin"),
    about: ABOUT.find(([re]) => re.test(aboutText))?.[1] ?? "other",
    version: get("version")?.replace(/^v(?=\d)/, "") ?? null,
    text: get("your response") ?? "",
    maintainerTicked: /-\s*\[x\]/i.test(sections.get("maintainer") ?? ""),
  };
}

/** The response as published: line ends trimmed, and cut at a paragraph when far too long. */
export function responseText(text: string, issueUrl: string): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length <= MAX_TEXT) return clean;
  const note = `\n\n[The rest of this response is in the issue: ${issueUrl}]`;
  const room = MAX_TEXT - note.length;
  const cut = clean.lastIndexOf("\n\n", room);
  return `${clean.slice(0, cut > room / 2 ? cut : room).trimEnd()}${note}`;
}

/** The listed plugin a form's "Plugin" field names: its page on the site or its repository. */
export function slugFor(field: string | null, slugs: Record<string, string>): string | null {
  if (!field) return null;
  const page = field.match(/zoteroplugins\.org\/p\/([a-z0-9-]+)/i)?.[1]?.toLowerCase();
  if (page && Object.values(slugs).includes(page)) return page;
  const repo = field.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?\s]|$)/i);
  if (repo) return slugs[`${repo[1]}/${repo[2]}`.toLowerCase()] ?? null;
  const bare = field.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return bare ? (slugs[`${bare[1]}/${bare[2]}`.toLowerCase()] ?? null) : null;
}

/**
 * Adds a response to a plugin's curated file, or updates it when the issue was edited: only while
 * we haven't replied, so an edit never changes text we've answered. Returns the new YAML, or null
 * when nothing changes. Comments and formatting in the file are kept.
 */
export function upsertResponse(
  yamlText: string | null,
  base: { slug: string; repo: string },
  response: Response,
): string | null {
  const doc: Document = yamlText
    ? parseDocument(yamlText)
    : new Document({ schemaVersion: 1, slug: base.slug, repo: base.repo, status: "listed" });
  const quoted = (v: string) => Object.assign(new Scalar(v), { type: Scalar.QUOTE_DOUBLE });
  const block = (v: string) => Object.assign(new Scalar(v), { type: Scalar.BLOCK_LITERAL });
  const node = doc.createNode({
    date: quoted(response.date),
    from: response.from,
    about: response.about,
    ...(response.version ? { version: quoted(response.version) } : {}),
    text: block(response.text),
    url: response.url,
    status: response.status,
  });
  let list = doc.get("responses");
  if (!isSeq(list)) {
    list = new YAMLSeq();
    doc.set("responses", list);
  }
  const seq = list as YAMLSeq;
  const at = seq.items.findIndex((item) => isMap(item) && item.get("url") === response.url);
  if (at >= 0) {
    const old = seq.items[at];
    if (!isMap(old) || old.get("status") !== "open" || old.get("reply")) return null;
    const same =
      old.get("text") === response.text &&
      old.get("about") === response.about &&
      (old.get("version") ?? null) === (response.version ?? null);
    if (same) return null;
    seq.items[at] = node;
  } else seq.items.push(node);
  const out = doc.toString({ lineWidth: 0 });
  // The file must still be valid: a bad response never reaches the site.
  PluginCurated.parse(parseDocument(out).toJS());
  return out;
}

export interface Verification {
  ok: boolean;
  how: string;
}

type Get = (path: string) => Promise<{ status: number; data: unknown }>;

/**
 * Whether a GitHub account maintains a repository, from what anyone can see: it owns the
 * repository, it published one of its recent releases, or it's a public member of the
 * organisation that owns it. Collaborator lists need push access to the repository, so a
 * maintainer who is none of these is checked by hand.
 */
export async function verifyMaintainer(
  get: Get,
  repo: string,
  login: string,
): Promise<Verification> {
  const [owner = ""] = repo.split("/");
  const who = login.toLowerCase();
  if (owner.toLowerCase() === who) return { ok: true, how: `owns ${repo}` };
  const releases = await get(`/repos/${repo}/releases?per_page=30`);
  if (
    releases.status === 200 &&
    Array.isArray(releases.data) &&
    releases.data.some(
      (r) => (r as { author?: { login?: string } }).author?.login?.toLowerCase() === who,
    )
  )
    return { ok: true, how: `published releases of ${repo}` };
  const member = await get(`/orgs/${owner}/members/${login}`);
  if (member.status === 204) return { ok: true, how: `is a public member of ${owner}` };
  return {
    ok: false,
    how: `doesn't own ${repo}, hasn't published one of its last 30 releases and isn't a public member of ${owner}`,
  };
}

/** Our note on the issue. */
export function noteFor(login: string, slug: string | null, v: Verification | null): string {
  if (!slug)
    return `${NOTE_MARK}\nThanks, @${login}. We couldn't tell which listed plugin this is about from the "Plugin" field. Could you edit the issue and put the plugin's page on zoteroplugins.org or its GitHub repository there? We'll pick it up from the edit.`;
  if (!v?.ok)
    return `${NOTE_MARK}\nThanks, @${login}. We publish responses from people who maintain the plugin's repository, and we couldn't confirm that automatically. We'll check by hand and reply here.`;
  return `${NOTE_MARK}\nThanks, @${login}. Your response is now on the plugin's page, https://zoteroplugins.org/p/${slug}#developer-response (it can take a few minutes to appear), marked "We're checking". We'll re-check the finding against the release file and reply here, usually within a week. If our check was wrong, we fix it for every plugin, and the card changes with it.`;
}

export interface IntakeResult {
  issue: number;
  slug: string | null;
  verified: boolean;
  changed: boolean;
  note: string | null;
  skipped?: string;
}

interface Issue {
  number: number;
  state: string;
  body: string | null;
  html_url: string;
  created_at: string;
  user: { login: string; type?: string };
  labels: { name: string }[];
  pull_request?: unknown;
}

/** The plugin's profile gets the curated responses, as `atlas profile` would write them. */
async function patchProfile(slug: string, responses: Response[]): Promise<void> {
  const file = join(paths.generated, slug, "profile.json");
  const profile = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (JSON.stringify(profile.responses ?? []) === JSON.stringify(responses)) return;
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(profile)) {
    if (k === "responses") continue;
    out[k] = v;
    // Where the profile builder puts it (run.ts): right after integrityEvents.
    if (k === "integrityEvents" && responses.length) {
      out.responses = responses;
      placed = true;
    }
  }
  if (!placed && responses.length) out.responses = responses;
  await writeFile(file, `${JSON.stringify(out, null, 1)}\n`);
}

/**
 * Reads one issue and publishes its response when its author maintains the plugin. `post` leaves
 * the note on the issue (once); without it the run only writes files (a dry run on a laptop).
 */
export async function intakeIssue(
  number: number,
  gh: { get: Get; post?: (path: string, body: unknown) => Promise<{ status: number }> },
): Promise<IntakeResult> {
  const res = await gh.get(`/repos/${SITE_REPO}/issues/${number}`);
  if (res.status !== 200) throw new Error(`issue ${number}: HTTP ${res.status}`);
  const issue = res.data as Issue;
  const base: IntakeResult = {
    issue: number,
    slug: null,
    verified: false,
    changed: false,
    note: null,
  };
  if (issue.pull_request) return { ...base, skipped: "a pull request" };
  if (!issue.labels.some((l) => l.name === LABEL)) return { ...base, skipped: `no ${LABEL} label` };
  if (issue.state !== "open") return { ...base, skipped: "closed" };
  const form = parseForm(issue.body ?? "");
  if (!form.text) return { ...base, skipped: "no response text" };
  const slugs = JSON.parse(
    await readFile(join(paths.root, "data", "slugs.json"), "utf8"),
  ) as Record<string, string>;
  const slug = slugFor(form.plugin, slugs);
  const repo = slug ? Object.keys(slugs).find((k) => slugs[k] === slug) : undefined;
  let verification: Verification | null = null;
  let changed = false;
  if (slug && repo) {
    verification = await verifyMaintainer(gh.get, repo, issue.user.login);
    if (verification.ok) {
      const response = DeveloperResponse.parse({
        date: issue.created_at.slice(0, 10),
        from: issue.user.login,
        about: form.about,
        ...(form.version && /^\d/.test(form.version) ? { version: form.version } : {}),
        text: responseText(form.text, issue.html_url),
        url: issue.html_url,
        status: "open",
      });
      const file = join(paths.root, "data", "plugins", `${slug}.yaml`);
      let text: string | null = null;
      try {
        text = await readFile(file, "utf8");
      } catch {
        text = null;
      }
      const curated = text ? PluginCurated.parse(parseDocument(text).toJS()) : null;
      const out = upsertResponse(text, { slug, repo: curated?.repo ?? repo }, response);
      if (out) {
        await writeFile(file, out);
        const responses = PluginCurated.parse(parseDocument(out).toJS()).responses;
        await patchProfile(slug, responses);
        changed = true;
      }
    }
  }
  // One note per issue: an edit that fixes the plugin link gets the published note.
  let note: string | null = null;
  if (gh.post) {
    const comments = await gh.get(`/repos/${SITE_REPO}/issues/${number}/comments?per_page=100`);
    const ours = (Array.isArray(comments.data) ? comments.data : []) as { body?: string }[];
    const noted = ours.filter((c) => c.body?.includes(NOTE_MARK));
    const wanted = noteFor(issue.user.login, slug, verification);
    const already = noted.some(
      (c) =>
        c.body === wanted || (verification?.ok && c.body?.includes("is now on the plugin's page")),
    );
    if (!already) {
      await gh.post(`/repos/${SITE_REPO}/issues/${number}/comments`, { body: wanted });
      note = wanted;
    }
    if (
      slug &&
      verification &&
      !verification.ok &&
      !issue.labels.some((l) => l.name === "needs-check")
    )
      await gh.post(`/repos/${SITE_REPO}/issues/${number}/labels`, { labels: ["needs-check"] });
  }
  return { ...base, slug, verified: Boolean(verification?.ok), changed, note };
}

/**
 * Every open card-response issue, oldest first. The workflow runs this whichever issue started it:
 * GitHub keeps one waiting run per concurrency group, so a run cancelled while the census held the
 * group loses nothing.
 */
export async function intakeOpen(gh: Parameters<typeof intakeIssue>[1]): Promise<IntakeResult[]> {
  const res = await gh.get(
    `/repos/${SITE_REPO}/issues?labels=${LABEL}&state=open&per_page=100&sort=created&direction=asc`,
  );
  if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`issues: HTTP ${res.status}`);
  const out: IntakeResult[] = [];
  for (const i of res.data as Issue[])
    if (!i.pull_request) out.push(await intakeIssue(i.number, gh));
  return out;
}

/** GitHub's REST API with the workflow's token. */
export function restClient(token: string | undefined) {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "zoteroplugins.org card responses",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return {
    get: async (path: string) => {
      const r = await fetch(`https://api.github.com${path}`, { headers });
      return { status: r.status, data: r.status === 204 ? null : await r.json().catch(() => null) };
    },
    post: async (path: string, body: unknown) => {
      const r = await fetch(`https://api.github.com${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.status >= 300) throw new Error(`POST ${path}: HTTP ${r.status}`);
      return { status: r.status };
    },
  };
}
