"""Print an .xpi's add-on ID: manifest.json (Zotero 7+) or install.rdf (Zotero 6)."""

import json
import re
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as z:
    names = set(z.namelist())
    if "manifest.json" in names:
        m = json.loads(z.read("manifest.json").decode("utf-8-sig"))
        apps = m.get("applications") or m.get("browser_specific_settings") or {}
        found = (apps.get("zotero") or apps.get("gecko") or {}).get("id")
    elif "install.rdf" in names:
        rdf = z.read("install.rdf").decode("utf-8", "replace")
        # The add-on's own em:id, not a target application's (those sit inside targetApplication).
        rdf = re.sub(r"<em:targetApplication>.*?</em:targetApplication>", "", rdf, flags=re.S)
        m = re.search(r"<em:id>([^<]+)</em:id>|em:id=\"([^\"]+)\"", rdf)
        found = (m.group(1) or m.group(2)) if m else None
    else:
        found = None
if not found or not re.fullmatch(r"[\w.@+{}-]+", found):
    sys.exit(1)
print(found)
