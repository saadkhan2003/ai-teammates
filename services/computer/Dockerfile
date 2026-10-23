FROM debian:trixie-slim

ARG S6_OVERLAY_VERSION=3.2.3.2
ARG S6_OVERLAY_NOARCH_SHA256=5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12
ARG S6_OVERLAY_X86_64_SHA256=e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils \
        xvfb xauth x11-utils x11-xserver-utils openbox x11vnc \
        tint2 feh pcmanfm \
        chromium chromium-sandbox \
        python3 python3-pip python3-venv python3-pytest \
        xdotool xterm procps \
        fonts-dejavu-core fonts-liberation \
        git ripgrep patch \
        imagemagick \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

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
        playwright==1.49.1

COPY s6/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
COPY s6/user-bundles.d/ /etc/s6-overlay/user-bundles.d/
COPY scripts/bots-init /etc/s6-overlay/scripts/bots-init
COPY src/ /opt/desk/src/
# One desktop, no iconify animation, no live resize redraw. Openbox stays the WM.
RUN sed -i \
        -e 's/<animateIconify>yes<\/animateIconify>/<animateIconify>no<\/animateIconify>/' \
        -e 's/<number>4<\/number>/<number>1<\/number>/' \
        -e 's/<drawContents>yes<\/drawContents>/<drawContents>no<\/drawContents>/' \
        /etc/xdg/openbox/rc.xml
COPY fixtures/ /opt/fixtures/www/
COPY fixtures/mcp_echo.py /opt/fixtures/mcp_echo.py
COPY sample-repo/ /opt/fixtures/sample-repo/
COPY desktop/rc.xml /etc/xdg/openbox/rc.xml
COPY desktop/menu.xml /etc/xdg/openbox/menu.xml
COPY desktop/top.tint2rc /opt/desk/tint2/top.tint2rc
COPY desktop/dock.tint2rc /opt/desk/tint2/dock.tint2rc
COPY desktop/start-panels /opt/desk/bin/start-panels
COPY desktop/launch-browser /opt/desk/bin/launch-browser
COPY desktop/launch-files /opt/desk/bin/launch-files
COPY desktop/launch-terminal /opt/desk/bin/launch-terminal
COPY desktop/chromium.desktop /opt/desk/applications/chromium.desktop
COPY desktop/files.desktop /opt/desk/applications/files.desktop
COPY desktop/terminal.desktop /opt/desk/applications/terminal.desktop
RUN chmod +x /etc/s6-overlay/scripts/bots-init /opt/desk/bin/start-panels \
        /opt/desk/bin/launch-browser /opt/desk/bin/launch-files /opt/desk/bin/launch-terminal \
    && find /etc/s6-overlay/s6-rc.d -name run -exec chmod +x {} \; \
    && chmod 0755 /opt/desk/src \
    && mkdir -p /usr/share/backgrounds /opt/desk/icons \
    && convert -size 1024x768 gradient:'#f7f1e6-#e4d3c0' \
        \( -size 640x420 radial-gradient:'rgba(196,98,45,0.18)-rgba(196,98,45,0)' \) -geometry +180+120 -composite \
        \( -size 420x280 radial-gradient:'rgba(255,255,255,0.55)-rgba(255,255,255,0)' \) -geometry +520+40 -composite \
        /usr/share/backgrounds/teammates.png \
    && convert -size 64x64 xc:none -fill '#3b82f6' -draw 'circle 32,32 32,8' \
        -fill '#22c55e' -draw 'circle 18,40 18,30' -fill '#eab308' -draw 'circle 46,40 46,30' \
        -fill '#ef4444' -draw 'circle 32,22 32,14' /opt/desk/icons/chromium.png \
    && convert -size 64x64 xc:none -fill '#c4622d' -draw 'roundrectangle 10,18 54,52 6,6' \
        -fill '#f6f1e7' -draw 'roundrectangle 16,26 48,46 3,3' /opt/desk/icons/files.png \
    && convert -size 64x64 xc:none -fill '#1c1c1c' -draw 'roundrectangle 8,14 56,50 6,6' \
        -fill '#f5f5f5' -font DejaVu-Sans -pointsize 22 -draw "text 16,40 '>_'" /opt/desk/icons/terminal.png

# mkfs.ext4 runs inside this image. The host often does not have e2fsprogs.
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs \
    && rm -rf /var/lib/apt/lists/*

ENV S6_VERBOSITY=1 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=60000 \
    PYTHONUNBUFFERED=1 \
    MALLOC_ARENA_MAX=2 \
    DISPLAY_GEOMETRY=1024x768 \
    DISPLAY_DEPTH=16 \
    DISPLAY_NUM=1 \
    CDP_PORT=9223 \
    CDP_PROXY_PORT=9222 \
    VNC_VIEW_PORT=5900 \
    VNC_RW_PORT=6900

EXPOSE 7700 6080 8099

HEALTHCHECK --interval=30s --timeout=5s --retries=5 --start-period=25s \
    CMD curl -fsS http://127.0.0.1:7700/health || exit 1

ENTRYPOINT ["/init"]
