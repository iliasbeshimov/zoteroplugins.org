import type { APIRoute } from "astro";
import { shownPlugins } from "../lib/atlas.ts";

/** What the browse page's search indexes, one document per listed plugin (see lib/search.ts). */
export const GET: APIRoute = () =>
  new Response(JSON.stringify(shownPlugins().map((p) => p.search)), {
    headers: { "Content-Type": "application/json" },
  });
