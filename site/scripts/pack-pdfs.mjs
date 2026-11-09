/**
 * Renders each plugin pack page (dist/for/<slug>.html) to dist/for/<slug>.pdf with headless
 * Chrome, through the page's own print stylesheet, so the PDF and the page always list the same
 * plugins. Runs after `astro build`. The pages are served from dist on a local port, and Google's
 * analytics hosts don't resolve, so a render never counts as a visit.
 *
 * Without Chrome a local build skips the PDFs with a warning; in CI it fails, since the pages link
 * to them. CHROME_PATH picks a browser explicitly.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const packDir = join(dist, "for");
const slugs = existsSync(packDir)
  ? readdirSync(packDir)
      .filter((f) => f.endsWith(".html") && f !== "index.html")
      .map((f) => f.slice(0, -".html".length))
  : [];

const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => p && existsSync(p));

if (!slugs.length) {
  console.log("pack-pdfs: no pack pages in dist/for; nothing to render.");
  process.exit(0);
}
if (!chrome) {
  const msg = "pack-pdfs: Chrome not found (set CHROME_PATH); the pack PDFs weren't rendered.";
  if (process.env.CI) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
  process.exit(0);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

// dist as the site serves it: /for/phd-students is dist/for/phd-students.html.
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  const file = [join(dist, rel), join(dist, `${rel}.html`), join(dist, rel, "index.html")].find(
    (f) => f.startsWith(dist) && existsSync(f) && statSync(f).isFile(),
  );
  if (!file || file.split(sep).includes("..")) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), "pack-pdfs-"));
const blocked = ["www.googletagmanager.com", "*.google-analytics.com", "*.doubleclick.net"]
  .map((h) => `MAP ${h} ~NOTFOUND`)
  .join(", ");
let failed = 0;
try {
  for (const slug of slugs) {
    const out = join(packDir, `${slug}.pdf`);
    rmSync(out, { force: true });
    try {
      await run(
        chrome,
        [
          "--headless",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          // CI runners and root can't always start Chrome's sandbox; it only loads our own pages here.
          ...(process.env.CI || process.getuid?.() === 0 ? ["--no-sandbox"] : []),
          `--user-data-dir=${profile}`,
          `--host-resolver-rules=${blocked}`,
          "--no-pdf-header-footer",
          "--virtual-time-budget=10000",
          `--print-to-pdf=${out}`,
          `http://127.0.0.1:${port}/for/${slug}`,
        ],
        { timeout: 60_000 },
      );
    } catch (e) {
      console.error(`pack-pdfs: Chrome failed on ${slug}: ${e.message}`);
    }
    if (existsSync(out) && statSync(out).size > 5_000) {
      console.log(`pack-pdfs: for/${slug}.pdf (${Math.round(statSync(out).size / 1024)} KB)`);
    } else {
      console.error(`pack-pdfs: for/${slug}.pdf wasn't written`);
      failed++;
    }
  }
} finally {
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
if (failed && process.env.CI) process.exit(1);
