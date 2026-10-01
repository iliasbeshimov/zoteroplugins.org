import type { CodeEvidence } from "@atlas/schema";
import { EMPTY_INDEX, type LibraryIndex } from "../libs/index.ts";
import {
  type CallRecord,
  collect,
  type FnRecord,
  hashKey,
  type LiteralRecord,
} from "../libs/normalize.ts";
import type { AcornNode } from "../libs/parse.ts";

/**
 * A code file with a line index, evidence helpers, and a map of which byte ranges are bundled
 * third-party code (so findings there can be attributed to the library, not the plugin).
 */

const KNOWN_LIBS: [RegExp, string][] = [
  [/pdf\.js|pdfjs-dist|PDFJS/, "pdf.js"],
  [/\bmarked\b.*(?:markdown|Christopher Jeffrey)/i, "marked"],
  [/lodash/i, "lodash"],
  [/jQuery (?:JavaScript Library )?v\d/i, "jquery"],
  [/KaTeX/, "katex"],
  [/MathJax/, "mathjax"],
  [/highlight\.js/i, "highlight.js"],
  [/markdown-it/i, "markdown-it"],
  [/DOMPurify/, "dompurify"],
  [/crypto-js|CryptoJS/, "crypto-js"],
  [/Tesseract/, "tesseract.js"],
  [/mermaid/i, "mermaid"],
  [/turndown/i, "turndown"],
  [/react(?:-dom)?\.production/i, "react"],
  [/Vue\.js v\d/i, "vue"],
  [/Chart\.js/i, "chart.js"],
  [/echarts/i, "echarts"],
  [/\bd3\b.*(?:Mike Bostock|d3js\.org)/i, "d3"],
  [/pdf-lib/i, "pdf-lib"],
  [/@citation-js|citation-js/i, "citation-js"],
  [/Element Plus Icons/, "@element-plus/icons-vue"],
  [/Element Plus/, "element-plus"],
  [/DevExtreme/, "devextreme"],
];

/** node_modules is always third-party; lib/ or vendor/ alone says nothing about who wrote a file. */
const NODE_MODULES_PATH = /(^|\/)node_modules\//i;
// Files named like a library release: "excalidraw.production.min-0.16.1.js", "foo-2.3.4.min.js".
const RELEASE_FILE = /(\.production(\.min)?|[-.]\d+\.\d+\.\d+(\.min)?)[-.\w]*\.m?js$/i;
const LIB_NAMES =
  "pdf(?:\\.worker)?|pdfjs|katex|mathjax|tex-(?:mml-)?(?:chtml|svg)(?:-full)?|jquery|lodash|marked|highlight|mermaid|tesseract|crypto-js|markdown-it|turndown|purify|dompurify|chart|echarts|d3|react(?:-dom)?|vue|pdf-lib|pako|jszip|fontkit|vis-network|mupdf(?:-wasm)?|force-graph|xterm|papaparse|showdown|sortable|axios|dayjs|moment|dx";
// "katex.min.js", "d3.v7.min.js", "vis-network.min.js", "vue.global.prod.js", "dx.all.js"
const VENDORED_FILE = new RegExp(
  `(^|/)(${LIB_NAMES})(\\.v?\\d+(?:\\.\\d+)*)?(\\.umd|\\.global|\\.all)?(\\.prod(?:uction)?)?(\\.min)?(\\.[a-z]+)?\\.m?js$`,
  "i",
);
// A folder named after a library: "vendor/mathjax/es5/tex-svg.js", "lib/katex/contrib/x.js".
const LIB_DIR = new RegExp(`(^|/)(${LIB_NAMES}|mathjax[-\\w]*|katex[-\\w]*)/`, "i");
/** Vendor folders: a minified file inside one is a library release, not the plugin's source. */
const VENDOR_DIR = /(^|\/)(lib|libs|vendor|vendors|third[-_]?party|external)\//i;
// esbuild emits "// node_modules/pkg/file.js" before each module in unminified output;
// webpack keys modules as "./node_modules/pkg/...".
// esbuild indents these inside its IIFE wrapper, so allow leading whitespace.
// Any bundled source type ends the previous module's region, so a plugin's own template
// (`// content/report.pug`) isn't attributed to the library bundled before it.
const SECTION_MARKER =
  /^[ \t]*\/\/ ((?:\.\.\/)*[\w@+./-]+\.(?:m?js|cjs|mts|cts|ts|tsx|jsx|json|vue|svelte|pug|jade|html?|xhtml|css|scss|sass|less|styl|md|txt|svg|ftl|ya?ml|wasm|properties))[ \t]*$|["'](\.\/node_modules\/[^"']+)["']\s*:/gm;

