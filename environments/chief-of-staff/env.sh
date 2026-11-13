#!/usr/bin/env bash
# The chief of staff environment: a Rome container of its own, built from this
# checkout, connected to a test Discord server through the agent's Discord bot,
# with three member bots that play the team.
#
#   environments/chief-of-staff/env.sh up [--no-build]  # start, or bring up to date
#   environments/chief-of-staff/env.sh reset            # wipe Rome and the test chats, start again
#   environments/chief-of-staff/env.sh down             # remove everything up created
#
# The verifier drives it through cos-env only. See README.md.
set -euo pipefail

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"

NAME=chief-of-staff
STATE_DIR="${ROME_ENV_STATE_DIR:-$HOME/.rome-environments/$NAME}"
SECRETS_FILE="${COS_SECRETS_FILE:-$STATE_DIR/secrets.env}"
RUN_DIR="$STATE_DIR/run"
STATE_FILE="$RUN_DIR/state.json"
BUILD_FILE="$RUN_DIR/build.json"
ROME_ENV_FILE="$RUN_DIR/rome.env"
OWNER_FILE="$RUN_DIR/owner"

IMAGE="rome-env-${NAME}:latest"
ROME="rome-env-${NAME}-rome"
HOME_VOLUME="rome-env-${NAME}-home"
MEMORY_VOLUME="rome-env-${NAME}-memory"
USER_VOLUME="rome-env-${NAME}-user"
# Rome's API inside the container, behind Caddy's sign-in check.
API="http://127.0.0.1:4141/api"

# shellcheck source=team.env
. "$ENV_DIR/team.env"
read -r -a MEMBERS <<<"$COS_MEMBERS"
read -r -a MEMBER_NAMES <<<"$COS_MEMBER_NAMES"
read -r -a CHATS <<<"$COS_CHATS"

log() { printf 'env/%s: %s\n' "$NAME" "$*" >&2; }
die() {
  log "$*"
  exit 1
}

# Reads the secrets file into the environment, and stops naming the first one
# missing. Values are never echoed.
load_secrets() {
  [ -f "$SECRETS_FILE" ] || die "no secrets file at $SECRETS_FILE. README.md lists what it holds."
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  set +a
  local name
  for name in COS_DISCORD_SERVER_ID COS_AGENT_BOT_TOKEN COS_MEMBER_1_BOT_TOKEN COS_MEMBER_2_BOT_TOKEN COS_MEMBER_3_BOT_TOKEN; do
    [ -n "${!name:-}" ] || die "$SECRETS_FILE does not set $name"
  done
  if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    die "$SECRETS_FILE sets both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN. Keep the one model login the run should use."
  fi
  [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] ||
    die "$SECRETS_FILE sets no model login: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
}

member_token_var() {
  local i
  for i in "${!MEMBERS[@]}"; do
    if [ "${MEMBERS[$i]}" = "$1" ]; then
      printf 'COS_MEMBER_%d_BOT_TOKEN' "$((i + 1))"
      return
    fi
  done
  die "no member named \"$1\". Members: ${MEMBERS[*]}"
}

discord() {
  COS_STATE="$STATE_FILE" COS_READER_TOKEN="$COS_MEMBER_1_BOT_TOKEN" node "$ENV_DIR/discord.mjs" "$@"
}

# One field of the JSON on stdin, by a dotted path. Prints nothing when absent.
json() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v = JSON.parse(s);
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
      if (v !== undefined && v !== null) process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}

# Calls Rome's API from inside its container, so no port is published. A body
# goes on stdin, which keeps a token out of `ps`.
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

# Builds the production Rome image, apps included, from this checkout. Records
# which commits went in, for `cos-env version`.
build_rome_image() {
  local sha dirty=false
  sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- . ':!environments')" ] || dirty=true
  log "building the Rome image from ${sha:0:9}$([ "$dirty" = false ] || echo ' with uncommitted changes') ..."
  (
    cd "$REPO_ROOT"
    node scripts/docker/prepare-runtime-workspace.mjs >/dev/null
    docker build --quiet \
      --file .docker/rome-runtime-workspace/Dockerfile \
      --tag "$IMAGE" \
      --build-arg ROME_DOCKER_APP_CODE_MODE=compiled \
      --build-arg "ROME_BUILD_SHA=$sha" \
      --build-arg "ROME_BUILD_TIME=$(date -u +%FT%TZ)" \
      .docker/rome-runtime-workspace >/dev/null
  )
  printf '{"rome":{"commit":"%s","dirty":%s},"app":%s,"builtAt":"%s"}\n' \
    "$sha" "$dirty" "$(tree_json rome_apps/chief-of-staff)" "$(date -u +%FT%TZ)" >"$BUILD_FILE"
}

