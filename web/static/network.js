"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var nodes = [];
var edges = [];
var canvas = null;
var ctx = null;
var dpr = 1;
var cssWidth = 0, cssHeight = 0;

// View transform: screen = world * view.s + (view.tx, view.ty), in CSS pixels.
// BASE_SCALE is the scale at which nodes are drawn at their nominal size.
var BASE_SCALE = 1.2;
var MIN_SCALE = 1e-4, MAX_SCALE = 40;
var view = {s: BASE_SCALE, tx: 0, ty: 0};

var colorMode = 'peers';   // 'peers' (grey scale by peer count) or 'height' (address height)
var heightRange = {min: 0, max: 0};
var selectedNode = null;
var hoverNode = null;
var theme = {};
var drawPending = false;

// Address height palettes (viridis); the dark one has its two darkest stops
// lifted to >= 3:1 contrast against black (WCAG 1.4.11), the rest unchanged.
var HEIGHT_STOPS_LIGHT = [[0x44, 0x01, 0x54], [0x3b, 0x52, 0x8b], [0x21, 0x91, 0x8c], [0x5e, 0xc9, 0x62], [0xfd, 0xe7, 0x25]];
var HEIGHT_STOPS_DARK  = [[0x78, 0x48, 0x84], [0x43, 0x59, 0x90], [0x21, 0x91, 0x8c], [0x5e, 0xc9, 0x62], [0xfd, 0xe7, 0x25]];

// Hop-distance colours used when a node is selected in peer-count mode
var DEPTH_COLORS = ['#000000', '#096EE8', '#09E8B8', '#36E809', '#ADE809', '#E8B809', '#E87509', '#E83A09', '#E86946', '#E8AC9B', '#E8C9C1'];
var DEPTH_TEXT_LIGHT = ['#000000', '#032247', '#034537', '#0E3D02', '#354703', '#403203', '#3D1F02', '#3B0E02', '#3B0E02', '#3B0E02', '#3B0E02'];

var COLOR_MODE_KEY = 'yggmap.colorMode';
var DARK_QUERY = '(pointer: coarse), (prefers-color-scheme: dark)';
var SHEET_QUERY = '(max-width: 700px)';

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
    var h = hex.replace('#', '');
    return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
}

function rgbToHex(rgb) {
    return '#' + rgb.map(function(c) { return ('0' + Math.round(c).toString(16)).slice(-2); }).join('');
}

