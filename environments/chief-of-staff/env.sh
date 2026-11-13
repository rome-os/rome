#!/usr/bin/env bash
# The chief of staff environment: a Rome container of its own, built from this
# checkout, connected to a test Discord server through the agent's Discord bot,
# with bots that play the team.
#
#   environments/chief-of-staff/env.sh up [--no-build]  # start, or bring up to date
#   environments/chief-of-staff/env.sh reset            # wipe Rome and the test chats, start again
#   environments/chief-of-staff/env.sh down             # remove everything up created
#   environments/chief-of-staff/env.sh seed <dir>       # hand the agent the team roster and goals
#
# The verifier drives it through cos-env only. See README.md.
set -euo pipefail

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"

NAME=chief-of-staff
STATE_DIR="${ROME_ENV_STATE_DIR:-$HOME/.rome-environments/$NAME}"
# Secrets come from one 1Password item, read with a service account scoped to
# the development vault. The secrets file is the fallback when the devbox has no
# service account token.
OP_VAULT="${COS_OP_VAULT:-Rome dev}"
OP_ITEM="${COS_OP_ITEM:-Chief of staff test}"
OP_TOKEN_FILE="${COS_OP_TOKEN_FILE:-$HOME/.config/op/service-account-token}"
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
# A throwaway checkout where this branch is merged with the agent's ref, so the
# test Rome carries the agent without the agent's code ever landing on this branch.
BUILD_TREE="$RUN_DIR/agent-tree"
# The agent under test. It lives on its own branch, not on this one. The default
# is the head of the chief of staff agent's pull request.
AGENT_REF="${COS_AGENT_REF:-origin/claude/project-thread-ys37d4}"
# The one model every tier runs on, cheapest first to keep the bill down. A run
# that needs a stronger model sets COS_MODEL, in the shell or the secrets file.
DEFAULT_MODEL=claude-haiku-5-5
# Rome's API inside the container, behind Caddy's sign-in check.
API="http://127.0.0.1:4141/api"

# shellcheck source=team.env
. "$ENV_DIR/team.env"
read -r -a MEMBERS <<<"$COS_MEMBERS"
read -r -a CHATS <<<"$COS_CHATS"

log() { printf 'env/%s: %s\n' "$NAME" "$*" >&2; }
die() {
  log "$*"
  exit 1
}

# Runs the 1Password CLI from Nix, signed in as the service account whose
# token sits in OP_TOKEN_FILE.
op_cli() {
  OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-$(cat "$OP_TOKEN_FILE")}" NIXPKGS_ALLOW_UNFREE=1 \
    nix shell --impure nixpkgs#_1password-cli -c op "$@"
}

# Exports each field of the 1Password item that names a secret variable. Values
# pass from op to node to `export` without reaching argv or the terminal.
load_from_1password() {
  local name value item_json
  item_json="$(op_cli item get "$OP_ITEM" --vault "$OP_VAULT" --format json 2>/dev/null)" ||
    die "cannot read the 1Password item \"$OP_ITEM\" in the vault \"$OP_VAULT\". Check the service account token in $OP_TOKEN_FILE and its access to the vault."
  while IFS= read -r -d '' name && IFS= read -r -d '' value; do
    # A variable already set in the shell wins, so a run can override one value.
    [ -n "${!name:-}" ] || export "$name=$value"
  done < <(node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      for (const f of JSON.parse(s).fields ?? []) {
        if (/^(COS_[A-Z0-9_]+|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/.test(f.label ?? "") && f.value)
          process.stdout.write(`${f.label}\0${f.value}\0`);
      }
    });' <<<"$item_json")
}

