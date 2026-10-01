import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../paths.ts";
import { collect, hashKey } from "./normalize.ts";
import { parseJs } from "./parse.ts";

/**
 * What the scanner knows about third-party libraries: the calls and string literals of their
 * official npm releases (data/libraries/), stored as short hashes. Only the releases are a
 * reference; a copy found inside a plugin is never one.
 */

export const Catalogue = z.object({
  schemaVersion: z.literal(1),
  libraries: z.record(z.string(), z.object({ aliases: z.array(z.string()) })),
});
export type Catalogue = z.infer<typeof Catalogue>;

export const LibraryReference = z.object({
  schemaVersion: z.literal(1),
  library: z.string(),
  source: z.literal("npm"),
  builtAt: z.string(),
  normalizerVersion: z.number().int(),
  versions: z.array(
    z.object({
      version: z.string(),
      integrity: z.string(),
      files: z.number().int(),
      skipped: z.number().int(),
    }),
  ),
  calls: z.array(z.string()),
  literals: z.array(z.string()),
});
export type LibraryReference = z.infer<typeof LibraryReference>;

export interface LibraryIndex {
  /** Hash of a normalised call → the npm names whose release has it. */
  calls: Map<string, string[]>;
  /** Hash of a string literal → the npm names whose release has it. */
  literals: Map<string, string[]>;
  /** A name the scanner detected (`pdf.js`, `purify`) → its npm name; unknown names stay as they are. */
  aliasOf(name: string): string;
  /** Whether the library is in the catalogue and has a reference file. */
  has(npmName: string): boolean;
}

export const EMPTY_INDEX: LibraryIndex = {
  calls: new Map(),
  literals: new Map(),
  aliasOf: (name) => name,
  has: () => false,
};

/** `@scope/name` → `@scope__name`, safe as a file name. */
export const libraryFileName = (name: string) => name.replaceAll("/", "__");

function build(
  sets: Map<string, { calls: Iterable<string>; literals: Iterable<string> }>,
  aliases: Record<string, string[]>,
): LibraryIndex {
  const calls = new Map<string, string[]>();
  const literals = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, hash: string, name: string) => {
    const list = map.get(hash);
    if (list) list.push(name);
    else map.set(hash, [name]);
  };
  for (const [name, set] of sets) {
    for (const h of set.calls) add(calls, h, name);
    for (const h of set.literals) add(literals, h, name);
  }
  const alias = new Map<string, string>();
  for (const [name, list] of Object.entries(aliases))
    for (const a of list) alias.set(a.toLowerCase(), name);
  return {
    calls,
    literals,
    aliasOf: (name) => (sets.has(name) ? name : (alias.get(name.toLowerCase()) ?? name)),
    has: (name) => sets.has(name),
  };
}

const loaded = new Map<string, LibraryIndex>();

export function loadLibraryIndex(dir = join(paths.root, "data", "libraries")): LibraryIndex {
  const cached = loaded.get(dir);
  if (cached) return cached;
  const catalogueFile = join(dir, "catalogue.json");
  let index = EMPTY_INDEX;
  if (existsSync(catalogueFile)) {
    const catalogue = Catalogue.parse(JSON.parse(readFileSync(catalogueFile, "utf8")));
    const sets = new Map<string, { calls: Iterable<string>; literals: Iterable<string> }>();
    const aliases: Record<string, string[]> = {};
    for (const [name, entry] of Object.entries(catalogue.libraries)) {
      aliases[name] = entry.aliases;
      const file = join(dir, `${libraryFileName(name)}.json`);
      if (!existsSync(file)) continue;
      const ref = LibraryReference.parse(JSON.parse(readFileSync(file, "utf8")));
      sets.set(name, ref);
    }
    index = build(sets, aliases);
  }
  loaded.set(dir, index);
  return index;
}

/** An index built from source text, for tests: library name → the sources of its release. */
export function indexFromSources(refs: Record<string, string[]>): LibraryIndex {
  const sets = new Map<string, { calls: Set<string>; literals: Set<string> }>();
  for (const [name, sources] of Object.entries(refs)) {
    const set = { calls: new Set<string>(), literals: new Set<string>() };
    for (const source of sources) {
      const { calls, literals } = collect(parseJs(source));
      for (const c of calls) set.calls.add(hashKey(c.key));
      for (const l of literals) set.literals.add(hashKey(l.value));
    }
    sets.set(name, set);
  }
  return build(sets, {});
}
