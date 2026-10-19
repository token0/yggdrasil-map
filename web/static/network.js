"use strict";

// yggdrasil-map front end.
//
// Rendering model (raster cache):
//   * #map (base layer): tree links and nodes, drawn only when the view is at
//     rest. #overlay: selection, second ring, hover; cheap to redraw.
//   * Both canvases sit in #map-layer, which is larger than the viewport by a
//     margin on every side. During a pan/zoom gesture nothing is redrawn: the
//     layer is moved and scaled with a CSS transform by the compositor. When
//     the gesture ends, both layers are redrawn once for the new view.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var nodes = [];             // {i, id, label, wx, wy, size, height, degree, centrality, coords, ...}
var treeEdges = [];         // [nodeA, nodeB] pairs of the backbone tree (always drawn)
var treeAdj = [];           // per node index: neighbours in the tree
var fullAdj = null;         // per node index: all peers, once links.json is loaded
var linksLoaded = false;
var maxDegree = 1;
var dataCreated = 0;

var wrapper, layer, baseCanvas, overlayCanvas, baseCtx, overlayCtx;
var vw = 0, vh = 0;         // viewport (CSS px)
var mx = 0, my = 0;         // layer margin beyond the viewport (CSS px)
var MARGIN = 0.25;          // margin as a fraction of the viewport size
var dpr = 1;
var dprLocked = false;      // set once the adaptive resolution has been decided

// View transform: screen = world * view.s + (view.tx, view.ty), screen in CSS
// px relative to the viewport. renderedView is the view the bitmaps show.
var BASE_SCALE = 1.2;
var MIN_SCALE = 1e-5, MAX_SCALE = 60;
var view = {s: BASE_SCALE, tx: 0, ty: 0};
var renderedView = null;
var gestureActive = false;
var renderPending = false, overlayPending = false;

var colorMode = 'peers';
var selectedNode = null;
var hoverNode = null;
var ring2 = null;           // {pairs: [[a,b],...], truncated: bool, total: n} for the selection
var RING2_LIMIT = 3000;
var theme = {};
var grid = null;            // spatial index for hit testing

// Dot sizes: R0 px at the reference (fitted) zoom, scaled by the peer count,
// growing with zoom as (zoom / reference)^SIZE_EXP: slower than the map
// itself, so neighbours separate as you zoom in
var refScale = 1, R0 = 4, SIZE_EXP = 0.6;
var R_MIN = 1.5, R_MAX = 48;

// Address height filter: non-matching nodes are dimmed, matching ones listed
var filter = {min: 0, max: 0, active: false};
var maxHeight = 0;
var hasUnknownHeight = false;
var FILTER_KEY = 'yggmap.heightFilter';
var FILTER_LIST_LIMIT = 300;

var COLOR_MODE_KEY = 'yggmap.colorMode';
var DARK_QUERY = '(pointer: coarse), (prefers-color-scheme: dark)';
var SHEET_QUERY = '(max-width: 700px)';

// Address height classes. Every colour has >= 3.9:1 contrast against its
// theme background (WCAG) and the closest two colours are >= 18 CIEDE2000
// apart (23 on black), so neighbouring classes are clearly distinct.
var HEIGHT_CLASSES = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 7], [8, 11], [12, 255]];
var HEIGHT_CLASS_LABELS = ['0', '1', '2', '3', '4', '5–7', '8–11', '12+'];
var HEIGHT_COLORS_DARK  = ['#8A8A8A', '#4F8CFF', '#16D4E8', '#3DDC6A', '#F0E442', '#FF9922', '#FF4F79', '#C77DFF'];
var HEIGHT_COLORS_LIGHT = ['#7A7A7A', '#1F5FD6', '#00818F', '#178A3E', '#8C7A00', '#C25E00', '#D11A4A', '#8A3FD1'];

// Hop-distance colours used when a node is selected in peer-count mode
var DEPTH_COLORS = ['#000000', '#096EE8', '#09E8B8', '#36E809', '#ADE809', '#E8B809', '#E87509', '#E83A09', '#E86946', '#E8AC9B', '#E8C9C1'];
var DEPTH_TEXT_LIGHT = ['#000000', '#032247', '#034537', '#0E3D02', '#354703', '#403203', '#3D1F02', '#3B0E02', '#3B0E02', '#3B0E02', '#3B0E02'];

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

function heightClass(h) {
    if (h == null) return -1;
    for (var i = 0; i < HEIGHT_CLASSES.length; ++i)
        if (h >= HEIGHT_CLASSES[i][0] && h <= HEIGHT_CLASSES[i][1]) return i;
    return HEIGHT_CLASSES.length - 1;
}

function heightColor(h) {
    var c = heightClass(h);
    if (c < 0) return null;
    return (theme.dark ? HEIGHT_COLORS_DARK : HEIGHT_COLORS_LIGHT)[c];
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    theme.dark = v('--theme') == 'dark';
    var bg = v('--bg');
    theme.bgRgb = hexToRgb(bg.length == 7 ? bg : (theme.dark ? '#000000' : '#f5f5f5'));
    theme.edge = v('--map-edge');
    theme.edgeHighlight = v('--map-edge-highlight');
    theme.ring2 = v('--map-ring2');
    theme.outline = v('--map-outline');
    theme.ring = v('--map-ring');
    theme.peerRing = v('--map-peer-ring');
    theme.unknown = v('--map-unknown');
    theme.label = v('--map-label');
    theme.labelHalo = v('--map-label-halo');
    theme.coarse = window.matchMedia('(pointer: coarse)').matches;
    buildLegend();
}

