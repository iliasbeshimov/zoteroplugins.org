import { listZipEntries, readZipEntry } from "../census/xpi.ts";
import type { XpiEntry } from "./analyze.ts";

/** Every file in an .xpi (a zip), with its bytes; a file that can't be read comes back empty. */
export async function unzip(bytes: Uint8Array): Promise<XpiEntry[]> {
  const read = async (start: number, end: number) =>
    bytes.subarray(start, Math.min(end + 1, bytes.length));
  const entries = await listZipEntries(read, bytes.length);
  const out: XpiEntry[] = [];
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    try {
      out.push({ path: e.name, data: await readZipEntry(read, e) });
    } catch {
      out.push({ path: e.name, data: new Uint8Array() });
    }
  }
  return out;
}
