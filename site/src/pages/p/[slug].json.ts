import type { APIRoute } from "astro";
import { allPlugins, type Plugin } from "../../lib/atlas.ts";

/** What the compare page needs about one plugin: its grade and the scorecard rows, in order. */
export function getStaticPaths() {
  return allPlugins().map((p) => ({ params: { slug: p.slug }, props: { p } }));
}

export const GET: APIRoute = ({ props }) => {
  const p = (props as { p: Plugin }).p;
  return new Response(
    JSON.stringify({
      slug: p.slug,
      name: p.name,
      version: p.version,
      downloads: p.downloads,
      grade: p.grade,
      gradeWord: p.gradeWord,
      gradeTone: p.gradeTone,
      because: p.because,
      areas: p.areas.map((a) => ({ key: a.key, level: a.level, value: a.value, sub: a.sub ?? "" })),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};
