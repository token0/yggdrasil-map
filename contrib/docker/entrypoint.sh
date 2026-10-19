#!/usr/bin/env sh

set -e

cron
cd /src/yggdrasil-map/web/ && python3 updateGraph.py
exec python3 /src/yggdrasil-map/web/web.py --host "$HOST" --port "$PORT"
