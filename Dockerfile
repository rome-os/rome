# =============================================================================
# Rome — Multi-stage Docker build
# =============================================================================

# Optional build-time mirrors for unreliable or proxied networks. Both default
# to empty so upstream builds keep using the official sources unchanged; set
# them via --build-arg (or the ROME_APT_MIRROR / ROME_NPM_REGISTRY env vars in
# scripts/dev/run-local-docker.sh) to route apt and the npm registry through a
# closer/more stable mirror. APT_MIRROR is a bare host that replaces
# deb.debian.org / security.debian.org (e.g. mirrors.tuna.tsinghua.edu.cn).
ARG APT_MIRROR=""
ARG NPM_REGISTRY=""

# ---------------------------------------------------------------------------
# Stage 0: Tailscale binaries
# ---------------------------------------------------------------------------
FROM tailscale/tailscale:latest AS tailscale

# ---------------------------------------------------------------------------
# Stage 1: Dependency cache inputs
# ---------------------------------------------------------------------------
FROM node:24-slim AS docker-manifests

WORKDIR /context

# Compose builds from the repository root for an intuitive
# `docker compose up -d --build` path. This stage reduces that full context
# back to dependency manifests so source edits do not invalidate pnpm install.
COPY . .

RUN set -eux; \
    mkdir -p /docker-manifests; \
    cp package.json pnpm-lock.yaml pnpm-workspace.yaml /docker-manifests/; \
    find packages rome_apps -path '*/package.json' -type f -exec sh -c '\
      for src do \
        dest="/docker-manifests/$src"; \
        mkdir -p "$(dirname "$dest")"; \
        cp "$src" "$dest"; \
      done \
    ' sh {} +; \
    # Workspace packages may declare "bin" entries (e.g. @rome-os/app-web-sdk's
    # `rome` CLI). pnpm only links node_modules/.bin/* if the target file
    # exists at install time, so include any bin/ launchers alongside the
    # manifests. Source-only edits leave these untouched, preserving the cache.
    find packages rome_apps -type d -name bin -not -path '*/node_modules/*' -exec sh -c '\
      for src do \
        dest="/docker-manifests/$src"; \
        mkdir -p "$(dirname "$dest")"; \
        cp -r "$src" "$dest"; \
      done \
    ' sh {} +

# ---------------------------------------------------------------------------
# Stage 2: Fetch dependencies into pnpm content-addressed store
# ---------------------------------------------------------------------------
# `pnpm fetch` downloads the runtime workspace closure into /pnpm/store.
# Copy the manifest workspace instead of only pnpm-lock.yaml so Docker cache
# invalidates when a package manifest changes without a lockfile delta.
# It may also populate node_modules/.pnpm as a virtual store, so remove that
# transient tree before the filtered builder install recreates the runtime
# closure from the warm store.
FROM node:24-slim AS fetch
ARG APT_MIRROR=""
ARG NPM_REGISTRY=""

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    if [ -n "$APT_MIRROR" ]; then \
      printf 'Acquire::Retries "8";\nAcquire::http::Timeout "60";\nAcquire::https::Timeout "60";\nAcquire::http::Proxy "DIRECT";\nAcquire::https::Proxy "DIRECT";\n' > /etc/apt/apt.conf.d/99rome-resilience; \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git

ENV COREPACK_ENABLE_STRICT=0
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /build

COPY --from=docker-manifests /docker-manifests ./

# Persist the registry override into the pnpm/npm config so it carries into the
# builder stage (FROM fetch) without re-declaring the arg there. The resilience
# settings (more retries, longer timeouts, lower concurrency) only kick in when
# a mirror is configured — i.e. the flaky/proxied-network case — so default and
# CI builds keep pnpm's stock behavior. Lower network-concurrency matters most:
# fewer parallel large-tarball TLS streams survive far better on unstable links.
RUN if [ -n "$NPM_REGISTRY" ]; then \
      pnpm config set registry "$NPM_REGISTRY" && \
      pnpm config set fetch-retries 6 && \
      pnpm config set fetch-retry-mintimeout 20000 && \
      pnpm config set fetch-retry-maxtimeout 120000 && \
      pnpm config set fetch-timeout 600000 && \
      pnpm config set network-concurrency 4; \
    fi

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm fetch \
    --filter @rome/core... \
    --filter @rome/discord-cli... \
    --filter rome-web... \
    --filter @rome-os/app-web-sdk... \
    --filter @rome-os/app-runtime... \
    --filter './rome_apps/*...' && \
    rm -rf node_modules

