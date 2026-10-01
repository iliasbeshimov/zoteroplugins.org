#!/bin/bash
# The plugin sandbox: runs one Zotero plugin in a throwaway Zotero inside the atlas-sandbox podman
# machine and records what it does. See sandbox/README.md for the design.
#
#   sandbox/run.sh setup                          build the images and seed the test libraries
#   sandbox/run.sh baseline <zotero-version>      a run with no plugin: what Zotero itself does
#   sandbox/run.sh test <zotero-version> <xpi> [<name>]
#   sandbox/run.sh links <zotero-version> <xpi> [<name>]   the link check for Install Link Blocker
#   sandbox/run.sh clicks <zotero-version> <xpi> [<name>]  clicking those links in a note and a PDF
#
# EXTRA=<xpi> installs another add-on beside the plugin (Install Link Blocker, for the link check).
#
# Runs in parallel need different SLOT values (1-200): each run gets its own internal network.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
IO="$ROOT/.cache/sandbox-io"            # shared with the machine as /io, and nothing else
CACHE="$ROOT/.cache/sandbox"
PM=(podman --connection atlas-sandbox)
MITM=docker.io/mitmproxy/mitmproxy@sha256:62d266a86ee95187217866c0e35487837498daa3aa1cdce37d256f07e198a47b
VERSIONS=(10.0.3 9.0.6 8.0.4 7.0.32)
SLOT=${SLOT:-1}
TIMEOUT=${ATLAS_TIMEOUT:-360}

die() { echo "sandbox: $*" >&2; exit 1; }

# The Zotero tarball for a version: the ARM64 build, or for Zotero 7, which has none, the x86-64
# build (run under the machine's emulation, several times slower).
tarball() {
  if [ -f "$CACHE/zotero/Zotero-${1}_linux-arm64.tar.xz" ]; then echo "Zotero-${1}_linux-arm64.tar.xz"
  else echo "Zotero-${1}_linux-x86_64.tar.xz"; fi
}

# wait_exit <container> <seconds>: until it stops (macOS has no `timeout`).
wait_exit() {
  local waited=0
  while [ "$("${PM[@]}" inspect -f '{{.State.Status}}' "$1" 2> /dev/null || echo gone)" = running ]; do
    [ "$waited" -ge "$2" ] && return 1
    sleep 2
    waited=$((waited + 2))
  done
}

ensure_machine() {
  podman machine inspect atlas-sandbox --format '{{.State}}' 2> /dev/null | grep -q running \
    || podman machine start atlas-sandbox > /dev/null
}

setup() {
  ensure_machine
  mkdir -p "$IO/ca" "$IO/proxy" "$IO/template" "$IO/runs"
  cp "$ROOT/sandbox/proxy/atlas_log.py" "$IO/proxy/atlas_log.py"
  # The proxy's CA, made once by mitmproxy itself; its key never leaves $IO/ca.
  if [ ! -f "$IO/ca/mitmproxy-ca-cert.pem" ]; then
    chmod 777 "$IO/ca"
    "${PM[@]}" run --rm -v /io/ca:/home/mitmproxy/.mitmproxy "$MITM" \
      sh -c 'timeout 5 mitmdump --set confdir=/home/mitmproxy/.mitmproxy --listen-port 18080 > /dev/null 2>&1; true'
    [ -f "$IO/ca/mitmproxy-ca-cert.pem" ] || die "the proxy didn't create its CA"
  fi
  for v in "${VERSIONS[@]}"; do
    local tar ctx="$CACHE/ctx-$v" platform=linux/arm64
    tar=$(tarball "$v")
    [ -f "$CACHE/zotero/$tar" ] || die "missing $CACHE/zotero/$tar"
    case "$tar" in *x86_64*) platform=linux/amd64 ;; esac
    rm -rf "$ctx" && mkdir -p "$ctx"
    cp -R "$ROOT/sandbox/zotero/." "$ctx/"
    cp "$CACHE/zotero/$tar" "$ctx/"
    cp "$IO/ca/mitmproxy-ca-cert.pem" "$ctx/proxy-ca.pem"
    "${PM[@]}" build -q --platform "$platform" -t "atlas-zotero:$v" --build-arg "ZOTERO_TARBALL=$tar" "$ctx"
    # The settings Zotero and Firefox define by default, so a report can tell a plugin's own
    # new settings from changes to existing ones.
    local omni="$CACHE/omni-$v"
    mkdir -p "$omni"
    tar -xJf "$CACHE/zotero/$tar" -C "$omni" 'Zotero_linux-*/omni.ja' 'Zotero_linux-*/app/omni.ja'
    for o in "$omni"/Zotero_linux-*/omni.ja "$omni"/Zotero_linux-*/app/omni.ja; do
      unzip -Z1 "$o" | grep -E "(greprefs\.js|defaults/pref[^/]*/.*\.js)$" |
        while read -r f; do unzip -p "$o" "$f"; done
    done | grep -oE '^[[:space:]]*(pref|sticky_pref|lockPref)\([[:space:]]*"[^"]+"' |
      sed -E 's/.*"([^"]+)"/\1/' | sort -u > "$IO/known-prefs-$v.txt"
    if [ ! -f "$IO/template/$v/data.tar" ]; then
      local id
      id=$(run_one seed "$v" "" "seed-$v")
      [ -f "$IO/runs/$id/results/data.tar" ] || die "seeding Zotero $v failed (see $IO/runs/$id)"
      mkdir -p "$IO/template/$v" && cp "$IO/runs/$id/results/data.tar" "$IO/template/$v/data.tar"
    fi
  done
}

