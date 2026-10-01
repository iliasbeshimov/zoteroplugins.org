import type { DocLanguage } from "@atlas/schema";

/**
 * Which languages a README is written in, from the scripts its prose uses. Deterministic and
 * deliberately coarse: we only need to tell readers "the documentation is in Chinese only", not
 * to identify every European language.
 */

// Words that are also common in Spanish, Portuguese or German ("a", "as", "an", "also") are left
// out so those READMEs don't read as English.
const ENGLISH_WORDS = new Set(
  (
    "the and to of is for you with this it on that your are be can or by from will not use if " +
    "all when which have has more after into its any only how what then there"
  ).split(" "),
);

/** Removes code, markup, links' targets and badges, keeping human prose. */
export function prose(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

interface Counts {
  han: number;
  kana: number;
  hangul: number;
  cyrillicWords: number;
  latinWords: number;
  englishWords: number;
}

function count(text: string): Counts {
  const n = (re: RegExp) => text.match(re)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}{2,}/gu) ?? [];
  return {
    han: n(/\p{Script=Han}/gu),
    kana: n(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu),
    hangul: n(/\p{Script=Hangul}/gu),
    cyrillicWords: n(/\p{Script=Cyrillic}{2,}/gu),
    latinWords: latin.length,
    englishWords: latin.filter((w) => ENGLISH_WORDS.has(w.toLowerCase())).length,
  };
}

/**
 * Languages ordered by share of the text, keeping those with at least 15% of it. Latin-script
 * words count as English only when enough of them are English function words; otherwise they're
 * usually product names inside CJK prose, and count as "latin" only if they dominate.
 */
export function detectDocLanguages(markdown: string): DocLanguage[] {
  const c = count(prose(markdown));
  // Rough word equivalents so scripts can be compared: about 1.8 Han characters per English word.
  const japanese = c.kana > 0.15 * (c.han + c.kana);
  const units: Partial<Record<DocLanguage, number>> = {
    zh: japanese ? 0 : c.han / 1.8,
    ja: japanese ? (c.han + c.kana) / 1.8 : 0,
    ko: c.hangul / 3,
    ru: c.cyrillicWords,
  };
  const total0 = Object.values(units).reduce((s, v) => s + (v ?? 0), 0) + c.latinWords;
  if (c.latinWords > 0) {
    // Product names inside CJK prose dilute the ratio, so enough function words also count.
    if (c.englishWords >= 20 || c.englishWords / c.latinWords >= 0.1) units.en = c.latinWords;
    else if (c.latinWords / total0 >= 0.5) units.latin = c.latinWords;
  }
  const total = Object.values(units).reduce((s, v) => s + (v ?? 0), 0);
  if (total < 15) return [];
  return (Object.entries(units) as [DocLanguage, number][])
    .filter(([, v]) => v >= 0.15 * total && v >= 10)
    .sort((a, b) => b[1] - a[1])
    .map(([lang]) => lang);
}

const LANGUAGE_HINTS: [string, RegExp][] = [
  ["en", /(^|[^a-z])(en|eng|english)([^a-z]|$)|英文|英语|英語/i],
  ["zh", /(^|[^a-z])(zh|cn|chs|cht|chinese)([^a-z]|$)|中文|简体|繁體|繁体|汉语|漢語/i],
  ["ja", /(^|[^a-z])(ja|jp|japanese)([^a-z]|$)|日本語/i],
  ["ko", /(^|[^a-z])(ko|kr|korean)([^a-z]|$)|한국어/i],
  ["ru", /(^|[^a-z])(ru|russian)([^a-z]|$)|Русский/i],
  ["de", /(^|[^a-z])(de|deutsch|german)([^a-z]|$)/i],
  ["fr", /(^|[^a-z])(fr|français|francais|french)([^a-z]|$)/i],
  ["es", /(^|[^a-z])(es|español|espanol|spanish)([^a-z]|$)/i],
];

/**
 * Other-language versions of the README that it links to, e.g. `[English](README_EN.md)` or
 * `[简体中文](docs/zh-CN/README.md)`. Returns language codes.
 */
export function linkedReadmeLanguages(markdown: string): string[] {
  const found = new Set<string>();
  for (const m of markdown.matchAll(/(?<!!)\[([^\]]{1,40})\]\(([^)\s]{1,200})\)/g)) {
    const text = (m[1] ?? "").trim();
    const target = m[2] ?? "";
    if (/^https?:/i.test(target) && !/github\.com\/[^/]+\/[^/]+\/(blob|tree)\//i.test(target)) {
      continue;
    }
    const file = decodeURIComponent(target.split(/[?#]/)[0] ?? "")
      .split("/")
      .slice(-3)
      .join("/");
    const isReadme = /readme[^/]*\.md$/i.test(file) || /(^|\/)(docs?|i18n)\//i.test(file);
    const textIsLanguageName = LANGUAGE_HINTS.some(([, re]) => re.test(text)) && text.length <= 16;
    if (!isReadme && !textIsLanguageName) continue;
    if (!/\.md$|\/$/i.test(file) && !isReadme) continue;
    for (const [lang, re] of LANGUAGE_HINTS) {
      const fileHint = file.replace(/readme/i, "");
      if (re.test(text) || (isReadme && re.test(fileHint))) found.add(lang);
    }
  }
  return [...found].sort();
}

/** Locale folders shipped in an .xpi: `locale/<tag>/`, `_locales/<tag>/`, `chrome/locale/<tag>/`. */
export function uiLocales(paths: string[]): string[] {
  const found = new Set<string>();
  for (const p of paths) {
    const m = p.match(/(?:^|\/)(?:_locales|locales?)\/([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)\//);
    if (m?.[1]) found.add(normalizeLocale(m[1]));
  }
  return [...found].sort();
}

export function normalizeLocale(tag: string): string {
  const [lang = "", ...rest] = tag.split(/[-_]/);
  const parts = rest.map((p) =>
    p.length === 2
      ? p.toUpperCase()
      : p.length === 4
        ? `${p.slice(0, 1).toUpperCase()}${p.slice(1).toLowerCase()}`
        : p,
  );
  return [lang.toLowerCase(), ...parts].join("-");
}