# ---------------------------------------------------------------------------
# Stage 3: Build application
# ---------------------------------------------------------------------------
FROM fetch AS builder
ARG ROME_DOCKER_APP_CODE_MODE=source
ENV ROME_DOCKER_APP_CODE_MODE=${ROME_DOCKER_APP_CODE_MODE}

COPY . .

# Link node_modules from the warm store. `--prefer-offline` uses the fetched
# store first while still allowing pnpm to download exact locked tarballs that
# `pnpm fetch` does not materialize, such as GitHub archive dependencies.
# `--frozen-lockfile` matches the manifests against the lockfile.
# Lifecycle scripts (e.g. each SDK's `prepare: tsc`) can run here because
# src/ and tsconfig.json are now present on disk.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --prefer-offline --frozen-lockfile \
    --filter @rome/core... \
    --filter @rome/discord-cli... \
    --filter rome-web... \
    --filter @rome-os/app-web-sdk... \
    --filter @rome-os/app-runtime... \
    --filter './rome_apps/*...'

# Remove desktop-only deps not needed in Docker (electron ~500MB).
# Enumerate names explicitly — a previous `electron-*@*` glob also matched
# `electron-to-chromium@*`, which `browserslist` needs at vite-build time
# (loaded transitively by vite-plugin-svgr).
RUN rm -rf node_modules/.pnpm/electron@* \
           node_modules/.pnpm/electron-builder@* \
           node_modules/.pnpm/electron-builder-*@* \
           node_modules/.pnpm/electron-publish@* \
           node_modules/.pnpm/electron-updater@* \
           node_modules/.pnpm/electron-winstaller@* \
           node_modules/.pnpm/app-builder-bin@* \
           node_modules/.pnpm/7zip-bin@* \
           node_modules/.pnpm/@electron*

RUN pnpm build:docker-runtime

# ---------------------------------------------------------------------------
# Stage 4: Production image
# ---------------------------------------------------------------------------
FROM node:24-slim AS production
ARG TARGETARCH
ARG ROME_DOCKER_APP_CODE_MODE=source
ARG COMPOSIO_CLI_VERSION=@composio/cli@0.2.32
# Vendored standalone CLIs (see the Slack/Notion install step below).
ARG SLACK_CLI_VERSION=4.4.0
ARG NTN_CLI_VERSION=0.19.0
# Build identity, surfaced in the dashboard's Advanced settings footer. The
# production image ships without a .git directory (see .dockerignore), so these
# freeze the running build's SHA + build time at image-build time. ROME_VERSION
# is the release semver (no v prefix, matching the image's docker tag); it is
# empty on non-release builds.
ARG ROME_VERSION
ARG ROME_BUILD_SHA
ARG ROME_BUILD_TIME
# GA4 measurement ID, consumed at container RUNTIME only: the boot
# script writes it into the SPA's runtime-config.js and the gateway page. The
# build-arg merely sets the image's default ENV (CI secret on published images,
# empty everywhere else) — starting a container with ROME_GA_MEASUREMENT_ID
# overridden or emptied changes/disables analytics without a rebuild (R7).
ARG ROME_GA_MEASUREMENT_ID=""
ARG APT_MIRROR=""
ARG NPM_REGISTRY=""
# When non-empty, install the Debian-repo `chromium` on amd64 instead of pulling
# google-chrome from dl.google.com. Lets amd64 builds on networks that cannot
# reach Google use the same browser path as arm64 (which already ships chromium).
ARG ROME_FORCE_CHROMIUM=""

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    if [ -n "$APT_MIRROR" ]; then \
      printf 'Acquire::Retries "8";\nAcquire::http::Timeout "60";\nAcquire::https::Timeout "60";\nAcquire::http::Proxy "DIRECT";\nAcquire::https::Proxy "DIRECT";\n' > /etc/apt/apt.conf.d/99rome-resilience; \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends curl gnupg ca-certificates && \
    if [ "$TARGETARCH" = "amd64" ] && [ -z "$ROME_FORCE_CHROMIUM" ]; then \
      install -m 0755 -d /etc/apt/keyrings && \
      curl -fsSL --retry 5 --retry-delay 2 https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg && \
      chmod a+r /etc/apt/keyrings/google-chrome.gpg && \
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
    fi && \
    apt-get update && \
    if [ "$TARGETARCH" = "amd64" ] && [ -z "$ROME_FORCE_CHROMIUM" ]; then \
      BROWSER_PACKAGE="google-chrome-stable"; \
      BROWSER_BINARY="/usr/bin/google-chrome-stable"; \
    else \
      BROWSER_PACKAGE="chromium"; \
      BROWSER_BINARY="/usr/bin/chromium"; \
    fi && \
    apt-get install -y --no-install-recommends tini git gh jq ripgrep openssh-server gosu rsync iptables iproute2 sudo caddy sshfs fuse3 xvfb x11vnc novnc websockify openbox xterm socat python3 python3-websocket xclip unzip fonts-noto fonts-noto-cjk fonts-noto-color-emoji fonts-liberation "$BROWSER_PACKAGE" && \
    printf '%s\n' "$BROWSER_BINARY" > /etc/rome-browser-binary

