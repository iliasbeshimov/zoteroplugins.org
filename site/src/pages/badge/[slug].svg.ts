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

export function getStaticPaths() {
  return allPlugins().map((p) => ({ params: { slug: p.slug }, props: { p } }));
}

export const GET: APIRoute = ({ props }) => {
  const p = (props as { p: Plugin }).p;
  const [bg, fg] = COLORS[p.grade];
  const brand = "Plugins Atlas";
  const bw = 92;
  const gw = p.grade === "A+" ? 34 : 28;
  const w = bw + gw;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${brand}: ${p.grade}"><title>${brand}: ${p.grade} (${p.gradeLong})</title><clipPath id="r"><rect width="${w}" height="20" rx="4"/></clipPath><g clip-path="url(#r)"><rect width="${bw}" height="20" fill="${BRAND}"/><rect x="${bw}" width="${gw}" height="20" fill="${bg}"/></g><g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${bw / 2}" y="14" fill="#fff">${brand}</text><text x="${bw + gw / 2}" y="14" fill="${fg}" font-weight="bold">${p.grade}</text></g></svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
};
