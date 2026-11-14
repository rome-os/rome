#!/usr/bin/env bash
# The voice input environment: a Rome container of its own, built from a
# product ref merged with this branch, signed in to a Rome Cloud of its own,
# a stand-in transcriber beside them, and a Chrome whose microphone is a
# recording.
#
#   environments/voice-input/env.sh up [--no-build]  # start, or bring up to date
#   environments/voice-input/env.sh reset            # wipe Rome back to empty and start again
#   environments/voice-input/env.sh down             # remove everything up created
#
# The verifier drives it through voice-env only. See README.md.
set -euo pipefail
# The state file holds the guardian's password, so nothing here is readable by others.
umask 077

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"
PATH="$PATH:/run/current-system/sw/bin"

NAME=voice-input
STATE_DIR="${ROME_ENV_STATE_DIR:-$HOME/.rome-environments/$NAME}"
SECRETS_FILE="${VOICE_ENV_FILE:-$HOME/.config/rome/voice.env}"
RUN_DIR="$STATE_DIR/run"
STATE_FILE="$RUN_DIR/state.json"
BUILD_FILE="$RUN_DIR/build.json"
ROME_ENV_FILE="$RUN_DIR/rome.env"
OWNER_FILE="$RUN_DIR/owner"

IMAGE="rome-env-${NAME}:latest"
TOOLS_IMAGE="rome-env-${NAME}-tools:latest"
NETWORK="rome-env-${NAME}"
ROME="rome-env-${NAME}-rome"
TRANSCRIBER="rome-env-${NAME}-transcriber"
CAPTURE="rome-env-${NAME}-capture"
HOME_VOLUME="rome-env-${NAME}-home"
MEMORY_VOLUME="rome-env-${NAME}-memory"
USER_VOLUME="rome-env-${NAME}-user"
SIGNER="rome-env-${NAME}-signer"
SIGNER_KEY_VOLUME="rome-env-${NAME}-signer-key"
SIGNER_SOCKET_VOLUME="rome-env-${NAME}-signer-sock"
BUILD_TREE="$RUN_DIR/product-tree"

# The product under test. Its code never lands on this branch: the build
# merges it with this branch in a throwaway checkout.
PRODUCT_REF="${VOICE_PRODUCT_REF:-origin/main}"
# Every model tier runs on Haiku when the secrets file holds a model login.
DEFAULT_MODEL=claude-haiku-5-5

# Host ports, all on 127.0.0.1. The dashboard is Rome's public port (Caddy),
# as a guardian's browser reaches it.
DASHBOARD_PORT="${VOICE_DASHBOARD_PORT:-4780}"
TRANSCRIBER_CONTROL_PORT="${VOICE_TRANSCRIBER_CONTROL_PORT:-4781}"
PROXY_PORT="${VOICE_PROXY_PORT:-4783}"
CDP_PORT="${VOICE_CDP_PORT:-4784}"
DASHBOARD="http://127.0.0.1:$DASHBOARD_PORT"

# The stand-in, as Rome sees it on the environment's network.
STAND_IN_URL="ws://transcriber:8790/transcribe-websocket"
STAND_IN_KEY="stand-in-key"
SONIOX_URL="wss://stt-rt.soniox.com/transcribe-websocket"
GUARDIAN_USER=guardian

# Rome's API inside the container, past Caddy.
API="http://127.0.0.1:4141/api"

# shellcheck source=lib/cloud.sh
. "$ENV_DIR/lib/cloud.sh"

log() { printf 'env/%s: %s\n' "$NAME" "$*" >&2; }
die() {
  log "$*"
  exit 1
}

# Reads KEY=value lines from the secrets file into the environment. A value
# already set in the shell wins. Values are never echoed.
load_secrets() {
  [ -f "$SECRETS_FILE" ] || return 0
  local line name value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#export }"
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    value="${value%\"}" value="${value#\"}" value="${value%\'}" value="${value#\'}"
    [ -n "$value" ] || continue
    [ -n "${!name:-}" ] || export "$name=$value"
  done <"$SECRETS_FILE"
}

