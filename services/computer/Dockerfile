FROM ghcr.io/astral-sh/uv:0.8.22 AS uv-runtime
FROM debian:trixie-slim

# uv/uvx are standalone binaries; no extra Python environment or installer.
COPY --from=uv-runtime /uv /uvx /usr/local/bin/

# Official Node.js 24 LTS tarball (this image already targets x86_64 for s6).
ARG NODE_VERSION=24.22.1
ARG NODE_SHA256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6

ARG S6_OVERLAY_VERSION=3.2.3.2
ARG S6_OVERLAY_NOARCH_SHA256=5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12
ARG S6_OVERLAY_X86_64_SHA256=e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils \
        xvfb xauth x11-utils x11-xserver-utils x11vnc \
        xfwm4 picom plank thunar xfce4-terminal dbus-x11 dbus-user-session adwaita-icon-theme gnome-themes-extra feh \
        chromium chromium-sandbox \
        python3 python3-pip python3-venv python3-pytest \
        xdotool xterm procps \
        fonts-dejavu-core fonts-liberation \
        git ripgrep patch \
        tmux \
        imagemagick librsvg2-bin \
        util-linux nftables \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
        "node-v${NODE_VERSION}-linux-x64/bin/node" "node-v${NODE_VERSION}-linux-x64/lib/node_modules/npm" \
    && rm /tmp/node.tar.xz \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version && npx --version && uv --version && uvx --version

RUN curl -fsSL -o /tmp/s6-noarch.tar.xz \
        "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
    && curl -fsSL -o /tmp/s6-arch.tar.xz \
        "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz" \
    && echo "${S6_OVERLAY_NOARCH_SHA256}  /tmp/s6-noarch.tar.xz" | sha256sum -c - \
    && echo "${S6_OVERLAY_X86_64_SHA256}  /tmp/s6-arch.tar.xz" | sha256sum -c - \
    && tar -C / -Jxpf /tmp/s6-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
    && rm -f /tmp/s6-noarch.tar.xz /tmp/s6-arch.tar.xz

RUN groupadd --system desk \
    && useradd --system --gid desk --create-home --home-dir /data/home/desk --shell /usr/sbin/nologin desk \
    && python3 -m venv /opt/desk/venv \
    && /opt/desk/venv/bin/pip install --no-cache-dir \
        fastapi==0.115.6 \
        uvicorn==0.34.0 \
        playwright==1.49.1 \
    && /opt/desk/venv/bin/pip install --no-cache-dir websockets==15.0.1

COPY s6/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
COPY s6/user-bundles.d/ /etc/s6-overlay/user-bundles.d/
COPY scripts/start-window /usr/local/bin/start-window
COPY scripts/stop-window /usr/local/bin/stop-window
COPY scripts/box-bounded-log /usr/local/bin/box-bounded-log
COPY scripts/bots-init /etc/s6-overlay/scripts/bots-init
COPY src/ /opt/desk/src/
COPY fixtures/ /opt/fixtures/www/
COPY fixtures/mcp_echo.py /opt/fixtures/mcp_echo.py
COPY sample-repo/ /opt/fixtures/sample-repo/
COPY desktop/wallpaper.svg /usr/share/backgrounds/teammates.svg
COPY desktop/start-panels /opt/desk/bin/start-panels
COPY desktop/start-wm /opt/desk/bin/start-wm
COPY desktop/icons/ /opt/desk/icons-src/
COPY desktop/launch-browser /opt/desk/bin/launch-browser
COPY desktop/launch-files /opt/desk/bin/launch-files
COPY desktop/launch-terminal /opt/desk/bin/launch-terminal
COPY desktop/chromium.desktop /opt/desk/applications/chromium.desktop
COPY desktop/files.desktop /opt/desk/applications/files.desktop
COPY desktop/terminal.desktop /opt/desk/applications/terminal.desktop
RUN chmod +x /etc/s6-overlay/scripts/bots-init /usr/local/bin/start-window /usr/local/bin/stop-window /usr/local/bin/box-bounded-log /opt/desk/bin/start-panels /opt/desk/bin/start-wm \
        /opt/desk/bin/launch-browser /opt/desk/bin/launch-files /opt/desk/bin/launch-terminal \
    && find /etc/s6-overlay/s6-rc.d -name run -exec chmod +x {} \; \
    && chmod 0755 /opt/desk/src \
    && mkdir -p /usr/share/backgrounds /opt/desk/icons \
    && rsvg-convert /usr/share/backgrounds/teammates.svg -o /usr/share/backgrounds/teammates.png \
    && for name in chromium files terminal; do rsvg-convert -w 128 -h 128 /opt/desk/icons-src/$name.svg -o /opt/desk/icons/$name.png; done

# mkfs.ext4 runs inside this image. The host often does not have e2fsprogs.
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs \
    && rm -rf /var/lib/apt/lists/*

ENV S6_VERBOSITY=1 \
    COMPUTER_BOT_NFT=required \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=60000 \
    PYTHONUNBUFFERED=1 \
    MALLOC_ARENA_MAX=2 \
    DISPLAY_GEOMETRY=1920x1200 \
    DISPLAY_DEPTH=24 \
    DISPLAY_NUM=1 \
    COMPUTER_SECOND_DISPLAY=true \
    CDP_PORT=9223 \
    CDP_PROXY_PORT=9222 \
    VNC_VIEW_PORT=5900 \
    VNC_RW_PORT=6900

EXPOSE 7700 6080 8099

HEALTHCHECK --interval=30s --timeout=5s --retries=5 --start-period=25s \
    CMD curl -fsS http://127.0.0.1:7700/health || exit 1

ENTRYPOINT ["/init"]