function luminance(rgb) {
    var c = rgb.map(function(v) {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Move a colour towards white (dark theme) or black (light theme) until it
// reaches the given contrast against the background, keeping its hue.
function ensureContrast(rgb, bg, ratio) {
    var towards = theme.dark ? 255 : 0;
    for (var t = 0; t <= 1.0001; t += 0.02) {
        var c = rgb.map(function(v) { return v + (towards - v) * t; });
        if (contrast(c, bg) >= ratio)
            return c;
    }
    return [towards, towards, towards];
}

function heightStops() {
    return theme.dark ? HEIGHT_STOPS_DARK : HEIGHT_STOPS_LIGHT;
}

function heightToRgb(h) {
    var stops = heightStops();
    var span = heightRange.max - heightRange.min;
    var t = span > 0 ? (h - heightRange.min) / span : 0;
    var seg = t * (stops.length - 1);
    var idx = Math.min(Math.floor(seg), stops.length - 2);
    var f = seg - idx;
    var a = stops[idx], b = stops[idx + 1];
    return [0, 1, 2].map(function(c) { return Math.round(a[c] + (b[c] - a[c]) * f); });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    theme.dark = v('--theme') == 'dark';
    theme.bg = v('--bg');
    theme.bgRgb = hexToRgb(theme.bg.length == 7 ? theme.bg : (theme.dark ? '#000000' : '#f5f5f5'));
    theme.edge = v('--map-edge');
    theme.edgeHighlight = v('--map-edge-highlight');
    theme.outline = v('--map-outline');
    theme.ring = v('--map-ring');
    theme.peerRing = v('--map-peer-ring');
    theme.unknown = v('--map-unknown');
    var stops = heightStops().map(rgbToHex);
    $('#height-bar').css('background', 'linear-gradient(to right, ' + stops.join(', ') + ')');
}

// ---------------------------------------------------------------------------
// Canvas, view transform and rendering
// ---------------------------------------------------------------------------

function updateCanvasSize() {
    var rect = canvas.getBoundingClientRect();
    cssWidth = rect.width;
    cssHeight = rect.height;
    // HiDPI: render at device resolution, capped at 2x to keep 10k-node frames fast
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
}

function nodeRadius(node) {
    return Math.max(1.5, node.size * view.s / BASE_SCALE);
}

// Screen positions are cached on the nodes for drawing and hit testing
function projectNodes() {
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        n.x = n.wx * view.s + view.tx;
        n.y = n.wy * view.s + view.ty;
        n.radius = nodeRadius(n);
    }
}

function requestDraw() {
    if (drawPending)
        return;
    drawPending = true;
    window.requestAnimationFrame(function() {
        drawPending = false;
        drawNetwork();
    });
}

function drawNetwork() {
    projectNodes();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    var pad = 50;
    var minX = -pad, minY = -pad, maxX = cssWidth + pad, maxY = cssHeight + pad;
    function visible(n) {
        return n.x + n.radius >= minX && n.x - n.radius <= maxX && n.y + n.radius >= minY && n.y - n.radius <= maxY;
    }

    // Edges: one path for all normal edges, one for highlighted ones
    var highlighted = [];
    var edgeCount = 0;
    ctx.beginPath();
    for (var i = 0; i < edges.length; ++i) {
        var e = edges[i], a = e.sourceNode, b = e.targetNode;
        if ((a.x < minX && b.x < minX) || (a.x > maxX && b.x > maxX) ||
            (a.y < minY && b.y < minY) || (a.y > maxY && b.y > maxY))
            continue;
        if (a.hover || b.hover || a === selectedNode || b === selectedNode) {
            highlighted.push(e);
            continue;
        }
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        edgeCount++;
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.edge;
    // Thousands of overlapping edges merge into a solid blob; fade them with
    // the number on screen (down to 30%) so structure stays visible
    ctx.globalAlpha = Math.max(0.3, Math.min(1, 6000 / Math.max(1, edgeCount)));
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (highlighted.length) {
        ctx.beginPath();
        for (var i = 0; i < highlighted.length; ++i) {
            var e = highlighted[i];
            ctx.moveTo(e.sourceNode.x, e.sourceNode.y);
            ctx.lineTo(e.targetNode.x, e.targetNode.y);
        }
        ctx.strokeStyle = theme.edgeHighlight;
        ctx.stroke();
    }

    // Nodes: one path per fill colour; outlines in one more path (dark theme)
    var groups = {};
    var outlined = [];
    var drawOutlines = theme.outline && theme.outline != 'transparent';
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        if (!visible(n))
            continue;
        (groups[n.color] || (groups[n.color] = [])).push(n);
        if (drawOutlines && n.radius >= 3)
            outlined.push(n);
    }
    for (var color in groups) {
        var list = groups[color];
        ctx.beginPath();
        for (var i = 0; i < list.length; ++i) {
            var n = list[i];
            ctx.moveTo(n.x + n.radius, n.y);
            ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        }
        ctx.fillStyle = color;
        ctx.fill();
    }
    if (outlined.length) {
        ctx.beginPath();
        for (var i = 0; i < outlined.length; ++i) {
            var n = outlined[i];
            ctx.moveTo(n.x + n.radius + 0.5, n.y);
            ctx.arc(n.x, n.y, n.radius + 0.5, 0, Math.PI * 2);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = theme.outline;
        ctx.stroke();
    }

    // In height mode the fill carries the height, so the selection and its
    // direct peers are marked with rings instead of recolouring.
    if (colorMode == 'height' && selectedNode) {
        ctx.beginPath();
        for (var i = 0; i < selectedNode.peers.length; ++i) {
            var p = selectedNode.peers[i];
            ctx.moveTo(p.x + p.radius + 1.5, p.y);
            ctx.arc(p.x, p.y, p.radius + 1.5, 0, Math.PI * 2);
        }
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = theme.peerRing;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(selectedNode.x, selectedNode.y, selectedNode.radius + 2.5, 0, Math.PI * 2);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = theme.ring;
        ctx.stroke();
        ctx.lineWidth = 1;
    }

    // Labels: only where there is room (zoomed in), plus selection and hover
    ctx.textAlign = 'center';
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        if (!(n.radius > 4 || n.selected || n.hover) || !visible(n))
            continue;
        var fontPx = Math.max(10, (4 + n.radius * 0.4) * 4 / 3);
        ctx.font = fontPx + 'px "Ubuntu Mono", monospace';
        ctx.fillStyle = n.textColor;
        ctx.fillText(n.label, n.x, n.y - n.radius - 2);
    }
}

// Area of the canvas not covered by the bottom sheet
function visibleArea() {
    var h = cssHeight;
    if (isSheetLayout()) {
        // Target height of the sheet, not its animated current height
        h = Math.max(80, cssHeight - sheetHeights()[sheetState]);
    }
    return {w: cssWidth, h: h};
}

// Centre the layout. Graphs up to 300 nodes keep the original 1.2x scale;
// larger ones (sfdp layouts span tens of thousands of points) are fitted,
// with labels appearing as you zoom in.
function fitToView() {
    if (nodes.length == 0)
        return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nodes.length; ++i) {
        minX = Math.min(minX, nodes[i].wx); maxX = Math.max(maxX, nodes[i].wx);
        minY = Math.min(minY, nodes[i].wy); maxY = Math.max(maxY, nodes[i].wy);
    }
    var area = visibleArea();
    var pad = 40;
    var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    var s = BASE_SCALE;
    if (nodes.length > 300)
        s = Math.min((area.w - 2 * pad) / w, (area.h - 2 * pad) / h, BASE_SCALE);
    view.s = s;
    view.tx = (area.w - w * s) / 2 - minX * s;
    view.ty = (area.h - h * s) / 2 - minY * s;
}

function zoomAt(x, y, factor) {
    var s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.s * factor));
    factor = s / view.s;
    view.tx = x - (x - view.tx) * factor;
    view.ty = y - (y - view.ty) * factor;
    view.s = s;
    requestDraw();
}

