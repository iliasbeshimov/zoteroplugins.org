/**
 * Evidence packs for the requirements check: one Markdown file per plugin shown by
 * default, with what a reviewer needs to say whether it needs an API key: its descriptions, README,
 * the services its code calls, where its code keeps a key, its default settings and what its sandbox
 * test saw. READMEs come from the GitHub cache (a conditional request when a token is set).
 *
 *   GITHUB_TOKEN=$(gh auth token) pnpm tsx pipeline/src/requirements/dossier.mts
 *
 * Writes .cache/requirements/input/<slug>.md and .cache/requirements/slugs.txt.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { cachedRest, GitHub } from "../net/github.ts";
import { DiskCache } from "../net/http.ts";
import { unzip } from "../scan/run.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, ".cache/requirements/input");
const README_MAX = 14000;

const config = loadConfig();
const cache = new DiskCache(join(ROOT, ".cache/http"));
const gh = process.env.GITHUB_TOKEN
  ? new GitHub(process.env.GITHUB_TOKEN, config.userAgent, cache)
  : null;

async function readme(repo: string): Promise<string> {
  const path = `/repos/${repo}/readme`;
  let data = await cachedRest<{ content?: string }>(cache, path);
  if (!data && gh) data = (await gh.rest<{ content?: string }>(path)).data;
  return data?.content ? Buffer.from(data.content, "base64").toString("utf8") : "";
}

async function prefsFromXpi(xpi: string): Promise<string> {
  try {
    const entries = await unzip(new Uint8Array(await readFile(xpi)));
    return entries
      .filter((e) => /(^|\/)prefs\.js$|defaults\/preferences\/[^/]+\.js$/.test(e.path))
      .map((e) => `// ${e.path}\n${new TextDecoder().decode(e.data)}`)
      .join("\n")
      .slice(0, 6000);
  } catch {
    return "";
  }
}

const slugs: string[] = [];
await mkdir(OUT, { recursive: true });
for (const slug of (await readdir(join(ROOT, "data/generated"))).sort()) {
  let p: any;
  try {
    p = JSON.parse(await readFile(join(ROOT, "data/generated", slug, "profile.json"), "utf8"));
  } catch {
    continue;
  }
  if (p.listing?.kind !== "plugin" || p.listing.hiddenByDefault) continue;
  const sha: string | undefined = p.trust?.appliesTo?.sha256;
  const version: string | undefined = p.trust?.appliesTo?.version;
  let release: any = null;
  if (version) {
    try {
      release = JSON.parse(
        await readFile(join(ROOT, "data/generated", slug, `${version}.json`), "utf8"),
      );
    } catch {}
  }
  const a = release?.analysis;
  const xpi = sha ? join(ROOT, ".cache/blobs/sha256", sha.slice(0, 2), `${sha}.xpi`) : null;
  const hosts = (a?.network?.hosts ?? [])
    .filter((h: any) => h.usage !== "link" && !h.inVendoredCode)
    .map(
      (h: any) =>
        `- ${h.host} (${h.provider ?? "?"}; ${h.category}; ${h.usage}) e.g. ${h.evidence?.[0]?.file}:${h.evidence?.[0]?.line} \`${(h.evidence?.[0]?.snippet ?? "").slice(0, 140)}\``,
    );
  const creds = (a?.capabilities ?? [])
    .filter((c: any) => ["credential-storage", "login-manager"].includes(c.id))
    .flatMap((c: any) => c.evidence.filter((e: any) => !e.inVendoredCode).slice(0, 10))
    .map((e: any) => `- ${e.file}:${e.line} \`${(e.snippet ?? "").slice(0, 160)}\``);
  let sandbox = "";
  try {
    const s = JSON.parse(await readFile(join(ROOT, "data/sandbox", `${slug}.json`), "utf8"));
    sandbox = `Tested in Zotero ${s.zotero}: verdict ${s.verdict}; loaded ${s.loaded}; hosts contacted with no key entered: ${JSON.stringify(s.hostUsage)}; menu items clicked: ${s.exercised?.menuItems}.`;
  } catch {}
  const text = await readme(p.repo);
  const prefs = xpi ? await prefsFromXpi(xpi) : "";
  const md = [
    `# ${p.name} (${slug})`,
    `Repo: https://github.com/${p.repo} · version ${version ?? "?"} · release file: ${xpi ?? "none"}`,
    "",
    `GitHub description: ${p.about?.githubDescription ?? ""}`,
    `Manifest description: ${p.about?.manifestDescription ?? ""}`,
    `Topics: ${(p.about?.topics ?? []).join(", ")}`,
    "",
    "## Services its code calls (static analysis; not vendored code; links excluded)",
    hosts.join("\n") || "(none found)",
    "",
    "## Where its code keeps a key, token or password (static analysis)",
    creds.join("\n") || "(none found)",
    "",
    "## Its default settings (prefs files in the release)",
    prefs ? `\`\`\`js\n${prefs}\n\`\`\`` : "(none)",
    "",
    "## Sandbox test",
    sandbox || "(not tested)",
    "",
    `## README${text.length > README_MAX ? ` (first ${README_MAX} characters)` : ""}`,
    text.slice(0, README_MAX) || "(no README)",
  ].join("\n");
  await writeFile(join(OUT, `${slug}.md`), md);
  slugs.push(slug);
}
await writeFile(join(ROOT, ".cache/requirements/slugs.txt"), `${slugs.join("\n")}\n`);
console.log(`wrote ${slugs.length} evidence packs to .cache/requirements/input`);
