#!/usr/bin/env bash
# The onboarding environment: a local Rome Cloud that creates each new Rome as a
# container on this machine, reachable through the Cloudflare tunnel.
#
#   environments/onboarding/env.sh up      # start, or bring up to date
#   environments/onboarding/env.sh walk    # reset, then run the walk-through
#   environments/onboarding/env.sh reset   # delete every account and Rome
#   environments/onboarding/env.sh down    # remove everything up created
#
# See README.md for what it tests and how it differs from production.
set -euo pipefail

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"

NAME=onboarding
NETWORK=rome-edge
DOMAIN="${ROME_ENV_DOMAIN:-romeos.dev}"
# The tunnel maps <name>-pantheon.<domain> to Traefik Host pantheon.<name>.rome.localhost
# and <slug>.<domain> to Traefik Host <slug>.rome.localhost.
CLOUD_ORIGIN="https://${NAME}-pantheon.${DOMAIN}"
CLOUD_TRAEFIK_HOST="pantheon.${NAME}.rome.localhost"

STATE_DIR="${ROME_ENV_STATE_DIR:-$HOME/.rome-environments/$NAME}"
ROME_CLOUD_REPO="${ROME_CLOUD_REPO:-$HOME/workspace/rome-cloud}"
ROME_CLOUD_REF="${ROME_CLOUD_REF:-origin/main}"
# Set ROME_CLOUD_DIR to run a Rome Cloud checkout as it is, for example while
# changing Rome Cloud code. Otherwise up checks out ROME_CLOUD_REF.
ROME_CLOUD_DIR="${ROME_CLOUD_DIR:-$STATE_DIR/rome-cloud}"

# Shared by every environment, and kept by `down`. The name stays out of
# rome-vm-*, which Rome Cloud uses for the Romes it creates.
REGISTRY=rome-env-registry
REGISTRY_PORT=5050
ROME_IMAGE_PUSH="127.0.0.1:${REGISTRY_PORT}/rome:env-${NAME}"
ROME_IMAGE_PULL="${REGISTRY}:5000/rome:env-${NAME}"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"

PG="rome-env-${NAME}-pg"
PG_VOLUME="rome-env-${NAME}-pg"
CLOUD="rome-env-${NAME}-cloud"
ROUTER="rome-env-${NAME}-router"
RUNNER_IMAGE="rome-env-${NAME}-runner"
ENV_FILE="$STATE_DIR/cloud.env"
OWNER_FILE="$STATE_DIR/owner"

log() { printf 'env/%s: %s\n' "$NAME" "$*" >&2; }
die() {
  log "$*"
  exit 1
}

main_worktree() {
  local list
  list="$(git -C "$REPO_ROOT" worktree list --porcelain)"
  list="${list#worktree }"
  printf '%s' "${list%%$'\n'*}"
}

ensure_edge() {
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1 ||
    [ -z "$(docker ps -q --filter name=rome-traefik-traefik)" ]; then
    log "starting the shared Traefik ..."
    docker compose -f "$(main_worktree)/infra/traefik/compose.yml" up -d >/dev/null
  fi
}

ensure_registry() {
  if [ -z "$(docker ps -aq --filter "name=^${REGISTRY}$")" ]; then
    log "starting the local image registry ..."
    docker run -d --name "$REGISTRY" --restart unless-stopped -p "127.0.0.1:${REGISTRY_PORT}:5000" registry:2 >/dev/null
  fi
  docker start "$REGISTRY" >/dev/null
  docker network connect "$NETWORK" "$REGISTRY" 2>/dev/null || true
}

head_sha() { git -C "$REPO_ROOT" rev-parse --short HEAD; }

# The commit the registry's Rome image was built from, or nothing when there is none.
image_sha() {
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$ROME_IMAGE_PUSH" 2>/dev/null |
    sed -n 's/^ROME_BUILD_SHA=//p'
}

# Builds unless the image already comes from this commit. `force` builds anyway,
# which picks up uncommitted changes.
ensure_rome_image() {
  if [ "${1:-}" != force ] && [ "$(image_sha)" = "$(head_sha)" ]; then
    log "reusing the Rome image built from $(head_sha)"
    return
  fi
  build_rome_image
}

