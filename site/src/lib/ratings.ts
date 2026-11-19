import { existsSync, readFileSync } from "node:fs";
import { type PluginRatings, PublicRatings } from "@atlas/schema";
import { ROOT } from "./atlas.ts";

/**
 * Published ratings and reviews (data/generated/ratings.json, fetched nightly by `atlas ratings`).
 * Ratings come from Zotero Atlas and from this site; each is checked before it's published. They
 * sit next to the grade and never change it.
 */
let cache: PublicRatings["plugins"] | null = null;

export function ratingsOf(slug: string): PluginRatings | null {
  if (!cache) {
    // RATINGS_FILE: another file, for looking at the page with sample ratings.
    const file = process.env.RATINGS_FILE ?? `${ROOT}generated/ratings.json`;
    const parsed = existsSync(file)
      ? PublicRatings.safeParse(JSON.parse(readFileSync(file, "utf8")))
      : null;
    cache = parsed?.success ? parsed.data.plugins : {};
  }
  return cache[slug] ?? null;
}

/**
 * Whether this site takes reviews: on once the review service can send its confirmation emails
 * (set PUBLIC_REVIEWS_OPEN=1 for the build; the census workflow passes the REVIEWS_OPEN variable).
 * Until then a plugin's page shows ratings only when it has some, and no form.
 */
export const REVIEWS_OPEN = import.meta.env.PUBLIC_REVIEWS_OPEN === "1";

/** A version needs this many ratings before it shows an average. */
export const MIN_SHOWN = 10;

/**
 * "used for at least 3 months", or null. usedDays counts from when Zotero Atlas first saw the
 * plugin installed, and the rater may have used it long before, so it's only a lower bound; under
 * a day it says nothing worth printing.
 */
export function usedFor(days: number | null): string | null {
  if (days === null || days < 1) return null;
  const d = Math.floor(days);
  if (d < 14) return `used for at least ${d} day${d === 1 ? "" : "s"}`;
  if (d < 60) return `used for at least ${Math.round(d / 7)} weeks`;
  if (d < 730) return `used for at least ${Math.round(d / 30.4)} months`;
  return `used for at least ${Math.floor(d / 365)} years`;
}

export const starsText = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
