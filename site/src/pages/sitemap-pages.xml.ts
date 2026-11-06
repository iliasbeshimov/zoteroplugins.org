import type { APIRoute } from "astro";
import { pageEntries, urlset } from "../lib/seo.ts";

/** The home page, browse, categories and the site's other pages. */
export const GET: APIRoute = () => urlset(pageEntries());
