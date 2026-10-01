"""Build the plugin file from src/: an uncompressed zip of exactly the four files listed below.

    python3 build.py

Writes dist/install-link-blocker-<version>.xpi and dist/updates.json (what Zotero reads to find
updates) and prints the file's SHA-256. The zip has fixed dates, order and file attributes and no
compression, so anyone who builds the same commit, on any system, gets the same bytes, and
unzipping the file gives back those four files.
"""

import hashlib
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
DIST = HERE / "dist"
FILES = ["bootstrap.js", "manifest.json", "prefs.js", "settings.xhtml"]

extra = sorted(p.relative_to(SRC).as_posix() for p in SRC.rglob("*") if p.is_file())
if extra != FILES:
    sys.exit(f"src/ must hold exactly {FILES}; it holds {extra}")

manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
zotero = manifest["applications"]["zotero"]
version = manifest["version"]
repo = manifest["homepage_url"]
if zotero["update_url"] != f"{repo}/releases/latest/download/updates.json":
    sys.exit("update_url must be homepage_url + /releases/latest/download/updates.json")
name = f"install-link-blocker-{version}.xpi"

DIST.mkdir(exist_ok=True)
xpi = DIST / name
with zipfile.ZipFile(xpi, "w", zipfile.ZIP_STORED) as z:
    for file in FILES:
        info = zipfile.ZipInfo(file, date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3  # Unix, whatever system builds it
        info.create_version = info.extract_version = 20
        info.external_attr = 0o644 << 16
        z.writestr(info, (SRC / file).read_bytes())

sha256 = hashlib.sha256(xpi.read_bytes()).hexdigest()
updates = {
    "addons": {
        zotero["id"]: {
            "updates": [
                {
                    "version": version,
                    "update_link": f"{repo}/releases/download/v{version}/{name}",
                    "update_hash": f"sha256:{sha256}",
                    "applications": {
                        "zotero": {
                            "strict_min_version": zotero["strict_min_version"],
                            "strict_max_version": zotero["strict_max_version"],
                        }
                    },
                }
            ]
        }
    }
}
with open(DIST / "updates.json", "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps(updates, indent=2) + "\n")
print(f"{name}  sha256:{sha256}")
