/**
 * Ids for tooltips, numbered per page (tip-1, tip-2, …). Every page render has its own request, so
 * counting per request keeps them unique on a page and the same from one build to the next, and
 * short runs of digits compress far better than random strings on pages with a thousand cards.
 */
const counts = new WeakMap<Request, number>();

export function tipId(request: Request): string {
  const n = (counts.get(request) ?? 0) + 1;
  counts.set(request, n);
  return `tip-${n}`;
}
