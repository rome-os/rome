# Dev-only Chrome sidecar for compose.dev.yml — gives the dev:all stack the
# server browser (CDP on :9222) + virtual desktop (noVNC on :6080) that the
# production container bakes into the root Dockerfile. Kept separate so the
# node:24-slim rome dev image stays browser-free.
#
# Always installs Debian `chromium` (same browser path the production image
# uses on arm64 / ROME_FORCE_CHROMIUM); dev doesn't need the dl.google.com
# google-chrome variant.
#
# The launcher scripts (scripts/docker/rome-start-chrome-cdp.sh,
# rome-apply-cdp-stealth.sh, stealth-inject.js) are bind-mounted by
# compose.dev.yml at /opt/rome/scripts/docker — editing them needs no image
# rebuild. Only entrypoint.sh is baked.
FROM debian:bookworm-slim

# Bare mirror host substituted for deb.debian.org, e.g.
# mirrors.tuna.tsinghua.edu.cn — same knob as the root Dockerfile's APT_MIRROR.
ARG APT_MIRROR=""

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    if [ -n "$APT_MIRROR" ]; then \
      printf 'Acquire::Retries "8";\nAcquire::http::Timeout "60";\nAcquire::https::Timeout "60";\n' > /etc/apt/apt.conf.d/99rome-resilience; \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      chromium \
      tigervnc-standalone-server novnc websockify openbox \
      socat curl ca-certificates python3 python3-websocket \
      fonts-noto fonts-noto-cjk fonts-noto-color-emoji fonts-liberation

COPY entrypoint.sh /usr/local/bin/chrome-sidecar-entrypoint.sh
RUN chmod +x /usr/local/bin/chrome-sidecar-entrypoint.sh

# Non-root browser user. /home/chrome/.rome is the chrome-profile volume
# mountpoint (compose.dev.yml); created here so the named volume inherits
# this ownership on first use.
RUN useradd --create-home --shell /bin/bash chrome && \
    mkdir -p /home/chrome/.rome /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix && \
    chown -R chrome:chrome /home/chrome/.rome
USER chrome
ENV HOME=/home/chrome

EXPOSE 9222 6080

ENTRYPOINT ["chrome-sidecar-entrypoint.sh"]
