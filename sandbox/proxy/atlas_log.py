"""mitmproxy addon for the sandbox: log every request as a JSON line, and refuse destinations on
this computer or a private network (the host Mac, its LAN), so a plugin can only reach the
public internet. Loaded with `mitmdump -s atlas_log.py`; writes /log/flows.jsonl."""

import ipaddress
import json
import socket
import time

from mitmproxy import http

LOG = "/log/flows.jsonl"
CGNAT = ipaddress.ip_network("100.64.0.0/10")
BODY_BYTES = 2000


def write(record: dict) -> None:
    record["t"] = round(time.time(), 3)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def refused(host: str) -> str | None:
    """The first address of `host` that isn't on the public internet, if any."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
            or (ip.version == 4 and ip in CGNAT)
        ):
            return str(ip)
    return None


def body(message) -> str:
    raw = message.raw_content or b""
    return raw[:BODY_BYTES].decode("utf-8", "replace")


class AtlasLog:
    def http_connect(self, flow: http.HTTPFlow) -> None:
        host = flow.request.host
        ip = refused(host)
        write({"kind": "connect", "host": host, "port": flow.request.port, "refused": ip})
        if ip:
            flow.response = http.Response.make(403, b"refused by the sandbox")

    def request(self, flow: http.HTTPFlow) -> None:
        req = flow.request
        ip = refused(req.host)
        write(
            {
                "kind": "request",
                "id": flow.id,
                "method": req.method,
                "url": req.pretty_url,
                "host": req.pretty_host,
                "scheme": req.scheme,
                "contentType": req.headers.get("content-type"),
                "userAgent": req.headers.get("user-agent"),
                "bodyBytes": len(req.raw_content or b""),
                "body": body(req),
                "refused": ip,
            }
        )
        if ip:
            flow.response = http.Response.make(403, b"refused by the sandbox")

    def response(self, flow: http.HTTPFlow) -> None:
        res = flow.response
        write(
            {
                "kind": "response",
                "id": flow.id,
                "status": res.status_code,
                "contentType": res.headers.get("content-type"),
                "bodyBytes": len(res.raw_content or b""),
            }
        )

    def error(self, flow: http.HTTPFlow) -> None:
        write({"kind": "error", "id": flow.id, "error": str(flow.error)})

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        write({"kind": "websocket", "id": flow.id, "url": flow.request.pretty_url})

    def tls_failed_client(self, data) -> None:
        write({"kind": "tls-failed", "sni": getattr(data.context.client, "sni", None)})


addons = [AtlasLog()]
