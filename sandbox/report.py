"""Read one sandbox run against the baseline run of the same Zotero version and, when given, the
plugin's card; print a JSON summary with a verdict.

    python3 sandbox/report.py <run dir> <baseline run dir> [<profile.json>]

The verdict is "as-described" when, during the run, the plugin loaded, and everything it did
beyond what Zotero does by itself is something its card already says: the hosts it contacted, the
programs it started, the servers it opened, the settings it changed outside its own, the files it
wrote outside Zotero's folders, and changes to Zotero's database. Anything else is listed under
"unexpected". "not-loaded" when it didn't start; "incomplete" when the harness didn't finish.
"""

from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import unquote_plus

PREF = re.compile(r'^user_pref\("([^"]+)",\s*(.*)\);$')
# Zotero's own bookkeeping, and per-plugin pane state Zotero keeps under the plugin's ID.
NOISE_PREF = re.compile(
    r"^(app\.update\.|browser\.|extensions\.(databaseSchema|lastApp|lastPlatform|pendingOperations|"
    r"signatureCheckpoint|webextensions\.|blocklist\.|installedDistroAddon|systemAddonSet|"
    r"zotero\.(lastSelectedPrefPane|lastViewedFolder|pane\.persist|panes\.|lastLongTagMode|"
    r"lastRenameAssociatedFile|recentSaveTargets|itemTree\.|reader\.|firstRunGuidanceShown|"
    r"sync\.storage\.|lastPDFMethod|tabs\.|autoRenameFiles\.done|fulltext\.|search\.|purge\.|newItemTypeMRU|lastCreatorFieldMode|sidenav\.)|reset\.)|toolkit\.|datareporting\.|media\.|gfx\.|dom\.|"
    r"privacy\.|places\.|security\.sandbox\.|network\.cookie\.|idle\.|intl\.|storage\.vacuum\.)"
)
ZOTERO_PROCS = re.compile(
    r"(/opt/zotero/|/sandbox/|Xvfb|dbus-(daemon|launch)|\bsleep\b|\bps -eo\b|tcpdump|"
    r"timeout --kill-after|\[(Socket Process|glxtest|Chroot Helper)\]|<defunct>|"
    # Desktop helpers GTK starts on demand (settings, accessibility, virtual file systems).
    r"/usr/libexec/(dconf-service|at-spi|gvfs)|^\s*$)"
)
OWN_DIRS = ("/tmp", "/home/zotero/.cache", "/home/zotero/.dbus", "/home/zotero/.mozilla", "/proc")


def load_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def prefs(path: Path) -> dict:
    out = {}
    if path.exists():
        for line in path.read_text(errors="replace").splitlines():
            m = PREF.match(line.strip())
            if m:
                out[m.group(1)] = m.group(2)
    return out


def flows(run: Path) -> list:
    path = run / "proxy" / "flows.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def requests(run: Path) -> list:
    return [f for f in flows(run) if f["kind"] in ("request", "connect")]


def processes(run: Path) -> set:
    """Programs seen while Zotero ran (the entrypoint's own steps before and after don't count)."""
    path = run / "monitor" / "processes.txt"
    entry = load_json(run / "results" / "entry.json", {}) or {}
    start, end = entry.get("start") or 0, entry.get("end") or float("inf")
    seen = set()
    at = 0.0
    if path.exists():
        for line in path.read_text(errors="replace").splitlines():
            if line.startswith("---"):
                at = float(line.split()[1])
                continue
            parts = line.split(None, 3)
            if start <= at <= end and len(parts) == 4 and not ZOTERO_PROCS.search(parts[3]):
                seen.add(parts[3][:300])
    return seen


def listening(run: Path) -> set:
    path = run / "monitor" / "listening.txt"
    out = set()
    if path.exists():
        for line in path.read_text().splitlines():
            parts = line.split()
            if not line.startswith("---") and len(parts) >= 5:
                out.add(f"{parts[0]} {parts[4]}")
    return out


def connections(run: Path) -> list:
    """Connection attempts that didn't go to the proxy (DNS, direct sockets, loopback servers)."""
    path = run / "monitor" / "connections.txt"
    if not path.exists():
        return []
    return [line for line in path.read_text().splitlines() if " IP" in line or " IP6" in line]


def fs_changes(run: Path) -> set:
    path = run / "results" / "fsdiff.txt"
    if not path.exists():
        return set()
    out = set()
    for line in path.read_text().splitlines():
        kind, _, p = line.partition(" ")
        if kind in ("A", "D") and not p.startswith(OWN_DIRS):
            out.add(line)
    return out


