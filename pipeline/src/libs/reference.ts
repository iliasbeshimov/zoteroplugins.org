import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadConfig } from "../config.ts";
import { fetchWithRetry } from "../net/http.ts";
import { paths } from "../paths.ts";
import { Catalogue, LibraryReference, libraryFileName } from "./index.ts";
import { collect, hashKey, NORMALIZER_VERSION } from "./normalize.ts";
import { parseJs } from "./parse.ts";

export { Catalogue, LibraryReference };

/**
 * Builds a library's reference from its official releases on npm. A copy found in a plugin is
 * never a reference: that is the thing being checked.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SKIPPED_DIRS = new Set(["test", "tests", "__tests__", "example", "examples", "docs"]);

/**
 * The names the scanner's file-name and banner detection produces for a library, where they
 * differ from its npm name.
 */
const SEED_ALIASES: Record<string, string[]> = {
  "pdfjs-dist": ["pdf.js", "pdfjs", "pdf"],
  "highlight.js": ["highlight"],
  dompurify: ["purify"],
  "react-dom": [],
  mathjax: [],
  vditor: [],
  "zotero-plugin-toolkit": [],
  "@pdf-lib/fontkit": ["fontkit"],
};

export const libraryDir = () => join(paths.root, "data", "libraries");

export interface TarEntry {
  name: string;
  data: Buffer;
}