# One onboarding environment per machine, owned by the worktree that started it.
claim_ownership() {
  local owner
  owner="$(cat "$OWNER_FILE" 2>/dev/null || true)"
  if [ -n "$owner" ] && [ "$owner" != "$REPO_ROOT" ] && [ "${ROME_ENV_TAKE_OVER:-0}" != 1 ]; then
    die "the environment belongs to $owner. Run down there, or set ROME_ENV_TAKE_OVER=1 to take it over."
  fi
  printf '%s\n' "$REPO_ROOT" >"$OWNER_FILE"
}

build_rome_image() {
  log "building the Rome image from $(head_sha) ..."
  (
    cd "$REPO_ROOT"
    node scripts/docker/prepare-runtime-workspace.mjs
    docker build --quiet \
      --file .docker/rome-runtime-workspace/Dockerfile \
      --tag "$ROME_IMAGE_PUSH" \
      --build-arg ROME_DOCKER_APP_CODE_MODE=compiled \
      --build-arg "ROME_BUILD_SHA=$(git rev-parse --short HEAD)" \
      --build-arg "ROME_BUILD_TIME=$(date -u +%FT%TZ)" \
      .docker/rome-runtime-workspace >/dev/null
  )
  docker push --quiet "$ROME_IMAGE_PUSH" >/dev/null
}

checkout_rome_cloud() {
  if [ "$ROME_CLOUD_DIR" != "$STATE_DIR/rome-cloud" ]; then
    log "using Rome Cloud as it is in $ROME_CLOUD_DIR"
    return
  fi
  [ -d "$ROME_CLOUD_REPO/.git" ] || die "no Rome Cloud clone at $ROME_CLOUD_REPO (set ROME_CLOUD_REPO)"
  git -C "$ROME_CLOUD_REPO" fetch --quiet origin
  if [ ! -e "$ROME_CLOUD_DIR/.git" ]; then
    git -C "$ROME_CLOUD_REPO" worktree add --quiet --detach "$ROME_CLOUD_DIR" "$ROME_CLOUD_REF"
  else
    git -C "$ROME_CLOUD_DIR" checkout --quiet --detach "$ROME_CLOUD_REF"
  fi
  log "Rome Cloud at $(git -C "$ROME_CLOUD_DIR" rev-parse --short HEAD) ($ROME_CLOUD_REF)"
}

# Runs a command in the Rome Cloud checkout, inside the runner image.
in_runner() {
  docker run --rm --network "$NETWORK" --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e npm_config_store_dir="$STATE_DIR/pnpm-store" \
    --env-file "$ENV_FILE" \
    -v "$STATE_DIR:$STATE_DIR" -v "$ROME_CLOUD_DIR:$ROME_CLOUD_DIR" -w "$ROME_CLOUD_DIR" \
    "$RUNNER_IMAGE" bash -c "$1"
}

# A value already in the env file, so secrets survive a rewrite.
kept() { [ ! -f "$ENV_FILE" ] || sed -n "s/^$1=//p" "$ENV_FILE"; }