// Pan so a node lies inside the area not covered by the sheet
function ensureVisible(node) {
    var area = visibleArea();
    var x = node.wx * view.s + view.tx, y = node.wy * view.s + view.ty;
    var m = 40;
    if (x >= m && x <= area.w - m && y >= m && y <= area.h - m)
        return;
    view.tx += area.w / 2 - x;
    view.ty += area.h / 2 - y;
    requestDraw();
}

// Nearest node within its radius, or within a minimum hit radius for fingers
function getNodeAt(x, y, minHit) {
    var best = null, bestDist = Infinity;
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        var r = Math.max(n.radius + 1, minHit || 0);
        var dx = n.x - x, dy = n.y - y;
        var d = dx * dx + dy * dy;
        if (d <= r * r && d < bestDist) {
            best = n;
            bestDist = d;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Colours per mode, selection
// ---------------------------------------------------------------------------

function changeHash(hash) {
    window.location.replace(('' + window.location).split('#')[0] + '#' + hash);
}

function searchNode(id) {
    for (var i = 0; i < nodes.length; ++i) {
        if (nodes[i].id == id)
            return nodes[i];
    }
    return null;
}

function computeHeightRange() {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < nodes.length; ++i) {
        var h = nodes[i].height;
        if (h == null) continue;
        if (h < min) min = h;
        if (h > max) max = h;
    }
    if (min === Infinity) { min = 0; max = 0; }
    heightRange = {min: min, max: max};
    $('#height-min').text(min);
    $('#height-max').text(max);
}

function applyColorMode() {
    for (var i = 0; i < nodes.length; ++i) {
        var node = nodes[i];
        if (colorMode == 'height') {
            if (node.height == null) {
                node.originalColor = theme.unknown;
                node.originalTextColor = theme.dark ? '#BBBBBB' : '#777777';
            } else {
                var rgb = heightToRgb(node.height);
                node.originalColor = rgbToHex(rgb);
                node.originalTextColor = rgbToHex(ensureContrast(rgb, theme.bgRgb, 4.5));
            }
        } else if (theme.dark) {
            // Inverted grey scale: most connected nodes brightest
            var inv = hexToRgb(node.peerColor).map(function(c) { return 255 - c; });
            node.originalColor = rgbToHex(inv);
            node.originalTextColor = node.originalColor;
        } else {
            node.originalColor = node.peerColor;
            node.originalTextColor = node.peerColor;
        }
    }
    $('#height-legend').toggle(colorMode == 'height');

    if (selectedNode) {
        var sel = selectedNode;
        clearNodes(true);
        selectNode(sel, false, true);
    } else {
        for (var i = 0; i < nodes.length; ++i) {
            nodes[i].color = nodes[i].originalColor;
            nodes[i].textColor = nodes[i].originalTextColor;
        }
    }
}

function setColorMode(mode) {
    colorMode = mode;
    try {
        window.localStorage.setItem(COLOR_MODE_KEY, mode);
    } catch (e) { /* storage unavailable, mode just won't persist */ }
    applyColorMode();
    requestDraw();
}

function clearNodes(keepPanel) {
    if (!keepPanel) {
        changeHash('');
        $('#node-info').html('');
    }
    for (var i = 0; i < nodes.length; ++i) {
        var node = nodes[i];
        node.depth = 0xFFFF;
        node.color = node.originalColor;
        node.textColor = node.originalTextColor;
        node.selected = false;
    }
    selectedNode = null;
}

function selectNode(node, redraw, keepView) {
    if (!node)
        return;
    clearNodes(true);
    changeHash(node.id);
    node.selected = true;
    selectedNode = node;
    showNodeInfo(node);
    if (colorMode != 'height')
        markPeers(node, 0);
    if (isSheetLayout() && sheetState == 'collapsed')
        setSheet('half');
    if (!keepView)
        ensureVisible(node);
    if (redraw)
        requestDraw();
}

// Colour nodes by hop distance from the selected node (iterative BFS)
function markPeers(start) {
    var queue = [start];
    start.depth = 0;
    for (var qi = 0; qi < queue.length; ++qi) {
        var node = queue[qi];
        var depth = node.depth;
        if (theme.dark) {
            node.color = depth == 0 ? '#FFFFFF' : (depth >= DEPTH_COLORS.length ? '#333333' : DEPTH_COLORS[depth]);
            node.textColor = node.color;
        } else {
            node.color = depth >= DEPTH_COLORS.length ? '#FFFFFF' : DEPTH_COLORS[depth];
            node.textColor = depth >= DEPTH_TEXT_LIGHT.length ? '#FFFFFF' : DEPTH_TEXT_LIGHT[depth];
        }
        for (var i = 0; i < node.peers.length; ++i) {
            var n = node.peers[i];
            if (n.depth > depth + 1) {
                n.depth = depth + 1;
                queue.push(n);
            }
        }
    }
}

// Address with its height byte (last two hex digits of the first group)
// coloured in the node's height colour, readable on the panel background.
function formatAddress(id, height) {
    var m = /^([23])([0-9a-f]{2})(:.*)$/i.exec(id);
    if (!m || height == null)
        return '<span class="addr">' + id + '</span>';
    var rgb = ensureContrast(heightToRgb(height), theme.bgRgb, 4.5);
    return '<span class="addr">' + m[1] + '<span class="hb" style="color:' + rgbToHex(rgb) + '">' +
        m[2] + '</span>' + m[3] + '</span>';
}

function showNodeInfo(node) {
    var ip_peers = [];
    var dns_peers = [];

    for (var i = 0; i < node.peers.length; ++i) {
        var n = node.peers[i];
        if (/^[0-9A-F]{4}$/i.test(n.label))
            ip_peers.push(n);
        else
            dns_peers.push(n);
    }

    var label_compare = function(a, b) {
        return a.label.localeCompare(b.label);
    };
    dns_peers.sort(label_compare);
    ip_peers.sort(label_compare);
    var peers = dns_peers.concat(ip_peers);

    var html =
        '<h2>' + node.label + '</h2>' +
        '<span class="node-addr">' + formatAddress(node.id, node.height) + '</span>' +
        '<div class="facts">' +
        (node.coords ? '<strong>Coords:</strong> ' + node.coords + '<br>' : '') +
        '<strong>Peers:</strong> ' + node.peers.length + '<br>' +
        '<strong>Centrality:</strong> ' + node.centrality + '<br>' +
        '<strong>Address height:</strong> ' + (node.height == null ? 'unknown' : node.height) +
        '</div>' +
        '<div class="peers">' +
        peers.map(function(n) {
            return '<a class="peer" href="#' + n.id + '">' +
                '<span class="peer-name">' + n.label + '</span>' +
                '<span class="peer-count">' + n.peers.length + '</span>' +
                (n.id.charAt(0) == '?' ? '' : formatAddress(n.id, n.height)) + '</a>';
        }).join('') +
        '</div>';

    $('#node-info').html(html).scrollTop(0);
}

// ---------------------------------------------------------------------------
// Bottom sheet (narrow screens)
// ---------------------------------------------------------------------------

var sheetState = 'collapsed';

function isSheetLayout() {
    return window.matchMedia(SHEET_QUERY).matches;
}

function sheetHeights() {
    var handle = document.getElementById('sheet-handle');
    var search = document.getElementById('search-wrapper');
    var collapsed = handle.offsetHeight + search.offsetHeight +
        parseFloat(getComputedStyle(search).marginBottom || 0) + 4;
    var avail = window.innerHeight - 48;
    return {
        collapsed: collapsed,
        half: Math.max(collapsed, Math.round(avail * 0.45)),
        full: Math.max(collapsed, Math.round(avail * 0.9))
    };
}

function setSheetHeight(px) {
    document.getElementById('sidebar').style.setProperty('--sheet-height', px + 'px');
}

function setSheet(state) {
    if (!isSheetLayout())
        return;
    sheetState = state;
    setSheetHeight(sheetHeights()[state]);
}

function initSheet() {
    var sidebar = document.getElementById('sidebar');
    var handle = document.getElementById('sheet-handle');
    var drag = null;

    handle.addEventListener('pointerdown', function(e) {
        if (!isSheetLayout())
            return;
        handle.setPointerCapture(e.pointerId);
        drag = {y: e.clientY, h: sidebar.getBoundingClientRect().height, moved: false};
        sidebar.classList.add('dragging');
        e.preventDefault();
    });
    handle.addEventListener('pointermove', function(e) {
        if (!drag)
            return;
        var dy = drag.y - e.clientY;
        if (Math.abs(dy) > 6)
            drag.moved = true;
        var hs = sheetHeights();
        setSheetHeight(Math.max(hs.collapsed, Math.min(hs.full, drag.h + dy)));
    });
    function end(e) {
        if (!drag)
            return;
        sidebar.classList.remove('dragging');
        var hs = sheetHeights();
        if (!drag.moved) {
            setSheet(sheetState == 'collapsed' ? 'half' : 'collapsed');
        } else {
            // Snap to the nearest of the three positions
            var h = sidebar.getBoundingClientRect().height;
            var best = 'collapsed';
            ['half', 'full'].forEach(function(s) {
                if (Math.abs(hs[s] - h) < Math.abs(hs[best] - h))
                    best = s;
            });
            setSheet(best);
        }
        drag = null;
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', function(e) {
        if (e.key == 'Enter' || e.key == ' ') {
            setSheet(sheetState == 'collapsed' ? 'half' : 'collapsed');
            e.preventDefault();
        }
    });

    // Suggestions open downwards, so give the search the full sheet height
    $('#search-box').on('focus', function() {
        if (isSheetLayout())
            setSheet('full');
    });

    setSheet('collapsed');
}