# One field of the JSON on stdin, by a dotted path. Prints nothing when absent.
json() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v = JSON.parse(s || "null");
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
      if (v !== undefined && v !== null) process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}

state() { [ -f "$STATE_FILE" ] && json "$1" <"$STATE_FILE"; }

# Merges a JSON object into the state file.
set_state() {
  node -e '
    const fs = require("fs"); const [f, patch] = process.argv.slice(1);
    let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    fs.writeFileSync(f, JSON.stringify({ ...s, ...JSON.parse(patch) }) + "\n", { mode: 0o600 });' \
    "$STATE_FILE" "$1"
}

# Calls Rome's API from inside its container. A body goes on stdin.
api() {
  local method="$1" path="$2"
  if [ "$method" = GET ]; then
    docker exec "$ROME" curl -sS --fail-with-body "$API$path"
  else
    docker exec -i "$ROME" curl -sS --fail-with-body -X "$method" \
      -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' \
      --data-binary @- "$API$path"
  fi
}

claim_ownership() {
  local owner
  owner="$(cat "$OWNER_FILE" 2>/dev/null || true)"
  if [ -n "$owner" ] && [ "$owner" != "$REPO_ROOT" ] && [ "${ROME_ENV_TAKE_OVER:-0}" != 1 ]; then
    die "the environment belongs to $owner. Run down there, or set ROME_ENV_TAKE_OVER=1 to take it over."
  fi
  printf '%s\n' "$REPO_ROOT" >"$OWNER_FILE"
}

# The commit the paths last changed at, and whether they hold uncommitted changes.
tree_json() {
  local commit dirty=false
  commit="$(git -C "$REPO_ROOT" log -1 --format=%H -- "$@")"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- "$@")" ] || dirty=true
  printf '{"commit":"%s","dirty":%s}' "${commit:-none}" "$dirty"
}

image_sha() {
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" 2>/dev/null |
    sed -n 's/^ROME_BUILD_SHA=//p'
}

# Builds the production Rome image from the product ref merged with this
# branch, in a throwaway checkout, so product code never lands here.
build_rome_image() {
  local product_sha env_sha env_dirty=false merged
  # The image takes the checkout's file modes. Under the state files' umask,
  # its packages would be readable by Rome's own user only, and the signer,
  # which runs as another user, could not load.
  umask 022
  git -C "$REPO_ROOT" fetch --quiet origin main
  git -C "$REPO_ROOT" fetch --quiet origin "${PRODUCT_REF#origin/}" 2>/dev/null || true
  env_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  product_sha="$(git -C "$REPO_ROOT" rev-parse "$PRODUCT_REF^{commit}" 2>/dev/null)" ||
    die "cannot resolve the product ref \"$PRODUCT_REF\". Set VOICE_PRODUCT_REF to a branch or commit."
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- environments/voice-input)" ] || env_dirty=true

  log "merging the product ${product_sha:0:9} into a throwaway checkout of ${env_sha:0:9} ..."
  git -C "$REPO_ROOT" worktree remove --force "$BUILD_TREE" 2>/dev/null || true
  rm -rf "$BUILD_TREE"
  git -C "$REPO_ROOT" worktree add --quiet --detach "$BUILD_TREE" "$env_sha"
  if ! git -C "$BUILD_TREE" -c user.name=voice-env -c user.email=voice-env@invalid \
    merge --no-edit --no-ff "$product_sha" >/dev/null 2>&1; then
    git -C "$BUILD_TREE" merge --abort 2>/dev/null || true
    git -C "$REPO_ROOT" worktree remove --force "$BUILD_TREE" 2>/dev/null || true
    die "the product ref does not merge cleanly with this branch. Rebase it on main, or set VOICE_PRODUCT_REF to one that merges."
  fi
  merged="$(git -C "$BUILD_TREE" rev-parse HEAD)"

  log "building the Rome image from the merged tree ${merged:0:9} ..."
  (
    cd "$BUILD_TREE"
    node scripts/docker/prepare-runtime-workspace.mjs >/dev/null
    docker build --quiet \
      --file .docker/rome-runtime-workspace/Dockerfile \
      --tag "$IMAGE" \
      --build-arg ROME_DOCKER_APP_CODE_MODE=compiled \
      --build-arg "ROME_BUILD_SHA=$merged" \
      --build-arg "ROME_BUILD_TIME=$(date -u +%FT%TZ)" \
      .docker/rome-runtime-workspace >/dev/null
  )
  git -C "$REPO_ROOT" worktree remove --force "$BUILD_TREE" 2>/dev/null || true
  umask 077

  printf '{"product":{"ref":"%s","commit":"%s"},"environment":{"commit":"%s","dirty":%s},"merged":"%s","builtAt":"%s"}\n' \
    "$PRODUCT_REF" "$product_sha" "$env_sha" "$env_dirty" "$merged" "$(date -u +%FT%TZ)" >"$BUILD_FILE"
}