def known_prefs(zotero: str | None) -> set:
    """Settings Zotero or Firefox define by default (sandbox/run.sh setup extracts them)."""
    path = Path(__file__).resolve().parent.parent / ".cache" / "sandbox-io" / f"known-prefs-{zotero}.txt"
    return set(path.read_text().split()) if zotero and path.exists() else set()


def own_branches(xpi: Path) -> set:
    """The settings branches a plugin declares defaults for (prefs.js), which are its own."""
    out = set()
    try:
        with zipfile.ZipFile(xpi) as z:
            for name in z.namelist():
                if re.fullmatch(r"(defaults/preferences/)?[^/]*prefs?\.js", name):
                    text = z.read(name).decode("utf-8", "replace")
                    for key in re.findall(r"""pref\(\s*["']([^"']+)["']""", text):
                        branch = key.rsplit(".", 1)[0] + "."
                        # Saved through Zotero.Prefs, a full name gains Zotero's own prefix.
                        out.update({branch, "extensions.zotero." + branch})
    except (OSError, zipfile.BadZipFile):
        pass
    # A bare "extensions." or "extensions.zotero." would claim every plugin's settings.
    return {b for b in out if b.count(".") >= 2 and b != "extensions.zotero."}


# What the test library holds (sandbox/zotero/harness/bootstrap.js and make_pdf.py). Finding one of
# these in a request means the plugin sent library data there, and which kind.
CANARIES = {
    "titles": ["deep learning", "structure of scientific revolutions", "深度学习研究综述"],
    "identifiers": ["10.1038/nature14539", "nature14539", "9780226458083"],
    "authors": ["lecun", "bengio", "hinton", "kuhn", "张三"],
    "abstract": ["computational models to learn representations"],
    "notes": ["a test note about"],
    "pdf-text": ["sandbox test document", "zoteroplugins.org test library", "multiple processing layers"],
    "tags": ["machine learning", "philosophy of science"],
    "collections": ["sandbox test"],
}


def sent_kinds(flow: dict) -> set:
    """The kinds of library data a request carries in its address or body."""
    text = unquote_plus(unquote_plus(flow.get("url") or "")) + "\n" + (flow.get("body") or "")
    text = text.lower().replace("_", " ").replace("+", " ")
    kinds = {kind for kind, marks in CANARIES.items() if any(m in text for m in marks)}
    if "%pdf-" in text:
        kinds.add("pdf-file")
    return kinds


def host_usage(flows_: list) -> dict:
    """Per host: what the plugin's requests there carried."""
    out: dict = {}
    for f in flows_:
        if f["kind"] != "request" or f.get("refused"):
            continue
        entry = out.setdefault(f["host"], {"sent": set(), "data": False})
        entry["sent"] |= sent_kinds(f)
        if f.get("method") not in ("GET", "HEAD") or f.get("bodyBytes") or "?" in (f.get("url") or ""):
            entry["data"] = True
    return {
        h: {
            "usage": "sends-library-data" if e["sent"] else "sends-data" if e["data"] else "fetches",
            "sent": sorted(e["sent"]),
        }
        for h, e in out.items()
    }


def card_facts(profile: dict) -> dict:
    trust = profile.get("trust") or {}
    facets = trust.get("facets") or {}
    hosts = set()
    for group in (facets.get("dataSharing") or {}).get("hosts") or []:
        hosts.update(group.get("hosts") or [])
    badges = {b["id"] for b in (facets.get("capabilities") or {}).get("badges") or []}
    return {"hosts": hosts, "badges": badges, "label": (trust.get("overall") or {}).get("label")}


# Hosts that serve another host's files: GitHub's release downloads, archives and raw files.
SAME_AS = {
    "release-assets.githubusercontent.com": "github.com",
    "objects.githubusercontent.com": "github.com",
    "codeload.github.com": "github.com",
    "raw.githubusercontent.com": "github.com",
}


def host_on_card(host: str, card_hosts: set) -> bool:
    host = SAME_AS.get(host.lower(), host.lower())
    bare = host[4:] if host.startswith("www.") else host
    return any(
        bare == h or host == h or bare.endswith("." + h) or h.endswith("." + bare)
        for h in (c.lower().removeprefix("www.") for c in card_hosts)
    )