export type LibraryEvidence = "banner" | "file-name" | "package-json" | "hash";

export interface Region {
  start: number;
  end: number;
  library: string;
}

/** Files over this size aren't fingerprinted: code in them is the plugin's own. */
const MAX_FINGERPRINT_CHARS = 8 * 1024 * 1024;
/** A library is in a file when this many of the file's distinct specific calls are its… */
const IDENTIFY_MIN_CALLS = 25;
/** …and they are at least this share of those calls. */
const IDENTIFY_MIN_SHARE = 0.15;
/** A function is a library's when this share of its calls (at least three) are. */
const FUNCTION_MATCH_SHARE = 0.8;
/** Failures kept per library and file; the report shows ten. */
const UNMATCHED_KEPT = 200;

/** How a file's calls match one library's release, as counts per function. */
interface LibraryStats {
  /** Per call: it, and every string in it, is in the release. */
  ok: Uint8Array;
  /** Per function (index + 1; slot 0 is the top level): calls directly in it, and matching ones. */
  calls: Int32Array;
  matching: Int32Array;
  /** The same, counting the functions inside each one too. */
  nestedCalls: Int32Array;
  nestedMatching: Int32Array;
}

export type LibraryMatch = "release" | "partial" | "not-in-catalogue";

export class SourceFile {
  readonly lineStarts: number[] = [0];
  readonly vendoredFile: string | null;
  readonly vendoredBy: LibraryEvidence | null;
  readonly regions: Region[];
  private calls: CallRecord[] = [];
  private literals: LiteralRecord[] = [];
  private fns: FnRecord[] = [];
  /** Hashes of the calls, filled in as they're needed. */
  private hashes: (string | undefined)[] = [];
  private identifiedLibraries: string[] | null = null;
  private stats = new Map<string, LibraryStats>();
  private memo = new Map<number, string | null>();
  private failed = new Map<string, number[]>();

  constructor(
    readonly path: string,
    readonly text: string,
    private readonly index: LibraryIndex = EMPTY_INDEX,
  ) {
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    const lib = detectVendoredFile(path, text);
    this.vendoredFile = lib?.name ?? null;
    this.vendoredBy = lib?.by ?? null;
    this.regions = this.vendoredFile ? [] : detectRegions(text);
  }

