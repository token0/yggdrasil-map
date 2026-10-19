#!/usr/bin/env sh
# Run an embedded yggdrasil node (optional), collect + render the map every
# UPDATE_INTERVAL seconds, and serve it with Flask.
#
# Environment:
#   HOST, PORT            listen address/port of the web server
#   YGG_EMBEDDED          1 = run the embedded node (default), 0 = use an external one
#   YGG_CONF              embedded node config, generated on first start (default /config/yggdrasil.conf)
#   YGG_PEERS             peers written into a newly generated config
#   YGG_ADMIN_ENDPOINT    admin endpoint to collect from; defaults to the embedded node's socket.
#                         Set to empty with YGG_EMBEDDED=0 to only render CURRENT_SOURCE.
#   YGG_WARMUP            seconds to wait before the first collection (default 60 with the embedded node)
#   COLLECTOR             crawl = peering graph via debug_remoteGetPeers (default),
#                         lookups = spanning tree from the node's 'lookups' log
#   CURRENT_SOURCE        crawler output to render (file path or URL), default: current
#   UPDATE_INTERVAL       seconds of rest between collections, default: 600
#   RENDER_CHECK_INTERVAL seconds between checks for new data to render, default: 30

APP_DIR="${APP_DIR:-/src/yggdrasil-map}"
COLLECTOR="${COLLECTOR:-crawl}"
UPDATE_INTERVAL="${UPDATE_INTERVAL:-600}"
YGG_EMBEDDED="${YGG_EMBEDDED:-1}"
YGG_CONF="${YGG_CONF:-/config/yggdrasil.conf}"
export YGG_ADMIN_SOCKET="${YGG_ADMIN_SOCKET:-/run/yggdrasil/yggdrasil.sock}"
YGG_RUNTIME_CONF="$(dirname "$YGG_ADMIN_SOCKET")/runtime.conf"

if [ "$YGG_EMBEDDED" = "1" ]; then
    YGG_ADMIN_ENDPOINT="${YGG_ADMIN_ENDPOINT-unix://$YGG_ADMIN_SOCKET}"
    YGG_WARMUP="${YGG_WARMUP:-60}"
    mkdir -p "$(dirname "$YGG_CONF")" "$(dirname "$YGG_ADMIN_SOCKET")"
    ygg-config generate "$YGG_CONF" || exit 1
    ygg-config runtime "$YGG_CONF" "$YGG_RUNTIME_CONF" || exit 1
    echo "yggdrasil: address $(yggdrasil -useconffile "$YGG_RUNTIME_CONF" -address)"
    (
        while true; do
            yggdrasil -useconffile "$YGG_RUNTIME_CONF" -logto stdout
            echo "yggdrasil: exited with status $?, restarting in 5 s" >&2
            sleep 5
        done
    ) &
else
    YGG_WARMUP="${YGG_WARMUP:-0}"
fi

cd "$APP_DIR/web" || exit 1

collect() {
    case "$COLLECTOR" in
        lookups)
            if python3 "$APP_DIR/scripts/getcurrent.py" "$YGG_ADMIN_ENDPOINT" > current.tmp; then
                mv current.tmp current
            else
                rm -f current.tmp
                echo "collect: failed, keeping previous data" >&2
            fi ;;
        *)
            # Writes partial snapshots to 'current' while crawling, final result at the end
            python3 "$APP_DIR/scripts/crawl-peers.py" "$YGG_ADMIN_ENDPOINT" --out current \
                || echo "collect: crawl failed, keeping previous data" >&2 ;;
    esac
}

# Collection loop: one collection, then UPDATE_INTERVAL seconds of rest
if [ -n "$YGG_ADMIN_ENDPOINT" ]; then
    (
        if [ "$YGG_WARMUP" -gt 0 ]; then
            echo "collect: first collection in $YGG_WARMUP s"
            sleep "$YGG_WARMUP"
        fi
        while true; do
            collect
            sleep "$UPDATE_INTERVAL"
        done
    ) &
fi

# Render loop: redraw whenever the collected data is newer than the rendered map
# (or periodically for a remote CURRENT_SOURCE)
(
    while true; do
        if [ "$CURRENT_SOURCE" != "${CURRENT_SOURCE#*://}" ]; then
            python3 updateGraph.py || echo "render: failed" >&2
            sleep "$UPDATE_INTERVAL"
            continue
        fi
        # dash's -nt is false when the second file is missing, so test that separately
        if [ -f current ] && { [ ! -f static/graph.json ] || [ current -nt static/graph.json ]; }; then
            python3 updateGraph.py || echo "render: failed" >&2
        fi
        sleep "${RENDER_CHECK_INTERVAL:-30}"
    done
) &

exec python3 web.py --host "${HOST:-0.0.0.0}" --port "${PORT:-3000}"
