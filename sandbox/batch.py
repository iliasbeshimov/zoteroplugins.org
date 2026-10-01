"""Run plugins through the sandbox, a few at a time, and write one report per plugin.

    python3 sandbox/batch.py [--jobs 4] <slug> [<slug> ...]
    python3 sandbox/batch.py [--jobs 4] --file slugs.txt

Each plugin runs its current release (the file its card describes) on the newest Zotero it says
it supports: 10.0.3, else 9.0.6; older plugins are skipped. Reports go to
.cache/sandbox-io/reports/<slug>.json; the raw run stays in .cache/sandbox-io/runs/.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IO = ROOT / ".cache" / "sandbox-io"
ZOTERO = {10: "10.0.3", 9: "9.0.6"}


def latest(pattern: str) -> Path | None:
    runs = sorted(IO.glob(f"runs/{pattern}"))
    return runs[-1] if runs else None


def plan(slug: str) -> tuple[str, Path] | str:
    """(Zotero version, .xpi) for a plugin, or why it can't run."""
    profile = json.loads((ROOT / "data" / "generated" / slug / "profile.json").read_text())
    trust = profile.get("trust") or {}
    sha = (trust.get("appliesTo") or {}).get("sha256")
    if not sha:
        return "no analysed release"
    xpi = ROOT / ".cache" / "blobs" / "sha256" / sha[:2] / f"{sha}.xpi"
    if not xpi.exists():
        return "release file not cached"
    compat = (trust.get("facets") or {}).get("compatibility") or {}
    for key in ("current", "previous"):
        c = compat.get(key) or {}
        if c.get("status") == "compatible" and c.get("major") in ZOTERO:
            return ZOTERO[c["major"]], xpi
    return "doesn't support Zotero 9 or 10"


def run(slug: str, slot: int) -> dict:
    planned = plan(slug)
    out = IO / "reports" / f"{slug}.json"
    if isinstance(planned, str):
        report = {"slug": slug, "verdict": "skipped", "reason": planned}
    else:
        version, xpi = planned
        env = {"SLOT": str(slot), "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"}
        done = subprocess.run(
            [str(ROOT / "sandbox" / "run.sh"), "test", version, str(xpi), slug],
            capture_output=True, text=True, env=env, timeout=900,
        )
        run_id = done.stdout.strip().splitlines()[-1] if done.stdout.strip() else ""
        base = latest(f"baseline-{version}_*")
        if not run_id or not base:
            report = {"slug": slug, "verdict": "error", "reason": done.stderr[-500:]}
        else:
            rep = subprocess.run(
                [sys.executable, str(ROOT / "sandbox" / "report.py"), str(IO / "runs" / run_id),
                 str(base), str(ROOT / "data" / "generated" / slug / "profile.json")],
                capture_output=True, text=True,
            )
            report = json.loads(rep.stdout) if rep.returncode == 0 else {"verdict": "error", "reason": rep.stderr[-500:]}
            report.update({"slug": slug, "run": run_id, "baseline": base.name})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False))
    return report


def rereport(slug: str) -> dict | None:
    """Read an earlier run again, against the card as it is now (after a re-profile)."""
    out = IO / "reports" / f"{slug}.json"
    old = json.loads(out.read_text()) if out.exists() else {}
    if not old.get("run") or not old.get("baseline"):
        return None
    rep = subprocess.run(
        [sys.executable, str(ROOT / "sandbox" / "report.py"), str(IO / "runs" / old["run"]),
         str(IO / "runs" / old["baseline"]), str(ROOT / "data" / "generated" / slug / "profile.json")],
        capture_output=True, text=True,
    )
    if rep.returncode != 0:
        return None
    report = json.loads(rep.stdout)
    report.update({"slug": slug, "run": old["run"], "baseline": old["baseline"]})
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False))
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--file")
    ap.add_argument("--report-only", action="store_true", help="re-read earlier runs, run nothing")
    ap.add_argument("slugs", nargs="*")
    args = ap.parse_args()
    slugs = list(args.slugs)
    if args.file:
        slugs += [s.strip() for s in Path(args.file).read_text().split() if s.strip()]
    if args.report_only:
        slugs = slugs or sorted(p.stem for p in (IO / "reports").glob("*.json"))
        for slug in slugs:
            r = rereport(slug)
            if r:
                print(f"{slug}: {r['verdict']} {r.get('unexpected') or ''}", flush=True)
        return
    slots = list(range(1, args.jobs + 1))
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        free = list(slots)
        futures = {}
        for slug in slugs:
            if not free:
                done, _ = concurrent.futures.wait(futures, return_when="FIRST_COMPLETED")
                for f in done:
                    free.append(futures.pop(f))
                    r = f.result()
                    print(f"{r['slug']}: {r['verdict']} {r.get('unexpected') or r.get('reason') or ''}", flush=True)
            slot = free.pop()
            futures[pool.submit(run, slug, slot)] = slot
        for f in concurrent.futures.as_completed(futures):
            r = f.result()
            print(f"{r['slug']}: {r['verdict']} {r.get('unexpected') or r.get('reason') or ''}", flush=True)


if __name__ == "__main__":
    main()
