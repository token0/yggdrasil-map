#!/usr/bin/env python3
"""Dump the nodes recorded by the yggdrasil 'lookups' admin request as map input.

Usage:
  getcurrent.py                      # default unix socket
  getcurrent.py ENDPOINT             # unix:///path/to.sock, tcp://host:port or a socket path
  getcurrent.py HOST PORT            # TCP admin endpoint

'lookups' is only available when the node runs with "LogLookups: true" in its
config. Output is printed to stdout in the {"yggnodes": {...}} format that
web/updateGraph.py reads.
"""
import json
import socket
import sys
import urllib.parse

DEFAULT_ENDPOINT = "unix:///var/run/yggdrasil/yggdrasil.sock"
TIMEOUT = 10


def parse_endpoint(args):
    if len(args) == 2:
        return socket.AF_INET6 if ":" in args[0] else socket.AF_INET, (args[0], int(args[1]))
    endpoint = args[0] if args else DEFAULT_ENDPOINT
    u = urllib.parse.urlparse(endpoint)
    if u.scheme == "tcp":
        host = u.hostname or "localhost"
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        return family, (host, u.port or 9001)
    if u.scheme == "unix":
        return socket.AF_UNIX, u.path
    if u.scheme == "":
        return socket.AF_UNIX, endpoint
    raise ValueError("unsupported admin endpoint: %s" % endpoint)


def do_request(family, addr, request):
    """Send one request and return the decoded response object."""
    with socket.socket(family, socket.SOCK_STREAM) as s:
        s.settimeout(TIMEOUT)
        s.connect(addr)
        s.sendall(json.dumps(request).encode("utf-8"))
        buf = b""
        decoder = json.JSONDecoder()
        while True:
            frag = s.recv(65536)
            if not frag:
                break
            buf += frag
            # The admin socket writes one newline-terminated JSON object per request
            if buf.endswith(b"\n"):
                try:
                    obj, _ = decoder.raw_decode(buf.decode("utf-8").strip())
                    return obj
                except ValueError:
                    continue  # newline inside a partial object, keep reading
        if not buf:
            raise ConnectionError("admin socket closed without a response")
        return json.loads(buf.decode("utf-8"))


def main():
    try:
        family, addr = parse_endpoint(sys.argv[1:])
        res = do_request(family, addr, {"keepalive": True, "request": "lookups"})
    except Exception as e:
        print("getcurrent: request failed: %s" % e, file=sys.stderr)
        return 1

    if res.get("status") != "success":
        print("getcurrent: admin socket returned an error: %s "
              "(is LogLookups enabled in the node config?)" % res.get("error", res),
              file=sys.stderr)
        return 1

    infos = dict()
    for node in res["response"].get("infos") or []:
        coords = json.dumps(node["path"]).replace(",", " ")
        infos[node["key"]] = {"address": node["addr"], "coords": coords, "time": node["time"]}

    print(json.dumps({"yggnodes": infos}))
    print("getcurrent: %d nodes" % len(infos), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