// ---------------------------------------------------------------------------
// Input: Pointer Events (mouse, touch, pen) and wheel
// ---------------------------------------------------------------------------

function canvasPos(e) {
    var rect = canvas.getBoundingClientRect();
    return {x: e.clientX - rect.left, y: e.clientY - rect.top};
}

function setHover(node) {
    if (node === hoverNode)
        return;
    if (hoverNode)
        hoverNode.hover = false;
    hoverNode = node;
    if (node)
        node.hover = true;
    canvas.style.cursor = node ? 'pointer' : '';
    requestDraw();
}

function initInput() {
    var pointers = {};      // pointerId -> {x, y}
    var gesture = null;     // {type: 'pan'|'pinch', ...}
    var tap = null;         // candidate tap: {x, y, id, touch}

    function pointerList() {
        return Object.keys(pointers).map(function(k) { return pointers[k]; });
    }

    function startGesture() {
        var ps = pointerList();
        if (ps.length >= 2) {
            var a = ps[0], b = ps[1];
            gesture = {
                type: 'pinch',
                dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
                mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}
            };
            tap = null;
        } else if (ps.length == 1) {
            gesture = {type: 'pan', last: {x: ps[0].x, y: ps[0].y}};
        } else {
            gesture = null;
        }
    }

    canvas.addEventListener('pointerdown', function(e) {
        if (e.pointerType == 'mouse' && e.button != 0)
            return;
        // Touching the map closes the on-screen keyboard
        if (document.activeElement && document.activeElement.id == 'search-box')
            document.activeElement.blur();
        canvas.setPointerCapture(e.pointerId);
        var p = canvasPos(e);
        pointers[e.pointerId] = p;
        if (Object.keys(pointers).length == 1)
            tap = {x: p.x, y: p.y, id: e.pointerId, touch: e.pointerType != 'mouse'};
        startGesture();
        e.preventDefault();
    });

    canvas.addEventListener('pointermove', function(e) {
        var p = canvasPos(e);
        if (!(e.pointerId in pointers)) {
            // Mouse hovering without a button pressed
            if (e.pointerType == 'mouse')
                setHover(getNodeAt(p.x, p.y, 0));
            return;
        }
        pointers[e.pointerId] = p;
        if (tap && e.pointerId == tap.id &&
            Math.hypot(p.x - tap.x, p.y - tap.y) > (tap.touch ? 10 : 3))
            tap = null;
        if (!gesture)
            return;
        if (gesture.type == 'pinch') {
            var ps = pointerList();
            var a = ps[0], b = ps[1];
            var dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
            var mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
            // Pan with the midpoint, zoom around it
            view.tx += mid.x - gesture.mid.x;
            view.ty += mid.y - gesture.mid.y;
            zoomAt(mid.x, mid.y, dist / gesture.dist);
            gesture.dist = dist;
            gesture.mid = mid;
        } else if (!tap) {
            view.tx += p.x - gesture.last.x;
            view.ty += p.y - gesture.last.y;
            gesture.last = p;
            canvas.style.cursor = 'move';
            requestDraw();
        }
    });

    function endPointer(e, cancelled) {
        if (!(e.pointerId in pointers))
            return;
        var p = canvasPos(e);
        delete pointers[e.pointerId];
        if (!cancelled && tap && e.pointerId == tap.id) {
            var node = getNodeAt(p.x, p.y, tap.touch ? 16 : 0);
            if (node) {
                selectNode(node, true, true);
            } else {
                clearNodes();
                if (isSheetLayout())
                    setSheet('collapsed');
                requestDraw();
            }
        }
        if (e.pointerId === (tap && tap.id))
            tap = null;
        canvas.style.cursor = hoverNode ? 'pointer' : '';
        // Two fingers -> one: continue as a pan from the remaining finger
        startGesture();
    }
    canvas.addEventListener('pointerup', function(e) { endPointer(e, false); });
    canvas.addEventListener('pointercancel', function(e) { endPointer(e, true); });
    canvas.addEventListener('pointerleave', function(e) {
        if (e.pointerType == 'mouse' && !(e.pointerId in pointers))
            setHover(null);
    });

    // Mouse wheel and trackpad pinch (sent as wheel events with ctrlKey)
    canvas.addEventListener('wheel', function(e) {
        e.preventDefault();
        var p = canvasPos(e);
        var dy = e.deltaY * (e.deltaMode == 1 ? 16 : (e.deltaMode == 2 ? cssHeight : 1));
        var k = e.ctrlKey ? 0.01 : 0.0029;   // ~4/3 per notch of a normal wheel
        zoomAt(p.x, p.y, Math.exp(-dy * k));
    }, {passive: false});
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

