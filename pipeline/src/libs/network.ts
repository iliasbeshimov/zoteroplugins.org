import type { SourceFile } from "../scan/text.ts";
import type { NetworkDescriptor } from "./index.ts";
import type { AcornNode } from "./parse.ts";

/**
 * Works out what a bundled library sends, from its descriptor and the settings the plugin's own
 * code passes it. A library that is the unmodified release still sends wherever its settings say,
 * so "it's Vditor" alone can't tell us where.
 */

// biome-ignore lint/suspicious/noExplicitAny: a syntax tree walked by field name, as in ESTree
type Node = AcornNode & { [key: string]: any };

export type OptionState = "off" | "local" | "remote" | "unknown";
export type FixedState = "active" | "missing-asset" | "unknown";

interface Binding {
  count: number;
  init?: Node;
}
interface Scope {
  names: Map<string, Binding>;
}

/** A configuration object found in the plugin's own code, with the scopes around it. */
export interface Config {
  file: SourceFile;
  node: Node;
  /** Innermost scope last. */
  scopes: Scope[];
  /** Names assigned after their declaration, anywhere in the file: those aren't constants. */
  assigned: Set<string>;
}

export interface LibraryNetwork {
  library: string;
  displayName: string;
  role: string;
  configFound: boolean;
  options: { path: string; state: OptionState; host?: string }[];
  fixed: { host: string; state: FixedState }[];
  userContent: { what: string; state: "on" | "off" }[];
}

/** A destination the plugin chose, or ships code that always sends to. */
export interface Destination {
  url: string;
  file: SourceFile;
  offset: number;
}

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).type === "string";

function declare(scope: Scope, name: string, init?: Node) {
  const b = scope.names.get(name) ?? { count: 0 };
  b.count++;
  if (init) b.init = init;
  scope.names.set(name, b);
}

/** Every name a pattern binds (`{ a, b: [c] }`), none of them with a value we can follow. */
function patternNames(p: Node | null | undefined, out: string[] = []): string[] {
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern")
    for (const x of p.properties)
      patternNames(x.type === "RestElement" ? x.argument : x.value, out);
  else if (p.type === "ArrayPattern") for (const x of p.elements) patternNames(x, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  return out;
}

const keyName = (p: Node): string | null => {
  if (p.type !== "Property" || p.computed) return null;
  if (p.key.type === "Identifier") return p.key.name;
  if (p.key.type === "Literal" && typeof p.key.value === "string") return p.key.value;
  return null;
};

/** The calls a function makes itself, not counting the functions inside it. */
function directCalls(root: Node, limit = 200): Node[] {
  const out: Node[] = [];
  const visit = (node: Node) => {
    if (out.length >= limit) return;
    if (node.type === "CallExpression" || node.type === "NewExpression") out.push(node);
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c) && !FUNCTIONS.has(c.type)) visit(c);
      } else if (isNode(v) && !FUNCTIONS.has(v.type)) visit(v);
    }
  };
  visit(root);
  return out;
}

/**
 * Objects in the plugin's own code whose keys include enough of the library's setting names to be
 * what it passes to the library. The library's own defaults object looks the same, and can pass
 * for the plugin's when the function around it has too few calls to be recognised as the
 * library's, so an object in a function that makes calls the release makes is the library's. An
 * object inside another match is a part of it, not a second configuration.
 */
