import type { APIRoute } from "astro";
import { known } from "../../lib/submissions.ts";

/**
 * Every repository we already know (listed, in review, waiting, or turned down for a given release),
 * by lower-case owner/name. The submit function reads it so a repeat starts nothing, and the
 * submit page reads it to show where a submission stands.
 */
export const GET: APIRoute = () =>
  new Response(JSON.stringify(known()), { headers: { "Content-Type": "application/json" } });
