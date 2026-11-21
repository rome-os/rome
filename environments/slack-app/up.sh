#!/usr/bin/env bash
# Starts the Slack app test environment and writes .state/env.json.
#
#   environments/slack-app/up.sh [--rome <ref>] [--rome-cloud <ref>] [--old-connections rome-a|rome-b]
#
# --rome        the rome commit the instances run (default origin/main)
# --rome-cloud  the rome-cloud commit Rome Cloud and the relay run (default origin/main)
# --cloud-only  start Rome Cloud, the relay and the fake Slack, without instances
# --old-connections  give that instance the older slack_bot and slack
#               connections an upgrade leaves (ctl.sh old-connections), for R10
#
# Rome Cloud's checkout is found at $ROME_CLOUD_DIR, else next to this rome
# checkout. The model credential comes from $SLACKENV_ANTHROPIC_API_KEY or
# $SLACKENV_CLAUDE_OAUTH_TOKEN, or the files ~/.config/slackenv/anthropic-api-key
# or ~/.config/slackenv/claude-oauth-token. It stays in the model proxy and is
# never written to env.json. README.md has the rest.
set -euo pipefail

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROME_DIR="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"
ROME_CLOUD_DIR="${ROME_CLOUD_DIR:-$(dirname "$ROME_DIR")/rome-cloud}"
STATE_DIR="$ENV_DIR/.state"
ROME_REF=origin/main
ROME_CLOUD_REF=origin/main
CLOUD_ONLY=0
OLD_CONNECTIONS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --rome)
      ROME_REF="$2"
      shift 2
      ;;
    --rome-cloud)
      ROME_CLOUD_REF="$2"
      shift 2
      ;;
    --cloud-only)
      CLOUD_ONLY=1
      shift
      ;;
    --old-connections)
      case "${2:-}" in rome-a | rome-b) ;; *)
        echo "--old-connections takes rome-a or rome-b" >&2
        exit 2
        ;;
      esac
      OLD_CONNECTIONS="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

log() { printf '[slackenv] %s\n' "$*" >&2; }
die() {
  printf '[slackenv] %s\n' "$*" >&2
  exit 1
}

# ----------------------------------------------------------------- commits
# The environment runs only committed code: this folder must be clean, and
# rome and rome-cloud run from commits checked out into fresh worktrees, so
# nothing uncommitted in either checkout can reach them.
[ -d "$ROME_CLOUD_DIR/.git" ] || [ -f "$ROME_CLOUD_DIR/.git" ] || die "no rome-cloud checkout at $ROME_CLOUD_DIR (set ROME_CLOUD_DIR)"
if [ -n "$(git -C "$ROME_DIR" status --porcelain -- "$ENV_DIR" ':!environments/slack-app/.state')" ]; then
  die "environments/slack-app has uncommitted changes; commit them first"
fi
ENV_SHA="$(git -C "$ROME_DIR" rev-parse HEAD)"

resolve() { # <repo> <ref>
  "$ENV_DIR/tools/resolve-ref.sh" "$1" "$2" || die "cannot resolve $2 in $1"
}
ROME_SHA="$(resolve "$ROME_DIR" "$ROME_REF")"
ROME_CLOUD_SHA="$(resolve "$ROME_CLOUD_DIR" "$ROME_CLOUD_REF")"
log "environment $ENV_SHA, rome $ROME_SHA ($ROME_REF), rome-cloud $ROME_CLOUD_SHA ($ROME_CLOUD_REF)"

# --------------------------------------------------------------- the model
AGENT_MODEL="${SLACKENV_AGENT_MODEL:-claude-haiku-5-5}"
read_secret() {
  [ -n "${!1:-}" ] && {
    printf '%s' "${!1}"
    return
  }
  [ -f "$2" ] && tr -d '\n' <"$2"
  true
}
MODEL_PROXY_API_KEY="$(read_secret SLACKENV_ANTHROPIC_API_KEY "$HOME/.config/slackenv/anthropic-api-key")"
MODEL_PROXY_OAUTH_TOKEN="$(read_secret SLACKENV_CLAUDE_OAUTH_TOKEN "$HOME/.config/slackenv/claude-oauth-token")"
if [ "$CLOUD_ONLY" = 0 ] && [ -z "$MODEL_PROXY_API_KEY" ] && [ -z "$MODEL_PROXY_OAUTH_TOKEN" ]; then
  die "no model credential: set SLACKENV_ANTHROPIC_API_KEY or SLACKENV_CLAUDE_OAUTH_TOKEN (or the files named in this script's header)"