# tcpdump, for recording the server's outbound traffic from inside Rome's
# network namespace without adding anything to Rome's own container.
build_tools_image() {
  docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1 && return
  log "building the capture tools image ..."
  printf 'FROM alpine:3.20\nRUN apk add --no-cache tcpdump\n' | docker build --quiet --tag "$TOOLS_IMAGE" - >/dev/null
}

ensure_network() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
}

# The ws package from this checkout, mounted into the stand-in's container.
ws_dir() {
  dirname "$(node -e "console.log(require('module').createRequire('$REPO_ROOT/packages/core/package.json').resolve('ws'))")" ||
    die "cannot find the ws package. Run pnpm install in $REPO_ROOT."
}

start_transcriber() {
  docker rm -f "$TRANSCRIBER" >/dev/null 2>&1 || true
  docker run -d --name "$TRANSCRIBER" --restart unless-stopped --memory 2g \
    --network "$NETWORK" --network-alias transcriber \
    -p "127.0.0.1:$TRANSCRIBER_CONTROL_PORT:8791" \
    -e "STAND_IN_API_KEY=$STAND_IN_KEY" \
    -v "$ENV_DIR/lib:/stand-in:ro" -v "$(ws_dir):/node_modules/ws:ro" \
    node:24-bookworm-slim node /stand-in/stand-in.mjs >/dev/null
  local attempts=0
  until curl -fsS -o /dev/null "http://127.0.0.1:$TRANSCRIBER_CONTROL_PORT/script" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 30 ] || die "the stand-in transcriber never answered. Inspect: docker logs $TRANSCRIBER"
    sleep 0.5
  done
}

# A value already in the Rome env file, so the instance secrets survive a rewrite.
kept() { [ ! -f "$ROME_ENV_FILE" ] || sed -n "s/^$1=//p" "$ROME_ENV_FILE"; }

