"use strict";

// Renderer benchmark: draws the current map with different strategies and
// reports the time per full redraw on this device. Every measurement forces
// the canvas to finish (getImageData), so deferred rasterization is included.

var bench = {nodes: [], tree: [], links: []};

function benchLog(msg) {
    $('#bench-status').text(msg);
}

function load() {
    return $.when(
        $.ajax({url: '/data/graph.json', dataType: 'json'}),
        $.ajax({url: '/data/links.json', dataType: 'json'})
    ).then(function(g, l) {
        g = g[0]; l = l[0];
        var F = {};
        g.fields.forEach(function(f, i) { F[f] = i; });
        bench.nodes = g.nodes.map(function(r) {
            return {wx: r[F.x], wy: r[F.y], size: r[F.size], degree: r[F.degree], label: String(r[F.label])};
        });
        function pairs(flat) {
            var out = [];
            for (var k = 0; k + 1 < flat.length; k += 2)
                out.push([bench.nodes[flat[k]], bench.nodes[flat[k + 1]]]);
            return out;
        }
        bench.tree = pairs(g.tree);
        bench.links = pairs(l.links);
    });
}

function setup(dpr) {
    var canvas = document.getElementById('bench-canvas');
    var stage = document.getElementById('bench-stage');
    var w = stage.clientWidth, h = stage.clientHeight;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    return {canvas: canvas, ctx: ctx, w: w, h: h, dpr: dpr};
}

function fitView(st, zoom) {
    var n = bench.nodes, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < n.length; ++i) {
        minX = Math.min(minX, n[i].wx); maxX = Math.max(maxX, n[i].wx);
        minY = Math.min(minY, n[i].wy); maxY = Math.max(maxY, n[i].wy);
    }
    var fit = Math.min((st.w - 20) / Math.max(1, maxX - minX), (st.h - 20) / Math.max(1, maxY - minY));
    var s = fit * zoom;
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    // Same sizing model as the map (network.js radiusAt)
    var spacing = Math.sqrt(Math.max(1, (maxX - minX) * (maxY - minY)) / Math.max(1, n.length));
    var R0 = Math.max(2.5, Math.min(7, 0.35 * spacing * fit));
    var maxDeg = 1;
    for (var i = 0; i < n.length; ++i) maxDeg = Math.max(maxDeg, n[i].degree);
    for (var i = 0; i < n.length; ++i) {
        n[i].x = (n[i].wx - cx) * s + st.w / 2;
        n[i].y = (n[i].wy - cy) * s + st.h / 2;
        var sf = 0.8 + 1.6 * Math.sqrt(n[i].degree / maxDeg);
        n[i].r = Math.max(1.5, Math.min(48, R0 * sf * Math.pow(zoom, 0.6)));
    }
}

