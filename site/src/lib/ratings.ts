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

/** "used for 3 months", "used for less than a day", or null without history. */
export function usedFor(days: number | null): string | null {
  if (days === null) return null;
  if (days < 1) return "used for less than a day";
  if (days < 14) return `used for ${days} day${days === 1 ? "" : "s"}`;
  if (days < 60) return `used for ${Math.round(days / 7)} weeks`;
  if (days < 730) return `used for ${Math.round(days / 30.4)} months`;
  return `used for ${Math.floor(days / 365)} years`;
}

export const starsText = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
