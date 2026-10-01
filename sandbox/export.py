"""Turn sandbox reports into the public record the profiles read: data/sandbox/<slug>.json.

    python3 sandbox/export.py            # every report in .cache/sandbox-io/reports
    python3 sandbox/export.py <slug> ...

Each record names the exact release file tested (its SHA-256), so a profile uses it only for that
file. Request addresses keep their host and path; query strings and bodies stay in the raw run.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
IO = ROOT / ".cache" / "sandbox-io"
OUT = ROOT / "data" / "sandbox"
SANDBOX_VERSION = "1.1.0"


def sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export(slug: str) -> dict | None:
    report = json.loads((IO / "reports" / f"{slug}.json").read_text())
    if report.get("verdict") in ("skipped", "error") or not report.get("run"):
        return None
    run = IO / "runs" / report["run"]
    harness = {}
    for name in ("harness.json", "progress.json"):
        p = run / "results" / name
        if p.exists():
            harness = json.loads(p.read_text())
            break
    entry = json.loads((run / "results" / "entry.json").read_text())
    requests = []
    for r in report.get("requests") or []:
        u = urlsplit(r["url"])
        item = {"method": r["method"], "host": u.hostname or "", "path": u.path[:200]}
        if item not in requests:
            requests.append(item)
    record = {
        "schemaVersion": 1,
        "sandboxVersion": SANDBOX_VERSION,
        "slug": slug,
        "sha256": sha256(run / "in" / "target.xpi"),
        "addonId": report.get("target"),
        "zotero": report.get("zotero") or run.name,
        "testedAt": datetime.datetime.fromtimestamp(entry.get("start") or 0, datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "seconds": entry.get("seconds"),
        "verdict": report["verdict"],
        "loaded": report.get("loaded", False),
        "cutShort": report.get("cutShort", False),
        "exercised": {
            "itemsSelected": harness.get("itemsSelected", 0),
            "readerOpened": bool(harness.get("readerOpened")),
            "settingsPane": bool(report.get("prefPanes")),
            "menuItems": len(harness.get("menuClicks") or []),
            "dialogs": len(harness.get("prompts") or []),
        },
        "contacted": report.get("contacted") or [],
        # Per host: "sends-library-data" (with the kinds found: titles, notes, pdf-text…),
        # "sends-data" (a body or query without library data), or "fetches" (plain page loads).
        "hostUsage": report.get("hostUsage") or {},
        "requests": requests[:60],
        "refused": report.get("refused") or [],
        "programs": report.get("newProcesses") or [],
        "servers": report.get("newListening") or [],
        "settings": [p["key"] for p in report.get("changedPrefs") or [] if not p.get("own")],
        "files": report.get("filesOutsideZotero") or [],
        "databaseStructureChanged": bool(report.get("schemaChanged")),
        "unexpected": report.get("unexpected") or [],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{slug}.json").write_text(json.dumps(record, indent=1, ensure_ascii=False) + "\n")
    return record


def main() -> None:
    slugs = sys.argv[1:] or sorted(p.stem for p in (IO / "reports").glob("*.json"))
    done = [s for s in slugs if export(s)]
    print(f"wrote {len(done)} records to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
