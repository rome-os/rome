# Rome dev image.
#
# Minimal Node + pnpm + build deps for better-sqlite3 / node-pty. At runtime
# /workspace is the container-owned `rome-workspace` named volume: source is
# synced into it (read-only) by the rome-sync sidecar via mutagen, and
# node_modules + dist are populated in-container by `pnpm install
# --frozen-lockfile` from scripts/dev-up.sh. Nothing under /workspace is a host
# bind-mount, which is what makes host `pnpm install` safe.
#
# Compose services override `command:` per process (backend, web, app-build).
# No ENTRYPOINT so `docker compose exec` runs ad-hoc commands cleanly.

FROM node:24-slim

ARG COMPOSIO_CLI_VERSION=@composio/cli@0.2.32
# Vendored standalone CLIs (see the Slack/Notion install step below).
ARG SLACK_CLI_VERSION=4.4.0
ARG NTN_CLI_VERSION=0.19.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        gh \
        ripgrep \
        python3 \
        make \
        g++ \
        ca-certificates \
        curl \
        unzip \
    && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_STRICT=0
# Pin corepack's cache to a HOME-independent path so the prepared pnpm survives
# the runtime HOME=/rome-home swap (compose.dev.yml). Without this, corepack
# re-downloads pnpm on every container start because its default cache lives
# under $HOME/.cache/node/corepack — which differs at build vs run time.
ENV COREPACK_HOME=/opt/corepack
RUN mkdir -p /opt/corepack \
    && corepack enable \
    && corepack prepare pnpm@11.6.0 --activate \
    && chmod -R a+rX /opt/corepack

# /rome-home backs the rome-home named volume (the runtime HOME — compose
# overrides `user:` to the host uid:gid). Pre-create it world-writable so a
# fresh volume initializes with permissive ownership: pnpm 11 hard-fails with
# EACCES when it can't read/write $HOME/.config/pnpm/config.yaml.
# dev-up.sh reconciles volumes created before this.
RUN mkdir -p /rome-home && chmod 0777 /rome-home

# AI tool CLIs — mirrored from the production Dockerfile so the dashboard's
# terminal-server (claude /login, codex login, opencli usage) finds them on
# PATH inside the dev container.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @anthropic-ai/claude-code@2.1.251 @openai/codex@0.144.5 @yunfanye/opencli@1.8.8

# The container's browser is the server-side Chrome (the `chrome` sidecar,
# which shares this container's network namespace — compose.dev.yml): BROWSER
# points every URL open at the CDP opener, so CLI OAuth flows (`codex login`,
# `claude /login`, …) land as tabs in the noVNC-visible Chrome. Mirrors the
# production Dockerfile; see the rationale there. The build context is
# .docker/rome-runtime-workspace (scripts/dev-up.sh), which mirrors
# scripts/docker/.
COPY scripts/docker/rome-open-in-server-browser.sh /usr/local/bin/rome-open-in-server-browser
RUN chmod 0755 /usr/local/bin/rome-open-in-server-browser
ENV BROWSER=/usr/local/bin/rome-open-in-server-browser

RUN curl -fsSL https://composio.dev/install | COMPOSIO_INSTALL_DIR=/usr/local/lib/composio bash -s -- "$COMPOSIO_CLI_VERSION" \
    && ln -sf /usr/local/lib/composio/composio /usr/local/bin/composio \
    && chmod -R a+rX /usr/local/lib/composio

# Vendor the Slack + Notion CLIs — mirrored from the production Dockerfile so the
# dev container's agents have the same `slack` / `ntn` binaries on PATH. See the
# rationale there. Pinned tarballs unpacked under /usr/local/lib, symlinked onto
# PATH; Notion's sha256 is verified.
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

# Compose overrides `user` to the host uid:gid at runtime so the synced source
# + node_modules in the /workspace volume are writable. The image itself runs
# as root; we don't `USER node` here because node:24-slim's node user (uid 1000)
# rarely matches the host.
#
# /rome-home is a world-writable HOME directory for pnpm, so pnpm state (store,
# shell config) doesn't leak into the workspace tree. Compose backs /workspace
# (rome-workspace) and /rome-home with named volumes for persistence across
# container recreations. Docker seeds a *new* named volume from the image's
# contents at the mountpoint, so the 0777 mode we set here is what the volume
# inherits — that's what lets a non-root host user write into it. (rome-sync
# usually seeds the rome-workspace volume first, with the same 0777 mode.)
RUN mkdir -p /workspace /rome-home \
    && chmod 0777 /workspace /rome-home

WORKDIR /workspace

# The source workspace is volume-populated at runtime. Keep a stable PATH entry
# whose target appears as soon as the sync sidecar seeds /workspace.
RUN ln -sf /workspace/packages/discord-cli/bin/discord.js /usr/local/bin/discord
