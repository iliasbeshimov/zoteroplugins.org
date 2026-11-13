/**
 * "Our picks" on the home page: plugins we chose by hand, each with a screenshot from its own
 * README (site/public/shots/<slug>.jpg, at most 1200px wide). Picked for a good grade, a release
 * that works with the current Zotero, and a screenshot that shows what it does. Nobody pays to be
 * here. A pick whose plugin stops being listed or stops working with the current Zotero drops out
 * until it's replaced.
 */
export interface Pick {
  slug: string;
  /** The screenshot's path under site/public, and its size in px. */
  shot: string;
  w: number;
  h: number;
  /** What the screenshot shows, for its alt text. */
  alt: string;
}

export const PICKS: Pick[] = [
  {
    slug: "zoplicate",
    shot: "/shots/zoplicate.jpg",
    w: 1156,
    h: 768,
    alt: "Zotero's item pane with Zoplicate's Non-duplicates section listing an item marked as not a duplicate",
  },
  {
    slug: "zotero-actions-tags",
    shot: "/shots/zotero-actions-tags.jpg",
    w: 900,
    h: 492,
    alt: "A collection's right-click menu with Actions and Tags' Trigger Action submenu and its shortcut",
  },
  {
    slug: "modern-zotero-themes",
    shot: "/shots/modern-zotero-themes.jpg",
    w: 1200,
    h: 764,
    alt: "The Zotero window split into three of the plugin's colour themes: light, paper and dark",
  },
];