  lineCol(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.lineStarts[lo] ?? 0) };
  }

  /**
   * Records the calls and strings of a parsed script, so a claim that code is a library's can be
   * checked against that library's release. `base` is where the script starts in the file; a
   * file can have several. Without it the claim can't be checked and the code counts as the
   * plugin's own.
   */
  attachAst(ast: AcornNode, base: number): void {
    if (this.index.calls.size === 0 || this.text.length > MAX_FINGERPRINT_CHARS) return;
    let found: ReturnType<typeof collect>;
    try {
      found = collect(ast, base);
    } catch {
      // A tree too deep to walk: leave the file unchecked.
      return;
    }
    const callsBefore = this.calls.length;
    const fnsBefore = this.fns.length;
    for (const c of found.calls) {
      if (c.parent >= 0) c.parent += callsBefore;
      if (c.fn >= 0) c.fn += fnsBefore;
      this.calls.push(c);
    }
    for (const f of found.fns) {
      if (f.parent >= 0) f.parent += fnsBefore;
      this.fns.push(f);
    }
    for (const l of found.literals) {
      if (l.fn >= 0) l.fn += fnsBefore;
      this.literals.push(l);
    }
    this.identifiedLibraries = null;
    this.stats.clear();
    this.memo.clear();
    this.failed.clear();
  }

  /** Libraries in the catalogue whose calls make up a real share of this file. */
  identified(): string[] {
    if (this.identifiedLibraries) return this.identifiedLibraries;
    const found: string[] = [];
    const specific = this.calls.filter((c) => c.specific);
    if (specific.length >= IDENTIFY_MIN_CALLS) {
      const distinct = new Set<string>();
      for (const c of specific) distinct.add(hashKey(c.key));
      const counts = new Map<string, number>();
      for (const h of distinct)
        for (const lib of this.index.calls.get(h) ?? [])
          counts.set(lib, (counts.get(lib) ?? 0) + 1);
      for (const [lib, n] of counts)
        if (n >= IDENTIFY_MIN_CALLS && n / distinct.size >= IDENTIFY_MIN_SHARE) found.push(lib);
    }
    this.identifiedLibraries = found.sort();
    return this.identifiedLibraries;
  }

  /** What the file's name or markers say the code at `offset` is, before any checking. */
  private claimAt(offset: number): string | null {
    if (this.vendoredFile) return this.vendoredFile;
    for (const r of this.regions) if (offset >= r.start && offset < r.end) return r.library;
    return null;
  }

  /**
   * The library the code at `offset` belongs to, or null when it's the plugin's own. A library in
   * the catalogue counts only where the call (or string) there is one the official release has;
   * anything else is the plugin's code, however the file is named. A library not in the
   * catalogue is taken on its name.
   */
  libraryAt(offset: number, record = true): string | null {
    const known = this.memo.get(offset);
    if (known !== undefined) return known;
    // A question that isn't about a finding (is the file as a whole a library?) leaves no trace.
    if (!record) return this.resolve(offset, false);
    const lib = this.resolve(offset, true);
    this.memo.set(offset, lib);
    return lib;
  }

  private resolve(offset: number, record: boolean): string | null {
    const claim = this.claimAt(offset);
    if (this.index.calls.size === 0) return claim;
    const claimed = claim ? this.index.aliasOf(claim) : null;
    if (claim && claimed && !this.index.has(claimed)) return claim;
    const candidates = new Set(this.identified());
    if (claimed) candidates.add(claimed);
    for (const lib of candidates) if (this.matches(lib, offset)) return lib;
    // Between statements isn't a place worth a person's look, unless a file name or marker
    // put the library there.
    if (record && (claim !== null || this.inCode(offset)))
      for (const lib of candidates) {
        const list = this.failed.get(lib) ?? [];
        if (list.length < UNMATCHED_KEPT) list.push(offset);
        this.failed.set(lib, list);
      }
    return null;
  }

  private hashOf(i: number): string {
    let h = this.hashes[i];
    if (h === undefined) {
      h = hashKey((this.calls[i] as CallRecord).key);
      this.hashes[i] = h;
    }
    return h;
  }

  private statsFor(lib: string): LibraryStats {
    const cached = this.stats.get(lib);
    if (cached) return cached;
    const stats: LibraryStats = {
      ok: new Uint8Array(this.calls.length),
      calls: new Int32Array(this.fns.length + 1),
      matching: new Int32Array(this.fns.length + 1),
      nestedCalls: new Int32Array(this.fns.length + 1),
      nestedMatching: new Int32Array(this.fns.length + 1),
    };
    for (let i = 0; i < this.calls.length; i++) {
      const c = this.calls[i] as CallRecord;
      const ok = this.callIsIn(lib, i, c);
      stats.ok[i] = ok ? 1 : 0;
      (stats.calls[c.fn + 1] as number)++;
      if (ok) (stats.matching[c.fn + 1] as number)++;
    }
    // A function's parent always comes before it, so one pass from the end adds each up.
    stats.nestedCalls.set(stats.calls);
    stats.nestedMatching.set(stats.matching);
    for (let f = this.fns.length - 1; f >= 0; f--) {
      const parent = (this.fns[f] as FnRecord).parent + 1;
      (stats.nestedCalls[parent] as number) += stats.nestedCalls[f + 1] as number;
      (stats.nestedMatching[parent] as number) += stats.nestedMatching[f + 1] as number;
    }
    this.stats.set(lib, stats);
    return stats;
  }

  private callIsIn(lib: string, i: number, c: CallRecord): boolean {
    if (!this.index.calls.get(this.hashOf(i))?.includes(lib)) return false;
    return c.literals.every((s) => this.index.literals.get(hashKey(s))?.includes(lib));
  }

  /**
   * Whether a function is mostly the library's calls. With `nested`, the calls in the functions
   * inside it count too; the top level (-1) always means the whole file.
   */
  private mostlyIn(stats: LibraryStats, fn: number, nested = false): boolean {
    const all = nested || fn < 0;
    const calls = (all ? stats.nestedCalls : stats.calls)[fn + 1] as number;
    const matching = (all ? stats.nestedMatching : stats.matching)[fn + 1] as number;
    return calls >= 3 && matching / calls >= FUNCTION_MATCH_SHARE;
  }

  /** The innermost record open at `offset`: the last one starting before it, climbing out of siblings. */
  private innermost(
    list: { start: number; end: number; parent: number }[],
    offset: number,
  ): number {
    let lo = 0;
    let hi = list.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as { start: number }).start <= offset) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    while (at >= 0 && (list[at] as { end: number }).end <= offset)
      at = (list[at] as { parent: number }).parent;
    return at;
  }

  /**
   * The call the code at `offset` is part of (-1 for none) and the function it sits in. A function
   * passed to a library call has the plugin's code in it, and shows as just `fn` in the call's
   * key: only a call inside the body counts as the place.
   */
  private place(offset: number): { call: number; fn: number } {
    const call = this.innermost(this.calls, offset);
    const fn = this.innermost(this.fns, offset);
    const inCallback =
      call >= 0 &&
      fn >= 0 &&
      (this.fns[fn] as FnRecord).start >= (this.calls[call] as CallRecord).start;
    return { call: inCallback ? -1 : call, fn };
  }

  private inCode(offset: number): boolean {
    return this.place(offset).call >= 0 || this.literalAt(offset) !== null;
  }

  private literalAt(offset: number): LiteralRecord | null {
    let lo = 0;
    let hi = this.literals.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.literals[mid] as LiteralRecord).start <= offset) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const l = this.literals[at];
    return l && offset < l.end ? l : null;
  }

  /** Whether the code at `offset` is the release of `lib`: a call or string it has, in code that is mostly its own. */
  private matches(lib: string, offset: number): boolean {
    if (this.calls.length === 0 && this.literals.length === 0) return false;
    const stats = this.statsFor(lib);
    const { call, fn } = this.place(offset);
    if (call >= 0) {
      const c = this.calls[call] as CallRecord;
      if (!stats.ok[call]) return false;
      if (c.specific) return true;
      // `Zotero.Prefs.get(x)` starts where `Zotero.Prefs` does: a call that is part of a specific
      // one around it (outside any callback) was checked along with it.
      for (let a = c.parent; a >= 0; a = (this.calls[a] as CallRecord).parent) {
        const outer = this.calls[a] as CallRecord;
        if (outer.fn !== c.fn) break;
        if (outer.specific && stats.ok[a]) return true;
      }
      return c.fn >= 0 && this.mostlyIn(stats, c.fn);
    }
    const literal = this.literalAt(offset);
    if (literal) {
      return (
        (literal.group ?? [literal.value]).every((s) =>
          this.index.literals.get(hashKey(s))?.includes(lib),
        ) && this.mostlyIn(stats, literal.fn)
      );
    }
    // Between nodes (a statement, a declaration): in a function that is mostly the library's,
    // counting what is inside it, or at the top level in a file that is. A bundler's
    // `exports.X = void 0` is the kind of statement that has no call of its own to match.
    return this.mostlyIn(stats, fn, true);
  }

  /**
   * Each library claimed in this file with how the claim held up, and where it didn't (file
   * offsets). A library recognised by name alone, outside the catalogue, isn't checked.
   */
  libraryReport(): Map<string, { match: LibraryMatch; unmatched: number[] }> {
    const report = new Map<string, { match: LibraryMatch; unmatched: number[] }>();
    const claims = [this.vendoredFile, ...this.regions.map((r) => r.library)];
    for (const claim of claims) {
      if (!claim) continue;
      const npm = this.index.aliasOf(claim);
      if (this.index.calls.size === 0 || !this.index.has(npm))
        report.set(claim, { match: "not-in-catalogue", unmatched: [] });
      else report.set(npm, { match: "release", unmatched: [] });
    }
    if (this.index.calls.size > 0)
      for (const lib of this.identified()) report.set(lib, { match: "release", unmatched: [] });
    for (const [lib, entry] of report) {
      const offsets = this.failed.get(lib);
      if (entry.match === "release" && offsets?.length)
        report.set(lib, { match: "partial", unmatched: [...offsets].sort((a, b) => a - b) });
    }
    return report;
  }

  evidence(offset: number): CodeEvidence {
    const { line, column } = this.lineCol(offset);
    const lineStart = this.lineStarts[line - 1] ?? 0;
    const nextLine = this.lineStarts[line] ?? this.text.length + 1;
    const lineText = this.text.slice(lineStart, nextLine - 1);
    const from = Math.max(0, column - 80);
    let snippet = lineText
      .slice(from, from + 200)
      .replace(/\s+/g, " ")
      .trim();
    if (!snippet) snippet = "(whitespace)";
    return {
      kind: "code",
      file: this.path,
      line,
      column,
      snippet: redactSecrets(snippet).slice(0, 300),
      inVendoredCode: this.libraryAt(offset) !== null,
    };
  }

  /**
   * Average line length above 500 characters, or any line above 5,000, in a file over 5 KB. Only
   * the plugin's own code counts, and only lines that look like code: a bundle with a 16 KB inlined
   * SVG or a language-trigram table is still readable (review: zotero-pick2anki, papermachines).
   */
  get minified(): boolean {
    if (this.text.length < 5000) return false;
    const avg = this.text.length / this.lineStarts.length;
    if (avg > 500 && someLooksLikeCode(this.text, 0, this.text.length)) return true;
    for (let i = 0; i < this.lineStarts.length; i++) {
      const start = this.lineStarts[i] ?? 0;
      const end = this.lineStarts[i + 1] ?? this.text.length;
      if (end - start <= 5000 || this.libraryAt(start, false) !== null) continue;
      if (someLooksLikeCode(this.text, start, end)) return true;
    }
    return false;
  }
}