# Rome's env file. Signed in to Rome Cloud (the default), Rome holds no
# provider credential: it gets one from Rome Cloud per listening session.
# Otherwise it uses its own: the stand-in's key, or Soniox's from the secrets
# file when the state says real.
write_rome_env() {
  local jwt key mode url api_key sign_in token
  jwt="$(kept ROME_JWT_SECRET)"
  key="$(kept ROME_OAUTH_TOKEN_ENCRYPTION_KEY)"
  [ -n "$jwt" ] || jwt="$(openssl rand -hex 32)"
  [ -n "$key" ] || key="$(openssl rand -hex 32)"
  mode="$(state transcriber || true)"
  sign_in="$(state signIn || echo cloud)"
  token="$(state cloud.instanceToken || true)"
  [ "$sign_in" != cloud ] || [ -n "$token" ] || die "Rome Cloud has no instance for Rome yet. Run env.sh up."
  if [ "$mode" = real ]; then
    [ -n "${SONIOX_API_KEY:-}" ] || die "transcriber real needs SONIOX_API_KEY in $SECRETS_FILE"
    url="$SONIOX_URL" api_key="$SONIOX_API_KEY"
  else
    url="$STAND_IN_URL" api_key="$STAND_IN_KEY"
  fi
  {
    echo "NODE_ENV=production"
    echo "WEB_HOST=0.0.0.0"
    echo "ROME_JWT_SECRET=$jwt"
    echo "ROME_OAUTH_TOKEN_ENCRYPTION_KEY=$key"
    # The guardian signs in with a local password the environment holds,
    # either way: Rome has no slug, so Rome Cloud sign-in stays off.
    if [ "$sign_in" = cloud ]; then
      echo "PANTHEON_BASE_ORIGIN=$CLOUD_ORIGIN"
      echo "ROME_INSTANCE_TOKEN=$token"
    else
      echo "PANTHEON_BASE_ORIGIN="
      echo "ROME_TRANSCRIPTION_PROVIDER=soniox"
      echo "ROME_TRANSCRIPTION_URL=$url"
      echo "ROME_TRANSCRIPTION_API_KEY=$api_key"
    fi
    [ -z "${ANTHROPIC_API_KEY:-}" ] || echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
  } >"$ROME_ENV_FILE.new"
  mv "$ROME_ENV_FILE.new" "$ROME_ENV_FILE"
}

# The signer beside Rome, as docker-compose.yml runs it: it holds the
# instance's key, has no network, and shares only its socket with Rome. Rome
# Cloud accepts an instance token only to register that key.
start_signer() {
  docker rm -f "$SIGNER" >/dev/null 2>&1 || true
  docker run -d --name "$SIGNER" --restart unless-stopped --memory 256m \
    --entrypoint node --user 10001:10001 --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --network none \
    -e "SIGNER_AUDIENCE=$CLOUD_ORIGIN" -e SIGNER_KEY_DIR=/keys -e SIGNER_SOCKET=/run/rome-signer/signer.sock \
    -v "$SIGNER_KEY_VOLUME:/keys" -v "$SIGNER_SOCKET_VOLUME:/run/rome-signer" \
    "$IMAGE" /opt/rome/packages/signer/dist/main.js >/dev/null
}

# The same container settings as a hosted Rome's docker-compose.yml, with its
# public port on loopback only, where the environment's Chrome reaches it.
start_rome() {
  docker rm -f "$ROME" >/dev/null 2>&1 || true
  start_signer
  docker run -d --name "$ROME" --restart unless-stopped --memory 6g \
    --network "$NETWORK" \
    -p "127.0.0.1:$DASHBOARD_PORT:8080" \
    --env-file "$ROME_ENV_FILE" -e ROME_SIGNER_SOCKET=/run/rome-signer/signer.sock \
    -v "$HOME_VOLUME:/home/rome" -v "$MEMORY_VOLUME:/app/memory" -v "$USER_VOLUME:/home/user" \
    -v "$SIGNER_SOCKET_VOLUME:/run/rome-signer:ro" \
    --cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined --shm-size 1g \
    "$IMAGE" >/dev/null
  wait_for_rome
}

wait_for_rome() {
  local attempts=0
  until docker exec "$ROME" curl -fsS -o /dev/null "$API/health" 2>/dev/null &&
    curl -fsS -o /dev/null "$DASHBOARD/api/health" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 90 ] || die "Rome never answered. Inspect: docker logs $ROME"
    sleep 2
  done
}

# Creates the guardian the way a fresh self-hosted instance does, once. The
# password lives only in the state file.
ensure_guardian() {
  local password
  password="$(state guardianPassword || true)"
  if ! api GET /bootstrap | grep -q '"phase":"needs-account"'; then
    [ -n "$password" ] || die "Rome has a guardian the environment did not create. Run env.sh reset."
    return
  fi
  password="$(openssl rand -hex 16)"
  printf '{"userId":"%s","password":"%s"}' "$GUARDIAN_USER" "$password" |
    api POST /onboard/create-account >/dev/null || die "Rome refused to create the guardian"
  set_state "{\"guardianUser\":\"$GUARDIAN_USER\",\"guardianPassword\":\"$password\"}"
}