const field = (block: Buffer, from: number, length: number) => {
  const raw = block.subarray(from, from + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString("utf8");
};

/** The `path=` record of a pax header (`27 path=package/dist/x.js\n`). */
function paxPath(data: Buffer): string | null {
  const text = data.toString("utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\d+ path=(.*)$/);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** The regular files of a tar archive: 512-byte headers, GNU long names (`L`) and pax paths (`x`). */
export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let longName: string | null = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const base = field(header, 0, 100);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (type !== "0" && type !== "\0") {
      longName = null;
      continue;
    }
    entries.push({ name: longName ?? (prefix ? `${prefix}/${base}` : base), data });
    longName = null;
  }
  return entries;
}

const registryUrl = (name: string) =>
  `https://registry.npmjs.org/${name.startsWith("@") ? name.replace("/", "%2F") : name}`;

interface Packument {
  versions: Record<string, { dist: { tarball: string; integrity?: string; shasum?: string } }>;
  time?: Record<string, string>;
}

function chooseVersions(doc: Packument, max: number, explicit?: string[]): string[] {
  if (explicit?.length) return explicit;
  return Object.keys(doc.versions)
    .filter((v) => !v.includes("-"))
    .sort((a, b) => (doc.time?.[b] ?? "").localeCompare(doc.time?.[a] ?? ""))
    .slice(0, max);
}

async function tarball(
  name: string,
  version: string,
  dist: { tarball: string; integrity?: string; shasum?: string },
  cacheDir: string,
  userAgent: string,
): Promise<{ bytes: Buffer; integrity: string }> {
  const file = join(cacheDir, "npm", libraryFileName(name), `${version}.tgz`);
  let bytes: Buffer;
  if (existsSync(file)) bytes = await readFile(file);
  else {
    const res = await fetchWithRetry(dist.tarball, { headers: { "user-agent": userAgent } });
    if (!res.ok) throw new Error(`${dist.tarball}: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const ok = dist.integrity
    ? integrity === dist.integrity
    : createHash("sha1").update(bytes).digest("hex") === dist.shasum;
  if (!ok) throw new Error(`${name}@${version}: the download doesn't match its published checksum`);
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return { bytes, integrity };
}

/** JavaScript in a release that can be a library's own code (not tests, examples or types). */
function isLibraryScript(path: string, size: number): boolean {
  if (!/\.(m|c)?js$/i.test(path) || /\.d\.ts$/i.test(path) || size > MAX_FILE_BYTES) return false;
  const dirs = path.split("/").slice(0, -1);
  return !dirs.some((d) => SKIPPED_DIRS.has(d));
}

export interface AddOptions {
  max?: number;
  versions?: string[];
}

export async function addLibrary(
  name: string,
  { max = 30, versions }: AddOptions = {},
  log: (msg: string) => void = console.log,
): Promise<LibraryReference> {
  const config = loadConfig();
  const res = await fetchWithRetry(registryUrl(name), {
    headers: { "user-agent": config.userAgent },
  });
  if (!res.ok) throw new Error(`${name}: the npm registry answered HTTP ${res.status}`);
  const doc = (await res.json()) as Packument;
  const chosen = chooseVersions(doc, max, versions);

  const dir = libraryDir();
  const file = join(dir, `${libraryFileName(name)}.json`);
  const existing =
    versions?.length && existsSync(file)
      ? LibraryReference.parse(JSON.parse(readFileSync(file, "utf8")))
      : null;
  const calls = new Set<string>(existing?.calls);
  const literals = new Set<string>(existing?.literals);
  const built = new Map(existing?.versions.map((v) => [v.version, v]));

  for (const version of chosen) {
    const dist = doc.versions[version]?.dist;
    if (!dist) {
      log(`${name}@${version}: not on the registry, skipped`);
      continue;
    }
    const { bytes, integrity } = await tarball(
      name,
      version,
      dist,
      config.cacheDir,
      config.userAgent,
    );
    let files = 0;
    let skipped = 0;
    for (const entry of readTar(gunzipSync(bytes))) {
      const path = entry.name.split("/").slice(1).join("/");
      if (!isLibraryScript(path, entry.data.length)) continue;
      try {
        const found = collect(parseJs(entry.data.toString("utf8")));
        for (const c of found.calls) calls.add(hashKey(c.key));
        for (const l of found.literals) literals.add(hashKey(l.value));
        files++;
      } catch {
        skipped++;
      }
    }
    built.set(version, { version, integrity, files, skipped });
    log(`${name}@${version}: ${files} files, ${skipped} skipped`);
  }

  const time = (v: string) => doc.time?.[v] ?? "";
  const reference: LibraryReference = {
    schemaVersion: 1,
    library: name,
    source: "npm",
    builtAt: new Date().toISOString(),
    normalizerVersion: NORMALIZER_VERSION,
    versions: [...built.values()].sort((a, b) => time(b.version).localeCompare(time(a.version))),
    calls: [...calls].sort(),
    literals: [...literals].sort(),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(reference)}\n`);

  const catalogue = readCatalogue();
  // Libraries we already know a detected name for are listed even before their reference exists.
  for (const [seed, aliases] of Object.entries(SEED_ALIASES))
    catalogue.libraries[seed] ??= { aliases };
  catalogue.libraries[name] ??= { aliases: [] };
  await writeCatalogue(catalogue);
  return reference;
}

export function readCatalogue(): Catalogue {
  const file = join(libraryDir(), "catalogue.json");
  return existsSync(file)
    ? Catalogue.parse(JSON.parse(readFileSync(file, "utf8")))
    : { schemaVersion: 1, libraries: {} };
}

async function writeCatalogue(catalogue: Catalogue) {
  const sorted = Object.fromEntries(
    Object.entries(catalogue.libraries).sort(([a], [b]) => a.localeCompare(b, "en")),
  );
  await writeFile(
    join(libraryDir(), "catalogue.json"),
    `${JSON.stringify({ ...catalogue, libraries: sorted }, null, 2)}\n`,
  );
}

/** The catalogue with what each library's reference holds, for `atlas libs list`. */
export function listLibraries(): {
  name: string;
  aliases: string[];
  versions: number;
  calls: number;
  literals: number;
}[] {
  const catalogue = readCatalogue();
  return Object.entries(catalogue.libraries).map(([name, entry]) => {
    const file = join(libraryDir(), `${libraryFileName(name)}.json`);
    const ref = existsSync(file)
      ? LibraryReference.parse(JSON.parse(readFileSync(file, "utf8")))
      : null;
    return {
      name,
      aliases: entry.aliases,
      versions: ref?.versions.length ?? 0,
      calls: ref?.calls.length ?? 0,
      literals: ref?.literals.length ?? 0,
    };
  });
}
