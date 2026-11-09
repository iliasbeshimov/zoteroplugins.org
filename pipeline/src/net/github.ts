import { type DiskCache, fetchWithRetry, sleep } from "./http.ts";

const API = "https://api.github.com";

export interface RestResponse<T> {
  status: number;
  data: T | null;
  link: string | null;
  rateRemaining: number | null;
  rateReset: number | null;
}

interface CachedRest {
  etag: string;
  status: number;
  data: unknown;
  link: string | null;
}

type SearchKind = "repositories" | "code";

const restUrl = (path: string) => (path.startsWith("http") ? path : `${API}${path}`);

/**
 * The last successful answer to a REST GET, from the cache and without a request: what an offline
 * rebuild, or a run that skipped the call, can still read. Null when nothing is cached.
 */
export async function cachedRest<T>(cache: DiskCache, path: string): Promise<T | null> {
  const cached = await cache.get<CachedRest>(`rest:${restUrl(path)}`);
  return cached?.status === 200 ? ((cached.data as T | null) ?? null) : null;
}

export class GitHub {
  /** When each search family may be called again, from GitHub's x-ratelimit-* headers. */
  private searchBlockedUntil: Record<SearchKind, number> = { repositories: 0, code: 0 };

  constructor(
    private readonly token: string,
    private readonly userAgent: string,
    private readonly cache: DiskCache,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": this.userAgent,
      ...extra,
    };
  }

  /**
   * GET with ETag revalidation. A 304 is served from the cache and doesn't count against the
   * rate limit, so re-running the census is nearly free.
   */
  async rest<T>(path: string): Promise<RestResponse<T>> {
    const url = restUrl(path);
    const cached = await this.cache.get<CachedRest>(`rest:${url}`);
    const res = await fetchWithRetry(url, {
      headers: this.headers(cached ? { "if-none-match": cached.etag } : {}),
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    const rate = {
      rateRemaining: remaining === null ? null : Number(remaining),
      rateReset: reset === null ? null : Number(reset),
    };
    if (res.status === 304 && cached) {
      return { status: cached.status, data: cached.data as T, link: cached.link, ...rate };
    }
    const link = res.headers.get("link");
    const data = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
    const etag = res.headers.get("etag");
    if (etag && res.ok) {
      await this.cache.set<CachedRest>(`rest:${url}`, { etag, status: res.status, data, link });
    }
    return { status: res.status, data, link, ...rate };
  }

  /** Follows `rel="next"` links until exhausted or `maxPages` is reached. */
  async restPaginate<T>(path: string, maxPages = 100): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = path.includes("?") ? `${path}&per_page=100` : `${path}?per_page=100`;
    for (let page = 0; url && page < maxPages; page++) {
      const res: RestResponse<T[]> = await this.rest<T[]>(url);
      if (res.status !== 200 || !Array.isArray(res.data)) break;
      out.push(...res.data);
      url = nextLink(res.link);
    }
    return out;
  }

  /**
   * Search API. Paces itself from GitHub's rate-limit headers: calls go out back to back until the
   * per-minute allowance (30 search, 10 code search) is used up, then wait for the reset.
   */
  async search<T>(
    kind: SearchKind,
    q: string,
    page: number,
  ): Promise<{ total: number; items: T[] }> {
    const wait = this.searchBlockedUntil[kind] - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await this.rest<{ total_count: number; items: T[] }>(
      `/search/${kind}?q=${encodeURIComponent(q)}&per_page=100&page=${page}`,
    );
    if (res.rateRemaining === 0 && res.rateReset) {
      this.searchBlockedUntil[kind] = res.rateReset * 1000 + 1000;
    }
    if (res.status !== 200 || !res.data) return { total: 0, items: [] };
    return { total: res.data.total_count, items: res.data.items };
  }

  /**
   * GraphQL call, cached by query text. Returns `data` even when some aliases fail (GitHub reports
   * missing repositories as per-alias errors). Only answers whose errors are all NOT_FOUND are
   * cached: any other error means GitHub dropped part of the answer.
   *
   * An answer is reused only by the workflow run that fetched it (a re-run of a failed job keeps
   * its run id), and locally for an hour. A later run reusing it would publish GitHub as it was
   * hours before, next to fresher facts found elsewhere: a release seen at its update address, but
   * a last-release date from before it.
   */
  async graphql<T>(
    query: string,
    maxAgeMs = graphqlRunId() ? 20 * 60 * 60 * 1000 : 60 * 60 * 1000,
  ): Promise<{ data: T | null; errors: GraphqlError[] }> {
    const key = `graphql:${query}`;
    const runId = graphqlRunId();
    const cached = await this.cache.get<CachedGraphql<T>>(key, maxAgeMs);
    if (cached && (cached.runId ?? null) === runId)
      return { data: cached.data, errors: cached.errors };
    const res = await fetchWithRetry(`${API}/graphql`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { data: T | null; errors?: GraphqlError[] };
    const result = { data: body.data, errors: body.errors ?? [] };
    if (body.data && partialErrors(result.errors).length === 0)
      await this.cache.set<CachedGraphql<T>>(key, { ...result, runId });
    return result;
  }
}

interface CachedGraphql<T> {
  data: T | null;
  errors: GraphqlError[];
  /** The workflow run that fetched it; null outside Actions. Absent in entries from before. */
  runId?: string | null;
}

/** The current GitHub Actions run, read per call so tests can set it. */
const graphqlRunId = (): string | null => process.env.GITHUB_RUN_ID || null;

export interface GraphqlError {
  message: string;
  type?: string;
  path?: (string | number)[];
}

/**
 * Errors that mean part of the answer is missing, as opposed to NOT_FOUND for a deleted or private
 * repository. An oversized query gets RESOURCE_LIMITS_EXCEEDED and nulls in place of the fields
 * GitHub dropped, which would otherwise read as "this release has no files".
 */
export const partialErrors = (errors: GraphqlError[]) =>
  errors.filter((e) => e.type !== "NOT_FOUND");

export function nextLink(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

export function lastPage(link: string | null): number | null {
  const m = link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return m?.[1] ? Number(m[1]) : null;
}
