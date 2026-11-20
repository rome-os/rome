#!/usr/bin/env bash
# The live mode: Rome Cloud and one Rome instance against the real Slack, on
# the devbox, at public romeos.dev names. Separate from the scored environment
# (up.sh): its own compose project, state folder (.state-live) and images.
#
#   environments/slack-app/live.sh up [--rome <ref>] [--rome-cloud <ref>] [--slug <name>] [--guardian <email>]
#   environments/slack-app/live.sh check
#   environments/slack-app/live.sh down [--images]
#
# --slug      the public names: <slug>-pantheon.romeos.dev for Rome Cloud and
#             <slug>.romeos.dev for the instance's dashboard (default slack)
# --guardian  the Rome Cloud account the instance is enrolled to, and the
#             email to give Rome Cloud's dev sign-in (default guardian@slackenv.test)
#
# Rome's Slack app comes from SLACK_APP_CLIENT_ID, SLACK_APP_CLIENT_SECRET and
# SLACK_APP_SIGNING_SECRET in this script's environment, or else from
# ~/.config/rome/slack-app.env (SLACKENV_LIVE_SLACK_ENV names another file),
# which is read and never copied: the values reach only Rome Cloud's container
# and are written to no file of this environment. The model credential is read
# as up.sh reads it. `check` sends Rome Cloud Slack's signed URL challenge
# through Traefik and through the public name, and says which leg fails.
set -euo pipefail

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROME_DIR="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"
ROME_CLOUD_DIR="${ROME_CLOUD_DIR:-$(dirname "$ROME_DIR")/rome-cloud}"
STATE_DIR="${SLACKENV_LIVE_STATE:-$ENV_DIR/.state-live}"
PUBLIC_DOMAIN="${ROME_REMOTE_DOMAIN:-romeos.dev}"

log() { printf '[slackenv-live] %s\n' "$*" >&2; }
die() {
  printf '[slackenv-live] %s\n' "$*" >&2
  exit 1
}
compose() { docker compose --env-file "$STATE_DIR/compose.env" -f "$ENV_DIR/live/compose.yml" "$@"; }

# Reads the Slack app's three values into this process, never into a file.
slack_app_env() {
  local file="${SLACKENV_LIVE_SLACK_ENV:-$HOME/.config/rome/slack-app.env}"
  if [ -z "${SLACK_APP_CLIENT_ID:-}" ] && [ -f "$file" ]; then
    set -a
    # shellcheck disable=SC1090 # the operator's own file
    . "$file"
    set +a
  fi
  local v
  for v in SLACK_APP_CLIENT_ID SLACK_APP_CLIENT_SECRET SLACK_APP_SIGNING_SECRET; do
    [ -n "${!v:-}" ] || die "$v is not set (set it, or put it in $file)"
  done
  export SLACK_APP_CLIENT_ID SLACK_APP_CLIENT_SECRET SLACK_APP_SIGNING_SECRET
}

# Compose interpolates every variable on every command; down and check need
# no real value for the app's.
placeholders() {
  export SLACK_APP_CLIENT_ID="${SLACK_APP_CLIENT_ID:-unused}"
  export SLACK_APP_CLIENT_SECRET="${SLACK_APP_CLIENT_SECRET:-unused}"
  export SLACK_APP_SIGNING_SECRET="${SLACK_APP_SIGNING_SECRET:-unused}"
}

cmd_down() {
  if [ -f "$STATE_DIR/compose.env" ]; then
    placeholders
    compose --profile setup down -v --remove-orphans
  fi
  if [ "${1:-}" = "--images" ]; then
    docker images --format '{{.Repository}}:{{.Tag}}' | { grep -E '^slackenv-live-rome:' || true; } | xargs -r docker rmi || true
  fi
  git -C "$ROME_DIR" worktree remove --force "$STATE_DIR/rome-src" 2>/dev/null || true
  [ -d "$ROME_CLOUD_DIR" ] && git -C "$ROME_CLOUD_DIR" worktree remove --force "$STATE_DIR/rome-cloud-src" 2>/dev/null || true
  rm -rf "$STATE_DIR"
  git -C "$ROME_DIR" worktree prune
  [ -d "$ROME_CLOUD_DIR" ] && git -C "$ROME_CLOUD_DIR" worktree prune
  log "down"
}