// Legend chips double as a quick filter: tap a class to show only it
function buildLegend() {
    var colors = theme.dark ? HEIGHT_COLORS_DARK : HEIGHT_COLORS_LIGHT;
    var html = HEIGHT_CLASS_LABELS.map(function(label, i) {
        var c = HEIGHT_CLASSES[i];
        var on = filter.active && filter.min == c[0] && filter.max == Math.min(c[1], maxHeight);
        return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-class="' + i + '" title="Show only height ' + label + '">' +
            '<i style="background:' + colors[i] + '"></i>' + label + '</button>';
    }).join('') + (hasUnknownHeight ? '<span class="chip static"><i class="hollow"></i>unknown</span>' : '');
    $('#height-legend').html(html);
}

// ---------------------------------------------------------------------------
// Canvas layers, sizes and resolution
// ---------------------------------------------------------------------------

function resizeLayers() {
    var rect = wrapper.getBoundingClientRect();
    vw = rect.width;
    vh = rect.height;
    mx = Math.round(vw * MARGIN);
    my = Math.round(vh * MARGIN);
    layer.style.left = -mx + 'px';
    layer.style.top = -my + 'px';
    layer.style.width = (vw + 2 * mx) + 'px';
    layer.style.height = (vh + 2 * my) + 'px';
    // The viewport origin, in layer coordinates: gestures scale around it
    layer.style.transformOrigin = mx + 'px ' + my + 'px';
    setCanvasResolution();
}

function setCanvasResolution() {
    var w = Math.round((vw + 2 * mx) * dpr), h = Math.round((vh + 2 * my) * dpr);
    baseCanvas.width = overlayCanvas.width = w;
    baseCanvas.height = overlayCanvas.height = h;
}

// Radius on screen at view scale s.
// Zoomed out (up to the fitted zoom): the small v2.1 dots, so the overview
// stays uncluttered. Zooming in: blend towards the larger, zoom-growing size,
// fully reached at 4x the fitted zoom.
function radiusAt(n, s) {
    var rSmall = Math.max(n.size * s / BASE_SCALE, 1.2 + (n.size - 2) * 0.3);
    var k = s / refScale;
    if (k <= 1)
        return Math.min(R_MAX, rSmall);
    var rLarge = R0 * n.sf * Math.pow(k, SIZE_EXP);
    var t = Math.min(1, Math.log(k) / Math.log(4));
    return Math.max(R_MIN * 0.8, Math.min(R_MAX, rSmall + (rLarge - rSmall) * t));
}

// Reference sizes, fixed at load: R0 follows the average spacing between
// nodes at the fitted zoom (2.5..7 px), so dense maps get small dots and
// sparse ones big dots, and every map starts uncluttered
function computeSizing() {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nodes.length; ++i) {
        minX = Math.min(minX, nodes[i].wx); maxX = Math.max(maxX, nodes[i].wx);
        minY = Math.min(minY, nodes[i].wy); maxY = Math.max(maxY, nodes[i].wy);
    }
    var spacing = Math.sqrt(Math.max(1, (maxX - minX) * (maxY - minY)) / Math.max(1, nodes.length));
    refScale = view.s;
    R0 = Math.max(2.5, Math.min(7, 0.35 * spacing * refScale));
    for (var i = 0; i < nodes.length; ++i)
        nodes[i].sf = 0.8 + 1.6 * Math.sqrt(nodes[i].degree / maxDegree);   // 0.8 .. 2.4
}

function project() {
    var s = view.s, tx = view.tx, ty = view.ty;
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        n.x = n.wx * s + tx;
        n.y = n.wy * s + ty;
        n.r = radiusAt(n, s);
    }
}

function prepareCtx(ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, mx * dpr, my * dpr);
    ctx.clearRect(-mx, -my, vw + 2 * mx, vh + 2 * my);
}

function inBounds(n) {
    return n.x + n.r >= -mx && n.x - n.r <= vw + mx && n.y + n.r >= -my && n.y - n.r <= vh + my;
}

function edgeInBounds(a, b) {
    var x0 = -mx, x1 = vw + mx, y0 = -my, y1 = vh + my;
    return !((a.x < x0 && b.x < x0) || (a.x > x1 && b.x > x1) ||
             (a.y < y0 && b.y < y0) || (a.y > y1 && b.y > y1));
}

// Lines are stroked in chunks: one path per link is slow on draw-call-bound
// browsers, one path for thousands of overlapping translucent links is slow
// on rasterizer-bound ones (the whole union is rasterized at once).
var EDGE_CHUNK = 256;

