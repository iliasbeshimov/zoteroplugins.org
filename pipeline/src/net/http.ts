import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * fetch with retries on network errors, 5xx and rate limiting (429, or 403 with a retry-after or
 * exhausted-quota header). Waits as long as GitHub asks.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  retries = 4,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const limited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"));
    if ((limited || res.status >= 500) && attempt < retries) {
      await res.body?.cancel();
      await sleep(retryDelayMs(res, attempt));
      continue;
    }
    return res;
  }
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) return Number(retryAfter) * 1000 + 250;
  const reset = res.headers.get("x-ratelimit-reset");
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset) {
    return Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
  }
  return 1000 * 2 ** attempt;
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface CacheRecord<T> {
  storedAt: number;
  value: T;
}

/** JSON-on-disk cache, keyed by any string (hashed to a file name). */
export class DiskCache {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    const h = createHash("sha256").update(key).digest("hex");
    return join(this.dir, h.slice(0, 2), `${h}.json`);
  }

  async get<T>(key: string, maxAgeMs = Number.POSITIVE_INFINITY): Promise<T | undefined> {
    try {
      const record = JSON.parse(await readFile(this.file(key), "utf8")) as CacheRecord<T>;
      return Date.now() - record.storedAt <= maxAgeMs ? record.value : undefined;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const path = this.file(key);
    await mkdir(dirname(path), { recursive: true });
    const record: CacheRecord<T> = { storedAt: Date.now(), value };
    await writeFile(path, JSON.stringify(record));
  }
}
