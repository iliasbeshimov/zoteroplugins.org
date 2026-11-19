import { existsSync, readFileSync } from "node:fs";
import { ROOT } from "./atlas.ts";

/**
 * Screenshots from plugins' READMEs, shown as a gallery on their pages (data/census/gallery.json,
 * keyed by owner/repo in lower case). Each picture was chosen as showing the plugin at work and
 * captioned by AI; the files are our own WebP copies in site/public/gallery/, so a page loads
 * nothing from the developer's servers. An animated picture has a still (`file`) and the
 * animation (`anim`), loaded only when someone opens it.
 */
export interface Shot {
  /** The still, under /gallery/. */
  file: string;
  w: number;
  h: number;
  /** What it shows, written by AI; also the image's alt text. */
  caption: string;
  /** The animation, under /gallery/, for an animated picture: full size, every frame, lossless. */
  anim: string | null;
  /** The animation's size, which can be larger than the still's. */
  animW?: number;
  animH?: number;
}

export interface PluginGallery {
  /** Pictures in the README that aren't badges: how many there were to choose from. */
  readmeImages: number;
  shots: Shot[];
}

interface GalleryFile {
  /** When the READMEs were read. */
  read: string;
  plugins: Record<string, PluginGallery>;
}

let cache: GalleryFile | null = null;

function load(): GalleryFile {
  if (cache) return cache;
  const f = `${ROOT}census/gallery.json`;
  cache = existsSync(f)
    ? (JSON.parse(readFileSync(f, "utf8")) as GalleryFile)
    : { read: "", plugins: {} };
  return cache;
}

/** The plugin's gallery, or null when its README has no picture we'd show. */
export function galleryOf(repo: string): PluginGallery | null {
  const g = load().plugins[repo.toLowerCase()];
  return g?.shots.length ? g : null;
}

/** When the READMEs behind the galleries were read, as an ISO date ("" without a gallery file). */
export const galleryRead = () => load().read;
