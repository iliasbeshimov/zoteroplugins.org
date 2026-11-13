/**
 * A developer's response, and our reply, as the plugin page shows them. Developers write in the
 * GitHub issue form, so responses use Markdown: the common parts are rendered (headings, lists,
 * code, bold, links), everything else stays as written. All text is escaped before any tag is
 * added. Long responses are folded after their opening blocks.
 */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown: `code`, **bold**, [text](https://…) and bare https links. */
export function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${esc(part.slice(1, -1))}</code>`;
      const links: string[] = [];
      // Links are set aside behind private-use marks while the rest is escaped.
      const keep = (html: string) => `\uE000${links.push(html) - 1}\uE001`;
      const withLinks = part
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) =>
          keep(`<a href="${esc(u)}" rel="nofollow ugc noopener">${esc(t)}</a>`),
        )
        .replace(/https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g, (u) =>
          keep(`<a href="${esc(u)}" rel="nofollow ugc noopener">${esc(u)}</a>`),
        );
      return esc(withLinks)
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\uE000(\d+)\uE001/g, (_, n: string) => links[Number(n)] ?? "");
    })
    .join("");
}

const indentOf = (line: string) => line.match(/^\s*/)?.[0].length ?? 0;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** The text as HTML blocks: paragraphs, headings, lists and code. */
export function blocks(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; indent: number; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${list.items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
    }
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (FENCE.test(line)) {
      flush();
      const mark = (line.match(FENCE)?.[1] ?? "```") as string;
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).trim().startsWith(mark); i++)
        code.push(lines[i] as string);
      const cut = Math.min(...code.filter((l) => l.trim()).map(indentOf), Infinity);
      const body = code.map((l) => l.slice(Number.isFinite(cut) ? cut : 0)).join("\n");
      if (body.trim()) out.push(`<pre><code>${esc(body.replace(/^\n+|\n+$/g, ""))}</code></pre>`);
      continue;
    }
    if (!line.trim() || RULE.test(line)) {
      flush();
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      out.push(`<p class="rh"><strong>${inline(heading[1] ?? "")}</strong></p>`);
      continue;
    }
    const item = line.match(LIST_ITEM);
    if (item) {
      const ordered = /\d/.test(item[1] ?? "");
      const current = list as { ordered: boolean; indent: number; items: string[] } | null;
      if (!current || current.ordered !== ordered || indentOf(line) > current.indent + 1) {
        flush();
        list = { ordered, indent: indentOf(line), items: [] };
      }
      (list as unknown as { items: string[] }).items.push(item[2] ?? "");
      continue;
    }
    const current = list as { indent: number; items: string[] } | null;
    if (current && indentOf(line) > current.indent) {
      current.items[current.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (current) flush();
    para.push(line.trim());
  }
  flush();
  return out;
}

/**
 * Blocks to show, and the rest to fold behind "Read the full response": the opening blocks up to
 * about 600 characters of text. Nothing is folded when the rest is short.
 */
export function folded(text: string): { shown: string[]; more: string[] } {
  const all = blocks(text);
  const len = (html: string) => html.replace(/<[^>]+>/g, "").length;
  let used = 0;
  let cut = 0;
  while (cut < all.length && (cut === 0 || used + len(all[cut] as string) <= 600))
    used += len(all[cut++] as string);
  // A heading on its own at the end goes with what it introduces.
  while (cut > 1 && /^<p class="rh">/.test(all[cut - 1] as string)) cut--;
  const rest = all.slice(cut);
  return rest.reduce((n, b) => n + len(b), 0) < 300
    ? { shown: all, more: [] }
    : { shown: all.slice(0, cut), more: rest };
}