function strokeLinks(ctx, pairs, style, alpha) {
    ctx.strokeStyle = style;
    ctx.lineWidth = 1;
    ctx.globalAlpha = alpha;
    var count = 0;
    ctx.beginPath();
    for (var i = 0; i < pairs.length; ++i) {
        var a = pairs[i][0], b = pairs[i][1];
        if (!edgeInBounds(a, b))
            continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        if (++count % EDGE_CHUNK == 0) {
            ctx.stroke();
            ctx.beginPath();
        }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    return count;
}

function countVisibleLinks(pairs) {
    var c = 0;
    for (var i = 0; i < pairs.length; ++i)
        if (edgeInBounds(pairs[i][0], pairs[i][1])) c++;
    return c;
}

// Labels in the theme's label colour (white on black) with a dark halo, so
// they stay readable over dots and links of any colour
// Labels arrive HTML-escaped (for the panel); the canvas needs plain text
function decodeEntities(text) {
    return text.indexOf('&') < 0 ? text : text
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
}

function drawLabel(ctx, n, bold) {
    var fontPx = Math.max(theme.coarse ? 12 : 11, Math.min(18, 9 + n.r * 0.5));
    ctx.font = (bold ? 'bold ' : '') + fontPx + 'px "Ubuntu Mono", monospace';
    var y = n.y - n.r - 3;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.labelHalo;
    ctx.strokeText(n.text, n.x, y);
    ctx.fillStyle = theme.label;
    ctx.fillText(n.text, n.x, y);
}

function drawBase() {
    var ctx = baseCtx;
    prepareCtx(ctx);

    // Backbone tree links; fade them when many overlap on screen, and more
    // while a filter puts the focus on the matching nodes
    var visible = countVisibleLinks(treeEdges);
    var linkAlpha = Math.max(0.35, Math.min(1, 8000 / Math.max(1, visible)));
    strokeLinks(ctx, treeEdges, theme.edge, filter.active ? linkAlpha * 0.4 : linkAlpha);

    // Nodes grouped by fill colour: tiny ones as squares (identical at that
    // size, much cheaper than arcs), the rest as circles; hollow = unknown
    var squares = {}, circles = {}, hollow = [], outlined = [], visibleNodes = 0;
    var drawOutlines = theme.outline && theme.outline != 'transparent';
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        if (!inBounds(n))
            continue;
        visibleNodes++;
        // Group key: colour plus dimmed flag; dimmed groups are drawn faint
        var key = n.color + (n.dim ? '|d' : '');
        if (n.hollow) {
            hollow.push(n);
        } else if (n.r < 2.5) {
            (squares[key] || (squares[key] = [])).push(n);
        } else {
            (circles[key] || (circles[key] = [])).push(n);
            if (drawOutlines && n.r >= 4 && !n.dim)
                outlined.push(n);
        }
    }
    // Dimmed nodes first, so matching nodes are drawn on top of them
    var keys = function(groups) {
        return Object.keys(groups).sort(function(a, b) {
            return (b.indexOf('|d') >= 0) - (a.indexOf('|d') >= 0);
        });
    };
    keys(squares).forEach(function(key) {
        var list = squares[key];
        ctx.beginPath();
        for (var i = 0; i < list.length; ++i) {
            var n = list[i];
            ctx.rect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
        }
        ctx.globalAlpha = list[0].dim ? 0.18 : 1;
        ctx.fillStyle = list[0].color;
        ctx.fill();
    });
    keys(circles).forEach(function(key) {
        var list = circles[key];
        ctx.beginPath();
        for (var i = 0; i < list.length; ++i) {
            var n = list[i];
            ctx.moveTo(n.x + n.r, n.y);
            ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        }
        ctx.globalAlpha = list[0].dim ? 0.18 : 1;
        ctx.fillStyle = list[0].color;
        ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (hollow.length) {
        ctx.beginPath();
        for (var i = 0; i < hollow.length; ++i) {
            var n = hollow[i], r = Math.max(1.5, n.r - 0.75);
            ctx.moveTo(n.x + r, n.y);
            ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        }
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = theme.unknown;
        ctx.globalAlpha = filter.active ? 0.18 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
    if (outlined.length) {
        ctx.beginPath();
        for (var i = 0; i < outlined.length; ++i) {
            var n = outlined[i];
            ctx.moveTo(n.x + n.r + 0.5, n.y);
            ctx.arc(n.x, n.y, n.r + 0.5, 0, Math.PI * 2);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = theme.outline;
        ctx.stroke();
    }

    // Labels: all visible ones when few are on screen, otherwise big nodes
    // only; never for nodes dimmed by the filter
    ctx.textAlign = 'center';
    var allLabels = visibleNodes <= 300;
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        if (n.dim || !inBounds(n))
            continue;
        if (allLabels ? n.r >= 3 : n.r >= 10)
            drawLabel(ctx, n, false);
    }
}

function drawRings(ctx, list, extra, width, color) {
    if (!list.length) return;
    ctx.beginPath();
    for (var i = 0; i < list.length; ++i) {
        var n = list[i], r = n.r + extra;
        ctx.moveTo(n.x + r, n.y);
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
}

function drawOverlay() {
    var ctx = overlayCtx;
    prepareCtx(ctx);
    ctx.textAlign = 'center';
    var s = selectedNode;
    if (s) {
        var peers = peersOf(s);
        if (ring2 && ring2.pairs.length)
            strokeLinks(ctx, ring2.pairs, theme.ring2, 1);
        strokeLinks(ctx, peers.map(function(p) { return [s, p]; }), theme.edgeHighlight, 1);
        // In height mode the fill carries the height, so the peers get rings;
        // in peer-count mode the hop-distance colours already show them
        if (colorMode == 'height')
            drawRings(ctx, peers.filter(inBounds), 1.5, 1.5, theme.peerRing);
        drawRings(ctx, [s], 2.5, 2.5, theme.ring);
        drawLabel(ctx, s, true);
    }
    var h = hoverNode;
    if (h && h !== s) {
        strokeLinks(ctx, peersOf(h).map(function(p) { return [h, p]; }), theme.edgeHighlight, 0.8);
        drawRings(ctx, [h], 1.5, 1, theme.ring);
        drawLabel(ctx, h, false);
    }
}

// Full redraw of both layers for the current view; resets the gesture transform
function render() {
    project();
    var t0 = performance.now();
    drawBase();
    drawOverlay();
    // While the resolution is still being decided, force the drawing to
    // complete so the timing includes rasterization (some browsers defer it)
    if (!dprLocked) baseCtx.getImageData(0, 0, 1, 1);
    var ms = performance.now() - t0;
    renderedView = {s: view.s, tx: view.tx, ty: view.ty};
    layer.style.transform = '';
    adaptResolution(ms);
}

// Adaptive HiDPI: start at 1x; use the device resolution (max 2x) only if a
// full redraw is fast here, and fall back to 1x if it turns out slow.
function adaptResolution(ms) {
    if (dprLocked)
        return;
    var device = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr == 1 && device > 1 && ms < 25) {
        dpr = device;
        setCanvasResolution();
        requestRender();
    } else if (dpr > 1 && ms > 70) {
        dpr = 1;
        dprLocked = true;
        setCanvasResolution();
        requestRender();
    } else {
        dprLocked = true;
    }
}

function requestRender() {
    if (renderPending) return;
    renderPending = true;
    window.requestAnimationFrame(function() {
        renderPending = false;
        if (!gestureActive)
            render();
    });
}

function requestOverlay() {
    if (overlayPending) return;
    overlayPending = true;
    window.requestAnimationFrame(function() {
        overlayPending = false;
        if (gestureActive)
            return;
        if (!renderedView || renderedView.s != view.s || renderedView.tx != view.tx || renderedView.ty != view.ty)
            render();
        else
            drawOverlay();
    });
}

// ---------------------------------------------------------------------------
// Gestures: move the cached layer with a CSS transform, redraw at the end
// ---------------------------------------------------------------------------

function beginGesture() {
    if (gestureActive) return;
    gestureActive = true;
    if (hoverNode) {
        hoverNode = null;
        wrapper.style.cursor = '';
    }
}

function applyGestureTransform() {
    if (!renderedView) return;
    var k = view.s / renderedView.s;
    var dx = view.tx - k * renderedView.tx, dy = view.ty - k * renderedView.ty;
    layer.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + k + ')';
}

function endGesture() {
    if (!gestureActive) return;
    gestureActive = false;
    requestRender();
}

function zoomAt(x, y, factor) {
    var s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.s * factor));
    factor = s / view.s;
    view.tx = x - (x - view.tx) * factor;
    view.ty = y - (y - view.ty) * factor;
    view.s = s;
}

// Area of the viewport not covered by the bottom sheet
function visibleArea() {
    var h = vh;
    if (isSheetLayout())
        h = Math.max(80, vh - sheetHeights()[sheetState]);
    return {w: vw, h: h};
}

// Centre the layout. Graphs up to 300 nodes keep the original 1.2x scale;
// larger ones are fitted, with labels appearing as you zoom in.
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

// Pan so a node lies inside the area not covered by the sheet
function ensureVisible(node) {
    var area = visibleArea();
    var x = node.wx * view.s + view.tx, y = node.wy * view.s + view.ty;
    var m = 40;
    if (x >= m && x <= area.w - m && y >= m && y <= area.h - m)
        return false;
    view.tx += area.w / 2 - x;
    view.ty += area.h / 2 - y;
    return true;
}

// ---------------------------------------------------------------------------
// Hit testing through a uniform grid over world coordinates
// ---------------------------------------------------------------------------

function buildGrid() {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < nodes.length; ++i) {
        minX = Math.min(minX, nodes[i].wx); maxX = Math.max(maxX, nodes[i].wx);
        minY = Math.min(minY, nodes[i].wy); maxY = Math.max(maxY, nodes[i].wy);
    }
    var cell = Math.max(1e-6, Math.max(maxX - minX, maxY - minY) / Math.max(1, Math.sqrt(nodes.length)));
    var cells = {};
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        var key = Math.floor((n.wx - minX) / cell) + ',' + Math.floor((n.wy - minY) / cell);
        (cells[key] || (cells[key] = [])).push(n);
    }
    grid = {minX: minX, minY: minY, cell: cell, cells: cells};
}

