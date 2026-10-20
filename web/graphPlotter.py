import hashlib
import json
import math
import os
import time
from collections import defaultdict
import urllib.request

import networkx as nx
import pygraphviz as pgv
from networkx.algorithms import centrality

NODELIST_URL = "https://raw.githubusercontent.com/yakamok/yggdrasil-nodelist/master/nodelist"


def _new_graph(nodes):
    G = pgv.AGraph(strict=True, directed=False, size='10!')
    for n in nodes.values():
        attrs = {'label': n.label, 'coords': n.coords}
        if n.height is not None:
            attrs['height_addr'] = str(n.height)
        G.add_node(n.ip, **attrs)
    return G


def position_nodes(nodes, edges):
    """Lay out the (tree) graph and return a pygraphviz graph with 'pos' set.

    Up to CLUSTER_MIN nodes: graphviz on the whole tree (neato), as upstream.
    Larger maps: cluster_layout(), which keeps every node distinguishable.
    """
    prog = os.environ.get('LAYOUT_PROG')
    if len(nodes) > CLUSTER_MIN and prog in (None, '', 'cluster'):
        return cluster_layout(nodes, edges)

    G = _new_graph(nodes)
    for e in edges:
        G.add_edge(e.a.ip, e.b.ip, len=1.0)
    prog = prog or ('neato' if len(nodes) <= 500 else 'sfdp')
    if prog == 'neato':
        G.layout(prog='neato', args='-Gepsilon=0.0001 -Gmaxiter=100000')
    else:
        G.layout(prog=prog, args='-Goverlap=scale')
    return G


# Cluster layout -------------------------------------------------------------
#
# In a peer graph's backbone tree most nodes (~75-80%) are leaves hanging off
# a few hubs; a force-directed layout packs a hub's hundreds of leaves into a
# solid disk. Instead:
#   1. the skeleton (all non-leaf tree nodes) is laid out with sfdp,
#   2. each skeleton node becomes a disk big enough to hold its leaves on
#      concentric rings spaced LEAF_SPACING apart,
#   3. overlapping disks are pushed apart,
#   4. leaves are placed on the rings around their parent.
# Every leaf then sits LEAF_SPACING from its neighbours, so zooming in always
# separates them. World units: 1 = LEAF_SPACING.

CLUSTER_MIN = 500
LEAF_SPACING = 1.0
FIRST_RING = 1.3       # radius of the innermost ring (parent dot sits inside)
NODE_RADIUS = 0.6      # disk radius of a skeleton node without leaves
DISK_GAP = 0.8         # minimum free space between neighbouring disks


def _ring_capacity(r):
    return max(6, int(2 * math.pi * r / LEAF_SPACING))


def _first_ring(degree):
    # Hubs are drawn as bigger dots: start their innermost ring further out so
    # no leaf hides under the hub's own dot
    return FIRST_RING + 0.3 * math.sqrt(degree)


def _rings(count, first=FIRST_RING):
    """Radii and sizes of the rings holding `count` leaves, inner first."""
    rings, r = [], first
    while count > 0:
        k = min(count, _ring_capacity(r))
        rings.append((r, k))
        count -= k
        r += LEAF_SPACING
    return rings


def _stable_hash(text):
    # Stable across runs (the built-in hash() of str is randomized per process)
    return int(hashlib.sha1(text.encode()).hexdigest()[:8], 16)


def _stable_order(ip):
    # Deterministic pseudo-random order, so colours are not banded by sort key
    return _stable_hash(ip)