cmd_check() {
  [ -f "$STATE_DIR/compose.env" ] || die "no live stack here; run live.sh up first"
  slack_app_env
  # shellcheck disable=SC1091 # written by up
  . "$STATE_DIR/compose.env"
  local events="/api/slack/events" ok=0
  log "1/3 Rome Cloud answers through rome-traefik as pantheon.$SLUG.rome.localhost"
  curl -fsS -o /dev/null -H "Host: pantheon.$SLUG.rome.localhost" "http://127.0.0.1:3000/api/health" || {
    log "   no: rome-traefik does not reach Rome Cloud (is rome-traefik up, and pantheon on rome-edge?)"
    ok=1
  }
  log "2/3 the signed URL challenge, through rome-traefik"
  node "$ENV_DIR/tools/slack-challenge.mjs" "http://127.0.0.1:3000$events" --host "pantheon.$SLUG.rome.localhost" || ok=1
  log "3/3 the signed URL challenge, at https://$CLOUD_HOST$events, as Slack sends it"
  node "$ENV_DIR/tools/slack-challenge.mjs" "https://$CLOUD_HOST$events" || ok=1
  [ "$ok" = 0 ] && log "Slack would accept https://$CLOUD_HOST$events"
  return "$ok"
}

cmd_up() {
  local rome_ref=origin/main cloud_ref=origin/main slug=slack guardian=guardian@slackenv.test
  while [ $# -gt 0 ]; do
    case "$1" in
      --rome) rome_ref="$2" && shift 2 ;;
      --rome-cloud) cloud_ref="$2" && shift 2 ;;
      --slug) slug="$2" && shift 2 ;;
      --guardian) guardian="$2" && shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  case "$slug" in obs | clickhouse | otlp | deploy | *-pantheon | *[!a-z0-9-]*) die "--slug $slug does not fit the devbox's routing" ;; esac
  slack_app_env

  [ -n "$(git -C "$ROME_DIR" status --porcelain -- "$ENV_DIR" ':!environments/slack-app/.state' ':!environments/slack-app/.state-live')" ] &&
    die "environments/slack-app has uncommitted changes; commit them first"
  docker network inspect rome-edge >/dev/null 2>&1 ||
    die "no rome-edge network: rome-traefik is not running on this machine (pnpm dev:all starts it once)"
  # Another stack already answering these names would take the traffic.
  local routers
  routers="$(curl -fsS http://127.0.0.1:8080/api/http/routers 2>/dev/null || true)"
  [ -n "$routers" ] || die "rome-traefik's API on 127.0.0.1:8080 did not answer"
  if node -e '
    const [rs, slug, mine] = process.argv.slice(1);
    const taken = JSON.parse(rs).some((r) => !r.name.startsWith(mine + "-") &&
      [`pantheon.${slug}.rome.localhost`, `${slug}.rome.localhost`].some((h) => r.rule?.includes("`" + h + "`")));
    process.exit(taken ? 0 : 1);' "$routers" "$slug" slackenv-live; then
    die "another stack already routes $slug.rome.localhost; choose another --slug"
  fi

  local rome_sha cloud_sha
  rome_sha="$("$ENV_DIR/tools/resolve-ref.sh" "$ROME_DIR" "$rome_ref")" || die "cannot resolve $rome_ref"
  cloud_sha="$("$ENV_DIR/tools/resolve-ref.sh" "$ROME_CLOUD_DIR" "$cloud_ref")" || die "cannot resolve $cloud_ref"
  log "rome $rome_sha ($rome_ref), rome-cloud $cloud_sha ($cloud_ref)"

  local key token
  key="${SLACKENV_ANTHROPIC_API_KEY:-$(cat "$HOME/.config/slackenv/anthropic-api-key" 2>/dev/null || true)}"
  token="${SLACKENV_CLAUDE_OAUTH_TOKEN:-$(cat "$HOME/.config/slackenv/claude-oauth-token" 2>/dev/null || true)}"
  [ -n "$key$token" ] || die "no model credential: set SLACKENV_ANTHROPIC_API_KEY or SLACKENV_CLAUDE_OAUTH_TOKEN"
  export MODEL_PROXY_API_KEY="${key//$'\n'/}" MODEL_PROXY_OAUTH_TOKEN="${token//$'\n'/}"

  mkdir -p "$STATE_DIR"/{home,corepack,pnpm-store,relay-data,bin}
  for pair in "$ROME_CLOUD_DIR $cloud_sha rome-cloud-src" "$ROME_DIR $rome_sha rome-src"; do
    # shellcheck disable=SC2086 # three words
    set -- $pair
    git -C "$1" worktree remove --force "$STATE_DIR/$3" 2>/dev/null || rm -rf "${STATE_DIR:?}/$3"
    git -C "$1" worktree prune
    git -C "$1" worktree add -q --detach "$STATE_DIR/$3" "$2"
  done

  secret() { node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))'; }
  if [ ! -f "$STATE_DIR/secrets.env" ]; then
    local keys
    keys="$(node -e '
      const { generateKeyPairSync } = require("crypto");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      console.log(JSON.stringify({ priv: privateKey.export({ format: "jwk" }), pub: [publicKey.export({ format: "jwk" })] }));')"
    {
      echo "PANTHEON_JWT_SECRET=$(secret)"
      echo "PANTHEON_OAUTH_TOKEN_ENCRYPTION_KEY=$(secret)"
      echo "ROME_JWT_SECRET=$(secret)"
      echo "RELAY_SIGNING_KEY='$(node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).priv))' "$keys")'"
      echo "RELAY_PUBLIC_KEY='$(node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).pub))' "$keys")'"
    } >"$STATE_DIR/secrets.env"
    chmod 600 "$STATE_DIR/secrets.env"
  fi
  set -a
  # shellcheck disable=SC1091 # generated above
  . "$STATE_DIR/secrets.env"
  set +a

  export SLUG="$slug" PUBLIC_DOMAIN GUARDIAN_EMAIL="$guardian"
  export CLOUD_HOST="$slug-pantheon.$PUBLIC_DOMAIN" ROME_HOST="$slug.$PUBLIC_DOMAIN"
  # Kept across starts while the names stay: the edge and every container that
  # trusts it read it once, when they start.
  if [ "$(cat "$STATE_DIR/tls/names" 2>/dev/null)" != "$CLOUD_HOST $ROME_HOST" ]; then
    node "$ENV_DIR/tools/make-cert.mjs" "$STATE_DIR/tls" "$CLOUD_HOST" "$ROME_HOST"
    echo "$CLOUD_HOST $ROME_HOST" >"$STATE_DIR/tls/names"
  fi
  chmod 644 "$STATE_DIR/tls/tls.key" # read by the edge container's user; it guards nothing outside the network
  cat "$STATE_DIR/tls/tls.crt" ${SLACKENV_EXTRA_CA:+"$SLACKENV_EXTRA_CA"} >"$STATE_DIR/trust.pem"

  export SLACKENV_PROJECT=slackenv-live
  export SLACKENV_NODE_IMAGE="${SLACKENV_NODE_IMAGE:-node:24-slim}"
  export SLACKENV_POSTGRES_IMAGE="${SLACKENV_POSTGRES_IMAGE:-postgres:16-alpine}"
  export AGENT_MODEL="${SLACKENV_AGENT_MODEL:-claude-haiku-5-5}"
  export ROME_IMAGE="slackenv-live-rome:${rome_sha:0:12}"
  export ENV_DIR STATE_DIR HOST_UID HOST_GID
  HOST_UID="$(id -u)"
  HOST_GID="$(id -g)"
  # What compose interpolates, for check and down. The Slack app's values and
  # the model credential are left out.
  local v
  for v in SLACKENV_PROJECT SLACKENV_NODE_IMAGE SLACKENV_POSTGRES_IMAGE ROME_IMAGE AGENT_MODEL ENV_DIR STATE_DIR \
    HOST_UID HOST_GID SLUG PUBLIC_DOMAIN CLOUD_HOST ROME_HOST GUARDIAN_EMAIL ROME_JWT_SECRET; do
    printf '%s=%s\n' "$v" "${!v}"
  done >"$STATE_DIR/compose.env"
  chmod 600 "$STATE_DIR/compose.env"

  cat >"$STATE_DIR/pantheon.env" <<ENV
