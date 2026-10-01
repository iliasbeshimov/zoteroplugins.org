import { parse } from "acorn";

export type AcornNode = { type: string; start: number; end: number; [key: string]: unknown };

/** Parses a script the way Zotero loads one: as a classic script first, then as a module. */
export function parseJs(code: string): AcornNode {
  try {
    return parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowHashBang: true,
      allowReserved: true,
    }) as unknown as AcornNode;
  } catch {
    return parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
    }) as unknown as AcornNode;
  }
}