fi
export MODEL_PROXY_API_KEY MODEL_PROXY_OAUTH_TOKEN

# --------------------------------------------------------------- state
mkdir -p "$STATE_DIR"/{home,corepack,pnpm-store,relay-data,bin}
worktree() { # <repo> <sha> <dir>
  local repo="$1" sha="$2" dir="$3"
  # Only a complete worktree of its own: git run in a directory that is not one
  # walks up to the enclosing checkout, which the reset below must never touch.
  if [ -e "$dir/.git" ] &&
    [ "$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$dir" && pwd -P)" ] &&
    [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ]; then
    # Reused only as the commit says: a tracked file changed by hand is put back.
    # Untracked files (node_modules, .dev.vars) stay.
    git -C "$dir" reset -q --hard "$sha"
    return
  fi
  git -C "$repo" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
  git -C "$repo" worktree prune
  git -C "$repo" worktree add -q --detach "$dir" "$sha"
}
worktree "$ROME_CLOUD_DIR" "$ROME_CLOUD_SHA" "$STATE_DIR/rome-cloud-src"
worktree "$ROME_DIR" "$ROME_SHA" "$STATE_DIR/rome-src"

secret() { node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))'; }
if [ ! -f "$STATE_DIR/secrets.env" ]; then
  log "generating the environment's own secrets"
  RELAY_KEYS="$(node -e '
    const { generateKeyPairSync } = require("crypto");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const priv = privateKey.export({ format: "jwk" });
    const pub = publicKey.export({ format: "jwk" });
    console.log(JSON.stringify({ priv, pub: [pub] }));')"
  {
    echo "SLACK_SIGNING_SECRET=$(secret)"
    echo "SLACK_CLIENT_SECRET=$(secret)"
    echo "PANTHEON_JWT_SECRET=$(secret)"
    echo "PANTHEON_OAUTH_TOKEN_ENCRYPTION_KEY=$(secret)"
    echo "ROME_A_JWT_SECRET=$(secret)"
    echo "ROME_B_JWT_SECRET=$(secret)"
    echo "RELAY_SIGNING_KEY='$(node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).priv))' "$RELAY_KEYS")'"
    echo "RELAY_PUBLIC_KEY='$(node -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).pub))' "$RELAY_KEYS")'"
  } >"$STATE_DIR/secrets.env"
  chmod 600 "$STATE_DIR/secrets.env"
fi
set -a
. "$STATE_DIR/secrets.env"
set +a

# The fake Slack answers as https://slack.com inside the network with this
# certificate. SLACKENV_EXTRA_CA adds a CA the host's own network needs.
# wss-primary.slack.com is where Socket Mode connects (slack_bot). A certificate
# made for fewer names is made again.
TLS_NAMES="slack.com api.slack.com wss-primary.slack.com"
if [ ! -f "$STATE_DIR/tls/tls.crt" ] || [ "$(cat "$STATE_DIR/tls/names" 2>/dev/null)" != "$TLS_NAMES" ]; then
  # shellcheck disable=SC2086 # one argument per name
  node "$ENV_DIR/tools/make-cert.mjs" "$STATE_DIR/tls" $TLS_NAMES
  echo "$TLS_NAMES" >"$STATE_DIR/tls/names"
fi
cat "$STATE_DIR/tls/tls.crt" ${SLACKENV_EXTRA_CA:+"$SLACKENV_EXTRA_CA"} >"$STATE_DIR/trust.pem"
chmod 644 "$STATE_DIR/tls/tls.key" # read by the fake Slack's container user; the key guards nothing outside this environment