/**
 * Samples up to ten 200 KB windows spread across the range: a 2.5 MB one-line bundle can open
 * with a tokenizer's string tables and only then reach its code (zotero-gpt forks).
 */
function someLooksLikeCode(text: string, start: number, end: number): boolean {
  const size = 200_000;
  const windows = Math.min(10, Math.max(1, Math.ceil((end - start) / size)));
  const step = windows > 1 ? (end - start - size) / (windows - 1) : 0;
  for (let w = 0; w < windows; w++) {
    const from = start + Math.floor(step * w);
    if (looksLikeCode(text.slice(from, Math.min(end, from + size)))) return true;
  }
  return false;
}

/**
 * Code rather than data: under 60% of the characters inside string literals, and statement
 * punctuation (`; ( ) { } =`) at more than 2% of them. Minified code runs around 8%; a table of
 * numbers or strings is near zero.
 */
export function looksLikeCode(s: string): boolean {
  let quoted = 0;
  let punct = 0;
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      quoted++;
      if (c === "\\") {
        i++;
        quoted++;
      } else if (c === q || (c === "\n" && q !== "`")) q = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === ";" || c === "(" || c === ")" || c === "{" || c === "}" || c === "=") punct++;
  }
  return quoted / s.length < 0.6 && punct / s.length > 0.02;
}

