# Build from the repository root:
#   docker build -f contrib/docker/Dockerfile -t yggdrasil-map .
FROM python:3.13-slim

ENV HOST=localhost
ENV PORT=3000

WORKDIR /src/yggdrasil-map/web

# graphviz runtime + headers/compiler for building pygraphviz, cron for periodic re-render
RUN apt-get update && \
    apt-get install -y --no-install-recommends graphviz libgraphviz-dev gcc libc6-dev cron && \
    rm -rf /var/lib/apt/lists/*

COPY web/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && \
    apt-get purge -y --auto-remove gcc libc6-dev

COPY web/ ./
COPY contrib/docker/web_config.cfg ./web_config.cfg

COPY contrib/docker/entrypoint.sh /usr/bin/entrypoint.sh
RUN chmod 0555 /usr/bin/entrypoint.sh

COPY contrib/docker/crontab /etc/cron.d/jobs
RUN chmod 0644 /etc/cron.d/jobs

ENTRYPOINT [ "/usr/bin/entrypoint.sh" ]
