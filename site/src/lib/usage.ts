// The estimates are computed in the schema package (schema/src/usage.ts), so the catalogue Zotero
// Atlas reads carries the same numbers as the site.

export type { Growth } from "@atlas/schema";
export { fmtUse, loadGrowth, loadUsage } from "@atlas/schema/usage";

/** The tooltip that explains the number wherever it's shown. */
export const USE_TIP =
  "An estimate of how many copies of Zotero have it: Zotero downloads each new version once for every copy that has the plugin, so we count the downloads of its most-downloaded recent release. Rounded. Plugins that update from outside GitHub count low.";