# Reads the secrets into the environment from the 1Password vault when the
# devbox holds a service account token, otherwise from the secrets file, and
# stops naming the first one missing. The fourth member token is optional: it
# is the second account of member1, and only `--as member1:2` needs it. Values
# are never echoed.
load_secrets() {
  local source
  if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] || [ -s "$OP_TOKEN_FILE" ]; then
    source="the 1Password item \"$OP_ITEM\" in the vault \"$OP_VAULT\""
    load_from_1password
  elif [ -f "$SECRETS_FILE" ]; then
    source="$SECRETS_FILE"
    set -a
    # shellcheck disable=SC1090
    . "$SECRETS_FILE"
    set +a
  else
    die "no secrets: put a 1Password service account token in $OP_TOKEN_FILE, or write $SECRETS_FILE. README.md lists what either holds."
  fi
  local name
  for name in COS_DISCORD_SERVER_ID COS_AGENT_BOT_TOKEN COS_MEMBER_1_BOT_TOKEN COS_MEMBER_2_BOT_TOKEN COS_MEMBER_3_BOT_TOKEN; do
    [ -n "${!name:-}" ] || die "$source does not set $name"
  done
  if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    die "$source sets both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN. Keep the one model login the run should use."
  fi
  [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] ||
    die "$source sets no model login: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
}

# The bot token behind a member name. member1..3 are the three accounts;
# <member>:2 is that member's second account, the fourth bot.
member_token() {
  case "$1" in
    member1) printf '%s' "$COS_MEMBER_1_BOT_TOKEN" ;;
    member2) printf '%s' "$COS_MEMBER_2_BOT_TOKEN" ;;
    member3) printf '%s' "$COS_MEMBER_3_BOT_TOKEN" ;;
    *:2)
      [ -n "${COS_MEMBER_4_BOT_TOKEN:-}" ] ||
        die "no second account: $SECRETS_FILE sets no COS_MEMBER_4_BOT_TOKEN. Only \"--as $1\" needs it."
      [ "$1" = "member1:2" ] || die "the only second account is member1:2, not \"$1\""
      printf '%s' "$COS_MEMBER_4_BOT_TOKEN"
      ;;
    *) die "no member named \"$1\". Members: ${MEMBERS[*]} (and member1:2 with a fourth token)" ;;
  esac
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

# Builds the production Rome image, the agent app included. The agent lives on
# its own branch, so this merges that ref into a throwaway checkout of this
# branch and builds there — the agent's code never lands on this branch. Records
# the commits that went in, for `cos-env version`.
build_rome_image() {
  local main_sha env_sha agent_sha env_dirty=false merged
  git -C "$REPO_ROOT" fetch --quiet origin main
  git -C "$REPO_ROOT" fetch --quiet origin "${AGENT_REF#origin/}" 2>/dev/null || true
  main_sha="$(git -C "$REPO_ROOT" merge-base HEAD origin/main)"
  env_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  agent_sha="$(git -C "$REPO_ROOT" rev-parse "$AGENT_REF" 2>/dev/null)" ||
    die "cannot resolve the agent ref \"$AGENT_REF\". Set COS_AGENT_REF to the agent's branch or commit."
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- environments/chief-of-staff)" ] || env_dirty=true

  log "merging the agent ${agent_sha:0:9} into a throwaway checkout of ${env_sha:0:9} ..."
  git -C "$REPO_ROOT" worktree remove --force "$BUILD_TREE" 2>/dev/null || true
  rm -rf "$BUILD_TREE"
  git -C "$REPO_ROOT" worktree add --quiet --detach "$BUILD_TREE" "$env_sha"
  if ! git -C "$BUILD_TREE" merge --no-edit --no-ff "$agent_sha" >/dev/null 2>&1; then
    git -C "$BUILD_TREE" merge --abort 2>/dev/null || true
    git -C "$REPO_ROOT" worktree remove --force "$BUILD_TREE" 2>/dev/null || true
    die "the agent ref does not merge cleanly into this branch. Rebase the agent branch on main, or set COS_AGENT_REF to one that merges."
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

  printf '{"rome":{"commit":"%s","dirty":false},"agent":{"commit":"%s","dirty":false},"environment":{"commit":"%s","dirty":%s},"builtAt":"%s"}\n' \
    "$main_sha" "$agent_sha" "$env_sha" "$env_dirty" "$(date -u +%FT%TZ)" >"$BUILD_FILE"
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

