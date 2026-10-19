#!/usr/bin/env python3
"""Crawl the yggdrasil peering graph through a node's admin socket.

Starting from the node behind ENDPOINT, every discovered key is asked for its
peers with debug_remoteGetPeers (breadth-first) and, optionally, for its
NodeInfo. Unlike the 'lookups' request this does not depend on where the
crawling node sits in the spanning tree.

Usage: crawl-peers.py [ENDPOINT]     unix:///path/to.sock or tcp://host:port

Output (stdout): {"yggnodes": {key: {"address", "peers", "nodeinfo"?, "time"}}}
Nodes that never answered appear only inside other nodes' "peers" lists.

Environment:
  CRAWL_CONCURRENCY   parallel remote requests (default 16)
  CRAWL_MAX_NODES     stop querying after this many keys, 0 = unlimited (default 0)
  CRAWL_NODEINFO      1 = also fetch NodeInfo for node names (default 1)
"""
import ipaddress
import json
import os
import socket
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

DEFAULT_ENDPOINT = "unix:///run/yggdrasil/yggdrasil.sock"
SOCKET_TIMEOUT = 15  # the node itself gives up on remote requests after 6 s


def parse_endpoint(endpoint):
    u = urllib.parse.urlparse(endpoint)
    if u.scheme == "tcp":
        host = u.hostname or "localhost"
        return (socket.AF_INET6 if ":" in host else socket.AF_INET), (host, u.port or 9001)
    if u.scheme in ("unix", ""):
        return socket.AF_UNIX, u.path or endpoint
    raise ValueError("unsupported admin endpoint: %s" % endpoint)


class Admin:
    def __init__(self, endpoint):
        self.family, self.addr = parse_endpoint(endpoint)

    def request(self, name, **args):
        """Return the 'response' object of one admin request, or raise."""
        req = {"keepalive": True, "request": name}
        if args:
            req["arguments"] = args
        with socket.socket(self.family, socket.SOCK_STREAM) as s:
            s.settimeout(SOCKET_TIMEOUT)
            s.connect(self.addr)
            s.sendall(json.dumps(req).encode("utf-8"))
            buf = b""
            decoder = json.JSONDecoder()
            while True:
                frag = s.recv(65536)
                if not frag:
                    break
                buf += frag
                if buf.endswith(b"\n"):
                    try:
                        res, _ = decoder.raw_decode(buf.decode("utf-8").strip())
                        break
                    except ValueError:
                        continue
            else:
                res = json.loads(buf.decode("utf-8"))
        if res.get("status") != "success":
            raise RuntimeError(res.get("error", "unknown error"))
        return res["response"]


def addr_for_key(key_hex):
    """Port of yggdrasil-go src/address/address.go AddrForKey."""
    buf = bytes(~b & 0xFF for b in bytes.fromhex(key_hex))
    done, ones, bits, nbits, temp = False, 0, 0, 0, bytearray()
    for idx in range(8 * len(buf)):
        bit = (buf[idx // 8] >> (7 - idx % 8)) & 1
        if not done and bit:
            ones += 1
            continue
        if not done and not bit:
            done = True
            continue
        bits = ((bits << 1) | bit) & 0xFF
        nbits += 1
        if nbits == 8:
            nbits = 0
            temp.append(bits)
    return str(ipaddress.IPv6Address((bytes([0x02, ones]) + bytes(temp))[:16]))


def crawl(admin, concurrency, max_nodes, with_nodeinfo):
    self_info = admin.request("getSelf")
    self_key = self_info["key"]
    nodes = {}
    lock = threading.Lock()
    queued = {self_key}
    stats = {"ok": 0, "failed": 0}

    def visit(key):
        entry = {"address": addr_for_key(key), "time": int(time.time())}
        try:
            if key == self_key:
                peers = admin.request("getPeers")["peers"]
                entry["peers"] = sorted({p["key"] for p in peers if p.get("up", True) and p.get("key")})
            else:
                res = admin.request("debug_remoteGetPeers", key=key)
                entry["peers"] = sorted(set(next(iter(res.values()), {}).get("keys") or []))
        except Exception:
            with lock:
                stats["failed"] += 1
            return []
        if with_nodeinfo:
            try:
                res = admin.request("getNodeInfo", key=key)
                info = next(iter(res.values()), None)
                if isinstance(info, dict):
                    entry["nodeinfo"] = info
            except Exception:
                pass
        with lock:
            nodes[key] = entry
            stats["ok"] += 1
        return entry["peers"]

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        pending = {pool.submit(visit, self_key)}
        while pending:
            done = {f for f in pending if f.done()}
            if not done:
                time.sleep(0.05)
                continue
            pending -= done
            for f in done:
                for peer in f.result():
                    with lock:
                        if peer in queued or (max_nodes and len(queued) >= max_nodes):
                            continue
                        queued.add(peer)
                    pending.add(pool.submit(visit, peer))
    return nodes, stats, len(queued)


def main():
    endpoint = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ENDPOINT
    concurrency = int(os.environ.get("CRAWL_CONCURRENCY", "16"))
    max_nodes = int(os.environ.get("CRAWL_MAX_NODES", "0"))
    with_nodeinfo = os.environ.get("CRAWL_NODEINFO", "1") == "1"
    started = time.time()
    try:
        nodes, stats, queued = crawl(Admin(endpoint), concurrency, max_nodes, with_nodeinfo)
    except Exception as e:
        print("crawl: failed: %s" % e, file=sys.stderr)
        return 1
    print(json.dumps({"yggnodes": nodes}))
    print("crawl: %d nodes answered, %d did not, %d keys seen, %.0f s"
          % (stats["ok"], stats["failed"], queued, time.time() - started), file=sys.stderr)
    return 0 if nodes else 1


if __name__ == "__main__":
    sys.exit(main())