def main() -> None:
    run, base = Path(sys.argv[1]), Path(sys.argv[2])
    profile = load_json(Path(sys.argv[3]), {}) if len(sys.argv) > 3 else {}
    harness = load_json(run / "results" / "harness.json") or load_json(run / "results" / "progress.json", {})
    entry = load_json(run / "results" / "entry.json", {})
    target = harness.get("target") or entry.get("targetId") or ""
    addon = next(
        (a for a in (harness.get("addons") or harness.get("addonsAtStart") or []) if a["id"] == target),
        None,
    )
    base_harness = load_json(base / "results" / "harness.json", {})

    base_req = {(f.get("method"), f.get("url") or f.get("host")) for f in requests(base)}
    new_req = [f for f in requests(run) if (f.get("method"), f.get("url") or f.get("host")) not in base_req]
    contacted = sorted({f["host"] for f in new_req if not f.get("refused")})
    refused = sorted({f"{f['host']} ({f['refused']})" for f in new_req if f.get("refused")})

    before, after = prefs(run / "results" / "prefs.before.js"), prefs(run / "results" / "prefs.after.js")
    base_after = prefs(base / "results" / "prefs.after.js")
    id_bits = {b.lower() for b in re.split(r"[@._\-{}]+", target) if len(b) > 3}
    branches = own_branches(run / "in" / "target.xpi")
    # A setting neither Zotero nor Firefox defines is one the plugin made: its own.
    known = known_prefs(harness.get("zotero"))
    changed_prefs = []
    for key, value in sorted(after.items()):
        if before.get(key) == value or key in base_after or NOISE_PREF.search(key):
            continue
        own = (
            target.lower() in key.lower()
            or any(b in key.lower() for b in id_bits)
            or any(key.startswith(b) for b in branches)
            or (bool(known) and key not in known)
        )
        changed_prefs.append({"key": key, "value": value[:200], "own": own})

    base_errors = {c.get("message") for c in base_harness.get("console") or []}
    errors = [
        c["message"][:300]
        for c in harness.get("console") or []
        if c.get("source") is not None and not c.get("warning") and c.get("message") not in base_errors
    ]

    schema_before = (run / "results" / "schema.before.sql")
    schema_after = (run / "results" / "schema.after.sql")
    schema_changed = (
        schema_before.exists()
        and schema_after.exists()
        and schema_before.read_text() != schema_after.read_text()
    )

    summary = {
        "target": target,
        "zotero": harness.get("zotero"),
        "loaded": bool(addon and addon.get("isActive")),
        "finished": any(p.get("name") == "end" for p in harness.get("phases") or []),
        "reached": [p.get("name") for p in harness.get("phases") or []],
        "stepErrors": {k: v[:300] for k, v in harness.items() if k.endswith("Error") and v},
        "cutShort": bool(harness.get("watchdog")) or entry.get("exit") == 124,
        "prefPanes": harness.get("prefPanes") or [],
        "readerOpened": harness.get("readerOpened"),
        "newErrors": errors[:40],
        "contacted": contacted,
        "requests": [
            {"method": f.get("method") or "CONNECT", "url": (f.get("url") or f.get("host"))[:300]}
            for f in new_req
            if f["kind"] == "request"
        ][:200],
        "refused": refused,
        "hostUsage": host_usage([f for f in new_req if f.get("host") in contacted]),
        "otherConnections": connections(run)[:50],
        "newProcesses": sorted(processes(run) - processes(base))[:50],
        "newListening": sorted(listening(run) - listening(base)),
        "changedPrefs": changed_prefs,
        "filesOutsideZotero": sorted(fs_changes(run) - fs_changes(base))[:50],
        "schemaChanged": schema_changed,
    }

    unexpected = []
    if profile:
        card = card_facts(profile)
        badges = card["badges"]
        for h in contacted:
            if not host_on_card(h, card["hosts"]):
                unexpected.append(f"contacted {h}, which its card doesn't list")
        for r in refused:
            unexpected.append(f"tried to reach a local or private address: {r}")
        if summary["newProcesses"] and not badges & {"process-launch", "runs-bundled-binary", "download-exec"}:
            unexpected.append(f"started programs: {', '.join(summary['newProcesses'][:3])}")
        if summary["newListening"] and not badges & {"own-server", "local-http-server"}:
            unexpected.append(f"opened servers: {', '.join(summary['newListening'])}")
        foreign = [p["key"] for p in changed_prefs if not p["own"]]
        if foreign and not badges & {"changes-settings", "disables-security", "enables-local-api"}:
            unexpected.append(f"changed settings that aren't its own: {', '.join(foreign[:5])}")
        if summary["filesOutsideZotero"] and "filesystem" not in badges:
            unexpected.append(
                f"wrote files outside Zotero's folders: {', '.join(f.split(' ', 1)[-1] for f in summary['filesOutsideZotero'][:3])}"
            )
        if schema_changed and not badges & {"db-write", "sqlite-direct"}:
            unexpected.append("changed Zotero's database structure")
        summary["card"] = {"label": card["label"], "badges": sorted(badges), "hosts": sorted(card["hosts"])}
    summary["unexpected"] = unexpected
    summary["verdict"] = (
        "not-loaded"
        if not summary["loaded"]
        else "incomplete"
        if not summary["finished"]
        else "unexpected"
        if unexpected
        else "as-described"
    )
    print(json.dumps(summary, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