export function findConfigs(
  file: SourceFile,
  ast: AcornNode,
  descriptor: NetworkDescriptor,
  own: (offset: number) => boolean,
): Config[] {
  const wanted = new Set(descriptor.configKeys);
  const found: (Config & { around: Node })[] = [];
  const assigned = new Set<string>();
  const root: Scope = { names: new Map() };
  const walk = (node: Node, stack: Scope[], around: Node) => {
    let scopes = stack;
    let inside = around;
    if (FUNCTIONS.has(node.type)) {
      const inner: Scope = { names: new Map() };
      // A declaration's name belongs to the scope around it; an expression's to its own.
      if (node.id && node.type === "FunctionDeclaration")
        declare(stack.at(-1) as Scope, node.id.name);
      else if (node.id) declare(inner, node.id.name);
      for (const p of node.params) for (const n of patternNames(p)) declare(inner, n);
      scopes = [...stack, inner];
      inside = node;
    } else if (node.type === "VariableDeclarator") {
      const top = stack.at(-1) as Scope;
      if (node.id.type === "Identifier") declare(top, node.id.name, node.init ?? undefined);
      else for (const n of patternNames(node.id)) declare(top, n);
    } else if (node.type === "CatchClause" || node.type === "ClassDeclaration") {
      const top = stack.at(-1) as Scope;
      for (const n of patternNames(node.type === "CatchClause" ? node.param : node.id))
        declare(top, n);
    } else if (node.type === "AssignmentExpression") {
      for (const n of patternNames(node.left)) assigned.add(n);
    } else if (node.type === "ObjectExpression") {
      const keys = new Set<string>();
      for (const p of node.properties) {
        const k = keyName(p);
        if (k && wanted.has(k)) keys.add(k);
      }
      // A third of its keys at least: the library's language files are objects with a few of the
      // same words among hundreds of others.
      if (
        keys.size >= descriptor.minConfigKeys &&
        keys.size * 3 >= node.properties.length &&
        own(node.start)
      )
        found.push({ file, node, scopes: stack, assigned, around });
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) walk(c, scopes, inside);
      } else if (isNode(v)) walk(v, scopes, inside);
    }
  };
  try {
    walk(ast as Node, [root], ast as Node);
  } catch {
    // A tree too deep to walk: no configuration found, so the defaults apply.
    return [];
  }
  const plugins = found.filter((c) => !directCalls(c.around).some((call) => !own(call.start)));
  return plugins
    .filter(
      (c) =>
        !plugins.some((o) => o !== c && o.node.start <= c.node.start && c.node.end <= o.node.end),
    )
    .map(({ around: _around, ...config }) => config);
}

type Found =
  | { kind: "absent" }
  | { kind: "unknown" }
  | { kind: "node"; node: Node; scopes: Scope[]; at: number };

/** The value an identifier is bound to, when it is bound once and never assigned again. */
function follow(
  node: Node,
  scopes: Scope[],
  assigned: Set<string>,
): { node: Node; scopes: Scope[] } | null {
  let current = node;
  let chain = scopes;
  for (let i = 0; i < 5; i++) {
    if (current.type !== "Identifier") return { node: current, scopes: chain };
    let next: { node: Node; scopes: Scope[] } | null = null;
    for (let s = chain.length - 1; s >= 0; s--) {
      const b = chain[s]?.names.get(current.name);
      if (!b) continue;
      if (b.count === 1 && b.init && !assigned.has(current.name))
        next = { node: b.init, scopes: chain.slice(0, s + 1) };
      break;
    }
    if (!next) return null;
    current = next.node;
    chain = next.scopes;
  }
  return null;
}

/** A string the code spells out: a literal, a template, or a name bound once to either. */
function text(node: Node, scopes: Scope[], assigned: Set<string>): string | null {
  const v = follow(node, scopes, assigned);
  if (!v) return null;
  if (v.node.type === "Literal") return typeof v.node.value === "string" ? v.node.value : null;
  if (v.node.type !== "TemplateLiteral") return null;
  let out = "";
  for (let i = 0; i < v.node.quasis.length; i++) {
    out += v.node.quasis[i].value.cooked ?? "";
    const e = v.node.expressions[i];
    if (e) {
      const part = text(e, v.scopes, assigned);
      if (part === null) return null;
      out += part;
    }
  }
  return out;
}

function lookup(config: Config, path: string): Found {
  let obj: Node = config.node;
  let scopes = config.scopes;
  const segments = path.split(".");
  for (const [i, seg] of segments.entries()) {
    const props = obj.properties as Node[];
    const prop = [...props].reverse().find((p) => keyName(p) === seg);
    if (!prop) {
      // A spread or a computed key may carry it.
      return props.some((p) => p.type === "SpreadElement" || p.computed)
        ? { kind: "unknown" }
        : { kind: "absent" };
    }
    if (i === segments.length - 1)
      return { kind: "node", node: prop.value, scopes, at: prop.start };
    const inner = follow(prop.value, scopes, config.assigned);
    if (inner?.node.type !== "ObjectExpression") return { kind: "unknown" };
    obj = inner.node;
    scopes = inner.scopes;
  }
  return { kind: "unknown" };
}

