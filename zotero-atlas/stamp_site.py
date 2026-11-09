#!/usr/bin/env python3
"""Stamp site/*.html with a content hash on each local script and stylesheet.

zoteroatlas.com's zone tells browsers to keep assets for 4 hours, so a changed
/style.css under the same URL can pair new HTML with old CSS. Each page links
/style.css?v=<hash>, /site.js?v=<hash> and /consent.js?v=<hash> instead; run
this after changing any of them (or adding a page) and commit the result.
"""
import hashlib
import pathlib
import re

SITE = pathlib.Path(__file__).resolve().parent / "site"
ASSETS = ["style.css", "site.js", "consent.js"]


def main() -> None:
    stamps = {
        name: hashlib.sha256((SITE / name).read_bytes()).hexdigest()[:10] for name in ASSETS
    }
    for page in sorted(SITE.glob("*.html")):
        text = page.read_text(encoding="utf-8")
        new = text
        for name, stamp in stamps.items():
            new = re.sub(
                r'(["\'])/' + re.escape(name) + r'(?:\?v=[0-9a-f]+)?\1',
                lambda m, n=name, s=stamp: f"{m.group(1)}/{n}?v={s}{m.group(1)}",
                new,
            )
        if new != text:
            page.write_text(new, encoding="utf-8")
            print(f"stamped {page.name}")
    for name, stamp in stamps.items():
        print(f"{name}?v={stamp}")


if __name__ == "__main__":
    main()