# ----------------------------------------------------------- configuration
export SLACKENV_PROJECT="${SLACKENV_PROJECT:-slackenv}"
export SLACKENV_NODE_IMAGE="${SLACKENV_NODE_IMAGE:-node:24-slim}"
export SLACKENV_POSTGRES_IMAGE="${SLACKENV_POSTGRES_IMAGE:-postgres:16-alpine}"
# The Playwright release rome pins (packages/web @playwright/test), and the
# digest rome's CI pins for it.
export SLACKENV_PLAYWRIGHT_VERSION="${SLACKENV_PLAYWRIGHT_VERSION:-1.62.1}"
export SLACKENV_PLAYWRIGHT_IMAGE="${SLACKENV_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e}"
export PANTHEON_PORT=47100 FAKE_SLACK_PORT=47200 ROME_A_PORT=47181 ROME_B_PORT=47182 BROWSER_PORT=47190 MODEL_PROXY_HOST_PORT=47191
export HOST_UID HOST_GID
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
export ENV_DIR STATE_DIR AGENT_MODEL
export SLACK_APP_ID=A0SLACKENV1 SLACK_CLIENT_ID=1000000001.2000000002
export FAKE_SLACK_EVENTS_URL="http://pantheon-net:3100/api/slack/events"
# Slack retries after about 0 s, 1 min and 5 min; shortened here (DIFFERENCES.md).
export FAKE_SLACK_RETRY_DELAYS_MS="${FAKE_SLACK_RETRY_DELAYS_MS:-1000,10000,30000}"
export ROME_IMAGE="${SLACKENV_ROME_IMAGE:-slackenv-rome:${ROME_SHA:0:12}}"
CLOUD="http://127.0.0.1:$PANTHEON_PORT"

# What compose interpolates, kept for ctl.sh and down.sh. The model credential
# is left out: only `up` passes it, through this script's environment.
for v in SLACKENV_PROJECT SLACKENV_NODE_IMAGE SLACKENV_POSTGRES_IMAGE SLACKENV_PLAYWRIGHT_IMAGE \
  SLACKENV_PLAYWRIGHT_VERSION HOST_UID HOST_GID ENV_DIR STATE_DIR \
  PANTHEON_PORT FAKE_SLACK_PORT ROME_A_PORT ROME_B_PORT BROWSER_PORT MODEL_PROXY_HOST_PORT ROME_IMAGE AGENT_MODEL FAKE_SLACK_EVENTS_URL \
  FAKE_SLACK_RETRY_DELAYS_MS SLACK_APP_ID SLACK_CLIENT_ID SLACK_CLIENT_SECRET SLACK_SIGNING_SECRET \
  ROME_A_JWT_SECRET ROME_B_JWT_SECRET; do
  printf '%s=%s\n' "$v" "${!v}"
done >"$STATE_DIR/compose.env"
chmod 600 "$STATE_DIR/compose.env"

cat >"$STATE_DIR/pantheon.env" <<EOF
NODE_ENV=development
APP_PORT=3100
DATABASE_URL=postgresql://pantheon:pantheon@postgres:5432/pantheon
PANTHEON_DOMAIN=127.0.0.1
PANTHEON_BASE_ORIGIN=$CLOUD
NEXT_PUBLIC_PANTHEON_DOMAIN=127.0.0.1
PANTHEON_COOKIE_SECURE=false
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
SLACK_APP_BASE_URL=http://127.0.0.1:$FAKE_SLACK_PORT
SLACK_APP_CLIENT_ID=$SLACK_CLIENT_ID
SLACK_APP_CLIENT_SECRET=$SLACK_CLIENT_SECRET
SLACK_APP_SIGNING_SECRET=$SLACK_SIGNING_SECRET
SLACK_APP_ID=$SLACK_APP_ID
EOF
chmod 600 "$STATE_DIR/pantheon.env"
# The relay reads its trust anchor from .dev.vars in its (scratch) worktree.
printf "RELAY_PUBLIC_KEY='%s'\n" "$RELAY_PUBLIC_KEY" >"$STATE_DIR/rome-cloud-src/webhook-relay/.dev.vars"

compose() { docker compose --env-file "$STATE_DIR/compose.env" -f "$ENV_DIR/compose.yml" "$@"; }

# --------------------------------------------------------------- images
if [ "$CLOUD_ONLY" = 0 ] && ! docker image inspect "$ROME_IMAGE" >/dev/null 2>&1; then
  log "building $ROME_IMAGE from rome $ROME_SHA (first time for this commit: several minutes)"
  docker build -q -t "$ROME_IMAGE" --build-arg ROME_BUILD_SHA="$ROME_SHA" "$STATE_DIR/rome-src" >/dev/null
fi

# ------------------------------------------------------------ Rome Cloud
log "starting Rome Cloud, the relay, the fake Slack and the model proxy"
compose up -d postgres pantheon-net
# Recreated on every start: their code lives in the scratch worktree, which a
# new rome-cloud commit replaces under them.
compose up -d --force-recreate fake-slack relay pantheon model-proxy