$(document).ready(function() {
    canvas = document.getElementById('map');
    ctx = canvas.getContext('2d');
    try {
        var stored = window.localStorage.getItem(COLOR_MODE_KEY);
        if (stored == 'peers' || stored == 'height')
            colorMode = stored;
    } catch (e) { /* storage unavailable, keep default */ }

    readTheme();
    updateCanvasSize();
    initSheet();
    initInput();

    $(window).resize(function() {
        updateCanvasSize();
        if (isSheetLayout())
            setSheet(sheetState);
        requestDraw();
    });
    var darkMql = window.matchMedia(DARK_QUERY);
    var onThemeChange = function() {
        readTheme();
        applyColorMode();
        if (selectedNode)
            showNodeInfo(selectedNode);
        requestDraw();
    };
    if (darkMql.addEventListener)
        darkMql.addEventListener('change', onThemeChange);
    else if (darkMql.addListener)
        darkMql.addListener(onThemeChange);

    $('#update-time').text('loading map…');
    jQuery.getJSON('/static/graph.json', function(data) {
        nodes = data.nodes;
        edges = data.edges;

        for (var i = 0; i < nodes.length; ++i) {
            var node = nodes[i];
            node.wx = node.x;
            node.wy = node.y;
            node.hover = false;
            node.selected = false;
            node.edges = [];
            node.peers = [];
            node.depth = 0xFFFF;
            node.peerColor = node.color;
        }

        // Resolve edge endpoints through an id map (O(E) instead of O(E*N))
        var byId = {};
        for (var i = 0; i < nodes.length; ++i)
            byId[nodes[i].id] = nodes[i];
        var newEdges = [];
        for (var i = 0; i < edges.length; ++i) {
            var edge = edges[i];
            edge.sourceNode = byId[edge.sourceID];
            edge.targetNode = byId[edge.targetID];
            if (!edge.sourceNode || !edge.targetNode)
                continue;
            edge.sourceNode.edges.push(edge);
            edge.targetNode.edges.push(edge);
            edge.sourceNode.peers.push(edge.targetNode);
            edge.targetNode.peers.push(edge.sourceNode);
            newEdges.push(edge);
        }
        edges = newEdges;

        computeHeightRange();
        fitToView();

        var delta = Math.round(new Date().getTime() / 1000) - data.created;
        var min = Math.floor(delta / 60);
        var sec = delta % 60;
        $('#update-time').text(min + ' min, ' + sec + ' s ago');
        $('#number-of-nodes').text(nodes.length);
        $('#number-of-connections').text(edges.length);

        $('#color-mode').val(colorMode).change(function() {
            setColorMode($(this).val());
        });
        applyColorMode();

        if (window.location.hash) {
            var node = searchNode(window.location.hash.substring(1));
            if (node) selectNode(node, false);
        }

        requestDraw();

        var searchArray = [];
        for (var i = 0; i < nodes.length; ++i) {
            searchArray.push({value: nodes[i].label, data: nodes[i]});
            searchArray.push({value: nodes[i].id, data: nodes[i]});
        }
        $('#search-box').autocomplete({
            lookup: searchArray,
            autoSelectFirst: true,
            lookupLimit: 7,
            onSelect: function(suggestion) {
                selectNode(suggestion.data, true);
                $('#search-box').blur();
                if (isSheetLayout())
                    setSheet('half');
            }
        });
        $('#search-box').keypress(function(e) {
            if (e.which == 13)
                selectNode(searchNode($('#search-box').val()), true);
        });

        $(document).on('click', '#node-info a.peer', function(e) {
            e.preventDefault();
            selectNode(searchNode(this.getAttribute('href').substring(1)), true);
        });
    }).fail(function(xhr) {
        $('#update-time').text(xhr.status == 404
            ? 'never (no map rendered yet, check back in a few minutes)'
            : 'failed to load map (HTTP ' + xhr.status + ')');
    });
});
