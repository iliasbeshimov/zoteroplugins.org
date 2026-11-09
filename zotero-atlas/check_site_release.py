#!/usr/bin/env python3
"""Check that the .xpi zoteroatlas.com serves is the latest GitHub release's file.

Fails (exit 1) when site/ holds anything other than exactly one zotero-atlas-<version>.xpi whose
version is the latest release's, whose SHA-256 is that release asset's, and whose version, path
and SHA-256 are the ones install.html, index.html, trust.html and _headers state.

  python3 check_site_release.py            (GITHUB_TOKEN optional, raises the rate limit)
"""
import hashlib
import json
import os
import pathlib
import re
import sys
import urllib.request
import zipfile

SITE = pathlib.Path(__file__).resolve().parent / "site"
REPO = "iliasbeshimov/zotero-atlas"


def latest_release() -> dict:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "check-site-release"},
    )
    if os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", f"Bearer {os.environ['GITHUB_TOKEN']}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main() -> int:
    errors = []
    files = sorted(SITE.glob("*.xpi"))
    if len(files) != 1:
        print(f"::error::site/ should hold exactly one .xpi, found {[f.name for f in files]}")
        return 1
    xpi = files[0]
    m = re.fullmatch(r"zotero-atlas-(.+)\.xpi", xpi.name)
    if not m:
        print(f"::error::unexpected file name {xpi.name}")
        return 1
    version = m.group(1)
    sha = hashlib.sha256(xpi.read_bytes()).hexdigest()
    with zipfile.ZipFile(xpi) as z:
        inside = json.loads(z.read("manifest.json"))["version"]
    if inside != version:
        errors.append(f"{xpi.name} contains version {inside}")

    rel = latest_release()
    tag = rel["tag_name"]
    if tag != f"v{version}":
        errors.append(f"site serves {version}, latest release is {tag}")
    asset = next((a for a in rel.get("assets", []) if a["name"] == xpi.name), None)
    if asset is None:
        errors.append(f"release {tag} has no asset {xpi.name}")
    elif asset.get("digest") and asset["digest"] != f"sha256:{sha}":
        errors.append(f"{xpi.name} SHA-256 {sha[:12]}… differs from release asset {asset['digest'][7:19]}…")

    need = {
        "install.html": [f'href="/{xpi.name}"', f'data-version="{version}"', f"Zotero Atlas {version} ", f"releases/tag/v{version}", sha],
        "index.html": [xpi.name],
        "trust.html": [f"{version} file's SHA-256", sha],
        "_headers": [f"/{xpi.name}\n", f'filename="{xpi.name}"'],
    }
    for page, needles in need.items():
        text = (SITE / page).read_text(encoding="utf-8")
        errors += [f"{page} lacks {n.strip()!r}" for n in needles if n not in text]
    stale = re.compile(r"zotero-atlas-(\d+\.\d+\.\d+)\.xpi")
    for page in ["install.html", "index.html", "trust.html", "_headers"]:
        text = (SITE / page).read_text(encoding="utf-8")
        errors += [f"{page} names zotero-atlas-{v}.xpi" for v in sorted(set(stale.findall(text))) if v != version]

    for e in errors:
        print(f"::error::{e}")
    if errors:
        return 1
    print(f"site .xpi {version} matches release {tag} (SHA-256 {sha[:12]}…)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