// Nearest node within its radius, or within a minimum hit radius for fingers
function getNodeAt(px, py, minHit) {
    if (!grid || !nodes.length) return null;
    var s = view.s;
    var maxR = Math.max(minHit || 0, radiusAt({sf: 2.4, size: 14}, s) + 1);
    var wx = (px - view.tx) / s, wy = (py - view.ty) / s, wr = maxR / s;
    var c0x = Math.floor((wx - wr - grid.minX) / grid.cell), c1x = Math.floor((wx + wr - grid.minX) / grid.cell);
    var c0y = Math.floor((wy - wr - grid.minY) / grid.cell), c1y = Math.floor((wy + wr - grid.minY) / grid.cell);
    var candidates;
    if ((c1x - c0x + 1) * (c1y - c0y + 1) > 400) {
        candidates = nodes;   // zoomed far out: the search area covers most cells
    } else {
        candidates = [];
        for (var cx = c0x; cx <= c1x; ++cx)
            for (var cy = c0y; cy <= c1y; ++cy) {
                var list = grid.cells[cx + ',' + cy];
                if (list) candidates = candidates.concat(list);
            }
    }
    var best = null, bestDist = Infinity;
    for (var i = 0; i < candidates.length; ++i) {
        var n = candidates[i];
        var r = Math.max(radiusAt(n, s) + 1, minHit || 0);
        var dx = n.wx * s + view.tx - px, dy = n.wy * s + view.ty - py;
        var d = dx * dx + dy * dy;
        if (d > r * r)
            continue;
        // Prefer nodes matching the filter over dimmed ones nearby
        if (n.dim) d = d * 4 + 1;
        if (d < bestDist) {
            best = n;
            bestDist = d;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Colours per mode, selection
// ---------------------------------------------------------------------------

function peersOf(n) {
    return linksLoaded ? fullAdj[n.i] : treeAdj[n.i];
}

function changeHash(hash) {
    window.location.replace(('' + window.location).split('#')[0] + '#' + hash);
}

function searchNode(id) {
    for (var i = 0; i < nodes.length; ++i)
        if (nodes[i].id == id) return nodes[i];
    return null;
}

function peerCountColor(n) {
    // Grey by peer count (square root spreads the many small counts)
    var ratio = Math.sqrt(n.degree / maxDegree);
    var v = Math.round(100 * (1 - ratio));
    if (theme.dark) v = 255 - v;   // most connected brightest on black
    return rgbToHex([v, v, v]);
}

function applyColorMode() {
    for (var i = 0; i < nodes.length; ++i) {
        var n = nodes[i];
        n.hollow = false;
        if (colorMode == 'height') {
            var c = heightColor(n.height);
            if (c == null) {
                n.hollow = true;
                n.baseColor = theme.unknown;
                n.baseText = theme.dark ? '#AAAAAA' : '#777777';
            } else {
                n.baseColor = c;
                n.baseText = rgbToHex(ensureContrast(hexToRgb(c), theme.bgRgb, 4.5));
            }
        } else {
            n.baseColor = peerCountColor(n);
            n.baseText = n.baseColor;
        }
        n.color = n.baseColor;
        n.textColor = n.baseText;
    }
    $('#height-legend').toggle(colorMode == 'height');
    if (selectedNode && colorMode != 'height')
        markPeers(selectedNode);
}

// ---------------------------------------------------------------------------
// Address height filter
// ---------------------------------------------------------------------------

function matchesFilter(n) {
    return n.height != null && n.height >= filter.min && n.height <= filter.max;
}

function applyFilter() {
    filter.active = filter.min > 0 || filter.max < maxHeight;
    for (var i = 0; i < nodes.length; ++i)
        nodes[i].dim = filter.active && !matchesFilter(nodes[i]);
    $('#hmin').val(filter.min);
    $('#hmax').val(filter.max);
    $('#filter-clear').toggle(filter.active);
    $('#general-info .filter').toggleClass('active', filter.active);
    buildLegend();
}

function setFilter(min, max) {
    min = Math.max(0, Math.min(maxHeight, min));
    max = Math.max(0, Math.min(maxHeight, max));
    if (min > max) { var t = min; min = max; max = t; }
    filter.min = min;
    filter.max = max;
    applyFilter();
    try { window.localStorage.setItem(FILTER_KEY, min + '-' + max); } catch (e) { /* not persisted */ }
    if (!selectedNode) {
        if (filter.active) {
            showFilterList();
            if (isSheetLayout() && sheetState == 'collapsed') setSheet('half');
        } else {
            $('#node-info').html('');
        }
    }
    requestRender();
}

function initFilter() {
    var opts = '';
    for (var h = 0; h <= maxHeight; ++h) opts += '<option value="' + h + '">' + h + '</option>';
    $('#hmin, #hmax').html(opts);
    filter.min = 0;
    filter.max = maxHeight;
    try {
        var m = /^(\d+)-(\d+)$/.exec(window.localStorage.getItem(FILTER_KEY) || '');
        if (m) {
            filter.min = Math.min(maxHeight, +m[1]);
            filter.max = Math.min(maxHeight, +m[2]);
        }
    } catch (e) { /* storage unavailable */ }
    applyFilter();
    $('#hmin').change(function() { setFilter(+this.value, filter.max); });
    $('#hmax').change(function() { setFilter(filter.min, +this.value); });
    $('#filter-clear').click(function() { setFilter(0, maxHeight); });
    $('#height-legend').on('click', 'button.chip', function() {
        var c = HEIGHT_CLASSES[+this.getAttribute('data-class')];
        var max = Math.min(c[1], maxHeight);
        if (filter.active && filter.min == c[0] && filter.max == max) setFilter(0, maxHeight);
        else setFilter(c[0], max);
    });
}

// Panel content while a filter is active and no node is selected
function showFilterList() {
    var matching = nodes.filter(matchesFilter);
    matching.sort(function(a, b) { return (b.height - a.height) || (b.degree - a.degree); });
    var range = filter.min == filter.max ? String(filter.min) : filter.min + '–' + filter.max;
    var shown = matching.slice(0, FILTER_LIST_LIMIT);
    var html =
        '<h2>Height ' + range + '</h2>' +
        '<div class="facts"><strong>Matching nodes:</strong> ' + matching.length + '</div>' +
        (matching.length > shown.length ? '<div class="note">Showing the ' + shown.length + ' highest.</div>' : '') +
        '<div class="peers">' + shown.map(function(n) {
            return '<a class="peer" href="#' + n.id + '">' +
                '<span class="peer-name">' + n.label + '</span>' +
                '<span class="peer-count">' + n.degree + '</span>' +
                formatAddress(n.id, n.height) + '</a>';
        }).join('') + '</div>';
    $('#node-info').html(html).scrollTop(0);
}

function setColorMode(mode) {
    colorMode = mode;
    try { window.localStorage.setItem(COLOR_MODE_KEY, mode); } catch (e) { /* not persisted */ }
    applyColorMode();
    if (selectedNode) showNodeInfo(selectedNode);
    requestRender();
}

// Colour nodes by hop distance from the selected node (BFS)
function markPeers(start) {
    for (var i = 0; i < nodes.length; ++i) nodes[i].depth = 0xFFFF;
    var queue = [start];
    start.depth = 0;
    for (var qi = 0; qi < queue.length; ++qi) {
        var node = queue[qi], depth = node.depth;
        if (theme.dark) {
            node.color = depth == 0 ? '#FFFFFF' : (depth >= DEPTH_COLORS.length ? '#333333' : DEPTH_COLORS[depth]);
            node.textColor = node.color;
        } else {
            node.color = depth >= DEPTH_COLORS.length ? '#FFFFFF' : DEPTH_COLORS[depth];
            node.textColor = depth >= DEPTH_TEXT_LIGHT.length ? '#FFFFFF' : DEPTH_TEXT_LIGHT[depth];
        }
        var peers = peersOf(node);
        for (var i = 0; i < peers.length; ++i) {
            var n = peers[i];
            if (n.depth > depth + 1) {
                n.depth = depth + 1;
                queue.push(n);
            }
        }
    }
}

// Links of the selected node's peers (drawn faintly). Capped: around a big
// hub this can be tens of thousands of links, then only the links among the
// node's own peers are drawn.
function computeRing2(s) {
    var direct = peersOf(s), inDirect = {}, seen = {}, pairs = [], total = 0;
    for (var i = 0; i < direct.length; ++i) inDirect[direct[i].i] = true;
    for (var i = 0; i < direct.length; ++i) {
        var p = direct[i], pp = peersOf(p);
        for (var j = 0; j < pp.length; ++j) {
            var q = pp[j];
            if (q === s) continue;
            var key = p.i < q.i ? p.i + '-' + q.i : q.i + '-' + p.i;
            if (seen[key]) continue;
            seen[key] = true;
            total++;
            pairs.push([p, q]);
        }
    }
    if (total <= RING2_LIMIT)
        return {pairs: pairs, truncated: false, total: total};
    return {
        pairs: pairs.filter(function(e) { return inDirect[e[0].i] && inDirect[e[1].i]; }),
        truncated: true,
        total: total
    };
}

function clearSelection() {
    if (!selectedNode) return;
    var recolor = colorMode != 'height';
    selectedNode = null;
    ring2 = null;
    changeHash('');
    if (filter.active) showFilterList();
    else $('#node-info').html('');
    if (recolor) {
        for (var i = 0; i < nodes.length; ++i) {
            nodes[i].color = nodes[i].baseColor;
            nodes[i].textColor = nodes[i].baseText;
        }
        requestRender();
    } else {
        requestOverlay();
    }
}

function selectNode(node, center) {
    if (!node) return;
    if (selectedNode && colorMode != 'height') {
        for (var i = 0; i < nodes.length; ++i) {
            nodes[i].color = nodes[i].baseColor;
            nodes[i].textColor = nodes[i].baseText;
        }
    }
    selectedNode = node;
    ring2 = computeRing2(node);
    changeHash(node.id);
    if (colorMode != 'height')
        markPeers(node);
    showNodeInfo(node);
    if (isSheetLayout() && sheetState == 'collapsed')
        setSheet('half');
    var moved = center ? ensureVisible(node) : false;
    // Peer-count mode recolours every node (base layer); height mode only
    // needs the overlay unless the view moved
    if (moved || colorMode != 'height')
        requestRender();
    else
        requestOverlay();
}

// Address with its height byte (last two hex digits of the first group)
// coloured in the node's height class colour, readable on the panel
function formatAddress(id, height) {
    var m = /^([23])([0-9a-f]{2})(:.*)$/i.exec(id);
    var c = heightColor(height);
    if (!m || c == null)
        return '<span class="addr">' + id + '</span>';
    var rgb = ensureContrast(hexToRgb(c), theme.bgRgb, 4.5);
    return '<span class="addr">' + m[1] + '<span class="hb" style="color:' + rgbToHex(rgb) + '">' +
        m[2] + '</span>' + m[3] + '</span>';
}

function showNodeInfo(node) {
    var peers = peersOf(node).slice();
    var named = [], unnamed = [];
    for (var i = 0; i < peers.length; ++i)
        (/^[0-9A-F]{1,4}$/i.test(peers[i].label) ? unnamed : named).push(peers[i]);
    var byLabel = function(a, b) { return a.label.localeCompare(b.label); };
    named.sort(byLabel);
    unnamed.sort(byLabel);
    peers = named.concat(unnamed);

    var notes = '';
    if (!linksLoaded)
        notes += '<div class="note">Showing backbone links only, loading all links…</div>';
    if (ring2 && ring2.truncated)
        notes += '<div class="note">Second ring has ' + ring2.total + ' links, showing only those among this node\'s peers.</div>';

    var html =
        '<h2>' + node.label + '</h2>' +
        '<span class="node-addr">' + formatAddress(node.id, node.height) + '</span>' +
        '<div class="facts">' +
        (node.coords ? '<strong>Coords:</strong> ' + node.coords + '<br>' : '') +
        '<strong>Peers:</strong> ' + node.degree + '<br>' +
        '<strong>Centrality:</strong> ' + node.centrality.toFixed(4) + '<br>' +
        '<strong>Address height:</strong> ' + (node.height == null ? 'unknown' : node.height) +
        '</div>' + notes +
        '<div class="peers">' +
        peers.map(function(n) {
            return '<a class="peer" href="#' + n.id + '">' +
                '<span class="peer-name">' + n.label + '</span>' +
                '<span class="peer-count">' + n.degree + '</span>' +
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
    if (!isSheetLayout()) return;
    sheetState = state;
    setSheetHeight(sheetHeights()[state]);
}

function initSheet() {
    var sidebar = document.getElementById('sidebar');
    var handle = document.getElementById('sheet-handle');
    var drag = null;

    handle.addEventListener('pointerdown', function(e) {
        if (!isSheetLayout()) return;
        handle.setPointerCapture(e.pointerId);
        drag = {y: e.clientY, h: sidebar.getBoundingClientRect().height, moved: false};
        sidebar.classList.add('dragging');
        e.preventDefault();
    });
    handle.addEventListener('pointermove', function(e) {
        if (!drag) return;
        var dy = drag.y - e.clientY;
        if (Math.abs(dy) > 6) drag.moved = true;
        var hs = sheetHeights();
        setSheetHeight(Math.max(hs.collapsed, Math.min(hs.full, drag.h + dy)));
    });
    function end() {
        if (!drag) return;
        sidebar.classList.remove('dragging');
        var hs = sheetHeights();
        if (!drag.moved) {
            setSheet(sheetState == 'collapsed' ? 'half' : 'collapsed');
        } else {
            var h = sidebar.getBoundingClientRect().height, best = 'collapsed';
            ['half', 'full'].forEach(function(s) {
                if (Math.abs(hs[s] - h) < Math.abs(hs[best] - h)) best = s;
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
        if (isSheetLayout()) setSheet('full');
    });
    setSheet('collapsed');
}

// ---------------------------------------------------------------------------
// Input: Pointer Events (mouse, touch, pen) and wheel
// ---------------------------------------------------------------------------

function viewportPos(e) {
    var rect = wrapper.getBoundingClientRect();
    return {x: e.clientX - rect.left, y: e.clientY - rect.top};
}

function setHover(node) {
    if (node === hoverNode) return;
    hoverNode = node;
    wrapper.style.cursor = node ? 'pointer' : '';
    requestOverlay();
}

function initInput() {
    var pointers = {};      // pointerId -> {x, y}
    var gesture = null;     // {type: 'pan'|'pinch', ...}
    var tap = null;         // candidate tap: {x, y, id, touch}
    var wheelTimer = null;

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
            beginGesture();
        } else if (ps.length == 1) {
            gesture = {type: 'pan', last: {x: ps[0].x, y: ps[0].y}};
        } else {
            gesture = null;
        }
    }

    wrapper.addEventListener('pointerdown', function(e) {
        if (e.pointerType == 'mouse' && e.button != 0) return;
        // Touching the map closes the on-screen keyboard
        if (document.activeElement && document.activeElement.id == 'search-box')
            document.activeElement.blur();
        wrapper.setPointerCapture(e.pointerId);
        var p = viewportPos(e);
        pointers[e.pointerId] = p;
        if (Object.keys(pointers).length == 1)
            tap = {x: p.x, y: p.y, id: e.pointerId, touch: e.pointerType != 'mouse'};
        startGesture();
        e.preventDefault();
    });

    wrapper.addEventListener('pointermove', function(e) {
        var p = viewportPos(e);
        if (!(e.pointerId in pointers)) {
            // Mouse hovering without a button pressed: overlay only
            if (e.pointerType == 'mouse' && !gestureActive)
                setHover(getNodeAt(p.x, p.y, 0));
            return;
        }
        pointers[e.pointerId] = p;
        if (tap && e.pointerId == tap.id && Math.hypot(p.x - tap.x, p.y - tap.y) > (tap.touch ? 10 : 3)) {
            tap = null;
            beginGesture();
        }
        if (!gesture || !gestureActive) return;
        if (gesture.type == 'pinch') {
            var ps = pointerList(), a = ps[0], b = ps[1];
            var dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
            var mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
            // Pan with the midpoint, zoom around it
            view.tx += mid.x - gesture.mid.x;
            view.ty += mid.y - gesture.mid.y;
            zoomAt(mid.x, mid.y, dist / gesture.dist);
            gesture.dist = dist;
            gesture.mid = mid;
        } else {
            view.tx += p.x - gesture.last.x;
            view.ty += p.y - gesture.last.y;
            gesture.last = p;
            wrapper.style.cursor = 'move';
        }
        applyGestureTransform();
    });

    function endPointer(e, cancelled) {
        if (!(e.pointerId in pointers)) return;
        var p = viewportPos(e);
        delete pointers[e.pointerId];
        if (!cancelled && tap && e.pointerId == tap.id && !gestureActive) {
            var node = getNodeAt(p.x, p.y, tap.touch ? 16 : 0);
            if (node) {
                selectNode(node, false);
            } else {
                var hadSelection = !!selectedNode;
                clearSelection();
                if (isSheetLayout() && !(filter.active && hadSelection)) setSheet('collapsed');
            }
        }
        if (tap && e.pointerId == tap.id) tap = null;
        if (Object.keys(pointers).length == 0) {
            wrapper.style.cursor = '';
            gesture = null;
            endGesture();
        } else {
            // Two fingers -> one: continue as a pan from the remaining finger
            startGesture();
        }
    }
    wrapper.addEventListener('pointerup', function(e) { endPointer(e, false); });
    wrapper.addEventListener('pointercancel', function(e) { endPointer(e, true); });
    wrapper.addEventListener('pointerleave', function(e) {
        if (e.pointerType == 'mouse' && !(e.pointerId in pointers)) setHover(null);
    });

    // Mouse wheel and trackpad pinch (wheel with ctrlKey): transform while the
    // wheel turns, redraw once it has been quiet for 150 ms
    wrapper.addEventListener('wheel', function(e) {
        e.preventDefault();
        var p = viewportPos(e);
        var dy = e.deltaY * (e.deltaMode == 1 ? 16 : (e.deltaMode == 2 ? vh : 1));
        var k = e.ctrlKey ? 0.01 : 0.0029;   // ~4/3 per notch of a normal wheel
        beginGesture();
        zoomAt(p.x, p.y, Math.exp(-dy * k));
        applyGestureTransform();
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(endGesture, 150);
    }, {passive: false});
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadGraph(data) {
    var F = {};
    data.fields.forEach(function(f, i) { F[f] = i; });
    maxDegree = Math.max(1, data.maxDegree || 1);
    dataCreated = data.created;
    nodes = data.nodes.map(function(r, i) {
        return {
            i: i,
            id: r[F.id],
            label: String(r[F.label]),
            text: decodeEntities(String(r[F.label])),
            wx: r[F.x],
            wy: r[F.y],
            size: r[F.size],
            height: r[F.height] == null ? null : r[F.height],
            degree: r[F.degree],
            centrality: r[F.centrality] || 0,
            coords: r[F.coords] || ''
        };
    });
    maxHeight = 0;
    hasUnknownHeight = false;
    for (var i = 0; i < nodes.length; ++i) {
        if (nodes[i].height != null) maxHeight = Math.max(maxHeight, nodes[i].height);
        else hasUnknownHeight = true;
    }
    treeAdj = nodes.map(function() { return []; });
    treeEdges = [];
    for (var k = 0; k + 1 < data.tree.length; k += 2) {
        var a = nodes[data.tree[k]], b = nodes[data.tree[k + 1]];
        if (!a || !b) continue;
        treeEdges.push([a, b]);
        treeAdj[a.i].push(b);
        treeAdj[b.i].push(a);
    }
    buildGrid();
}

function loadLinks(attempt) {
    $.ajax({url: '/data/links.json', dataType: 'json', cache: true}).done(function(data) {
        if (data.created != dataCreated) {
            // The map was re-rendered between the two downloads; links do not
            // belong to these nodes. Retry once later, then give up quietly.
            if (attempt < 1) setTimeout(function() { loadLinks(attempt + 1); }, 3000);
            return;
        }
        fullAdj = nodes.map(function() { return []; });
        for (var k = 0; k + 1 < data.links.length; k += 2) {
            var a = nodes[data.links[k]], b = nodes[data.links[k + 1]];
            if (!a || !b) continue;
            fullAdj[a.i].push(b);
            fullAdj[b.i].push(a);
        }
        linksLoaded = true;
        $('#number-of-connections').text(Math.floor(data.links.length / 2));
        if (selectedNode) {
            // Refresh the selection with the full link set
            selectNode(selectedNode, false);
        }
    });
}

$(document).ready(function() {
    wrapper = document.getElementById('content-wrapper');
    layer = document.getElementById('map-layer');
    baseCanvas = document.getElementById('map');
    overlayCanvas = document.getElementById('overlay');
    baseCtx = baseCanvas.getContext('2d');
    overlayCtx = overlayCanvas.getContext('2d');
    try {
        var stored = window.localStorage.getItem(COLOR_MODE_KEY);
        if (stored == 'peers' || stored == 'height') colorMode = stored;
    } catch (e) { /* storage unavailable, keep default */ }

    readTheme();
    resizeLayers();
    initSheet();
    initInput();

    $(window).resize(function() {
        resizeLayers();
        if (isSheetLayout()) setSheet(sheetState);
        requestRender();
    });
    var darkMql = window.matchMedia(DARK_QUERY);
    var onThemeChange = function() {
        readTheme();
        applyColorMode();
        if (selectedNode) showNodeInfo(selectedNode);
        requestRender();
    };
    if (darkMql.addEventListener) darkMql.addEventListener('change', onThemeChange);
    else if (darkMql.addListener) darkMql.addListener(onThemeChange);

    $('#update-time').text('loading map…');
    $.ajax({url: '/data/graph.json', dataType: 'json', cache: true}).done(function(data) {
        if (!data || data.version != 2) {
            $('#update-time').text('map data has an old format, waiting for the next render');
            return;
        }
        loadGraph(data);
        fitToView();
        computeSizing();
        initFilter();

        var delta = Math.round(new Date().getTime() / 1000) - data.created;
        $('#update-time').text(Math.floor(delta / 60) + ' min, ' + (delta % 60) + ' s ago');
        $('#number-of-nodes').text(nodes.length);
        var links = data.mode == 'peers' ? '…' : treeEdges.length;
        $('#number-of-connections').text(links);

        $('#color-mode').val(colorMode).change(function() { setColorMode($(this).val()); });
        applyColorMode();

        if (window.location.hash) {
            var node = searchNode(window.location.hash.substring(1));
            if (node) selectNode(node, true);
        }
        if (!selectedNode && filter.active) showFilterList();
        requestRender();
        loadLinks(0);

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
                if (isSheetLayout()) setSheet('half');
            }
        });
        $('#search-box').keypress(function(e) {
            if (e.which == 13) selectNode(searchNode($('#search-box').val()), true);
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
