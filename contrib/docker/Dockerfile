# Built by contrib/docker/compose.yaml, or manually from the repository root:
#   docker build -f contrib/docker/Dockerfile -t yggdrasil-map .
FROM python:3.13-slim

WORKDIR /src/yggdrasil-map/web

# graphviz runtime + headers/compiler for building pygraphviz
RUN apt-get update && \
    apt-get install -y --no-install-recommends graphviz libgraphviz-dev gcc libc6-dev && \
    rm -rf /var/lib/apt/lists/*

COPY web/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && \
    apt-get purge -y --auto-remove gcc libc6-dev

COPY web/ ./
COPY scripts/getcurrent.py /src/yggdrasil-map/scripts/getcurrent.py
COPY contrib/docker/web_config.cfg ./web_config.cfg
COPY contrib/docker/entrypoint.sh /usr/bin/entrypoint.sh
RUN chmod 0555 /usr/bin/entrypoint.sh

ENV HOST=0.0.0.0 \
    PORT=3000 \
    UPDATE_INTERVAL=600 \
    YGG_ADMIN_ENDPOINT=unix:///run/yggdrasil/yggdrasil.sock \
    PYTHONUNBUFFERED=1

EXPOSE 3000
ENTRYPOINT [ "/usr/bin/entrypoint.sh" ]
