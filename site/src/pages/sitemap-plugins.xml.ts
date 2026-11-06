import type { APIRoute } from "astro";
import { pluginEntries, urlset } from "../lib/seo.ts";

/** Every plugin page search engines should index (see `indexable`). */
export const GET: APIRoute = () => urlset(pluginEntries());