/** `false`, or the `!1` a minifier writes for it. */
const isFalse = (n: Node) =>
  (n.type === "Literal" && n.value === false) ||
  (n.type === "UnaryExpression" &&
    n.operator === "!" &&
    n.argument.type === "Literal" &&
    n.argument.value === 1);

const LOCAL = /^(resource|chrome|moz-extension|file|jar):/i;

/** Where an address leads: nowhere, somewhere inside the xpi or this computer, or a host. */
export function classify(value: string): { state: OptionState; host?: string } {
  if (value === "") return { state: "off" };
  if (LOCAL.test(value)) return { state: "local" };
  if (/^(https?:)?\/\//i.test(value)) {
    try {
      const host = new URL(value.startsWith("//") ? `https:${value}` : value).hostname;
      if (host) return { state: "remote", host };
    } catch {
      // Not an address after all.
    }
    return { state: "unknown" };
  }
  // A relative path is inside the page that loads it.
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? { state: "unknown" } : { state: "local" };
}

const RANK: Record<OptionState, number> = { off: 0, local: 1, remote: 2, unknown: 3 };

interface Resolved {
  state: OptionState;
  host?: string;
  /** The address, where it's a remote one. */
  url?: string;
  /** Where the setting is written, or the object that leaves it out. */
  at: number;
}

/** One option in one configuration object. */
function resolveOption(
  config: Config,
  descriptor: NetworkDescriptor,
  path: string,
  memo: Map<string, string | null>,
): Resolved {
  const option = descriptor.options.find(
    (o) => o.path === path,
  ) as NetworkDescriptor["options"][number];
  const own = lookup(config, path);
  const at = own.kind === "node" ? own.at : config.node.start;
  for (const other of option.unlessSet ?? [])
    if (lookup(config, other).kind === "node") return { state: "off", at };
  let value: string | null;
  if (own.kind === "node") value = text(own.node, own.scopes, config.assigned);
  else if (own.kind === "absent") value = defaultOf(config, descriptor, option, memo);
  else value = null;
  if (value === null) return { state: "unknown", at };
  const c = classify(value);
  return { ...c, ...(c.state === "remote" ? { url: value } : {}), at };
}

/** An option's default, with `{cdn}` and `{version}` filled in; null when the cdn can't be read. */
function defaultOf(
  config: Config,
  descriptor: NetworkDescriptor,
  option: NetworkDescriptor["options"][number],
  memo: Map<string, string | null>,
): string | null {
  let out = option.default.replaceAll("{version}", "*");
  if (out.includes("{cdn}")) {
    if (!memo.has("cdn")) {
      const cdn = lookup(config, "cdn");
      const spec = descriptor.options.find((o) => o.path === "cdn");
      memo.set(
        "cdn",
        cdn.kind === "node"
          ? text(cdn.node, cdn.scopes, config.assigned)
          : cdn.kind === "absent" && spec
            ? spec.default.replaceAll("{version}", "*")
            : null,
      );
    }
    const cdn = memo.get("cdn");
    if (cdn === null || cdn === undefined) return null;
    out = out.replaceAll("{cdn}", cdn);
  }
  return out;
}

/** Offsets of a string in the code of one library, at most a few. */
function inLibrary(files: SourceFile[], library: string, needle: string) {
  for (const file of files) {
    if (!file.text.includes(needle)) continue;
    for (let at = file.text.indexOf(needle); at >= 0; at = file.text.indexOf(needle, at + 1))
      if (file.libraryAt(at, false) === library) return { file, offset: at };
  }
  return null;
}

