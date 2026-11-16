import type { APIRoute } from "astro";
import { boxData } from "../../lib/box-data.ts";

/** The packs' current picks for the library-guide box; served to guides through /api/v1/box.json. */
export const GET: APIRoute = () =>
  new Response(JSON.stringify(boxData()), { headers: { "Content-Type": "application/json" } });
