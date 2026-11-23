"""Build tiny bootstrap test add-ons for the policy test: build_plugins.py <outdir>"""
import json, sys, zipfile, os
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
BOOT = '''function install(){} function uninstall(){} function shutdown(){}
function startup(){ Services.prefs.setBoolPref("policytest.started." + "%(id)s", true);
  dump("[policytest] plugin startup %(id)s\\n"); Zotero.debug("[policytest] plugin startup %(id)s"); }
'''
for n in ["pre", "side", "file", "url", "bpre", "bside", "bfile", "burl", "force"]:
    id = f"{n}@policytest.invalid"
    m = {"manifest_version": 2, "name": f"policytest {n}", "version": "1.0.0",
         "applications": {"zotero": {"id": id, "update_url": "https://zoteroplugins.invalid/none.json",
                                      "strict_min_version": "6.999", "strict_max_version": "11.*"}}}
    with zipfile.ZipFile(f"{out}/{n}.xpi", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(m)); z.writestr("bootstrap.js", BOOT % {"id": id})