# Rewritten on every up, so a change to this script reaches Rome Cloud. The
# secrets are made once and kept.
write_env_file() {
  local jwt_secret token_key relay_key
  jwt_secret="$(kept PANTHEON_JWT_SECRET)"
  token_key="$(kept PANTHEON_OAUTH_TOKEN_ENCRYPTION_KEY)"
  relay_key="$(kept RELAY_SIGNING_KEY)"
  [ -n "$jwt_secret" ] || jwt_secret="$(openssl rand -hex 32)"
  [ -n "$token_key" ] || token_key="$(openssl rand -hex 32)"
  [ -n "$relay_key" ] || relay_key="$(node -e "const {privateKey}=require('crypto').generateKeyPairSync('ed25519');console.log(JSON.stringify(privateKey.export({format:'jwk'})))")"
  (
    umask 077
    cat >"$ENV_FILE.new" <<EOF
DATABASE_URL=postgresql://pantheon:pantheon@${PG}:5432/pantheon
PANTHEON_JWT_SECRET=${jwt_secret}
PANTHEON_OAUTH_TOKEN_ENCRYPTION_KEY=${token_key}
PANTHEON_DEV_IDP=1
PANTHEON_DOMAIN=${DOMAIN}
NEXT_PUBLIC_PANTHEON_DOMAIN=${DOMAIN}
PANTHEON_BASE_ORIGIN=${CLOUD_ORIGIN}
NEXT_TELEMETRY_DISABLED=1
PROVIDER=docker
DOCKER_NETWORK=${NETWORK}
DOCKER_INSECURE_REGISTRY=${REGISTRY}:5000
DOCKER_INSTANCE_ENV=FEATURE_GATE_ROME_CLOUD_AUTH=true
ROME_DOCKER_IMAGE=${ROME_IMAGE_PULL}
CLICKHOUSE_ENDPOINT=http://clickhouse.invalid:8123
CLICKHOUSE_INSTANCE_USERNAME=none
CLICKHOUSE_INSTANCE_PASSWORD=none
RELAY_ORIGIN=https://relay.invalid
RELAY_SIGNING_KEY=${relay_key}
EOF
  )
  mv "$ENV_FILE.new" "$ENV_FILE"
}

start_database() {
  if [ -z "$(docker ps -aq --filter "name=^${PG}$")" ]; then
    docker run -d --name "$PG" --network "$NETWORK" --restart unless-stopped \
      -e POSTGRES_USER=pantheon -e POSTGRES_PASSWORD=pantheon -e POSTGRES_DB=pantheon \
      -v "$PG_VOLUME:/var/lib/postgresql/data" postgres:16 >/dev/null
  fi
  docker start "$PG" >/dev/null
  until docker exec "$PG" pg_isready -U pantheon -q 2>/dev/null; do sleep 1; done
}

start_cloud() {
  docker rm -f "$CLOUD" >/dev/null 2>&1 || true
  # Rome Cloud runs `docker` to create each Rome, so it gets the socket and its group.
  docker run -d --name "$CLOUD" --network "$NETWORK" --restart unless-stopped \
    --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)" \
    -e HOME=/tmp --env-file "$ENV_FILE" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$ROME_CLOUD_DIR:$ROME_CLOUD_DIR" \
    -w "$ROME_CLOUD_DIR/packages/pantheon" \
    --label traefik.enable=true --label "traefik.docker.network=$NETWORK" \
    --label "traefik.http.routers.${CLOUD}.rule=Host(\`${CLOUD_TRAEFIK_HOST}\`)" \
    --label "traefik.http.routers.${CLOUD}.entrypoints=web" \
    --label "traefik.http.services.${CLOUD}.loadbalancer.server.port=3100" \
    "$RUNNER_IMAGE" node_modules/.bin/next dev --port 3100 --hostname 0.0.0.0 >/dev/null
}

# Routes <slug>.rome.localhost to the Rome container Rome Cloud named rome-vm-<slug>.
# Priority 1 lets every other stack's own Host rule win.
start_router() {
  docker rm -f "$ROUTER" >/dev/null 2>&1 || true
  docker run -d --name "$ROUTER" --network "$NETWORK" --restart unless-stopped \
    -v "$ENV_DIR/router.Caddyfile:/etc/caddy/Caddyfile:ro" \
    --label traefik.enable=true --label "traefik.docker.network=$NETWORK" \
    --label "traefik.http.routers.${ROUTER}.rule=HostRegexp(\`^[a-z0-9-]+\\.rome\\.localhost$\`)" \
    --label "traefik.http.routers.${ROUTER}.priority=1" \
    --label "traefik.http.routers.${ROUTER}.entrypoints=web" \
    --label "traefik.http.services.${ROUTER}.loadbalancer.server.port=80" \
    caddy:2 >/dev/null
}

