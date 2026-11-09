import { describe, expect, it } from "vitest";
import {
  declaredIcons,
  imageKind,
  inkStats,
  rdfIcon,
  recolorSvg,
  renderIcon,
  resolveIconPath,
} from "../src/profile/icons.ts";

const square = (rgba: [number, number, number, number], n = 16) =>
  new Uint8Array(Array.from({ length: n * n }, () => rgba).flat());

describe("plugin icons", () => {
  it("picks an SVG first, then the largest size a manifest declares", () => {
    expect(declaredIcons({ icons: { "48": "a48.png", "96": "a96.png" } })).toEqual([
      "a96.png",
      "a48.png",
    ]);
    expect(declaredIcons({ icons: { "32": "x.png", "48": "x.svg" } })[0]).toBe("x.svg");
    expect(declaredIcons({ name: "no icons" })).toEqual([]);
  });

  it("reads install.rdf's iconURL as an element or an attribute", () => {
    expect(rdfIcon("<em:iconURL>chrome://zotfile/skin/zotfile.png</em:iconURL>")).toBe(
      "chrome://zotfile/skin/zotfile.png",
    );
    expect(rdfIcon('<Description em:iconURL="chrome://x/content/i.png"/>')).toBe(
      "chrome://x/content/i.png",
    );
  });

  it("resolves chrome:// icons through chrome.manifest", () => {
    const cm = "content zotfile chrome/content/\nskin zotfile default chrome/skin/";
    expect(resolveIconPath("chrome://zotfile/skin/zotfile.png", cm)).toBe(
      "chrome/skin/zotfile.png",
    );
    expect(resolveIconPath("chrome://zotfile/content/i.png", cm)).toBe("chrome/content/i.png");
    expect(resolveIconPath("/content/icons/favicon.png", null)).toBe("content/icons/favicon.png");
  });

  it("tells formats apart by their first bytes", () => {
    expect(
      imageKind("a.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBe("png");
    expect(imageKind("a.svg", new TextEncoder().encode("<svg/>"))).toBe("svg");
    expect(imageKind("a.ico", new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it("gives Zotero's context colours a real colour", () => {
    expect(recolorSvg('<path fill="context-fill" fill-opacity="context-fill-opacity"/>')).toBe(
      '<path fill="#3c4150" fill-opacity="1"/>',
    );
  });

  it("calls an empty render blank and white-on-transparent light, but not a logo on white", () => {
    expect(inkStats(square([0, 0, 0, 0])).coverage).toBe(0);
    const glyph = square([0, 0, 0, 0]);
    for (let i = 0; i < 40 * 4; i += 4) glyph.set([255, 255, 255, 255], i);
    expect(inkStats(glyph).light).toBe(true);
    expect(inkStats(square([255, 255, 255, 255])).light).toBe(false);
    expect(inkStats(square([20, 60, 200, 255])).light).toBe(false);
  });

  it("renders an SVG to a 96 px PNG with its colours", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="context-fill"/></svg>';
    const { png, rgba } = renderIcon(new TextEncoder().encode(svg), "svg");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(rgba.length).toBe(96 * 96 * 4);
    expect(inkStats(rgba).coverage).toBeGreaterThan(0.9);
  });
});
