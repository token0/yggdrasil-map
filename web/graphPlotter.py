import json
import os
import time
import urllib.request

import networkx as nx
import pygraphviz as pgv
from networkx.algorithms import centrality

NODELIST_URL = "https://raw.githubusercontent.com/yakamok/yggdrasil-nodelist/master/nodelist"


def position_nodes(nodes, edges):
    G = pgv.AGraph(strict=True, directed=False, size='10!')

    for n in nodes.values():
        attrs = {'label': n.label, 'coords': n.coords}
        if n.height is not None:
            attrs['height_addr'] = str(n.height)
        G.add_node(n.ip, **attrs)

    for e in edges:
        G.add_edge(e.a.ip, e.b.ip, len=1.0)

    # neato gives the nicest result but scales badly; sfdp handles thousands of nodes
    prog = os.environ.get('LAYOUT_PROG') or ('neato' if len(nodes) <= 500 else 'sfdp')
    if prog == 'neato':
        G.layout(prog='neato', args='-Gepsilon=0.0001 -Gmaxiter=100000')
    else:
        G.layout(prog=prog, args='-Goverlap=scale')

    return G


def compute_betweenness(G):
    ng = nx.Graph()
    for start in G.iternodes():
        for other in G.neighbors(start):
            ng.add_edge(start, other)

    # Exact betweenness is O(n*m); sample pivots on large graphs
    k = None if ng.number_of_nodes() <= 1000 else 500
    return centrality.betweenness_centrality(ng, k=k, seed=1)


def canonalize_ip(ip):
    return ':'.join(i.rjust(4, '0') for i in ip.split(':'))


def load_db():
    #with open('nodedb/nodes') as f:
    #    return dict([ (canonalize_ip(v[0]), v[1]) for v in [ l.split(None)[:2] for l in f.readlines() ] if len(v) > 1 ])
    try:
        with urllib.request.urlopen(NODELIST_URL, timeout=10) as f:
            lines = f.read().decode('utf-8', 'replace').splitlines()
    except Exception as e:
        print('Warning: could not load node list (%s), continuing without it' % e)
        return {}
    return dict((canonalize_ip(v[0]), v[1])
                for v in (l.split(None)[:2] for l in lines) if len(v) > 1)


def get_graph_json(G):
    max_neighbors = 1
    for n in G.iternodes():
        neighbors = len(G.neighbors(n))
        if neighbors > max_neighbors:
            max_neighbors = neighbors
    print('Max neighbors: %d' % max_neighbors)

    out_data = {
        'created': int(time.time()),
        'nodes': [],
        'edges': []
    }

    centralities = compute_betweenness(G)
    db = load_db()

    for n in G.iternodes():
        neighbor_ratio = len(G.neighbors(n)) / float(max_neighbors)
        pos = n.attr['pos'].split(',', 1)
        centrality = centralities.get(n.name, 0)
        size = 5*(1 + 1*centrality)
        name = db.get(canonalize_ip(n.name))
        # If label isn't the default value, set name to that instead
        if n.attr['label'] != n.name.split(':')[-1]:
            name = n.attr['label']
        height = n.attr.get('height_addr')

        out_data['nodes'].append({
            'id': n.name,
            'label': name if name else n.attr['label'],
            'name': name,
            'coords': n.attr['coords'],
            'x': float(pos[0]),
            'y': float(pos[1]),
            'color': _gradient_color(neighbor_ratio, [(100, 100, 100), (0, 0, 0)]),
            'size': size,
            'centrality': '%.4f' % centrality,
            'height': int(height) if height else None
        })

    for e in G.iteredges():
        out_data['edges'].append({
            'sourceID': e[0],
            'targetID': e[1]
        })

    return json.dumps(out_data)


def _gradient_color(ratio, colors):
    jump = 1.0 / (len(colors) - 1)
    gap_num = int(ratio / (jump + 0.0000001))

    a = colors[gap_num]
    b = colors[gap_num + 1]

    ratio = (ratio - gap_num * jump) * (len(colors) - 1)

    r = a[0] + (b[0] - a[0]) * ratio
    g = a[1] + (b[1] - a[1]) * ratio
    b = a[2] + (b[2] - a[2]) * ratio

    return '#%02x%02x%02x' % (int(r), int(g), int(b))
