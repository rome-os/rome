#!/usr/bin/env bash
# Puts voice input in front of a person, on the devbox's Cloudflare Tunnel:
#
#   https://voice-input.romeos.dev   a Rome of its own, built from the same image as
#                                    the environment, transcribing with real Soniox
#   https://voice-try.romeos.dev     the provider try page
#
# Both sit behind the romeos.dev Cloudflare Access app. The Rome here is
# separate from the environment's, so a person trying it never disturbs a
# verifier run, and `env.sh reset` never wipes it.
#
#   environments/voice-input/try/public.sh up | down | password
#
# Routing: cloudflared → the devbox's Caddy shim → Traefik (rome-edge) → an
# edge Caddy registered for the two *.rome.localhost names → the Rome or the
# try page.
set -euo pipefail
# shellcheck source=../env.sh
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

PUBLIC_ROME="rome-env-${NAME}-public-rome"
PUBLIC_TRY="rome-env-${NAME}-public-try"
PUBLIC_EDGE="rome-env-${NAME}-public-edge"
PUBLIC_VOLUME_PREFIX="rome-env-${NAME}-public"
PUBLIC_STATE="$RUN_DIR/../public"
PUBLIC_ENV_FILE="$PUBLIC_STATE/rome.env"
PASSWORD_FILE="$PUBLIC_STATE/guardian-password"
EDGE_NETWORK=rome-edge

public_api() {
  docker exec -i "$PUBLIC_ROME" curl -sS --fail-with-body -X "$1" \
    -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
    --data-binary @- "$API$2"
}

cmd_up() {
  load_secrets
  [ -n "${SONIOX_API_KEY:-}" ] || die "set SONIOX_API_KEY in $SECRETS_FILE"
  [ -n "$(image_sha)" ] || die "no Rome image yet. Run env.sh up first."
  docker network inspect "$EDGE_NETWORK" >/dev/null 2>&1 || die "Traefik's $EDGE_NETWORK network is missing. Start it with scripts/dev-up.sh."
  ensure_network
  mkdir -p "$PUBLIC_STATE"

  local jwt key
  jwt="$(sed -n 's/^ROME_JWT_SECRET=//p' "$PUBLIC_ENV_FILE" 2>/dev/null || true)"
  key="$(sed -n 's/^ROME_OAUTH_TOKEN_ENCRYPTION_KEY=//p' "$PUBLIC_ENV_FILE" 2>/dev/null || true)"
  {
    echo "NODE_ENV=production"
    echo "WEB_HOST=0.0.0.0"
    echo "ROME_JWT_SECRET=${jwt:-$(openssl rand -hex 32)}"
    echo "ROME_OAUTH_TOKEN_ENCRYPTION_KEY=${key:-$(openssl rand -hex 32)}"
    echo "PANTHEON_BASE_ORIGIN="
    echo "ROME_TRANSCRIPTION_PROVIDER=soniox"
    echo "ROME_TRANSCRIPTION_URL=$SONIOX_URL"
    echo "ROME_TRANSCRIPTION_API_KEY=$SONIOX_API_KEY"
  } >"$PUBLIC_ENV_FILE"

  log "starting the public Rome with real Soniox ..."
  docker rm -f "$PUBLIC_ROME" >/dev/null 2>&1 || true
  docker run -d --name "$PUBLIC_ROME" --restart unless-stopped --network "$NETWORK" \
    --env-file "$PUBLIC_ENV_FILE" \
    -v "$PUBLIC_VOLUME_PREFIX-home:/home/rome" -v "$PUBLIC_VOLUME_PREFIX-memory:/app/memory" \
    -v "$PUBLIC_VOLUME_PREFIX-user:/home/user" \
    --cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined --shm-size 1g \
    "$IMAGE" >/dev/null
  local attempts=0
  until docker exec "$PUBLIC_ROME" curl -fsS -o /dev/null "$API/health" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 90 ] || die "the public Rome never answered. Inspect: docker logs $PUBLIC_ROME"
    sleep 2
  done
  if docker exec "$PUBLIC_ROME" curl -sS "$API/bootstrap" | grep -q '"phase":"needs-account"'; then
    openssl rand -hex 8 >"$PASSWORD_FILE"
    printf '{"userId":"%s","password":"%s"}' "$GUARDIAN_USER" "$(cat "$PASSWORD_FILE")" |
      public_api POST /onboard/create-account >/dev/null
  fi

  log "starting the try page ..."
  docker rm -f "$PUBLIC_TRY" >/dev/null 2>&1 || true
  docker run -d --name "$PUBLIC_TRY" --restart unless-stopped --network "$NETWORK" \
    -v "$ENV_DIR/try:/repo/environments/voice-input/try:ro" \
    -v "$REPO_ROOT/packages/core/package.json:/repo/packages/core/package.json:ro" \
    -v "$(ws_dir):/repo/packages/core/node_modules/ws:ro" \
    -v "$SECRETS_FILE:/secrets/voice.env:ro" -e VOICE_ENV_FILE=/secrets/voice.env \
    node:24-bookworm-slim node /repo/environments/voice-input/try/server.mjs --port 4790 --host 0.0.0.0 >/dev/null

  log "registering voice-input.rome.localhost and voice-try.rome.localhost with Traefik ..."
  docker rm -f "$PUBLIC_EDGE" >/dev/null 2>&1 || true
  printf '%s\n' \
    '{' '  admin off' '  auto_https off' '}' \
    ':80 {' \
    '  @try host voice-try.rome.localhost' \
    '  handle @try {' "    reverse_proxy $PUBLIC_TRY:4790" '  }' \
    '  handle {' "    reverse_proxy $PUBLIC_ROME:8080" '  }' \
    '}' >"$PUBLIC_STATE/Caddyfile"
  chmod 644 "$PUBLIC_STATE/Caddyfile"
  docker create --name "$PUBLIC_EDGE" --restart unless-stopped --network "$EDGE_NETWORK" \
    -l traefik.enable=true -l traefik.docker.network="$EDGE_NETWORK" \
    -l "traefik.http.routers.$PUBLIC_EDGE.entrypoints=web" \
    -l "traefik.http.routers.$PUBLIC_EDGE.rule=Host(\`voice-input.rome.localhost\`) || Host(\`voice-try.rome.localhost\`)" \
    -l "traefik.http.routers.$PUBLIC_EDGE.priority=100" \
    -l "traefik.http.services.$PUBLIC_EDGE.loadbalancer.server.port=80" \
    -v "$PUBLIC_STATE/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2-alpine >/dev/null
  docker network connect "$NETWORK" "$PUBLIC_EDGE"
  docker start "$PUBLIC_EDGE" >/dev/null
  log "up: https://voice-input.romeos.dev (guardian / password: public.sh password) and https://voice-try.romeos.dev"
}

cmd_down() {
  docker rm -f "$PUBLIC_EDGE" "$PUBLIC_TRY" "$PUBLIC_ROME" >/dev/null 2>&1 || true
  docker volume rm "$PUBLIC_VOLUME_PREFIX-home" "$PUBLIC_VOLUME_PREFIX-memory" "$PUBLIC_VOLUME_PREFIX-user" >/dev/null 2>&1 || true
  rm -rf "$PUBLIC_STATE"
  log "removed."
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  password) cat "$PASSWORD_FILE" ;;
  *) die "usage: public.sh up | down | password" ;;
esac