function drawLinks(ctx, pairs, mode, alpha) {
    ctx.strokeStyle = 'rgba(128,128,128,0.5)';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    if (mode == 'per-link') {
        for (var i = 0; i < pairs.length; ++i) {
            ctx.beginPath();
            ctx.moveTo(pairs[i][0].x, pairs[i][0].y);
            ctx.lineTo(pairs[i][1].x, pairs[i][1].y);
            ctx.stroke();
        }
    } else {
        var chunk = mode == 'single' ? Infinity : mode;
        var count = 0;
        ctx.beginPath();
        for (var i = 0; i < pairs.length; ++i) {
            ctx.moveTo(pairs[i][0].x, pairs[i][0].y);
            ctx.lineTo(pairs[i][1].x, pairs[i][1].y);
            if (++count % chunk == 0) { ctx.stroke(); ctx.beginPath(); }
        }
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

function drawNodes(ctx, mode) {
    var n = bench.nodes;
    if (mode == 'per-node-arc') {
        ctx.fillStyle = '#9a9a9a';
        for (var i = 0; i < n.length; ++i) {
            ctx.beginPath();
            ctx.arc(n[i].x, n[i].y, n[i].r, 0, Math.PI * 2);
            ctx.fill();
        }
        return;
    }
    // Batched: squares below 2.5 px, circles above (as the map does)
    ctx.fillStyle = '#9a9a9a';
    ctx.beginPath();
    for (var i = 0; i < n.length; ++i)
        if (n[i].r < 2.5) ctx.rect(n[i].x - n[i].r, n[i].y - n[i].r, n[i].r * 2, n[i].r * 2);
    ctx.fill();
    ctx.beginPath();
    for (var i = 0; i < n.length; ++i)
        if (n[i].r >= 2.5) { ctx.moveTo(n[i].x + n[i].r, n[i].y); ctx.arc(n[i].x, n[i].y, n[i].r, 0, Math.PI * 2); }
    ctx.fill();
}

function measure(st, draw) {
    var times = [];
    for (var k = 0; k < 5; ++k) {
        var t0 = performance.now();
        st.ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
        st.ctx.clearRect(0, 0, st.w, st.h);
        draw(st.ctx);
        st.ctx.getImageData(0, 0, 1, 1);   // force the drawing to complete
        times.push(performance.now() - t0);
    }
    times.sort(function(a, b) { return a - b; });
    return times[2];   // median of 5
}

// Frame rate while moving a drawn canvas with a CSS transform (the gesture path)
function measureTransform() {
    var layer = document.getElementById('bench-layer');
    return new Promise(function(resolve) {
        var frames = 0, start = null, last = null, worst = 0;
        function step(ts) {
            if (start === null) { start = last = ts; }
            worst = Math.max(worst, ts - last);
            last = ts;
            var t = (ts - start) / 1000;
            layer.style.transform = 'translate(' + (Math.sin(t * 3) * 40) + 'px,0) scale(' + (1 + 0.3 * Math.sin(t * 2)) + ')';
            frames++;
            if (ts - start < 2000) {
                requestAnimationFrame(step);
            } else {
                layer.style.transform = '';
                resolve({fps: frames / ((ts - start) / 1000), worst: worst});
            }
        }
        requestAnimationFrame(step);
    });
}

function pause() {
    return new Promise(function(resolve) { setTimeout(resolve, 50); });
}

function run() {
    $('#bench-run').prop('disabled', true);
    var rows = [];
    var device = window.devicePixelRatio || 1;
    var cases = [
        ['Map default: tree links (chunks of 256) + batched nodes, 1x', 1, 1, function(c) { drawLinks(c, bench.tree, 256, 1); drawNodes(c, 'batched'); }],
        ['Tree links, one path', 1, 1, function(c) { drawLinks(c, bench.tree, 'single', 1); }],
        ['Tree links, chunks of 256', 1, 1, function(c) { drawLinks(c, bench.tree, 256, 1); }],
        ['Tree links, chunks of 1024', 1, 1, function(c) { drawLinks(c, bench.tree, 1024, 1); }],
        ['Tree links, one path per link', 1, 1, function(c) { drawLinks(c, bench.tree, 'per-link', 1); }],
        ['All links, one path (v2.0)', 1, 1, function(c) { drawLinks(c, bench.links, 'single', 0.35); }],
        ['All links, chunks of 256', 1, 1, function(c) { drawLinks(c, bench.links, 256, 0.35); }],
        ['All links, one path per link (upstream)', 1, 1, function(c) { drawLinks(c, bench.links, 'per-link', 0.35); }],
        ['Nodes only, batched (squares + circles)', 1, 1, function(c) { drawNodes(c, 'batched'); }],
        ['Nodes only, one arc per node (upstream)', 1, 1, function(c) { drawNodes(c, 'per-node-arc'); }],
        ['Map default, zoomed 4x', 1, 4, function(c) { drawLinks(c, bench.tree, 256, 1); drawNodes(c, 'batched'); }]
    ];
    if (device > 1)
        cases.push(['Map default at ' + Math.min(device, 2) + 'x resolution', Math.min(device, 2), 1, function(c) { drawLinks(c, bench.tree, 256, 1); drawNodes(c, 'batched'); }]);

    var i = 0;
    function next() {
        if (i >= cases.length) {
            benchLog('measuring CSS transform frame rate…');
            return measureTransform().then(function(r) {
                rows.push(['Moving the drawn canvas with a CSS transform (gestures)', r.fps.toFixed(0) + ' fps, worst frame ' + r.worst.toFixed(0) + ' ms']);
                finish(rows);
            });
        }
        var c = cases[i++];
        benchLog('running ' + i + ' / ' + cases.length + ': ' + c[0]);
        return pause().then(function() {
            var st = setup(c[1]);
            fitView(st, c[2]);
            var ms = measure(st, c[3]);
            rows.push([c[0], ms.toFixed(1) + ' ms']);
            showRows(rows);
            return next();
        });
    }
    next();
}

function showRows(rows) {
    $('#bench-results').html('<tr><th>Variant</th><th>Full redraw</th></tr>' + rows.map(function(r) {
        return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>';
    }).join(''));
}

function finish(rows) {
    showRows(rows);
    var stage = document.getElementById('bench-stage');
    var header = [
        'yggdrasil-map ' + $('meta[name=version]').attr('content') + ' benchmark',
        'User agent: ' + navigator.userAgent,
        'Device pixel ratio: ' + (window.devicePixelRatio || 1) + ', stage ' + stage.clientWidth + 'x' + stage.clientHeight,
        'Nodes: ' + bench.nodes.length + ', tree links: ' + bench.tree.length + ', all links: ' + bench.links.length,
        ''
    ];
    $('#bench-text').val(header.concat(rows.map(function(r) { return r[0] + ': ' + r[1]; })).join('\n'));
    benchLog('done');
    $('#bench-run').prop('disabled', false);
}

$(document).ready(function() {
    benchLog('loading map data…');
    load().then(function() {
        benchLog('ready: ' + bench.nodes.length + ' nodes, ' + bench.links.length + ' links');
    }, function() {
        benchLog('no map data yet');
        $('#bench-run').prop('disabled', true);
    });
    $('#bench-run').click(run);
    $('#bench-copy').click(function() {
        var t = document.getElementById('bench-text');
        t.focus();
        t.select();
        try { document.execCommand('copy'); } catch (e) { /* selected for manual copy */ }
    });
});
