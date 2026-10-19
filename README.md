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

### Map view (v2.1)

  * Initial view: a backbone tree computed from the peer graph (one link per
    node, breadth-first from the best-connected node). Selecting a node shows
    all its peer links, and its peers' links faintly (capped at 3000).
  * Dot size follows the peer count; colour follows peer count or address
    height (discrete classes 0, 1, 2, 3, 4, 5–7, 8+).
  * Pan and zoom move the already drawn map with a CSS transform and redraw it
    once when the gesture ends, so weak devices stay smooth.
  * Pinch and drag move and zoom the map itself, never the page. On narrow
    screens node details live in a bottom sheet with a drag handle.
  * Touch devices, and desktops whose OS prefers dark mode, get a pitch-black
    theme.
  * `/bench` times the renderer variants on the current device.

### Data files

`updateGraph.py` writes `web/static/graph.json` (nodes and backbone tree, nodes
referenced by index) and `web/static/links.json` (all peer links), each with a
gzip copy; `/data/<file>` serves them compressed with ETag revalidation.

### Colouring

The map has a "Color by" switch in the bottom-left corner:

  * **Peer count** – the original grey scale.
  * **Address height** – colours each node by the byte following the `02` prefix of its address, i.e. the number of leading zero bits of its public key. Nodes without a known address (synthesised tree ancestors) are grey. In this mode selecting a node keeps the height colours and rings the node and its direct peers.

The choice is remembered in the browser.

## Web server with Docker

The image runs its own yggdrasil node (official release binary) and collects
data through it, re-rendering every `UPDATE_INTERVAL` seconds. Two collectors:

  * `crawl` (default, [`scripts/crawl-peers.py`](scripts/crawl-peers.py)) –
    breadth-first crawl with `debug_remoteGetPeers` (+ `getNodeInfo` for names),
    rendering the real peering graph. Works from any position in the tree.
    A full crawl of a ~10k node network takes on the order of 15 minutes
    (unanswered requests cost the node's 6 s timeout); partial snapshots are
    written every `CRAWL_SNAPSHOT` seconds and rendered as they arrive, and
    progress is logged every `CRAWL_PROGRESS` seconds.
  * `lookups` ([`scripts/getcurrent.py`](scripts/getcurrent.py)) – the original
    spanning-tree view from the node's `lookups` log. Only useful on a hub node:
    lookups travel down the tree towards their target, so a leaf sees almost none.

On first start a config is generated at `/config/yggdrasil.conf` (mode 0600,
contains the node's private key). It is contained by default:

  * `IfName: none` – no TUN interface, so no 200::/7 address or route exists in
    any network namespace; the node only talks to its peers over TCP/TLS.
  * no `Listen` entries and no multicast discovery.
  * peers taken from `YGG_PEERS`.

The file is yours afterwards (HJSON or JSON) and is never rewritten; the
container only enforces `LogLookups: true` and its internal admin socket at
runtime.

### Compose (e.g. Dockge)
Use [`contrib/docker/compose.yaml`](contrib/docker/compose.yaml) together with
[`contrib/docker/.env.example`](contrib/docker/.env.example) saved as `.env`.
The image is built and pushed to `ghcr.io/<owner>/yggdrasil-map` by the
[`Docker image`](.github/workflows/docker.yml) workflow on every push to
`master` (tag `latest`) and on `v*` tags; set `MAP_IMAGE` accordingly.

### Environment
`HOST`, `PORT`, `UPDATE_INTERVAL` (default 600), `YGG_PEERS`,
`COLLECTOR` (`crawl` or `lookups`), `CRAWL_CONCURRENCY` (default 32),
`CRAWL_SNAPSHOT` (default 120), `CRAWL_PROGRESS` (default 30),
`RENDER_CHECK_INTERVAL` (default 30),
`CRAWL_MAX_NODES` (default 0 = unlimited), `CRAWL_NODEINFO` (default 1),
`LAYOUT_PROG` (default neato up to 500 nodes, sfdp above),
`YGG_EMBEDDED` (default 1; 0 to use an external node via `YGG_ADMIN_ENDPOINT`,
`unix:///path` or `tcp://host:port`), `YGG_CONF` (default
`/config/yggdrasil.conf`), `YGG_WARMUP` (seconds before the first collection,
default 60 with the embedded node), `CURRENT_SOURCE` (file or URL to render,
default `current`).
