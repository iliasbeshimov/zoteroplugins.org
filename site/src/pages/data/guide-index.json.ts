import type { APIRoute } from "astro";
import { guideIndex } from "../../lib/guide-index.ts";

/** Every plugin we have a card for, in the short form the guide check reads (see lib/guide-index.ts). */
export const GET: APIRoute = () =>
  new Response(JSON.stringify(guideIndex()), { headers: { "Content-Type": "application/json" } });