# A value already in the Rome env file, so the instance secrets survive a rewrite.
kept() { [ ! -f "$ROME_ENV_FILE" ] || sed -n "s/^$1=//p" "$ROME_ENV_FILE"; }

write_rome_env() {
  local jwt key
  jwt="$(kept ROME_JWT_SECRET)"
  key="$(kept ROME_OAUTH_TOKEN_ENCRYPTION_KEY)"
  [ -n "$jwt" ] || jwt="$(openssl rand -hex 32)"
  [ -n "$key" ] || key="$(openssl rand -hex 32)"
  (
    umask 077
    {
      echo "NODE_ENV=production"
      echo "WEB_HOST=0.0.0.0"
      echo "ROME_JWT_SECRET=$jwt"
      echo "ROME_OAUTH_TOKEN_ENCRYPTION_KEY=$key"
      [ -z "${ANTHROPIC_API_KEY:-}" ] || echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
      [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
    } >"$ROME_ENV_FILE.new"
  )
  mv "$ROME_ENV_FILE.new" "$ROME_ENV_FILE"
}

# The same container settings as a hosted Rome's docker-compose.yml, less the
# ports: nothing outside reaches this Rome except through `docker exec`.
start_rome() {
  docker rm -f "$ROME" >/dev/null 2>&1 || true
  docker run -d --name "$ROME" --restart unless-stopped \
    --env-file "$ROME_ENV_FILE" \
    -v "$HOME_VOLUME:/home/rome" -v "$MEMORY_VOLUME:/app/memory" -v "$USER_VOLUME:/home/user" \
    --cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined \
    "$IMAGE" >/dev/null
  wait_for_rome
}

wait_for_rome() {
  local attempts=0
  until docker exec "$ROME" curl -fsS -o /dev/null "$API/health" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 60 ] || die "Rome never answered. Inspect: docker logs $ROME"
    sleep 2
  done
}

# Writes the bots' and chats' Discord ids, which every later command reads.
write_discord_state() {
  local agent members="" i id chats
  agent="$(COS_TOKEN="$COS_AGENT_BOT_TOKEN" discord whoami)"
  for i in "${!MEMBERS[@]}"; do
    id="$(COS_TOKEN="$(printenv "COS_MEMBER_$((i + 1))_BOT_TOKEN")" discord whoami | json id)"
    members+="${members:+,}\"${MEMBERS[$i]}\":{\"id\":\"$id\",\"name\":\"${MEMBER_NAMES[$i]}\"}"
  done
  chats="$(COS_TOKEN="$COS_MEMBER_1_BOT_TOKEN" discord chats "${CHATS[@]}")"
  printf '{"agent":%s,"members":{%s},"chats":%s}\n' "$agent" "$members" "$chats" >"$STATE_FILE"
}

state() { json "$1" <"$STATE_FILE"; }

# Connects the agent's bot the way the dashboard does: start the Discord setup,
# then answer its one question with the token.
connect_agent_bot() {
  local started cid outcome status error
  log "connecting the agent's Discord bot ..."
  started="$(echo '{}' | api POST /connections/discord/grants/bot/setup)"
  cid="$(json cid <<<"$started")"
  [ -n "$cid" ] || die "Rome did not start the Discord setup: $started"
  outcome="$(node -e 'process.stdout.write(JSON.stringify({answers:{token:process.env.COS_AGENT_BOT_TOKEN}}))' |
    api POST "/setups/$cid/input")"
  status="$(json state.status <<<"$outcome")"
  error="$(json state.error <<<"$outcome")"
  [ "$status" = "done" ] || die "Rome did not take the agent's bot token (${error:-$status})"
}

link_agent() {
  local agent_id connection
  agent_id="$(state agent.id)"
  connection="$(api GET /connected-accounts | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const a = JSON.parse(s).accounts.find((x) => x.account.platform === "discord" && x.account.id === process.argv[1]);
      if (a?.connection) process.stdout.write(a.connection);
    });' "$agent_id")"
  [ -n "$connection" ] || die "Rome lists no connected account for the agent's bot $agent_id"
  log "linking the $COS_AGENT agent to the connected account ..."
  printf '{"agent":"%s"}' "$COS_AGENT" | api PUT "/connected-accounts/discord/$agent_id/agent" >/dev/null ||
    die "Rome refused to link \"$COS_AGENT\". Is the agent's app in this checkout? GET /api/agents lists the loaded agents."
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    const s = JSON.parse(fs.readFileSync(f, "utf8")); s.connection = process.argv[2];
    fs.writeFileSync(f, JSON.stringify(s) + "\n");' "$STATE_FILE" "$connection"
}