# Sends every model tier to one model, through the setting the dashboard's
# model picker writes, when there is a model login at all.
set_model() {
  [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || {
    log "no model login in $SECRETS_FILE: messages send and are stored, but the agent cannot answer them"
    return
  }
  local model="${VOICE_MODEL:-$DEFAULT_MODEL}"
  log "running every model tier on $model ..."
  printf '{"tierModelMappings":{"anthropic":{"large":"%s","medium":"%s","small":"%s"}}}' \
    "$model" "$model" "$model" | api PUT /settings >/dev/null
}

cmd_up() {
  local build=1
  [ "${1:-}" = "--no-build" ] && build=0
  mkdir -p "$RUN_DIR"
  claim_ownership
  load_secrets
  [ -n "$(state transcriber || true)" ] || set_state '{"transcriber":"stand-in"}'
  [ -n "$(state signIn || true)" ] || set_state '{"signIn":"cloud"}'
  if [ "$build" = 1 ] || [ -z "$(image_sha)" ]; then build_rome_image; fi
  build_tools_image
  ensure_network
  log "starting the stand-in transcriber ..."
  start_transcriber
  apply_stand_in_keys
  if [ "$(state signIn)" = cloud ]; then
    log "starting Rome Cloud ..."
    cmd_cloud_up
  fi
  write_rome_env
  log "starting Rome ..."
  start_rome
  ensure_guardian
  set_model
  log "ready at $DASHBOARD. Drive it with environments/voice-input/voice-env."
}

remove_rome() {
  docker rm -f "$ROME" "$SIGNER" >/dev/null 2>&1 || true
  docker volume rm "$HOME_VOLUME" "$MEMORY_VOLUME" "$USER_VOLUME" \
    "$SIGNER_KEY_VOLUME" "$SIGNER_SOCKET_VOLUME" >/dev/null 2>&1 || true
}

# Chrome forks away from the pid it was started as, so every Chrome on the
# environment's profile is stopped by its profile path.
stop_chrome() {
  pkill -f -- "--user-data-dir=$RUN_DIR/chrome-profile" 2>/dev/null || true
  local attempts=0
  while pgrep -f -- "--user-data-dir=$RUN_DIR/chrome-profile" >/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 25 ] || pkill -9 -f -- "--user-data-dir=$RUN_DIR/chrome-profile" 2>/dev/null || true
    [ "$attempts" -lt 50 ] || die "a Chrome on $RUN_DIR/chrome-profile will not stop"
    sleep 0.2
  done
}

stop_browser() {
  stop_chrome
  local pid
  pid="$(state browser.proxyPid || true)"
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  [ ! -f "$STATE_FILE" ] || set_state '{"browser":null}'
}

# Back to a known empty state: a fresh Rome with only its guardian, the
# stand-in with its default script, no browser, no capture.
cmd_reset() {
  mkdir -p "$RUN_DIR"
  claim_ownership
  stop_browser
  docker rm -f "$CAPTURE" >/dev/null 2>&1 || true
  log "wiping Rome's home, memory and chats ..."
  remove_rome
  log "wiping Rome Cloud's account, sessions and usage ..."
  remove_cloud_data
  set_state '{"guardianPassword":null,"cookies":null,"transcriber":"stand-in","signIn":"cloud"}'
  cmd_up --no-build
}

cmd_down() {
  claim_ownership
  stop_browser
  docker rm -f "$CAPTURE" "$TRANSCRIBER" >/dev/null 2>&1 || true
  remove_rome
  remove_cloud_data
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR"
  log "removed. Rome Cloud's checkout stays in $CLOUD_DIR"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    up) cmd_up "${2:-}" ;;
    reset) cmd_reset ;;
    down) cmd_down ;;
    *) die "usage: env.sh up [--no-build] | reset | down" ;;
  esac
fi
