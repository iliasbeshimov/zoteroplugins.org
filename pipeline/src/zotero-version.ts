import type { ZoteroVersions } from "./census/compat.ts";
import { compareVersions } from "./census/compat.ts";
import type { GitHub } from "./net/github.ts";
import { fetchWithRetry } from "./net/http.ts";

const CHANNELS = ["release", "beta", "dev"] as const;
const PLATFORMS = ["mac", "win-x64", "linux-x86_64"] as const;

/**
 * Detects Zotero versions from zotero.org's download redirects (one HEAD per channel/platform,
 * no HTML scraping), plus the highest stable git tag per major.
 */
export async function detectZoteroVersions(gh: GitHub, userAgent: string): Promise<ZoteroVersions> {
  const found: Record<(typeof CHANNELS)[number], Record<string, string>> = {
    release: {},
    beta: {},
    dev: {},
  };
  for (const channel of CHANNELS) {
    for (const platform of PLATFORMS) {
      const url = `https://www.zotero.org/download/client/dl?channel=${channel}&platform=${platform}`;
      const res = await fetchWithRetry(url, {
        method: "HEAD",
        redirect: "manual",
        headers: { "user-agent": userAgent },
      });
      const location = res.headers.get("location") ?? "";
      const version = decodeURIComponent(
        location.split(`/client/${channel}/`)[1]?.split("/")[0] ?? "",
      );
      if (version) found[channel][platform] = version;
    }
  }

  const tags = await gh.restPaginate<{ name: string }>("/repos/zotero/zotero/tags", 30);
  const lastTagPerMajor: Record<number, string> = {};
  for (const { name } of tags) {
    if (!/^\d+\.\d+(\.\d+)*$/.test(name)) continue;
    const major = Number(name.split(".")[0]);
    const prev = lastTagPerMajor[major];
    if (!prev || compareVersions(name, prev) > 0) lastTagPerMajor[major] = name;
  }

  const majorOf = (v: string | undefined) => (v ? Number(v.split(".")[0]) : Number.NaN);
  const releaseMajors = Object.values(found.release).map(majorOf).filter(Number.isFinite);
  const tagMajors = Object.keys(lastTagPerMajor).map(Number);
  const currentMajor = Math.max(...(releaseMajors.length ? releaseMajors : tagMajors));
  const preMajors = [...Object.values(found.beta), ...Object.values(found.dev)]
    .map(majorOf)
    .filter((m) => Number.isFinite(m) && m > currentMajor);

  return {
    release: found.release,
    beta: found.beta,
    dev: found.dev,
    currentMajor,
    nextMajor: preMajors.length ? Math.max(...preMajors) : null,
    lastTagPerMajor,
  };
}
