# Yggdrasil map

  * Internet: https://yggdrasil-map.cwinfo.net
  * Hyperboria: https://yggdrasil-map.h.cwinfo.net
  * Yggdrasil Network: https://yggdrasil-map.y.cwinfo.net

Forked from the code for http://www.fc00.org (http://h.fc00.org on Hyperboria).

## Sending your view of the network

This code reads a map of known nodes from `y.yakamo.org:3000/current` (reachable over yggdrasil). You may alternatively generate your own view of the network by running [a crawler script](scripts/crawl-dht.py), but this may take some time (figuring out how to run it and use the results is left as an exercise to the user).

## Web server
Requires Python 3 and Graphviz (with headers, to build `pygraphviz`).
```bash
git clone https://github.com/Arceliar/yggdrasil-map.git
sudo apt-get install graphviz libgraphviz-dev

cd yggdrasil-map/web
pip install -r requirements.txt
cp web_config.example.cfg web_config.cfg
python3 web.py
```

Use `--host`/`--port` to adjust the address/port the server listens on (default `localhost:3000`). Note that most of the options in web_config.cfg are unused after forking from the fc00.org code, so this is mostly just a workaround until we have time to clean up this code.

Run `web/updateGraph.py` periodically to rerender nodes graph. It reads crawler output from `web/current` (a local path or URL, see `url` in `updateGraph.py`). You may want to customize reverse-proxy IP retrieval logic in web.py.

### Colouring

The map has a "Color by" switch in the bottom-left corner:

  * **Peer count** – the original grey scale.
  * **Address height** – colours each node by the byte following the `02` prefix of its address, i.e. the number of leading zero bits of its public key. Nodes without a known address (synthesised tree ancestors) are grey. In this mode selecting a node keeps the height colours and rings the node and its direct peers.

The choice is remembered in the browser.

## Web server with Docker

The image runs its own yggdrasil node (official release binary) and collects
data from it with the `lookups` admin request, re-rendering every
`UPDATE_INTERVAL` seconds.

On first start a config is generated at `/config/yggdrasil.conf` (mode 0600,
contains the node's private key). It is contained by default:

  * `IfName: none` – no TUN interface, so no 200::/7 address or route exists in
    any network namespace; the node only talks to its peers over TCP/TLS.
  * no `Listen` entries and no multicast discovery.
  * peers taken from `YGG_PEERS`.

The file is yours afterwards (HJSON or JSON) and is never rewritten; the
container only enforces `LogLookups: true` and its internal admin socket at
runtime. Note that `lookups` only records lookups that pass through this node,
so a leaf node sees a small part of the network.

### Compose (e.g. Dockge)
Use [`contrib/docker/compose.yaml`](contrib/docker/compose.yaml) together with
[`contrib/docker/.env.example`](contrib/docker/.env.example) saved as `.env`.
The image is built and pushed to `ghcr.io/<owner>/yggdrasil-map` by the
[`Docker image`](.github/workflows/docker.yml) workflow on every push to
`master` (tag `latest`) and on `v*` tags; set `MAP_IMAGE` accordingly.

### Environment
`HOST`, `PORT`, `UPDATE_INTERVAL` (default 600), `YGG_PEERS`,
`YGG_EMBEDDED` (default 1; 0 to use an external node via `YGG_ADMIN_ENDPOINT`,
`unix:///path` or `tcp://host:port`), `YGG_CONF` (default
`/config/yggdrasil.conf`), `YGG_WARMUP` (seconds before the first collection,
default 60 with the embedded node), `CURRENT_SOURCE` (file or URL to render,
default `current`).