def _relax_overlaps(pos, radius, iterations=600):
    """Push disks apart until no two overlap (or the iteration limit)."""
    ids = list(pos)
    if len(ids) < 2:
        return 0
    cell = 2 * sorted(radius.values())[len(ids) // 2] + DISK_GAP
    for it in range(iterations):
        grid = defaultdict(list)
        for i in ids:
            x, y = pos[i]
            r = radius[i] + DISK_GAP / 2
            for cx in range(int(math.floor((x - r) / cell)), int(math.floor((x + r) / cell)) + 1):
                for cy in range(int(math.floor((y - r) / cell)), int(math.floor((y + r) / cell)) + 1):
                    grid[(cx, cy)].append(i)
        moves = defaultdict(lambda: [0.0, 0.0])
        seen = set()
        overlaps = 0
        for members in grid.values():
            for a_i in range(len(members)):
                a = members[a_i]
                for b in members[a_i + 1:]:
                    key = (a, b) if a < b else (b, a)
                    if key in seen:
                        continue
                    seen.add(key)
                    (ax, ay), (bx, by) = pos[a], pos[b]
                    dx, dy = bx - ax, by - ay
                    dist = math.hypot(dx, dy)
                    need = radius[a] + radius[b] + DISK_GAP
                    if dist >= need:
                        continue
                    # Only intrusions deeper than half the gap count towards
                    # convergence: shallower ones cannot make dots collide
                    if dist < need - DISK_GAP / 2:
                        overlaps += 1
                    if dist < 1e-9:
                        ang = (_stable_hash(a + b) % 6283) / 1000.0
                        dx, dy, dist = math.cos(ang), math.sin(ang), 1.0
                    push = (need - dist) / dist
                    # The bigger disk moves less
                    wa = radius[b] ** 2 / (radius[a] ** 2 + radius[b] ** 2)
                    wb = 1 - wa
                    moves[a][0] -= dx * push * wa
                    moves[a][1] -= dy * push * wa
                    moves[b][0] += dx * push * wb
                    moves[b][1] += dy * push * wb
        if overlaps == 0:
            return it
        if it == iterations - 1:
            print('cluster layout: %d disks still closer than half the gap after %d iterations' % (overlaps, iterations))
        for i, (mx, my) in moves.items():
            pos[i] = (pos[i][0] + mx * 0.9, pos[i][1] + my * 0.9)
    return iterations


def cluster_layout(nodes, edges):
    started = time.time()
    adj = defaultdict(set)
    for e in edges:
        if e.a.ip != e.b.ip:
            adj[e.a.ip].add(e.b.ip)
            adj[e.b.ip].add(e.a.ip)

    # Leaves: tree degree 1. In a two-node component keep one as skeleton.
    leaves_of = defaultdict(list)
    is_leaf = set()
    for ip in nodes:
        if len(adj[ip]) == 1:
            parent = next(iter(adj[ip]))
            if len(adj[parent]) == 1 and parent > ip:
                continue
            is_leaf.add(ip)
            leaves_of[parent].append(ip)
    skeleton = [ip for ip in nodes if ip not in is_leaf]

    radius = {}
    for ip in skeleton:
        rings = _rings(len(leaves_of[ip]), _first_ring(len(adj[ip])))
        radius[ip] = (rings[-1][0] + LEAF_SPACING / 2) if rings else NODE_RADIUS

    # 1. Skeleton layout
    S = pgv.AGraph(strict=True, directed=False)
    for ip in skeleton:
        S.add_node(ip)
    skel_edges = [(a, b) for a in skeleton for b in adj[a] if b not in is_leaf and a < b]
    for a, b in skel_edges:
        S.add_edge(a, b)
    if len(skeleton) > 1:
        S.layout(prog='sfdp' if len(skeleton) > 300 else 'neato', args='-Goverlap=true')
        pos = {}
        for n in S.iternodes():
            x, y = n.attr['pos'].split(',')[:2]
            pos[n.name] = (float(x), float(y))
    else:
        pos = {ip: (0.0, 0.0) for ip in skeleton}

    # 2. Scale so that linked disks roughly touch, then 3. remove overlaps
    # (by edge length), but at least so the bounding box offers room for all
    # disks at ~45% packing density; relaxation then only fixes local overlaps
    lengths = sorted(math.dist(pos[a], pos[b]) for a, b in skel_edges) or [1.0]
    targets = sorted(radius[a] + radius[b] + DISK_GAP for a, b in skel_edges) or [1.0]
    f = targets[len(targets) // 2] / max(1e-9, lengths[len(lengths) // 2])
    xs = [x for x, y in pos.values()]
    ys = [y for x, y in pos.values()]
    box = max(1e-9, (max(xs) - min(xs)) * (max(ys) - min(ys)))
    disks = sum(math.pi * (r + DISK_GAP / 2) ** 2 for r in radius.values())
    f = max(f, math.sqrt(disks / 0.45 / box))
    pos = {ip: (x * f, y * f) for ip, (x, y) in pos.items()}
    iterations = _relax_overlaps(pos, radius)

    # 4. Leaves on rings around their parent
    for parent, leaves in leaves_of.items():
        px, py = pos[parent]
        leaves.sort(key=_stable_order)
        i = 0
        for r, k in _rings(len(leaves), _first_ring(len(adj[parent]))):
            offset = (_stable_hash(parent) % 1000) / 1000.0 * 2 * math.pi / k
            for j in range(k):
                ang = offset + 2 * math.pi * j / k
                pos[leaves[i]] = (px + r * math.cos(ang), py + r * math.sin(ang))
                i += 1

    G = _new_graph(nodes)
    for e in edges:
        G.add_edge(e.a.ip, e.b.ip)
    # Positions in points, y up as graphviz reports them
    scale = 20.0
    for n in G.iternodes():
        x, y = pos[n.name]
        n.attr['pos'] = '%.2f,%.2f' % (x * scale, y * scale)
    print('cluster layout: %d skeleton nodes, %d leaves, relaxed in %d iterations, %.1f s'
          % (len(skeleton), len(is_leaf), iterations, time.time() - started))
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
