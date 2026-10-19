#!/usr/bin/env python3
import html
import ipaddress
import json
import urllib.parse
import urllib.request

import graphPlotter

#url = "http://y.yakamo.org:3000/current"
url = "current"


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


def generate_graph(time_limit=60*60*3):
    data = json.loads(read_source(url))["yggnodes"]

    toAdd = []
    for key in data:
        if 'address' not in data[key] or 'coords' not in data[key]:
            continue
        ip = data[key]['address']
        coords = data[key]['coords']
        info = NodeInfo(ip, coords)
        try:
            if 'nodeinfo' in data[key]:
                if 'name' in data[key]['nodeinfo']:
                    label = str(data[key]['nodeinfo']['name'])
                    if len(label) <= 64:
                        info.label = label
        except Exception:
            pass
        info.label = html.escape(info.label)
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

    print('%d nodes, %d edges' % (len(nodes), len(edges)))

    graph = graphPlotter.position_nodes(nodes, edges)
    js = graphPlotter.get_graph_json(graph)

    with open('static/graph.json', 'w', encoding='utf-8') as f:
        f.write(js)


if __name__ == '__main__':
    generate_graph()