# Install AI tool CLIs globally (early for better layer caching).
# @yunfanye/opencli is not mirrored on npmmirror, so install it separately from the
# default registry. A scoped --@yunfanye:registry override on the mirrored install
# does NOT work: npm's replace-registry-host rewrites the npmjs tarball host to the
# top-level --registry (the mirror), producing a 404.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g ${NPM_REGISTRY:+--registry "$NPM_REGISTRY"} @anthropic-ai/claude-code@2.1.251 @openai/codex@0.144.5 && \
    npm install -g @yunfanye/opencli@1.8.7

RUN curl -fsSL --retry 5 --retry-delay 2 https://composio.dev/install | COMPOSIO_INSTALL_DIR=/usr/local/lib/composio bash -s -- "$COMPOSIO_CLI_VERSION" && \
    ln -sf /usr/local/lib/composio/composio /usr/local/bin/composio && \
    chmod -R a+rX /usr/local/lib/composio

# Vendor the Slack + Notion CLIs (both standalone binaries) so in-container
# agents can drive the Slack Web API (`slack api <method>`) and Notion (`ntn`)
# directly. Same shape as the Composio install above: pinned versions, unpacked
# under /usr/local/lib and symlinked onto PATH. The upstream installer scripts
# are unsuitable here (Slack's has no install-dir override and would land under
# /root, unreadable by the rome user), so we fetch the pinned release tarballs
# directly — Slack from its CDN (no published checksum, HTTPS + retries like the
# other vendored fetches), Notion with its published sha256 verified.
# Kept in sync with infra/rome/Dockerfile.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) ntn_target="x86_64-unknown-linux-musl" ;; \
      arm64) ntn_target="aarch64-unknown-linux-musl" ;; \
      *) echo "unsupported arch for slack/notion CLIs: $arch" >&2; exit 1 ;; \
    esac; \
    mkdir -p /usr/local/lib/slack-cli; \
    curl -fsSL --retry 5 --retry-delay 2 \
      "https://downloads.slack-edge.com/slack-cli/slack_cli_${SLACK_CLI_VERSION}_linux_${arch}.tar.gz" \
      | tar -xz -C /usr/local/lib/slack-cli; \
    ln -sf /usr/local/lib/slack-cli/bin/slack /usr/local/bin/slack; \
    tmp="$(mktemp -d)"; \
    ntn_archive="ntn-${ntn_target}.tar.gz"; \
    curl -fsSL --retry 5 --retry-delay 2 -o "$tmp/$ntn_archive" \
      "https://ntn.dev/releases/v${NTN_CLI_VERSION}/$ntn_archive"; \
    curl -fsSL --retry 5 --retry-delay 2 -o "$tmp/$ntn_archive.sha256" \
      "https://ntn.dev/releases/v${NTN_CLI_VERSION}/$ntn_archive.sha256"; \
    ( cd "$tmp" && sha256sum -c "$ntn_archive.sha256" ); \
    mkdir -p /usr/local/lib/notion-cli; \
    tar -xz --strip-components=1 -C /usr/local/lib/notion-cli -f "$tmp/$ntn_archive"; \
    ln -sf /usr/local/lib/notion-cli/ntn /usr/local/bin/ntn; \
    rm -rf "$tmp"; \
    chmod -R a+rX /usr/local/lib/slack-cli /usr/local/lib/notion-cli; \
    test -x /usr/local/lib/slack-cli/bin/slack; \
    ntn --version