# The chats the verifier reads and posts in: the shared ones, and one private
# chat per member that stands in for a direct message.
all_chat_names() {
  local member
  printf '%s\n' "${CHATS[@]}"
  for member in "${MEMBERS[@]}"; do printf '%s\n' "${COS_DM_CHAT_PREFIX}${member}"; done
}

# Writes the bots' and chats' Discord ids, which every later command reads.
write_discord_state() {
  local agent members="" member id chats names
  agent="$(COS_TOKEN="$COS_AGENT_BOT_TOKEN" discord whoami)"
  for member in "${MEMBERS[@]}"; do
    id="$(COS_TOKEN="$(member_token "$member")" discord whoami | json id)"
    members+="${members:+,}\"$member\":{\"id\":\"$id\"}"
  done
  if [ -n "${COS_MEMBER_4_BOT_TOKEN:-}" ]; then
    id="$(COS_TOKEN="$COS_MEMBER_4_BOT_TOKEN" discord whoami | json id)"
    members+=",\"member1:2\":{\"id\":\"$id\"}"
  fi
  mapfile -t names < <(all_chat_names)
  chats="$(COS_TOKEN="$COS_MEMBER_1_BOT_TOKEN" discord chats "${names[@]}")"
  printf '{"agent":%s,"members":{%s},"chats":%s,"dmPrefix":"%s"}\n' \
    "$agent" "$members" "$chats" "$COS_DM_CHAT_PREFIX" >"$STATE_FILE"
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
  log "linking the $COS_AGENT_NAME agent to the connected account ..."
  printf '{"agent":"%s"}' "$COS_AGENT_NAME" | api PUT "/connected-accounts/discord/$agent_id/agent" >/dev/null ||
    die "Rome refused to link \"$COS_AGENT_NAME\". Is the agent's app in this checkout? GET /api/agents lists the loaded agents."
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    const s = JSON.parse(fs.readFileSync(f, "utf8")); s.connection = process.argv[2];
    fs.writeFileSync(f, JSON.stringify(s) + "\n");' "$STATE_FILE" "$connection"
}

# One chat setting on one chat, by its name in the state.
set_chat() {
  local name="$1" patch="$2"
  printf '{"ref":{"connectionId":"%s","chatId":"%s"},"set":%s}' \
    "$(state connection)" "$(state "chats.$name")" "$patch" | api PATCH /chat-settings >/dev/null
}

# Every test chat hears every bot message, since the members are bots. Every
# other chat setting keeps Rome's default.
let_chats_hear_bots() {
  local name
  while IFS= read -r name; do
    set_chat "$name" '{"activation":{"botMessages":"all"}}'
  done < <(all_chat_names)
}

# Sends every model tier to one model, through the same setting the dashboard's
# model picker writes.
set_model() {
  local model="${COS_MODEL:-$DEFAULT_MODEL}"
  log "running the agent on $model ..."
  printf '{"tierModelMappings":{"anthropic":{"large":"%s","medium":"%s","small":"%s"}}}' \
    "$model" "$model" "$model" | api PUT /settings >/dev/null
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
  fi
  set_model
  log "ready. Drive it with environments/chief-of-staff/cos-env. Hand it the team with: cos-env seed <dir>"
}

