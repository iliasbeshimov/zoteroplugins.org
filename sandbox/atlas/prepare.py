"""Inputs for `sandbox/run.sh atlas`: the walk-through driver, the test plugins and Zotero Atlas's
saved catalogue and advisories.

    python3 sandbox/atlas/prepare.py      # writes .cache/atlas-sandbox/{extra,data}
    EXTRA_DIR=.cache/atlas-sandbox/extra ATLAS_DATA=.cache/atlas-sandbox/data \\
      sandbox/run.sh atlas 10.0.3 zotero-atlas/dist/zotero-atlas-1.0.0.xpi

The test catalogue is today's data/generated/catalog.json with one change: ZotMoov's listed
release (1.2.34) is graded B, below the A of 1.2.32 that gets installed, so Atlas holds the update
Zotero finds. Lab Tools is a made-up plugin the directory doesn't list, with a made-up critical
advisory. Delete Item with Attachment is installed at its listed version (0.5.1) and the driver
tells Atlas it was 0.5.0 before, so it shows as updated with a way back.
"""

import json
import shutil
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / ".cache" / "atlas-sandbox"
BLOBS = ROOT / ".cache" / "blobs" / "sha256"


def blob(sha):
    for p in (BLOBS / sha[:2] / sha, BLOBS / sha[:2] / f"{sha}.xpi"):
        if p.exists():
            return p
    sys.exit(f"missing blob {sha}")


def zipdir(src, dest):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_STORED) as z:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(src).as_posix())


shutil.rmtree(OUT, ignore_errors=True)
(OUT / "extra").mkdir(parents=True)
(OUT / "data").mkdir()
zipdir(HERE / "driver", OUT / "extra" / "atlas-driver.xpi")
zipdir(HERE / "labtools", OUT / "extra" / "lab-tools.xpi")

catalog = json.loads((ROOT / "data" / "generated" / "catalog.json").read_text())
by_slug = {p["slug"]: p for p in catalog["plugins"]}
zotmoov = by_slug["zotmoov"]
old = next(p for p in zotmoov["previous"] if p["version"] == "1.2.32")
shutil.copy(blob(old["file"]["sha256"]), OUT / "extra" / "zotmoov-1.2.32.xpi")
zotmoov["grade"] = "B"
zotmoov["because"] = "a finding made up for this walk-through"
dele = by_slug["delitemwithatt"]
shutil.copy(blob(dele["file"]["sha256"]), OUT / "extra" / "delitemwithatt-0.5.1.xpi")

# "Fetched" two days ahead, so Atlas uses these instead of fetching its own.
ahead = int((time.time() + 2 * 86400) * 1000)
(OUT / "data" / "catalog.json").write_text(json.dumps({"data": catalog, "fetchedAt": ahead}))
advisories = {
    "schemaVersion": 1,
    "updatedAt": "2026-11-09T00:00:00Z",
    "advisories": [
        {
            "id": "ZPA-2026-999",
            "addon": "lab-tools@example.org",
            "slug": None,
            "name": "Lab Tools",
            "affects": {"min": None, "max": "0.4.0"},
            "severity": "critical",
            "title": "uploads your library to a server its developer doesn't name",
            "text": "Turn it off; there's no fixed version yet.",
            "fixedIn": None,
            "url": "https://zoteroplugins.org/how-we-grade",
            "publishedAt": "2026-11-09T00:00:00Z",
        }
    ],
}
(OUT / "data" / "advisories.json").write_text(json.dumps({"data": advisories, "fetchedAt": ahead}))
print(f"wrote {OUT}")
