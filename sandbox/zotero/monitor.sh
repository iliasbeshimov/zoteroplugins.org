#!/bin/bash
# Runs beside the Zotero container, in its process and network namespaces, with only the
# capability to capture packets. Records every process, listening socket and connection attempt
# the proxy doesn't see (anything not sent to it, loopback included).
#   ATLAS_PROXY  host:port of the proxy, whose traffic is left out
set -u
L=/log
HOST=${ATLAS_PROXY%:*}
tcpdump -i any -nn -l -p -tttt -Z root \
  "not (host $HOST and tcp port ${ATLAS_PROXY#*:}) and ((tcp[tcpflags] & (tcp-syn) != 0 and tcp[tcpflags] & (tcp-ack) == 0) or udp)" \
  > "$L/connections.txt" 2> "$L/tcpdump.err" &
while :; do
  echo "--- $(date +%s.%N)" >> "$L/processes.txt"
  ps -eo pid,ppid,user,args --no-headers >> "$L/processes.txt" 2> /dev/null
  echo "--- $(date +%s.%N)" >> "$L/listening.txt"
  ss -ltnupH >> "$L/listening.txt" 2> /dev/null
  sleep 0.5
done