# Each test chat hears every bot message, since the members are bots. Every
# other chat setting keeps Rome's default.
let_chats_hear_bots() {
  local name connection
  connection="$(state connection)"
  for name in "${CHATS[@]}"; do
    printf '{"ref":{"connectionId":"%s","chatId":"%s"},"set":{"activation":{"botMessages":"all"}}}' \
      "$connection" "$(state "chats.$name")" | api PATCH /chat-settings >/dev/null
  done
}

# Each member bot's Discord account belongs to a person of the member's name,
# as the guardian would link a teammate.
add_people() {
  local i
  for i in "${!MEMBERS[@]}"; do
    printf '{"displayName":"%s","bondLevel":"other","accounts":[{"channel":"discord","channelUserId":"%s"}]}' \
      "${MEMBER_NAMES[$i]}" "$(state "members.${MEMBERS[$i]}.id")" | api POST /people >/dev/null
  done
}

reset_display_names() {
  local i
  for i in "${!MEMBERS[@]}"; do
    COS_TOKEN="$(printenv "COS_MEMBER_$((i + 1))_BOT_TOKEN")" discord rename "${MEMBER_NAMES[$i]}"
  done
}

cmd_up() {
  local build=1
  [ "${1:-}" = "--no-build" ] && build=0
  mkdir -p "$RUN_DIR"
  claim_ownership
  load_secrets
  if [ "$build" = 1 ] || [ -z "$(image_sha)" ]; then build_rome_image; fi
  log "reading the bots and chats on Discord ..."
  write_discord_state
  write_rome_env
  log "starting Rome ..."
  start_rome
  if [ -n "$(api GET /connected-accounts | json accounts.0)" ]; then
    log "Rome already holds the connection, keeping it"
    link_agent
  else
    connect_agent_bot
    link_agent
    let_chats_hear_bots
    add_people
  fi
  reset_display_names
  log "ready. Drive it with environments/chief-of-staff/cos-env"
}

clear_chats() {
  local name
  for name in "${CHATS[@]}"; do
    log "clearing #$name on Discord ..."
    discord clear "$(state "chats.$name")"
  done
}

remove_rome() {
  docker rm -f "$ROME" >/dev/null 2>&1 || true
  docker volume rm "$HOME_VOLUME" "$MEMORY_VOLUME" "$USER_VOLUME" >/dev/null 2>&1 || true
}

cmd_reset() {
  mkdir -p "$RUN_DIR"
  claim_ownership
  load_secrets
  write_discord_state
  clear_chats
  log "wiping Rome's home, memory and chats ..."
  remove_rome
  cmd_up --no-build
}

cmd_down() {
  claim_ownership
  remove_rome
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR"
  log "removed. The secrets file stays in $SECRETS_FILE, and the test chats keep their messages until the next reset."
}

# Entry points for cos-env, which sources this file.
cos_rome() {
  case "${1:-}" in
    stop) docker stop "$ROME" >/dev/null ;;
    start)
      docker start "$ROME" >/dev/null
      wait_for_rome
      ;;
    restart)
      docker restart "$ROME" >/dev/null
      wait_for_rome
      ;;
    *) die "usage: cos-env rome stop|start|restart" ;;
  esac
}

cos_version() {
  [ -f "$BUILD_FILE" ] || die "the environment is not up. Run environments/chief-of-staff/env.sh up first."
  local login model
  load_secrets
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then login=anthropic-api-key; else login=claude-oauth-token; fi
  model="$(api GET /settings 2>/dev/null | json tierModelMappings)"
  node -e '
    const [build, verifier, environment, login, model] = process.argv.slice(1);
    const b = JSON.parse(build);
    console.log(JSON.stringify({
      rome: b.rome,
      app: b.app,
      verifier: JSON.parse(verifier),
      environment: JSON.parse(environment),
      model: { login, tierModelMappings: model ? JSON.parse(model) : null },
      builtAt: b.builtAt,
    }, null, 2));' \
    "$(cat "$BUILD_FILE")" "$(tree_json environments/chief-of-staff/verifier)" \
    "$(tree_json environments/chief-of-staff ':!environments/chief-of-staff/verifier')" "$login" "$model"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    up) cmd_up "${2:-}" ;;
    reset) cmd_reset ;;
    down) cmd_down ;;
    *) die "usage: env.sh up [--no-build] | reset | down" ;;
  esac
fi
