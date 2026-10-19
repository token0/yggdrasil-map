#!/usr/bin/env sh
# Collect and render the map every UPDATE_INTERVAL seconds, serve it with Flask.
#
# Environment:
#   HOST, PORT            listen address/port of the web server
#   YGG_ADMIN_ENDPOINT    admin socket to collect from (unix:///path or tcp://host:port);
#                         empty = skip collection and only render CURRENT_SOURCE
#   CURRENT_SOURCE        crawler output to render (file path or URL), default: current
#   UPDATE_INTERVAL       seconds between updates, default: 600

APP_DIR="${APP_DIR:-/src/yggdrasil-map}"
UPDATE_INTERVAL="${UPDATE_INTERVAL:-600}"
cd "$APP_DIR/web" || exit 1

update() {
    if [ -n "$YGG_ADMIN_ENDPOINT" ]; then
        if python3 "$APP_DIR/scripts/getcurrent.py" "$YGG_ADMIN_ENDPOINT" > current.tmp; then
            mv current.tmp current
        else
            rm -f current.tmp
            echo "update: collection failed, keeping previous data" >&2
        fi
    fi
    python3 updateGraph.py || echo "update: render failed" >&2
}

(
    while true; do
        update
        sleep "$UPDATE_INTERVAL"
    done
) &

exec python3 web.py --host "${HOST:-0.0.0.0}" --port "${PORT:-3000}"
