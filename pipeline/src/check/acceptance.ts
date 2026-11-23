import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gradeOf, type PluginProfile } from "@atlas/schema";
import { checkXpi } from "./check.ts";
import { buildCheckDataFile, loadCheckData } from "./data.ts";

/**
 * Acceptance test for the plugin check: runs it over the cached release files of listed plugins
 * and compares its grade with the one the catalogue publishes (A+ counted as A, since the check
 * has no live test). Every disagreement is listed with what the release has that a local build
 * doesn't.
 *
 *   node pipeline/src/check/acceptance.ts --cache <dir holding blobs/> [--limit N] [--out file]
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};

const root = arg("root") ?? process.cwd();
const cache = arg("cache") ?? join(root, ".cache");
const limit = Number(arg("limit") ?? Number.POSITIVE_INFINITY);
const out = arg("out");

const data = loadCheckData(await buildCheckDataFile(root));
const gen = join(root, "data", "generated");
const slugs = (await readdir(gen)).sort();

interface Row {
  slug: string;
  published: string;
  checked: string;
  match: boolean;
  because?: string;
  cause?: string;
  detail?: string;
}
const rows: Row[] = [];
let missing = 0;
for (const slug of slugs) {
  if (rows.length >= limit) break;
  let p: PluginProfile;
  try {
    p = JSON.parse(await readFile(join(gen, slug, "profile.json"), "utf8"));
  } catch {
    continue;
  }
  const sha = p.install?.asset.sha256;
  const published = gradeOf(p);
  if (!sha || published === "–" || !p.trust) continue;
  const blob = join(cache, "blobs", "sha256", sha.slice(0, 2), `${sha}.xpi`);
  if (!existsSync(blob)) {
    missing++;
    continue;
  }
  const t0 = Date.now();
  try {
    const r = await checkXpi(`${slug}.xpi`, new Uint8Array(await readFile(blob)), data, {
      repo: p.repoName,
    });
    const pub = published === "A+" ? "A" : published;
    const row: Row = { slug, published: pub, checked: r.grade, match: pub === r.grade };
    if (!row.match) {
      const t = p.trust;
      const reasons: string[] = [];
      if (t.tested) reasons.push(`tested:${t.tested.verdict}`);
      if (p.integrityEvents?.length) reasons.push("integrity-events");
      const check = p.install?.updates?.check;
      if (check) reasons.push(`update:${check.result}${check.label ? `/${check.label}` : ""}`);
      if (p.install?.updates?.kind && p.install.updates.kind !== "this-project")
        reasons.push(`updatekind:${p.install.updates.kind}`);
      const own = (t.facets.sourceTransparency.drivers ?? []).filter(
        (d) => !["ST-NOT-CHECKED", "ST-PLAUSIBLE"].includes(d),
      );
      const mine = (r.card.facets.sourceTransparency.drivers ?? []).filter(
        (d) => !["ST-NOT-CHECKED", "ST-PLAUSIBLE"].includes(d),
      );
      row.cause = reasons.join(" ");
      row.detail = JSON.stringify({
        pubST: own,
        myST: mine,
        pubDS: t.facets.dataSharing.drivers,
        myDS: r.card.facets.dataSharing.drivers,
        pubCAP: t.facets.capabilities.badges.map((b) => `${b.id}:${b.concern}`),
        myCAP: r.card.facets.capabilities.badges.map((b) => `${b.id}:${b.concern}`),
        pubLabel: t.overall.label,
        myLabel: r.card.overall.label,
        reviewed: r.reviewedAs,
        applied: r.reviewsApplied,
      });
      row.because = r.because;
    }
    rows.push(row);
  } catch (e) {
    rows.push({
      slug,
      published: gradeOf(p),
      checked: "error",
      match: false,
      cause: "error",
      detail: (e as Error).message.slice(0, 200),
    });
  }
  if (rows.length % 100 === 0)
    console.error(`${rows.length} done (${((Date.now() - t0) / 1000).toFixed(1)}s last)`);
}

const byGrade = new Map<string, { n: number; ok: number }>();
for (const r of rows) {
  const g = byGrade.get(r.published) ?? { n: 0, ok: 0 };
  g.n++;
  if (r.match) g.ok++;
  byGrade.set(r.published, g);
}
const ok = rows.filter((r) => r.match).length;
console.log(`${rows.length} plugins compared (${missing} skipped: file not in the cache)`);
console.log(`agree: ${ok} (${((100 * ok) / rows.length).toFixed(1)}%)`);
for (const [g, v] of [...byGrade].sort())
  console.log(`  published ${g}: ${v.ok}/${v.n} (${((100 * v.ok) / v.n).toFixed(1)}%)`);
if (out) await writeFile(out, JSON.stringify(rows, null, 1));