# run_one <mode> <version> <xpi or ""> <name>: prints the run's id.
run_one() {
  local mode=$1 v=$2 xpi=$3 name=$4
  local id
  id="$(echo "$name" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-60)-$(date +%Y%m%d-%H%M%S)-$SLOT"
  local dir="$IO/runs/$id" net="atlas-sbx-$SLOT"
  local proxy_ip="10.90.$SLOT.2" zotero_ip="10.90.$SLOT.3"
  mkdir -p "$dir/in" "$dir/results" "$dir/proxy" "$dir/monitor"
  chmod 777 "$dir/results" "$dir/proxy" "$dir/monitor"
  [ -n "$xpi" ] && cp "$xpi" "$dir/in/target.xpi"
  if [ -n "${EXTRA:-}" ]; then mkdir -p "$dir/in/extra" && cp "$EXTRA" "$dir/in/extra/"; fi
  # The menu items Zotero has by itself, from this version's latest baseline run.
  local base
  base=$(ls -d "$IO/runs/baseline-${v}_"* 2> /dev/null | tail -1 || true)
  [ -n "$base" ] && [ -f "$base/results/menus.json" ] && cp "$base/results/menus.json" "$dir/in/menus.json"
  local template=()
  [ "$mode" != seed ] && template=(-v "/io/template/$v/data.tar:/template/data.tar:ro")

  cleanup() {
    "${PM[@]}" logs "atlas-proxy-$SLOT" > "$dir/proxy/proxy.log" 2>&1 || true
    "${PM[@]}" rm -f "atlas-monitor-$SLOT" "atlas-zotero-$SLOT" "atlas-proxy-$SLOT" > /dev/null 2>&1 || true
    "${PM[@]}" network rm -f "$net" > /dev/null 2>&1 || true
  }
  cleanup
  # An internal network: the Zotero container's only neighbour is the proxy.
  "${PM[@]}" network create --internal --disable-dns --subnet "10.90.$SLOT.0/24" "$net" > /dev/null

  "${PM[@]}" run -d --name "atlas-proxy-$SLOT" \
    --network podman --network "$net:ip=$proxy_ip" \
    --cap-drop ALL --security-opt no-new-privileges --memory 1g --pids-limit 256 \
    --user 65534:65534 --entrypoint mitmdump -e HOME=/tmp \
    -v /io/ca:/ca:ro -v "/io/proxy/atlas_log.py:/addon/atlas_log.py:ro" -v "/io/runs/$id/proxy:/log" \
    "$MITM" --listen-host "$proxy_ip" --listen-port 8080 -s /addon/atlas_log.py \
    --set confdir=/ca --set connection_strategy=lazy -q > /dev/null
  sleep 2

  "${PM[@]}" run -d --name "atlas-zotero-$SLOT" \
    --network "$net:ip=$zotero_ip" --dns none \
    --cap-drop ALL --security-opt no-new-privileges --memory 4g --cpus 2 --pids-limit 1024 \
    -e "ATLAS_MODE=$mode" -e "ATLAS_PROXY=$proxy_ip:8080" -e "ATLAS_TIMEOUT=$TIMEOUT" \
    -e "ATLAS_PROMPT=${ATLAS_PROMPT:-accept}" \
    -v "/io/runs/$id/in:/in:ro" -v "/io/runs/$id/results:/results" ${template[@]+"${template[@]}"} \
    "atlas-zotero:$v" > /dev/null

  # Beside it, in its process and network namespaces, allowed only to capture packets.
  "${PM[@]}" run -d --name "atlas-monitor-$SLOT" \
    --pid "container:atlas-zotero-$SLOT" --network "container:atlas-zotero-$SLOT" \
    --user 0 --cap-drop ALL --cap-add NET_RAW --cap-add SETUID --cap-add SETGID \
    --security-opt no-new-privileges \
    -e "ATLAS_PROXY=$proxy_ip:8080" -v "/io/runs/$id/monitor:/log" \
    --entrypoint /sandbox/monitor.sh "atlas-zotero:$v" > /dev/null

  wait_exit "atlas-zotero-$SLOT" $((TIMEOUT + 60)) || echo "sandbox: $id didn't stop in time" >&2
  "${PM[@]}" diff "atlas-zotero-$SLOT" > "$dir/results/fsdiff.txt" 2> /dev/null || true
  "${PM[@]}" logs "atlas-zotero-$SLOT" > "$dir/results/container.log" 2>&1 || true
  cleanup
  printf '{"id":"%s","mode":"%s","zotero":"%s","name":"%s"}\n' "$id" "$mode" "$v" "$name" > "$dir/run.json"
  echo "$id"
}

cmd=${1:-}
case "$cmd" in
  setup) setup ;;
  baseline)
    ensure_machine
    run_one baseline "${2:?zotero version}" "" "baseline-$2"
    ;;
  test)
    ensure_machine
    [ -f "${3:-}" ] || die "no such .xpi: ${3:-}"
    run_one test "${2:?zotero version}" "$3" "${4:-$(basename "$3" .xpi)}"
    ;;
  clicks)
    ensure_machine
    [ -f "${3:-}" ] || die "no such .xpi: ${3:-}"
    run_one clicks "${2:?zotero version}" "$3" "clicks-${4:-$(basename "$3" .xpi)}"
    ;;
  links)
    ensure_machine
    [ -f "${3:-}" ] || die "no such .xpi: ${3:-}"
    run_one links "${2:?zotero version}" "$3" "links-${4:-$(basename "$3" .xpi)}"
    ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ; exit 1 ;;
esac
