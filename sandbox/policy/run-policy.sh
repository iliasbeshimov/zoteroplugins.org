#!/bin/bash
# Policy test driver (separate from run.sh): run-policy.sh <scenario> [version]
# Scenarios are the files in sandbox/policy/scenarios/<name>.json ("none" = control, no policy).
# FLAGS="p1policy rescan": p1policy = policy already in place on the first start; rescan = delete extensions.json before the second start.
# No network, no proxy: the container has --network none and serves test .xpi files on 127.0.0.1.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IO="$ROOT/.cache/sandbox-io"
PM=(podman --connection atlas-sandbox)
SC=${1:?scenario}; V=${2:-10.0.3}; SLOT=${SLOT:-150}
podman machine inspect atlas-sandbox --format '{{.State}}' | grep -q running || podman machine start atlas-sandbox > /dev/null
W="$IO/policy-$SLOT"; ID="$SC-$V-$(date +%H%M%S)"
mkdir -p "$W/$ID/in/plugins" "$W/$ID/results" "$W/$ID/dist" "$W/code"
chmod -R 777 "$W/$ID"
cp -R "$ROOT/sandbox/policy/harness" "$W/code/"; cp "$ROOT/sandbox/policy/entry.sh" "$W/code/"
chmod -R a+rX "$W/code"
python3 -I "$ROOT/sandbox/policy/build_plugins.py" "$W/$ID/in/plugins"
[ "$SC" != none ] && cp "$ROOT/sandbox/policy/scenarios/$SC.json" "$W/$ID/in/policy.json"
for f in ${FLAGS:-}; do touch "$W/$ID/in/flag-$f"; done
chmod -R 777 "$W/$ID"
NAME="policy-test-$SLOT"
"${PM[@]}" rm -f "$NAME" > /dev/null 2>&1 || true
"${PM[@]}" run --name "$NAME" --network none --cap-drop ALL --security-opt no-new-privileges \
  --memory 4g --cpus 2 --pids-limit 1024 --entrypoint /policy/entry.sh \
  -v "/io/policy-$SLOT/code:/policy:ro" -v "/io/policy-$SLOT/$ID/in:/in:ro" \
  -v "/io/policy-$SLOT/$ID/results:/results" -v "/io/policy-$SLOT/$ID/dist:/opt/zotero/distribution" \
  -v "/io/template/$V/data.tar:/template/data.tar:ro" "atlas-zotero:$V" > "$W/$ID/container.log" 2>&1 || true
"${PM[@]}" rm -f "$NAME" > /dev/null 2>&1 || true
echo "$W/$ID/results"
