import { createHash } from "node:crypto";
import type { AcornNode } from "./parse.ts";

/**
 * Turns code into the pieces a library fingerprint is made of: one token string for each call and
 * each string literal. Two minifiers rewrite statements differently, so whole functions don't
 * match between builds of one library; a single call, with local names erased, does.
 */

/** Bump when a change here makes old keys stop matching: every reference file must be rebuilt. */
export const NORMALIZER_VERSION = 1;

// biome-ignore lint/suspicious/noExplicitAny: a syntax tree walked by field name, as in ESTree
type Node = AcornNode & { [key: string]: any };

export interface CallRecord {
  start: number;
  end: number;
  /** Index of the innermost call this one sits in, or -1. */
  parent: number;
  /** Index of the innermost function this call sits in, or -1. */
  fn: number;
  key: string;
  /** The key has enough names and strings to be one library's call and not a common idiom. */
  specific: boolean;
  /** String literals of 4 or more characters in the call, outside nested functions. */
  literals: string[];
}
export interface LiteralRecord {
  start: number;
  end: number;
  value: string;
  fn: number;
  /** For a piece of a template: the long pieces of the whole template, this one included. */
  group?: string[];
}
export interface FnRecord {
  start: number;
  end: number;
  /** The function this one sits in, or -1. */
  parent: number;
}
export interface Collected {
  calls: CallRecord[];
  literals: LiteralRecord[];
  fns: FnRecord[];
}

export const hashKey = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 12);

// Names a minifier can't rename, so they say what the code does.
const GLOBALS = new Set(
  "window document fetch XMLHttpRequest WebSocket EventSource Zotero Services ChromeUtils Components IOUtils PathUtils eval Function navigator location globalThis self importScripts Worker".split(
    " ",
  ),
);
const MAX_TOKENS = 400;
const MIN_STRING = 4;
const SKIP_KEYS = new Set(["type", "start", "end", "raw", "loc", "range"]);

const isFunction = (n: Node) =>
  n.type === "FunctionExpression" ||
  n.type === "ArrowFunctionExpression" ||
  n.type === "FunctionDeclaration";
const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).type === "string";
const isNumber = (n: Node) => n.type === "Literal" && typeof n.value === "number";
const isString = (n: Node) => n.type === "Literal" && typeof n.value === "string" && !n.regex;

/** `"ab" + "cd"` as one string, folded through any depth of `+`; null for anything else. */
function foldString(n: Node): string | null {
  if (isString(n)) return n.value as string;
  if (n.type !== "BinaryExpression" || n.operator !== "+") return null;
  const left = foldString(n.left);
  if (left === null) return null;
  const right = foldString(n.right);
  return right === null ? null : left + right;
}

/** A value known without running anything, which a minifier moves to the right of `==`. */
const literalLike = (n: Node) =>
  n.type === "Literal" ||
  (n.type === "UnaryExpression" && n.argument?.type === "Literal") ||
  (n.type === "Identifier" && n.name === "undefined");

// State of the call being described; describing never nests, so one set is enough.
let tokens: string[] = [];
let names = 0;
let strings = new Set<string>();
let cut = false;

function emit(token: string) {
  if (tokens.length >= MAX_TOKENS) cut = true;
  else tokens.push(token);
}

function emitString(value: string) {
  emit(`L:${JSON.stringify(value)}`);
  if (value.length >= MIN_STRING) {
    names++;
    strings.add(value);
  }
}

