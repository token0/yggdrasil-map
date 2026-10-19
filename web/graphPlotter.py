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


def to_networkx(G):
    ng = nx.Graph()
    ng.add_nodes_from(G.nodes())
    ng.add_edges_from(G.edges())
    return ng


def compute_betweenness(ng):
    # Exact betweenness is O(n*m); sample pivots on large graphs. Only used to
    # size the dots, so a sampled estimate is enough.
    k = None if ng.number_of_nodes() <= 1000 else 200
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


FIELDS = ['id', 'label', 'x', 'y', 'size', 'height', 'degree', 'centrality', 'coords']


def export_graph(G, nodes, full_edges, tree_edges, mode):
    """Build the compact map data.

    Returns (graph_json, links_json):
      graph.json: {"version": 2, "created", "mode", "fields", "nodes": [[...], ...],
                   "maxDegree", "tree": [i0, j0, i1, j1, ...]}
      links.json: {"created", "links": [i0, j0, ...]}   (all peer links)
    Nodes are referenced by their index in "nodes". Circle size follows the
    peer count (area proportional to degree); centrality is informational.
    """
    created = int(time.time())
    ids = [n.name for n in G.iternodes()]
    index = {ip: i for i, ip in enumerate(ids)}

    full = nx.Graph()
    full.add_nodes_from(ids)
    full.add_edges_from((e.a.ip, e.b.ip) for e in full_edges)
    degree = dict(full.degree())
    max_degree = max([1] + list(degree.values()))
    print('Max neighbors: %d' % max_degree)
    centralities = compute_betweenness(full)
    db = load_db()

    out_nodes = []
    for n in G.iternodes():
        attr = n.attr
        pos = attr['pos'].split(',', 1)
        name = db.get(canonalize_ip(n.name))
        label = attr['label']
        # If label isn't the default value, use it as the name
        if label != n.name.split(':')[-1]:
            name = label
        height = attr.get('height_addr')
        deg = degree.get(n.name, 0)
        size = 2 + 12 * (deg / float(max_degree)) ** 0.5
        out_nodes.append([
            n.name,
            name if name else label,
            round(float(pos[0]), 1),
            round(float(pos[1]), 1),
            round(size, 2),
            int(height) if height else None,
            deg,
            round(centralities.get(n.name, 0), 4),
            attr['coords'] or '',
        ])

    def pairs(edges):
        flat = []
        for e in edges:
            a, b = index.get(e.a.ip), index.get(e.b.ip)
            if a is not None and b is not None and a != b:
                flat += (a, b)
        return flat

    graph = {
        'version': 2,
        'created': created,
        'mode': mode,
        'fields': FIELDS,
        'maxDegree': max_degree,
        'nodes': out_nodes,
        'tree': pairs(tree_edges),
    }
    links = {'created': created, 'links': pairs(full_edges)}
    return (json.dumps(graph, separators=(',', ':')),
            json.dumps(links, separators=(',', ':')))


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
