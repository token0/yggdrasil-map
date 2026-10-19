#!/usr/bin/env python3
import gzip
import html
import ipaddress
import json
import os
import urllib.parse
import urllib.request
from collections import deque

import graphPlotter

# Crawler output: local file path or URL (e.g. "http://y.yakamo.org:3000/current")
url = os.environ.get("CURRENT_SOURCE", "current")


def read_source(src):
    """Read crawler output from a URL or, if src has no scheme, a local file."""
    if urllib.parse.urlparse(src).scheme:
        with urllib.request.urlopen(src) as response:
            return response.read().decode("utf-8")
    with open(src, "r", encoding="utf-8") as f:
        return f.read()


def address_height(ip):
    """Return the Yggdrasil address height, or None if ip is not a 200::/7 address.

    The byte following the 0x02/0x03 prefix is the number of leading 1-bits of the
    bitwise-inverted public key (i.e. leading zero bits of the key), see
    yggdrasil-go src/address/address.go AddrForKey.
    """
    try:
        packed = ipaddress.IPv6Address(ip).packed
    except ValueError:
        return None
    if packed[0] & 0xFE != 0x02:
        return None
    return packed[1]


# nodes indexed by coords
class NodeInfo:
    def __init__(self, ip, coords):
        self.ip = str(ip)
        self.label = str(ip).split(":")[-1]
        self.coords = str(coords)
        self.version = "unknown"
        self.height = address_height(self.ip)

    def getCoordList(self):
        return self.coords.strip("[]").split(" ")

    def getParent(self):
        p = self.getCoordList()
        if len(p) > 0:
            p = p[:-1]
        return "[" + " ".join(p).strip() + "]"

    def getLink(self):
        return int(self.getCoordList()[-1].strip() or "0")


class LinkInfo:
    def __init__(self, a, b):
        self.a = a  # NodeInfo
        self.b = b  # NodeInfo


def node_label(entry, default):
    """Label from NodeInfo 'name' if present and sane, html-escaped."""
    label = default
    try:
        name = entry.get('nodeinfo', {}).get('name')
        if name is not None and len(str(name)) <= 64:
            label = str(name)
    except Exception:
        pass
    return html.escape(label)


def build_peer_graph(data):
    """Nodes and undirected edges from crawler output with 'peers' lists."""
    nodes = dict()

    def get_node(key):
        if key not in nodes:
            entry = data.get(key, {})
            address = entry.get('address') or address_for_key(key)
            info = NodeInfo(address, '')
            info.label = node_label(entry, info.label)
            nodes[key] = info
        return nodes[key]

    edges = dict()
    for key, entry in data.items():
        a = get_node(key)
        for peer in entry.get('peers') or []:
            if peer == key:
                continue
            b = get_node(peer)
            edges[tuple(sorted((key, peer)))] = LinkInfo(a, b)
    return {n.ip: n for n in nodes.values()}, list(edges.values())


def address_for_key(key_hex):
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


def generate_graph(time_limit=60*60*3):
    data = json.loads(read_source(url))["yggnodes"]

    if any('peers' in entry for entry in data.values()):
        # Crawler output (scripts/crawl-peers.py): all peer links, drawn as a
        # backbone tree with the full link set available on selection
        nodes, edges = build_peer_graph(data)
        write_graph(nodes, edges, backbone_tree(nodes, edges), 'peers')
        return

    toAdd = []
    for key in data:
        if 'address' not in data[key] or 'coords' not in data[key]:
            continue
        ip = data[key]['address']
        coords = data[key]['coords']
        info = NodeInfo(ip, coords)
        info.label = node_label(data[key], info.label)
        toAdd.append(info)

    nodes = dict()

    def addAncestors(info):
        coords = info.getParent()
        parent = NodeInfo("{} {}".format("?", coords), coords)
        parent.label = parent.ip
        nodes[parent.coords] = parent
        if parent.coords != parent.getParent():
            addAncestors(parent)

    for info in toAdd:
        addAncestors(info)
    for info in toAdd:
        nodes[info.coords] = info

    sortedNodes = sorted(nodes.values(), key=(lambda x: x.getLink()))
    #for node in sortedNodes: print(node.ip, node.coords, node.getParent(), node.getLink())

    edges = []
    for node in sortedNodes:
        if node.coords == node.getParent():
            continue  # root has no parent
        edges.append(LinkInfo(node, nodes[node.getParent()]))

    # lookups data is already a tree: the tree and the full link set coincide
    write_graph(nodes, edges, edges, 'tree')


def backbone_tree(nodes, edges):
    """Breadth-first spanning tree of the peer graph, one per component.

    Each component is rooted at its best-connected node, and neighbours are
    visited best-connected first, so the tree follows the shortest hop paths
    from the hubs. Every tree link is a real peering. This approximates, but
    is not, yggdrasil's own spanning tree, whose parent links are not exposed
    by the remote debug API.
    """
    adjacency = {ip: [] for ip in nodes}
    for e in edges:
        adjacency[e.a.ip].append(e.b.ip)
        adjacency[e.b.ip].append(e.a.ip)
    degree = {ip: len(peers) for ip, peers in adjacency.items()}
    order = lambda ip: (-degree[ip], ip)
    for ip in adjacency:
        adjacency[ip].sort(key=order)

    visited = set()
    tree = []
    for root in sorted(nodes, key=order):
        if root in visited:
            continue
        visited.add(root)
        queue = deque([root])
        while queue:
            u = queue.popleft()
            for v in adjacency[u]:
                if v not in visited:
                    visited.add(v)
                    tree.append(LinkInfo(nodes[u], nodes[v]))
                    queue.append(v)
    return tree


def write_atomic(path, text):
    """Write text and a gzip copy atomically, so a half-written file is never served."""
    data = text.encode('utf-8')
    with open(path + '.tmp', 'wb') as f:
        f.write(data)
    with open(path + '.gz.tmp', 'wb') as f:
        f.write(gzip.compress(data, compresslevel=6, mtime=0))
    os.replace(path + '.gz.tmp', path + '.gz')
    os.replace(path + '.tmp', path)


def write_graph(nodes, full_edges, tree_edges, mode):
    print('%d nodes, %d edges' % (len(nodes), len(full_edges)))

    # Lay out on the tree only: a readable tree shape, as in upstream
    graph = graphPlotter.position_nodes(nodes, tree_edges)
    graph_json, links_json = graphPlotter.export_graph(graph, nodes, full_edges, tree_edges, mode)

    # links.json first: the page loads graph.json first and links.json after,
    # and checks that both carry the same 'created' stamp
    write_atomic('static/links.json', links_json)
    write_atomic('static/graph.json', graph_json)
    print('wrote graph.json (%d KB) and links.json (%d KB)'
          % (len(graph_json) // 1024, len(links_json) // 1024))


if __name__ == '__main__':
    generate_graph()
