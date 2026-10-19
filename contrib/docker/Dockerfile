# Built by .github/workflows/docker.yml, or manually from the repository root:
#   docker build -f contrib/docker/Dockerfile -t yggdrasil-map .
FROM python:3.13-slim

# Official yggdrasil release package, pinned by checksum
ARG YGG_VERSION=0.5.14
ARG YGG_DEB_SHA256=72745496b09baa1c3f5a6741e1257a704cfdb9d00cdf3ddbef025987b239699d

WORKDIR /src/yggdrasil-map/web

# graphviz runtime + headers/compiler for building pygraphviz
RUN apt-get update && \
    apt-get install -y --no-install-recommends graphviz libgraphviz-dev gcc libc6-dev && \
    rm -rf /var/lib/apt/lists/*

COPY web/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && \
    apt-get purge -y --auto-remove gcc libc6-dev

RUN python3 -c "import urllib.request, sys; urllib.request.urlretrieve(sys.argv[1], '/tmp/yggdrasil.deb')" \
        "https://github.com/yggdrasil-network/yggdrasil-go/releases/download/v${YGG_VERSION}/yggdrasil-${YGG_VERSION}-amd64.deb" && \
    echo "${YGG_DEB_SHA256}  /tmp/yggdrasil.deb" | sha256sum -c - && \
    dpkg-deb -x /tmp/yggdrasil.deb /tmp/ygg && \
    install -m 0755 /tmp/ygg/usr/bin/yggdrasil /tmp/ygg/usr/bin/yggdrasilctl /usr/local/bin/ && \
    rm -rf /tmp/yggdrasil.deb /tmp/ygg && \
    yggdrasil -version

COPY web/ ./
COPY scripts/getcurrent.py /src/yggdrasil-map/scripts/getcurrent.py
COPY contrib/docker/web_config.cfg ./web_config.cfg
COPY contrib/docker/ygg-config.py /usr/local/bin/ygg-config
COPY contrib/docker/entrypoint.sh /usr/bin/entrypoint.sh
RUN chmod 0555 /usr/bin/entrypoint.sh /usr/local/bin/ygg-config

ENV HOST=0.0.0.0 \
    PORT=3000 \
    UPDATE_INTERVAL=600 \
    YGG_EMBEDDED=1 \
    PYTHONUNBUFFERED=1

VOLUME /config
EXPOSE 3000
ENTRYPOINT [ "/usr/bin/entrypoint.sh" ]
