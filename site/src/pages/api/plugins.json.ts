import type { APIRoute } from "astro";
import { allPlugins } from "../../lib/atlas.ts";

/** Open data: one row per listed plugin with its grade. Full profiles are in the repository's data/generated/. */
export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      allPlugins().map((p) => ({
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
      })),
    ),
    { headers: { "Content-Type": "application/json" } },
  );