ENV COREPACK_ENABLE_STRICT=0
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

# Create rome user early so COPY --chown can avoid expensive recursive chown
RUN groupadd --system rome && \
    useradd --system --no-log-init --gid rome --create-home --shell /bin/bash rome

# Tailscale binaries + state dirs
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
RUN mkdir -p /var/lib/tailscale /var/run/tailscale && \
    echo "rome ALL=(root) NOPASSWD: /usr/local/bin/tailscale" > /etc/sudoers.d/rome-tailscale && \
    echo "rome ALL=(root) NOPASSWD: /bin/sh /app/scripts/docker/rome-hostfs-remote-access-provision.sh *" > /etc/sudoers.d/rome-hostfs && \
    chmod 0440 /etc/sudoers.d/rome-tailscale /etc/sudoers.d/rome-hostfs

# Build into /opt/rome — the bind-mounted /app volume hides image contents at
# runtime, so the entrypoint copies from /opt/rome to /app on first run.
WORKDIR /opt/rome

# Copy entire built application with correct ownership (avoids expensive chown -R layer)
COPY --chown=rome:rome --from=builder /build/ ./

ENV ROME_DOCKER_APP_CODE_MODE=${ROME_DOCKER_APP_CODE_MODE}
# Explicitly declare ownership of the production proxy config so daemon
# startup reconciliation is enabled without inferring ownership from a path.
ENV CADDY_CONFIG_PATH=/etc/caddy/Caddyfile

