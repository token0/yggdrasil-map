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

The image collects data itself from the local node's admin socket using the
`lookups` request, which requires `LogLookups: true` in the yggdrasil config.
It then re-renders every `UPDATE_INTERVAL` seconds.

### Compose (e.g. Dockge)
Use [`contrib/docker/compose.yaml`](contrib/docker/compose.yaml) together with
[`contrib/docker/.env.example`](contrib/docker/.env.example) saved as `.env`.
Compose builds the image directly from the git URL in `MAP_GIT_CONTEXT`, so no
local checkout is needed.

### Plain docker
From the repository root:
```bash
sudo docker build -f contrib/docker/Dockerfile -t yggdrasil-map .
sudo docker run --name yggdrasil-map -d --restart always \
  -v /var/run/yggdrasil:/run/yggdrasil:ro -p 127.0.0.1:3000:3000 yggdrasil-map
```

Environment: `HOST`, `PORT`, `UPDATE_INTERVAL` (default 600),
`YGG_ADMIN_ENDPOINT` (`unix:///path` or `tcp://host:port`, empty to skip
collection), `CURRENT_SOURCE` (file or URL to render, default `current`).