function libraryFromBanner(text: string): string | null {
  const head = text.slice(0, 600);
  if (!/^\s*(\/\*!|\/\*\*?\s*@license|\/\*[\s*]*(?:@preserve|Copyright|License))/i.test(head))
    return null;
  for (const [re, name] of KNOWN_LIBS) if (re.test(head)) return name;
  return null;
}

/**
 * A whole file that is a known library: by its file name, a library banner, or a release-style
 * name. A file under lib/ or vendor/ with none of these is the plugin's own code (review P2).
 */
function detectVendoredFile(
  path: string,
  text: string,
): { name: string; by: LibraryEvidence } | null {
  const m = path.match(VENDORED_FILE);
  if (m?.[2]) {
    const name = m[2].toLowerCase().replace(/\.worker$/, "");
    return {
      name: name === "pdf" ? "pdf.js" : name === "dx" ? "devextreme" : name,
      by: "file-name",
    };
  }
  const banner = libraryFromBanner(text);
  if (banner) return { name: banner, by: "banner" };
  const dir = path.match(LIB_DIR);
  if (dir?.[2]) return { name: dir[2].toLowerCase().replace(/[-_].*$/, ""), by: "file-name" };
  if (VENDOR_DIR.test(path) && /\.min\.m?js$/i.test(path)) {
    const base = path.split("/").at(-1) ?? path;
    return { name: base.replace(/(\.umd)?\.min\.m?js$/i, ""), by: "file-name" };
  }
  if (RELEASE_FILE.test(path)) {
    const base = path.split("/").at(-1) ?? path;
    return { name: base.replace(/(\.production|[-.]\d+\.\d+\.\d+).*$/i, ""), by: "file-name" };
  }
  if (NODE_MODULES_PATH.test(path)) {
    return { name: packageName(path), by: "package-json" };
  }
  return null;
}