NODE_ENV=development
APP_PORT=3100
DATABASE_URL=postgresql://pantheon:pantheon@postgres:5432/pantheon
PANTHEON_DOMAIN=$PUBLIC_DOMAIN
PANTHEON_BASE_ORIGIN=https://$CLOUD_HOST
NEXT_PUBLIC_PANTHEON_DOMAIN=$PUBLIC_DOMAIN
PANTHEON_COOKIE_SECURE=true
PANTHEON_DEV_IDP=1
PANTHEON_JWT_SECRET=$PANTHEON_JWT_SECRET
PANTHEON_OAUTH_TOKEN_ENCRYPTION_KEY=$PANTHEON_OAUTH_TOKEN_ENCRYPTION_KEY
PROVIDER=docker
DNS_PROVIDER=none
DOCKERHUB_USERNAME=slackenv
DOCKERHUB_TOKEN=unused
CLICKHOUSE_INSTANCE_USERNAME=unused
CLICKHOUSE_INSTANCE_PASSWORD=unused
RELAY_ORIGIN=http://relay:8787
RELAY_SIGNING_KEY=$RELAY_SIGNING_KEY
ENV
  chmod 600 "$STATE_DIR/pantheon.env"
  printf "RELAY_PUBLIC_KEY='%s'\n" "$RELAY_PUBLIC_KEY" >"$STATE_DIR/rome-cloud-src/webhook-relay/.dev.vars"

  if ! docker image inspect "$ROME_IMAGE" >/dev/null 2>&1; then
    log "building $ROME_IMAGE (first time for this commit: several minutes)"
    docker build -q -t "$ROME_IMAGE" --build-arg ROME_BUILD_SHA="$rome_sha" "$STATE_DIR/rome-src" >/dev/null
  fi

  log "starting Rome Cloud, the relay and the model proxy"
  compose up -d postgres
  # Recreated on every start, so the edge serves the certificate on disk now.
  compose up -d --force-recreate edge relay pantheon model-proxy
  wait_for() { # <what> <seconds> <command...>
    local what="$1" limit="$2" i
    shift 2
    for ((i = 0; i < limit; i++)); do
      "$@" >/dev/null 2>&1 && return 0
      sleep 1
    done
    die "$what did not come up in ${limit}s (see: docker compose -p $SLACKENV_PROJECT logs)"
  }
  wait_for "Rome Cloud" 600 curl -fsS -o /dev/null -H "Host: pantheon.$SLUG.rome.localhost" http://127.0.0.1:3000/api/health
  wait_for "the relay" 300 compose exec -T relay node -e 'fetch("http://127.0.0.1:8787/").then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))'
  # psql reads variables only from a script, not from -c.
  echo "INSERT INTO users (email, slug) VALUES (:'email', 'guardian') ON CONFLICT DO NOTHING;" |
    compose exec -T postgres psql -q -U pantheon -d pantheon -v email="$guardian" >/dev/null

  log "starting the instance"
  compose up -d rome-signer
  compose up -d --force-recreate rome
  wait_for "the instance" 600 compose exec -T rome node -e 'fetch("http://127.0.0.1:9368/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'
  log "enrolling the instance as $guardian"
  compose --profile setup run --rm enroll >"$STATE_DIR/rome-enroll.json"

  cat <<DONE
[slackenv-live] ready
  Rome Cloud     https://$CLOUD_HOST
  sign in first  https://$CLOUD_HOST/api/auth/dev/start?email=$guardian
  dashboard      https://$ROME_HOST  (Sign in with Rome Cloud, as $guardian)
  Slack app      redirect https://$CLOUD_HOST/api/slack/app/callback
                 events   https://$CLOUD_HOST/api/slack/events
  check          $ENV_DIR/live.sh check
  teardown       $ENV_DIR/live.sh down
DONE
}

case "${1:-}" in
  up) shift && cmd_up "$@" ;;
  check) cmd_check ;;
  down) shift && cmd_down "$@" ;;
  *)
    sed -n '2,21p' "$0"
    exit 2
    ;;
esac
