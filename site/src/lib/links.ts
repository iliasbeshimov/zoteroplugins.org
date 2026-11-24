/** Where people respond to or report on a card: this project's GitHub repository. */
export const REPO = "https://github.com/iliasbeshimov/zoteroplugins.org";
export const REPORT_URL = `${REPO}/issues/new`;
export const RESPOND_URL = `${REPO}/issues/new?template=card-response.yml`;
/** Ideas sent with the suggestion box (components/IdeaBox.astro): public issues labelled `idea`. */
export const IDEAS_URL = `${REPO}/issues?q=label%3Aidea`;
export const SITE = "https://zoteroplugins.org";
/** Our accounts elsewhere: in the footer and in the Organization sameAs (lib/meta.ts). */
export const BLUESKY = "https://bsky.app/profile/zoteroplugins.org";
export const LINKEDIN = "https://www.linkedin.com/company/zoteroplugins/";
/** The README badge's Markdown: the grade image, linked to the plugin's page. */
export const badgeMarkdown = (slug: string) =>
  `[![Zotero Plugins grade](${SITE}/badge/${slug}.svg)](${SITE}/p/${slug})`;
/** The plugin page offers the README badge at these grades; below them, the developer checklist. */
export const offersBadge = (grade: string) => grade === "A+" || grade === "A" || grade === "B";
/** Where librarians and readers write to us; forwards to the maintainer. */
export const CONTACT = "hello@zoteroplugins.org";
export const mailto = (subject: string) =>
  `mailto:${CONTACT}?subject=${encodeURIComponent(subject)}`;
/**
 * zoteroatlas.com, home of Zotero Atlas, our plugin that brings the catalogue into Zotero. The
 * utm_ parameters tell that site's analytics which spot here the visit came from.
 */
export const atlasLink = (
  medium: "band" | "install-sheet" | "install-guide" | "home-hero" | "home-section" | "plugin-page",
) =>
  `https://zoteroatlas.com/?utm_source=zoteroplugins.org&utm_medium=${medium}&utm_campaign=atlas`;
