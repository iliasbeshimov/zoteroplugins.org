/** Where people respond to or report on a card: this project's GitHub repository. */
export const REPO = "https://github.com/iliasbeshimov/zoteroplugins.org";
export const REPORT_URL = `${REPO}/issues/new`;
export const RESPOND_URL = `${REPO}/issues/new?template=card-response.yml`;
export const SITE = "https://zoteroplugins.org";
/** Where librarians and readers write to us; forwards to the maintainer. */
export const CONTACT = "hello@zoteroplugins.org";
export const mailto = (subject: string) =>
  `mailto:${CONTACT}?subject=${encodeURIComponent(subject)}`;
