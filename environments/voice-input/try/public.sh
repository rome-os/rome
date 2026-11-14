#!/usr/bin/env bash
# Puts the provider try page in front of a person, on the devbox's Cloudflare
# Tunnel, at https://voice-try.romeos.dev, behind the romeos.dev Cloudflare
# Access app. Voice input in Rome itself is tried on the environment's own
# Rome, which reaches a transcriber only through Rome Cloud.
#
#   environments/voice-input/try/public.sh up | down
#
# Routing: cloudflared → the devbox's Caddy shim → Traefik (rome-edge) → an
# edge Caddy registered for voice-try.rome.localhost → the try page.
set -euo pipefail
# shellcheck source=../env.sh
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

PUBLIC_TRY="rome-env-${NAME}-public-try"
PUBLIC_EDGE="rome-env-${NAME}-public-edge"
PUBLIC_STATE="$RUN_DIR/../public"
EDGE_NETWORK=rome-edge

cmd_up() {
  docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || die "Traefik's $EDGE_NETWORK network is missing. Start it with scripts/dev-up.sh."
  ensure_network
  mkdir -p "$PUBLIC_STATE"

  log "starting the try page ..."
  docker rm -f "$PUBLIC_TRY" >/dev/null 2>&1 || true
  docker run -d --name "$PUBLIC_TRY" --restart unless-stopped --memory 2g --network "$NETWORK" \
    -v "$ENV_DIR/try:/repo/environments/voice-input/try:ro" \
    -v "$REPO_ROOT/packages/core/package.json:/repo/packages/core/package.json:ro" \
    -v "$(ws_dir):/repo/packages/core/node_modules/ws:ro" \
    -v "$SECRETS_FILE:/secrets/voice.env:ro" -e VOICE_ENV_FILE=/secrets/voice.env \
    node:24-bookworm-slim node /repo/environments/voice-input/try/server.mjs --port 4790 --host 0.0.0.0 >/dev/null

  log "registering voice-try.rome.localhost with Traefik ..."
  docker rm -f "$PUBLIC_EDGE" >/dev/null 2>&1 || true
  printf '%s\n' \
    '{' '  admin off' '  auto_https off' '}' \
    ':80 {' "  reverse_proxy $PUBLIC_TRY:4790" '}' >"$PUBLIC_STATE/Caddyfile"
  chmod 644 "$PUBLIC_STATE/Caddyfile"
  docker create --name "$PUBLIC_EDGE" --restart unless-stopped --network "$EDGE_NETWORK" \
    -l traefik.enable=true -l traefik.docker.network="$EDGE_NETWORK" \
    -l "traefik.http.routers.$PUBLIC_EDGE.entrypoints=web" \
    -l "traefik.http.routers.$PUBLIC_EDGE.rule=Host(\`voice-try.rome.localhost\`)" \
    -l "traefik.http.routers.$PUBLIC_EDGE.priority=100" \
    -l "traefik.http.services.$PUBLIC_EDGE.loadbalancer.server.port=80" \
    -v "$PUBLIC_STATE/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2-alpine >/dev/null
  docker network connect "$NETWORK" "$PUBLIC_EDGE"
  docker start "$PUBLIC_EDGE" >/dev/null
  log "up: https://voice-try.romeos.dev"
}

cmd_down() {
  docker rm -f "$PUBLIC_EDGE" "$PUBLIC_TRY" >/dev/null 2>&1 || true
  rm -rf "$PUBLIC_STATE"
  log "removed."
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  *) die "usage: public.sh up | down" ;;
esac
