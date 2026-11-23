"""Print a policy-test run's results compactly: show.py <results dir>"""
import json, sys
r = sys.argv[1]
print(open(f"{r}/status.txt").read().strip())
def short(snap): return {a["id"].split("@")[0]: ("ACTIVE" if a["isActive"] else "inactive") + f" appDis={a['appDisabled']} userDis={a['userDisabled']} ran={a['startupFlag']} canUninst={a['canUninstall']} canDis={a['canDisable']}" for a in snap}
for p in ("phase1", "phase2", "phase3"):
    try: d = json.load(open(f"{r}/{p}.json"))
    except Exception as e: print(p, "no json", e); continue
    print("==", p, {k: d.get(k) for k in ("zotero", "policiesStatus", "isInstallEnabled", "isInstallAllowed", "isInstallAllowedErr", "harnessError")})
    if d.get("activePolicies"): print(" activePolicies", json.dumps(d["activePolicies"]))
    for k in ("addonsAtStart", "addonsAfterInstalls", "addonsAtEnd"):
        if k in d: print(" ", k); [print("    ", a, b) for a, b in short(d[k]).items()]
    for i in d.get("installs", []): print("  install", json.dumps(i))
    for k in ("disablePre", "aboutAddons"):
        if k in d: print(" ", k, json.dumps(d[k]))
print(open(f"{r}/ext-after-phase3.txt").read())
