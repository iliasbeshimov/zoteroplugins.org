import { readFileSync } from "node:fs";
import type { PluginProfile } from "@atlas/schema";
import type { APIRoute } from "astro";
import { allPlugins, ROOT } from "../../lib/atlas.ts";

/**
 * Open data (CC BY 4.0): one row per profiled plugin with its grade and what its card shows.
 * The first ten fields are the original shape; everything after them was added later, so
 * existing readers keep working. Full profiles are in the repository's data/generated/.
 */
export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      allPlugins().map((p) => {
        const prof = JSON.parse(
          readFileSync(`${ROOT}generated/${p.slug}/profile.json`, "utf8"),
        ) as PluginProfile;
        const facets = prof.trust?.facets;
        const st = facets?.sourceTransparency;
        const ds = facets?.dataSharing;
        const badges = new Map<string, { label: string; concern: string }>(
          (facets?.capabilities?.badges ?? []).map((b) => [b.id, b]),
        );
        return {
          slug: p.slug,
          name: p.name,
          repo: p.repo,
          version: p.version || null,
          grade: p.grade,
          because: p.because,
          hidden: p.hidden,
          worksWithCurrentZotero: p.currentOk,
          jobs: p.jobs,
          url: `/p/${p.slug}`,
          hiddenReason: p.hiddenReason,
          tagline: p.tagline,
          author: prof.author?.login ?? null,
          license: prof.license ?? null,
          forkOf: prof.fork?.of ?? null,
          createdAt: prof.popularity?.createdAt ?? null,
          lastReleaseAt: prof.maintenance?.lastReleaseAt ?? null,
          lastCommitAt: prof.maintenance?.lastCommitAt ?? null,
          maintenance: prof.maintenance?.status ?? null,
          stars: prof.popularity?.stars ?? null,
          forks: prof.popularity?.forks ?? null,
          contributors: prof.popularity?.contributors ?? null,
          releases: prof.popularity?.releaseCount ?? null,
          downloads: prof.popularity?.downloads ?? null,
          latestDownloads: prof.popularity?.latestDownloads ?? null,
          inUse: p.inUse,
          supports: prof.compatibility?.supports ?? [],
          minVersion: prof.compatibility?.minVersion ?? null,
          maxVersion: prof.compatibility?.maxVersion ?? null,
          docsLanguages: prof.languages?.docs ?? [],
          uiLanguages: prof.languages?.ui ?? [],
          keyNeed: p.keyNeed,
          aiServices: prof.requirementsHints?.aiServices ?? [],
          provenance: st?.provenance ?? null,
          obfuscated: st?.obfuscated ?? null,
          updates: st?.updates?.kind ?? null,
          dataSharing: ds?.value ?? null,
          hosts: (ds?.hosts ?? []).flatMap((g) =>
            g.hosts.map((host) => ({
              host,
              category: g.category,
              confirmed: !(g.unconfirmed ?? []).includes(host),
            })),
          ),
          capabilities: p.capIds.map((id) => ({
            id,
            label: badges.get(id)?.label ?? id,
            concern: badges.get(id)?.concern ?? null,
          })),
          liveTest: p.liveTest?.verdict ?? null,
        };
      }),
    ),
    { headers: { "Content-Type": "application/json" } },
  );