RUN case "$ROME_DOCKER_APP_CODE_MODE" in \
      source) ;; \
      compiled) \
        rm -rf /opt/rome/packages/core/src && \
        rm -rf /opt/rome/packages/web/src && \
        rm -f /opt/rome/scripts/*.ts \
              /opt/rome/scripts/*.test.ts \
              /opt/rome/scripts/*.integration.test.ts \
              /opt/rome/scripts/*.e2e.test.ts; \
        ;; \
      *) \
        echo "Unsupported ROME_DOCKER_APP_CODE_MODE: $ROME_DOCKER_APP_CODE_MODE" >&2; \
        exit 1; \
        ;; \
    esac

# The Discord CLI has no source runtime mode; every image executes dist only.
RUN rm -rf /opt/rome/packages/discord-cli/src

# Fingerprint synced app content (excluding image-backed node_modules) to skip redundant sync on restart.
RUN find /opt/rome \
      -name node_modules -prune -o \
      -type f -print0 | \
    sort -z | \
    xargs -0 sha256sum | \
    sha256sum | \
    awk '{print $1}' > /opt/rome/.image-sync-id

# Copy Caddyfile for public reverse proxy
COPY Caddyfile /etc/caddy/Caddyfile

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Agent-facing Discord REST CLI. /app is populated from /opt/rome by the
# entrypoint; the package launcher always loads its compiled dist entrypoint.
RUN ln -sf /app/packages/discord-cli/bin/discord.js /usr/local/bin/discord

# Chrome/CDP launcher assets
RUN chmod +x /opt/rome/scripts/docker/rome-start-chrome-cdp.sh /opt/rome/scripts/docker/rome-apply-cdp-stealth.sh

# Restore the execute bit on vendored ripgrep binaries. The Anthropic npm
# tarballs (@anthropic-ai/claude-agent-sdk as a pnpm dep, and the globally
# installed @anthropic-ai/claude-code) publish vendor/ripgrep/<arch>/rg as
# 0644, so the SDK's Grep tool fails with EACCES when it spawns rg directly.
# Mark every vendored rg executable in both the image node_modules (used at
# runtime via the /app/node_modules symlink) and the npm-global tree.
RUN find /opt/rome/node_modules /usr/local/lib/node_modules \
      -type f -path '*/vendor/ripgrep/*/rg' -exec chmod a+rx {} + 2>/dev/null || true

# The container's browser is the server-side Chrome: BROWSER points every
# URL open at the CDP opener, so any CLI OAuth flow that shells out to the
# system browser (`codex login`, `claude /login`, `gh auth login`, …) lands
# as a tab in the noVNC-visible Chrome. $BROWSER is honored both by browser
# launchers directly (e.g. codex's webbrowser crate checks it first) and by
# xdg-open's headless fallback path — the xdg mimeapps route is NOT viable
# here: xdg-open only consults mimeapps when $DISPLAY is set, and the
# backend runs without one.
RUN install -m 0755 /opt/rome/scripts/docker/rome-open-in-server-browser.sh /usr/local/bin/rome-open-in-server-browser
ENV BROWSER=/usr/local/bin/rome-open-in-server-browser

RUN test ! -e /opt/rome/packages/desktop && \
    test ! -e /opt/rome/packages/pantheon && \
    test ! -e /opt/rome/packages/cdp-client

# Set remaining permissions
RUN chown -R rome:rome /etc/caddy && \
    chmod 750 /home/rome

# Create user account for SSH access
RUN getent group fuse >/dev/null || groupadd --system fuse && \
    useradd --no-log-init --create-home --shell /bin/bash user && \
    chmod 750 /home/user && \
    usermod -aG user rome && \
    usermod -aG fuse rome

RUN printf 'user_allow_other\n' > /etc/fuse.conf

# SSH setup
RUN mkdir -p /run/sshd && \
    mkdir -p /etc/ssh/ssh_host_keys
COPY sshd_config /etc/ssh/sshd_config

WORKDIR /app

ENV NODE_ENV=production
ENV INTERNAL_API_WEB_ROOT=/app/packages/web/dist
ENV ROME_VERSION=${ROME_VERSION}
ENV ROME_BUILD_SHA=${ROME_BUILD_SHA}
ENV ROME_BUILD_TIME=${ROME_BUILD_TIME}
ENV ROME_GA_MEASUREMENT_ID=${ROME_GA_MEASUREMENT_ID}
ENV DISPLAY=:99
ENV ROME_SCREEN_SIZE=1280x800x24
ENV ROME_NOVNC_PORT=6080
ENV ROME_VNC_PORT=5900
ENV ROME_ENABLE_CHROME=1
ENV ROME_CHROME_NAME=Chrome
ENV ROME_CHROME_CDP_PORT=9222
ENV ROME_CHROME_INTERNAL_CDP_PORT=9223
ENV ROME_CHROME_BIND_ADDRESS=0.0.0.0
ENV ROME_CHROME_STARTUP_WAIT=20
ENV ROME_CHROME_WINDOW_SIZE=1280,800
ENV ROME_CHROME_URL=about:blank
ENV ROME_CHROME_USER_DATA_DIR=/home/rome/.rome/chrome-profile
ENV ROME_CHROME_FULLSCREEN=0
ENV ROME_CHROME_DISABLE_SANDBOX=0
ENV ROME_CHROME_ENABLE_STEALTH=1
ENV ROME_CHROME_TIMEZONE=America/Los_Angeles
ENV ROME_CHROME_LANG=en-US
ENV ROME_CHROME_CLIPBOARD_DEFAULT_SETTING=

EXPOSE 8080 4141 9368 22 5900 6080 9222

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
