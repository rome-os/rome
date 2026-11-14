# The Rome desktop app as a place, sourced by env.sh. The shell is built from
# the same merged tree as the Rome image and runs on Linux in a container on
# the environment's network, with an X server and no screen. It opens the
# environment's Rome through the shell's own dashboard URL override, which
# only an unpackaged build reads.

DESKTOP="rome-env-${NAME}-desktop"
DESKTOP_IMAGE="rome-env-${NAME}-desktop-runtime:latest"
DESKTOP_TREE="$STATE_DIR/desktop-tree"
DESKTOP_BUILD_FILE="$RUN_DIR/desktop-build.json"

# Electron's system libraries, an X server without a screen, and socat to
# give the shell the same loopback addresses Chrome uses.
build_desktop_image() {
  docker image inspect "$DESKTOP_IMAGE" >/dev/null 2>&1 && return
  log "building the desktop app's runtime image ..."
  printf '%s\n' \
    'FROM node:24-bookworm' \
    'RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends socat xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libxkbcommon0 libatk-bridge2.0-0 libcups2 libsecret-1-0 fonts-noto-cjk >/dev/null && rm -rf /var/lib/apt/lists/*' |
    docker build --quiet --tag "$DESKTOP_IMAGE" - >/dev/null
}

# Builds the desktop shell of the merged commit into a checkout of its own,
# which the desktop container mounts read-only.
build_desktop_shell() {
  local merged="$1"
  build_desktop_image
  log "building the desktop app from the merged tree ${merged:0:9} ..."
  if [ ! -e "$DESKTOP_TREE/.git" ]; then
    rm -rf "$DESKTOP_TREE"
    git -C "$REPO_ROOT" worktree add --quiet --detach "$DESKTOP_TREE" "$merged"
  else
    git -C "$DESKTOP_TREE" checkout --quiet --force --detach "$merged"
  fi
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e npm_config_store_dir="$STATE_DIR/pnpm-store" \
    -v "$STATE_DIR:$STATE_DIR" -w "$DESKTOP_TREE" "$DESKTOP_IMAGE" bash -c '
      set -e
      mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && export PATH=/tmp/bin:$PATH
      pnpm install --frozen-lockfile --filter "rome-desktop..." --reporter=silent
      pnpm --filter rome-desktop build >/tmp/build.log 2>&1 || { tail -40 /tmp/build.log >&2; exit 1; }
      cd packages/desktop && test -x "$(node -p "require(\"electron\")")"' ||
    die "the desktop app did not build. The output above says why."
  printf '{"commit":"%s","electron":"%s","platform":"linux","builtAt":"%s"}\n' "$merged" \
    "$(node -p "require('$DESKTOP_TREE/packages/desktop/node_modules/electron/package.json').version")" \
    "$(date -u +%FT%TZ)" >"$DESKTOP_BUILD_FILE"
}

stop_desktop() {
  docker rm -f "$DESKTOP" >/dev/null 2>&1 || true
}
