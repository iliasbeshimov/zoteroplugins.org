/** Where people respond to or report on a card: this project's GitHub repository. */
export const REPO = "https://github.com/iliasbeshimov/zoteroplugins.org";
export const REPORT_URL = `${REPO}/issues/new`;
export const RESPOND_URL = `${REPO}/issues/new?template=card-response.yml`;
export const SITE = "https://zoteroplugins.org";
/** Where librarians and readers write to us; forwards to the maintainer. */
export const CONTACT = "hello@zoteroplugins.org";
export const mailto = (subject: string) =>
  `mailto:${CONTACT}?subject=${encodeURIComponent(subject)}`;
/**
 * zoteroatlas.com, home of Zotero Atlas, our plugin that brings the catalogue into Zotero. The
 * utm_ parameters tell that site's analytics which spot here the visit came from.
 */
export const atlasLink = (medium: "band" | "install-sheet" | "install-guide") =>
  `https://zoteroatlas.com/?utm_source=zoteroplugins.org&utm_medium=${medium}&utm_campaign=atlas`;
