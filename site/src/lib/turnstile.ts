/**
 * Cloudflare Turnstile, the check against bots on the site's forms (submit, ratings, ideas).
 *
 * The site key is public (it's in the page). Every build but `astro dev` uses the real one: the
 * Pages secret only accepts its tokens, so a build that fell back to Cloudflare's test key turned
 * every submission away as a bot. `astro dev` keeps the always-pass test key.
 */
const SITE_KEY = "0x4AAAAAAFLUiYqWzSW4lRSQ";
const TEST_KEY = "1x00000000000000000000AA";
export const siteKey: string =
  import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || (import.meta.env.DEV ? TEST_KEY : SITE_KEY);