wait_for() { # <what> <seconds> <command...>
  local what="$1" limit="$2"
  shift 2
  for ((i = 0; i < limit; i++)); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "$what did not come up in ${limit}s (see: docker compose -p $SLACKENV_PROJECT logs)"
}
log "starting the browser for the verifier"
compose up -d browser
# The client the verifier connects with, at the browser's version: pure
# JavaScript, installed into .state only.
if [ ! -f "$STATE_DIR/browser-client/node_modules/playwright-core/package.json" ]; then
  mkdir -p "$STATE_DIR/browser-client"
  docker run --rm -u "$HOST_UID:$HOST_GID" -e HOME=/tmp -v "$STATE_DIR/browser-client:/client" "$SLACKENV_NODE_IMAGE" \
    npm install --prefix /client --no-audit --no-fund --silent "playwright-core@$SLACKENV_PLAYWRIGHT_VERSION" >/dev/null
fi
wait_for "the fake Slack" 60 curl -fsS "http://127.0.0.1:$FAKE_SLACK_PORT/_control/health"
wait_for "Rome Cloud" 600 curl -fsS -o /dev/null "$CLOUD/api/health"
# run-server answers plain HTTP once it listens.
wait_for "the browser" 300 curl -s -o /dev/null "http://127.0.0.1:$BROWSER_PORT/"
wait_for "the relay" 300 compose exec -T relay node -e 'fetch("http://127.0.0.1:8787/").then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))'

# Two guardian accounts, one per instance. Created directly, as the seed
# script creates the dev owner, so the dev sign-in skips onboarding.
compose exec -T postgres psql -q -U pantheon -d pantheon -c \
  "INSERT INTO users (email, slug) VALUES ('guardian-a@slackenv.test','guardian-a'), ('guardian-b@slackenv.test','guardian-b') ON CONFLICT DO NOTHING;" >/dev/null

# ------------------------------------------------------------ instances
[ "$CLOUD_ONLY" = 1 ] && log "cloud only: no instances started"
for name in $([ "$CLOUD_ONLY" = 1 ] || echo a b); do
  svc="rome-$name"
  log "starting $svc"
  compose up -d "$svc-net" "$svc-signer" "$svc"
done
for name in $([ "$CLOUD_ONLY" = 1 ] || echo a b); do
  svc="rome-$name"
  wait_for "$svc" 600 compose exec -T "$svc" node -e 'fetch("http://127.0.0.1:9368/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'
  port_var="ROME_$(echo "$name" | tr a-z A-Z)_PORT"
  log "enrolling $svc in Rome Cloud"
  node "$ENV_DIR/tools/enroll.mjs" "$CLOUD" "http://127.0.0.1:${!port_var}" "guardian-$name@slackenv.test" \
    "$STATE_DIR/$svc-cookies.json" >"$STATE_DIR/$svc-enroll.json"
done

if [ -n "$OLD_CONNECTIONS" ] && [ "$CLOUD_ONLY" = 0 ]; then
  log "writing the older Slack connections into $OLD_CONNECTIONS"
  "$ENV_DIR/ctl.sh" old-connections "$OLD_CONNECTIONS" >/dev/null || {
    log "the older Slack connections did not come back in $OLD_CONNECTIONS; see $STATE_DIR/$OLD_CONNECTIONS-old-connections.json"
    exit 1
  }
fi

# The verifier runs rome's import rules on the rome commit under test, so the
# scratch checkout gets its dependencies. Install scripts are skipped: the
# import rules need no native module.
export ROME_DEPENDENCIES=installed
if [ ! -x "$STATE_DIR/rome-src/node_modules/.bin/tsx" ]; then
  log "installing rome's dependencies in the scratch checkout for the verifier"
  if ! (cd "$STATE_DIR/rome-src" && pnpm install --frozen-lockfile --ignore-scripts --reporter=silent); then
    log "pnpm install failed in $STATE_DIR/rome-src; env.json says so and the import rules cannot run"
    ROME_DEPENDENCIES=failed
  fi
fi
export ROME_CLOUD_BASE_REF="${ROME_CLOUD_BASE_REF:-origin/main}"

# ------------------------------------------------------------ env.json
node "$ENV_DIR/tools/write-env-json.mjs" \
  "$ENV_SHA" "$ROME_SHA" "$ROME_REF" "$ROME_CLOUD_SHA" "$ROME_CLOUD_REF" "$AGENT_MODEL" "$STATE_DIR" >"$STATE_DIR/env.json"
log "ready: $STATE_DIR/env.json"
cat "$STATE_DIR/env.json"