function walk(n: Node, key: string, parent: Node | null, root: boolean): void {
  if (tokens.length >= MAX_TOKENS) {
    cut = true;
    return;
  }
  switch (n.type) {
    case "Identifier": {
      const asName =
        parent !== null &&
        !parent.computed &&
        ((parent.type === "MemberExpression" && key === "property") ||
          (key === "key" &&
            (parent.type === "Property" ||
              parent.type === "MethodDefinition" ||
              parent.type === "PropertyDefinition")));
      if (asName) {
        emit(`.${n.name}`);
        names++;
      } else emit(GLOBALS.has(n.name) || n.name === "undefined" ? n.name : "$");
      return;
    }
    case "Literal": {
      if (n.regex) emit(`L:/${n.regex.pattern}/${n.regex.flags}`);
      else if (typeof n.bigint === "string") emit(`L:${n.bigint}n`);
      else if (typeof n.value === "string") emitString(n.value);
      else emit(`L:${JSON.stringify(n.value)}`);
      return;
    }
    case "TemplateElement": {
      const value = String(n.value?.cooked ?? n.value?.raw ?? "");
      emit(`T:${value}`);
      if (value.length >= MIN_STRING) {
        names++;
        strings.add(value);
      }
      return;
    }
    case "UnaryExpression": {
      const arg = n.argument as Node;
      const canonical =
        n.operator === "!" && isNumber(arg)
          ? arg.value
            ? "L:false"
            : "L:true"
          : n.operator === "void" && arg.type === "Literal"
            ? "undefined"
            : n.operator === "-" && isNumber(arg)
              ? `L:${JSON.stringify(-arg.value)}`
              : null;
      if (canonical === null) break;
      emit(canonical);
      return;
    }
    case "BinaryExpression": {
      const folded = foldString(n);
      if (folded !== null) {
        emitString(folded);
        return;
      }
      if (["==", "===", "!=", "!=="].includes(n.operator)) {
        const swap = literalLike(n.left) && !literalLike(n.right);
        emit(`BinaryExpression${n.operator}`);
        walk(swap ? n.right : n.left, swap ? "right" : "left", n, false);
        walk(swap ? n.left : n.right, swap ? "left" : "right", n, false);
        return;
      }
      break;
    }
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "FunctionDeclaration":
      if (root) break;
      emit("fn");
      return;
  }
  emit(n.type + (n.operator ?? ""));
  for (const k of Object.keys(n)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = n[k];
    if (Array.isArray(v)) {
      emit("[");
      for (const c of v) if (isNode(c)) walk(c, k, n, false);
      emit("]");
    } else if (isNode(v)) walk(v, k, n, false);
  }
}

/** The key, whether it is specific, and its string literals; the call itself is the root. */
function describe(call: Node): { key: string; specific: boolean; literals: string[] } {
  tokens = [];
  names = 0;
  strings = new Set();
  cut = false;
  walk(call, "", null, true);
  return {
    key: tokens.join(" ") + (cut ? "…" : ""),
    specific: names >= 3,
    literals: [...strings],
  };
}

/** The normalised token string of a call or `new` expression. */
export function callKey(node: AcornNode): string {
  return describe(node as Node).key;
}

/** Child nodes in source order (acorn lists a template's text before its expressions). */
function children(n: Node): Node[] {
  const out: Node[] = [];
  for (const k of Object.keys(n)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = n[k];
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) out.push(c);
    } else if (isNode(v)) out.push(v);
  }
  for (let i = 1; i < out.length; i++)
    if ((out[i] as Node).start < (out[i - 1] as Node).start) {
      out.sort((a, b) => a.start - b.start);
      break;
    }
  return out;
}

/**
 * Every call, string literal and function in a syntax tree, in source order. `base` is added to
 * the offsets, for a script that sits inside a larger file.
 */
export function collect(ast: AcornNode, base = 0): Collected {
  const out: Collected = { calls: [], literals: [], fns: [] };
  const visit = (n: Node, call: number, fn: number): void => {
    let nextCall = call;
    let nextFn = fn;
    if (isFunction(n)) {
      nextFn = out.fns.length;
      out.fns.push({ start: n.start + base, end: n.end + base, parent: fn });
    } else if (n.type === "CallExpression" || n.type === "NewExpression") {
      const d = describe(n);
      nextCall = out.calls.length;
      out.calls.push({
        start: n.start + base,
        end: n.end + base,
        parent: call,
        fn,
        key: d.key,
        specific: d.specific,
        literals: d.literals,
      });
    } else if (n.type === "BinaryExpression" || n.type === "Literal") {
      const value = foldString(n);
      if (value !== null) {
        if (value.length >= MIN_STRING)
          out.literals.push({ start: n.start + base, end: n.end + base, value, fn });
        return;
      }
    } else if (n.type === "TemplateLiteral") {
      const quasis = n.quasis as Node[];
      const texts = quasis.map((q) => String(q.value?.cooked ?? q.value?.raw ?? ""));
      const group = texts.filter((t) => t.length >= MIN_STRING);
      quasis.forEach((q, i) => {
        const value = texts[i] as string;
        // From the backtick (or `}`) before the text: that is where a finding in a template points.
        if (value.length >= MIN_STRING)
          out.literals.push({ start: q.start + base - 1, end: q.end + base, value, fn, group });
      });
      for (const e of n.expressions as Node[]) visit(e, call, fn);
      return;
    }
    for (const c of children(n)) visit(c, nextCall, nextFn);
  };
  visit(ast as Node, -1, -1);
  out.literals.sort((a, b) => a.start - b.start);
  return out;
}
