#!/usr/bin/env python3
"""Manage the embedded yggdrasil node's configuration.

  ygg-config.py generate CONF    create CONF with a fresh key and contained defaults
                                 (skipped if CONF already exists)
  ygg-config.py runtime CONF OUT write the config the daemon actually runs with

The user-owned CONF (HJSON or JSON) is never modified after creation. The
runtime config is CONF normalised by `yggdrasil -normaliseconf`, with only the
settings the map depends on enforced on top.

Environment:
  YGG_PEERS          peers for a newly generated config, separated by spaces/commas
  YGG_ADMIN_SOCKET   admin socket path inside the container
"""
import json
import os
import re
import subprocess
import sys

ADMIN_SOCKET = os.environ.get("YGG_ADMIN_SOCKET", "/run/yggdrasil/yggdrasil.sock")


def yggdrasil(*args):
    return subprocess.run(["yggdrasil", *args], check=True, capture_output=True, text=True).stdout


def generate(conf):
    if os.path.exists(conf):
        print("ygg-config: using existing %s" % conf)
        return
    cfg = json.loads(yggdrasil("-genconf", "-json"))
    cfg.update({
        # Contained by default: no TUN (no 200::/7 address in any kernel),
        # no inbound listeners, no multicast peer discovery on the container network.
        "IfName": "none",
        "Listen": [],
        "MulticastInterfaces": [],
        "Peers": [p for p in re.split(r"[\s,]+", os.environ.get("YGG_PEERS", "")) if p],
        "LogLookups": True,
        "AdminListen": "unix://" + ADMIN_SOCKET,
    })
    tmp = conf + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)  # contains the private key
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    os.replace(tmp, conf)
    print("ygg-config: generated %s with %d peer(s)" % (conf, len(cfg["Peers"])))
    if not cfg["Peers"]:
        print("ygg-config: warning: no peers configured, the node will stay isolated", file=sys.stderr)


def runtime(conf, out):
    cfg = json.loads(yggdrasil("-useconffile", conf, "-normaliseconf", "-json"))
    # Required by the map: lookups logging and the admin socket the collector uses
    cfg["LogLookups"] = True
    cfg["AdminListen"] = "unix://" + ADMIN_SOCKET
    os.makedirs(os.path.dirname(ADMIN_SOCKET), exist_ok=True)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)
    print("ygg-config: runtime config ready (IfName=%s, %d peer(s), %d listener(s))"
          % (cfg.get("IfName"), len(cfg.get("Peers") or []), len(cfg.get("Listen") or [])))


def main():
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "generate":
            generate(sys.argv[2])
        elif len(sys.argv) == 4 and sys.argv[1] == "runtime":
            runtime(sys.argv[2], sys.argv[3])
        else:
            print(__doc__, file=sys.stderr)
            return 2
    except subprocess.CalledProcessError as e:
        print("ygg-config: yggdrasil failed: %s" % (e.stderr or e).strip(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
