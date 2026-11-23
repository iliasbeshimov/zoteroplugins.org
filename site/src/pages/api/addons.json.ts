import type { APIRoute } from "astro";
import { allPlugins } from "../../lib/atlas.ts";

/**
 * Open data (CC BY 4.0), the small version for matching an inventory of installed add-ons: one row
 * per profiled plugin that has an add-on ID, with the version we checked, its grade and its card.
 * Copies and forks often reuse an ID, so one ID can have several rows. The inventory scripts on
 * /security-teams read this file; it stays well under the 2 MB that Windows PowerShell 5.1 can
 * parse. /api/plugins.json has everything else.
 */
export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      allPlugins()
        .filter((p) => p.addonId)
        .map((p) => ({
          addonId: p.addonId,
          name: p.name,
          version: p.version || null,
          // "–" (not graded yet) as null: Windows PowerShell 5.1 reads JSON served without a
          // charset as Latin-1, which would garble the dash.
          grade: p.grade === "–" ? null : p.grade,
          hidden: p.hidden,
          url: `/p/${p.slug}`,
        })),
    ),
    { headers: { "Content-Type": "application/json" } },
  );