wait_for_cloud() {
  log "waiting for Rome Cloud at $CLOUD_ORIGIN ..."
  local code attempts=0
  until code="$(curl -4 -s -o /dev/null -w '%{http_code}' "$CLOUD_ORIGIN/api/health")" && [ "$code" = 200 ]; do
    attempts=$((attempts + 1))
    if [ "$code" = 302 ]; then
      die "Cloudflare Access redirected this machine. Add a Bypass policy for its IPv4 address to the *.${DOMAIN} Access app."
    fi
    [ "$attempts" -lt 90 ] || die "Rome Cloud never answered. Inspect: docker logs $CLOUD"
    sleep 2
  done
  # The dev server compiles a page on its first visit, so visit the landing page
  # and the sign-up flow once, not on the person's first click.
  local path
  for path in / /login /register /dashboard; do
    curl -4 -s -o /dev/null --max-time 180 "$CLOUD_ORIGIN$path" || true
  done
}

# Removes every Rome this environment's Rome Cloud created: the rome-vm-* containers
# on its network, and their volumes. Rome Cloud must be stopped first, so that it
# creates nothing while they go.
remove_romes() {
  local id volumes
  for id in $(docker ps -aq --filter "name=^rome-vm-" --filter "network=$NETWORK"); do
    volumes="$(docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' "$id")"
    docker rm -f "$id" >/dev/null
    # shellcheck disable=SC2086
    [ -z "$volumes" ] || docker volume rm $volumes >/dev/null
  done
}

cmd_up() {
  local build=1
  [ "${1:-}" = "--no-build" ] && build=0
  mkdir -p "$STATE_DIR"
  claim_ownership
  ensure_edge
  ensure_registry
  if [ "$build" = 1 ]; then ensure_rome_image force; else ensure_rome_image; fi
  checkout_rome_cloud
  docker build --quiet -t "$RUNNER_IMAGE" -f "$ENV_DIR/runner.Dockerfile" "$ENV_DIR" >/dev/null
  write_env_file
  log "installing Rome Cloud dependencies ..."
  in_runner "corepack pnpm install --frozen-lockfile --reporter=silent"
  start_database
  log "migrating the database ..."
  in_runner "cd packages/pantheon && node_modules/.bin/drizzle-kit migrate --config drizzle.config.ts >/dev/null"
  start_cloud
  start_router
  wait_for_cloud
  log "ready: open $CLOUD_ORIGIN"
}

cmd_reset() {
  claim_ownership
  log "deleting every account and Rome ..."
  docker rm -f "$CLOUD" >/dev/null 2>&1 || true
  remove_romes
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker volume rm "$PG_VOLUME" >/dev/null 2>&1 || true
  cmd_up --no-build
}

cmd_walk() {
  cmd_reset
  log "walking from the landing page to a Rome's chat ..."
  mkdir -p "$STATE_DIR/walk"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e "CLOUD_ORIGIN=$CLOUD_ORIGIN" -e "ROME_DOMAIN=$DOMAIN" -e OUT=/out \
    -v "$STATE_DIR/walk:/out" -v "$ENV_DIR/walk.mjs:/walk/walk.mjs:ro" -w /tmp \
    "$PLAYWRIGHT_IMAGE" bash -c "npm install --silent --no-save playwright@1.62.1 >/dev/null 2>&1 && cp /walk/walk.mjs . && node walk.mjs"
  log "walk passed on Rome $(image_sha) and Rome Cloud $(git -C "$ROME_CLOUD_DIR" rev-parse --short HEAD). Screenshots: $STATE_DIR/walk"
}

cmd_down() {
  claim_ownership
  docker rm -f "$CLOUD" >/dev/null 2>&1 || true
  remove_romes
  docker rm -f "$ROUTER" "$PG" >/dev/null 2>&1 || true
  docker volume rm "$PG_VOLUME" >/dev/null 2>&1 || true
  rm -f "$ENV_FILE" "$OWNER_FILE"
  log "removed. The Rome Cloud checkout stays in $ROME_CLOUD_DIR"
}

case "${1:-}" in
  up) cmd_up "${2:-}" ;;
  walk) cmd_walk ;;
  reset) cmd_reset ;;
  down) cmd_down ;;
  *) die "usage: env.sh up [--no-build] | walk | reset | down" ;;
esac