clear_chats() {
  local name
  while IFS= read -r name; do
    log "clearing #$name on Discord ..."
    discord clear "$(state "chats.$name")"
  done < <(all_chat_names)
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

# Replaces one of the agent app's documents (roster or goals) with the markdown
# in a file, through the app's own HTTP surface.
put_document() {
  local document="$1" file="$2"
  node -e '
    const fs = require("fs");
    process.stdout.write(JSON.stringify({ body: fs.readFileSync(process.argv[1], "utf8") }));' "$file" |
    api PUT "/apps/$COS_AGENT_APP/documents/$document" >/dev/null ||
    die "Rome refused to write the $document document. Is the $COS_AGENT_APP app in this checkout?"
}

# Links each member's Discord account to a person, sets their server display
# names, and hands the agent the roster and goals. team.json maps each member to
# a person: { "member1": { "displayName": "...", "bondLevel": "..." }, ... }. The
# roster and goals are markdown the agent reads through its own documents.
cmd_seed() {
  local dir="${1:?usage: cos-env seed <dir>}"
  mkdir -p "$RUN_DIR"
  claim_ownership
  load_secrets
  local file
  for file in team.json roster.md goals.md; do
    [ -f "$dir/$file" ] || die "$dir has no $file"
  done
  local member display bond person person1=""
  for member in "${MEMBERS[@]}"; do
    display="$(json "$member.displayName" <"$dir/team.json")"
    bond="$(json "$member.bondLevel" <"$dir/team.json")"
    [ -n "$display" ] || die "team.json has no displayName for $member"
    log "linking $member to $display ..."
    person="$(printf '{"displayName":"%s","bondLevel":"%s","accounts":[{"channel":"discord","channelUserId":"%s"}]}' \
      "$display" "${bond:-other}" "$(state "members.$member.id")" | api POST /people | json id)"
    [ -n "$person" ] || die "Rome did not create a person for $display"
    [ "$member" = "member1" ] && person1="$person"
    COS_TOKEN="$(member_token "$member")" discord rename "$display"
  done
  # The second account belongs to the same person as member1, so attribution
  # finds them under one person however they post.
  if [ -n "${COS_MEMBER_4_BOT_TOKEN:-}" ]; then
    log "linking member1's second account to $person1 ..."
    printf '{"channel":"discord","channelUserId":"%s"}' "$(state "members.member1:2.id")" |
      api POST "/people/$person1/accounts" >/dev/null
  fi
  log "handing the roster and goals to the agent ..."
  put_document roster "$dir/roster.md"
  put_document goals "$dir/goals.md"
  log "seeded."
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
    renew-session)
      shift
      cos_renew_session "$@"
      ;;
    *) die "usage: cos-env rome stop|start|restart|renew-session --chat <name>" ;;
  esac
}

# Arms a session renewal on a chat the way a normal renewal happens: set the
# chat's reset policy so a reset is due, then restart Rome so the next message
# opens the session cold and renewed. The verifier posts that message, then
# reads the chat to confirm. `cos-env reset` restores the chat's reset policy.
cos_renew_session() {
  local chat=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --chat) chat="${2:?--chat needs a chat name}" && shift 2 ;;
      *) die "usage: cos-env rome renew-session --chat <name>" ;;
    esac
  done
  [ -n "$chat" ] || die "usage: cos-env rome renew-session --chat <name>"
  load_secrets
  log "arming a session renewal on #$chat ..."
  set_chat "$chat" '{"session":{"reset":{"mode":"idle","idleMinutes":1}}}'
  docker restart "$ROME" >/dev/null
  wait_for_rome
  log "armed. The next message to the agent in #$chat renews its session once a minute has passed since its last turn. 'cos-env reset' restores the policy."
}

cos_version() {
  [ -f "$BUILD_FILE" ] || die "the environment is not up. Run environments/chief-of-staff/env.sh up first."
  local login model
  load_secrets
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then login=anthropic-api-key; else login=claude-oauth-token; fi
  model="$(api GET /settings 2>/dev/null | json tierModelMappings)"
  # rome is the main commit the test Rome sits on, agent and environment the
  # refs merged on top of it, all recorded when the image was built.
  node -e '
    const [build, verifier, login, model] = process.argv.slice(1);
    const b = JSON.parse(build);
    console.log(JSON.stringify({
      rome: b.rome,
      agent: b.agent,
      environment: b.environment,
      verifier: JSON.parse(verifier),
      model: {
        login,
        name: model ? (JSON.parse(model).anthropic?.large ?? null) : null,
        tierModelMappings: model ? JSON.parse(model) : null,
      },
      builtAt: b.builtAt,
    }, null, 2));' \
    "$(cat "$BUILD_FILE")" "$(tree_json environments/chief-of-staff/verifier)" "$login" "$model"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    up) cmd_up "${2:-}" ;;
    reset) cmd_reset ;;
    down) cmd_down ;;
    seed) cmd_seed "${2:-}" ;;
    *) die "usage: env.sh up [--no-build] | reset | down | seed <dir>" ;;
  esac
fi
