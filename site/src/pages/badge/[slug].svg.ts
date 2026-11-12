import type { APIRoute } from "astro";
import { allPlugins, type Plugin } from "../../lib/atlas.ts";

/** The README badge. Standalone SVG, so colours are the light theme's tokens as hex. */
const COLORS: Record<string, [string, string]> = {
  "A+": ["#1d5b4e", "#ffffff"],
  A: ["#2b7a5c", "#ffffff"],
  B: ["#d8ad3d", "#2c2412"],
  C: ["#bd3a2c", "#ffffff"],
  "–": ["#5c606b", "#ffffff"],
};
const BRAND = "#5b3fc4";

/**
 * The shelf mark (favicon.svg's geometry) in a 14px box at x=5, white with the leaning book in
 * lilac, the way shields.io badges carry a logo before their label.
 */
const MARK =
  `<g transform="translate(5 3) scale(${14 / 84}) translate(-5.4 -9.5)"><g fill="#fff">` +
  `<rect x="10" y="25" width="14" height="57" rx="3"/><rect x="30" y="16" width="14" height="66" rx="3"/>` +
  `<rect x="50" y="28" width="12" height="54" rx="3"/><rect x="8" y="82" width="79" height="5" rx="2.5"/></g>` +
  `<rect fill="#c9bfff" x="73.8" y="20" width="13" height="62" rx="3" transform="rotate(-12 86.8 82)"/></g>`;
/** "Zotero Plugins" in Verdana 11px measures 79.2px; it starts 4px after the mark. */
const TEXT_X = 23;
const TEXT_W = 80;

export function getStaticPaths() {
  return allPlugins().map((p) => ({ params: { slug: p.slug }, props: { p } }));
}

export const GET: APIRoute = ({ props }) => {
  const p = (props as { p: Plugin }).p;
  const [bg, fg] = COLORS[p.grade];
  const brand = "Zotero Plugins";
  const bw = TEXT_X + TEXT_W + 6;
  const gw = p.grade === "A+" ? 34 : 28;
  const w = bw + gw;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${brand}: ${p.grade}"><title>${brand}: ${p.grade} (${p.gradeLong})</title><clipPath id="r"><rect width="${w}" height="20" rx="4"/></clipPath><g clip-path="url(#r)"><rect width="${bw}" height="20" fill="${BRAND}"/><rect x="${bw}" width="${gw}" height="20" fill="${bg}"/></g>${MARK}<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${TEXT_X + TEXT_W / 2}" y="14" fill="#fff">${brand}</text><text x="${bw + gw / 2}" y="14" fill="${fg}" font-weight="bold">${p.grade}</text></g></svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
};