function packageName(modulePath: string): string {
  const after = modulePath.split("node_modules/").at(-1) ?? modulePath;
  // Yarn Berry's store: `.store/zotero-plugin-toolkit-npm-5.2.0-a1b2c3/package/…`,
  // `.store/@scope-name-npm-1.0.0-…/package/…`.
  const store = after.match(/^\.store\/(@?[^/]+?)-npm-\d[^/]*\/package\//);
  if (store?.[1])
    return store[1].startsWith("@") ? store[1].replace(/^(@[^-]+)-/, "$1/") : store[1];
  const parts = after.split("/");
  return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : (parts[0] ?? after);
}

/** A library checked out next to the plugin: `// ../zotero-plugin-toolkit/dist/basic.js`. */
const SIBLING_PACKAGE = /^(?:\.\.\/)+([\w@.-]+)\/(?:dist|lib|build|esm|cjs|es)\//;
/** esbuild's minified module wrappers: `__commonJS({"node_modules/pkg/x.js"(e){…}})`. */
const ESBUILD_MODULE = /["'](node_modules\/[^"']+?\.(?:m?js|cjs|json))["']\s*\([\w$,\s]*\)\s*\{/g;

function detectRegions(text: string): Region[] {
  const markers: { at: number; vendored: string | null }[] = [];
  for (const m of text.matchAll(SECTION_MARKER)) {
    const p = m[1] ?? m[2] ?? "";
    markers.push({
      at: m.index ?? 0,
      vendored: p.includes("node_modules/")
        ? packageName(p)
        : (p.match(SIBLING_PACKAGE)?.[1] ?? null),
    });
  }
  const regions: Region[] = [];
  markers.forEach((mk, i) => {
    if (!mk.vendored) return;
    regions.push({ start: mk.at, end: markers[i + 1]?.at ?? text.length, library: mk.vendored });
  });
  // Minified bundles have no comment markers: a wrapper's region ends at its closing brace, so
  // the plugin's own code after the last library module isn't attributed to it. Only when the
  // brace closes the wrapper (`}})`, or the next module's key): a regex or nested template can
  // throw the count off, and then the region isn't used (a stretched one swallowed
  // llm-for-zotero-batch-process's own download code).
  if (!markers.length)
    for (const m of text.matchAll(ESBUILD_MODULE)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = matchingBrace(text, open);
      if (
        close > open &&
        /^\s*(?:\}\s*\)|,\s*["']node_modules\/)/.test(text.slice(close + 1, close + 40))
      )
        regions.push({ start: m.index ?? 0, end: close + 1, library: packageName(m[1] ?? "") });
    }
  return regions;
}

/**
 * The `}` that closes the `{` at `open`, skipping strings, template text and escaped characters;
 * -1 when it isn't found within 2 MB (then the region isn't recorded, which is the safe side).
 */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  const end = Math.min(text.length, open + 2_000_000);
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Keys a plugin hard-codes are quoted in our evidence, which is published (site, /api, the public
 * repo). Replace anything shaped like a credential so we never republish someone's key; the
 * analysis itself still runs on the raw text.
 */
const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, // OpenAI-style keys (also DeepSeek, SiliconFlow, Moonshot...)
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key IDs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];
/** A long opaque string assigned to something named like a key, secret, token or password. */
const ASSIGNED_SECRET =
  /((?:api_?key|apikey|app_?key|app_?secret|secret(?:_?key)?|access_?token|auth_?token|password)["']?\s*[:=]\s*\\?["'`])([A-Za-z0-9_\-+/=.]{20,})/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted key]");
  return out.replace(ASSIGNED_SECRET, "$1[redacted key]");
}