/**
 * What one library sends in this plugin: each address setting (from the configuration objects
 * found, or the defaults when there are none), the destinations no setting turns off, and the
 * loads that follow the user's own content. Null when the library isn't really there: a
 * package that ships others inside it (Vditor's has mermaid and katex) is "found" by their calls
 * alone, so it counts only when its own code is, shown by an address only it spells out.
 */
export function resolveNetwork(
  library: string,
  descriptor: NetworkDescriptor,
  configs: Config[],
  files: SourceFile[],
  xpiPaths: string[],
): { entry: LibraryNetwork; destinations: Destination[]; quiet: boolean } | null {
  const literals = [
    ...descriptor.fixed.map((f) => f.literal),
    ...descriptor.userContent.map((u) => u.literal),
  ];
  const there = literals.length
    ? literals.some((l) => inLibrary(files, library, l))
    : configs.length > 0;
  if (!there) return null;
  const destinations: Destination[] = [];
  const seen = new Set<string>();
  const addDestination = (url: string, file: SourceFile, offset: number) => {
    const key = `${url}|${file.path}|${offset}`;
    if (seen.has(key)) return;
    seen.add(key);
    destinations.push({ url, file, offset });
  };
  // Without a configuration every setting has its default; the evidence is the library's own
  // mention of the address, since the plugin wrote nothing.
  const defaultsAt = (host: string) =>
    inLibrary(files, library, host) ?? {
      file: files.find((f) => f.identified().includes(library)) ?? (files[0] as SourceFile),
      offset: 0,
    };

  const none: Config = {
    file: files[0] as SourceFile,
    node: EMPTY_OBJECT,
    scopes: [],
    assigned: new Set(),
  };
  const options: LibraryNetwork["options"] = [];
  for (const option of descriptor.options) {
    let state: OptionState = "off";
    let host: string | undefined;
    // With no configuration the plugin wrote nothing, so there is no file to point at.
    const results = (configs.length ? configs : [none]).map((config) => ({
      r: resolveOption(config, descriptor, option.path, new Map()),
      file: configs.length ? config.file : null,
    }));
    for (const { r, file } of results) {
      if (RANK[r.state] > RANK[state]) state = r.state;
      if (r.state !== "remote" || !r.url) continue;
      host ??= r.host;
      if (file) addDestination(r.url, file, r.at);
      else {
        const where = defaultsAt(r.host ?? "");
        addDestination(r.url, where.file, where.offset);
      }
    }
    options.push({ path: option.path, state, ...(state === "remote" && host ? { host } : {}) });
  }

  const cdn = options.find((o) => o.path === "cdn")?.state;
  const fixed: LibraryNetwork["fixed"] = [];
  for (const f of descriptor.fixed) {
    const at = inLibrary(files, library, f.literal);
    if (!at) continue;
    const asset = f.needsAsset;
    const shipped = asset ? xpiPaths.some((p) => p === asset || p.endsWith(`/${asset}`)) : true;
    const state: FixedState =
      cdn === "remote"
        ? "active"
        : cdn === "local"
          ? shipped
            ? "active"
            : "missing-asset"
          : "unknown";
    fixed.push({ host: f.host, state });
    if (state === "active") addDestination(f.literal, at.file, at.offset);
  }

  const userContent: LibraryNetwork["userContent"] = [];
  for (const u of descriptor.userContent) {
    if (!inLibrary(files, library, u.literal)) continue;
    const turnedOff =
      u.unlessFalse !== undefined &&
      configs.length > 0 &&
      configs.every((config) => {
        const v = lookup(config, u.unlessFalse as string);
        return v.kind === "node" && isFalse(v.node);
      });
    userContent.push({ what: u.what, state: turnedOff ? "off" : "on" });
  }

  return {
    entry: {
      library,
      displayName: descriptor.displayName,
      role: descriptor.role,
      configFound: configs.length > 0,
      options,
      fixed,
      userContent,
    },
    destinations,
    quiet: options.every((o) => o.state === "off" || o.state === "local"),
  };
}

const EMPTY_OBJECT = { type: "ObjectExpression", start: 0, end: 0, properties: [] } as Node;
