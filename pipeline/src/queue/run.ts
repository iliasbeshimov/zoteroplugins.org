import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildQueue, KINDS, type QueueState } from "./build.ts";
import { queueMarkdown } from "./report.ts";

/** Writes queue.json, queue.md and the label snapshot (queue-state.json) into `out`. */
export async function runQueue(opts: { out: string; dataDir: string; now?: Date }) {
  let previous: QueueState | null = null;
  try {
    previous = JSON.parse(await readFile(join(opts.out, "queue-state.json"), "utf8"));
  } catch {
    // First run: there is no earlier snapshot to compare grades with.
  }
  const { queue, state } = await buildQueue({
    dataDir: opts.dataDir,
    previous,
    now: opts.now ?? new Date(),
  });
  await mkdir(opts.out, { recursive: true });
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  await writeFile(join(opts.out, "queue.json"), json(queue));
  await writeFile(join(opts.out, "queue.md"), queueMarkdown(queue));
  await writeFile(join(opts.out, "queue-state.json"), json(state));
  console.log(KINDS.map((k) => `${k} ${queue.counts[k]}`).join(", "));
  return queue;
}
