#!/usr/bin/env bash
# The chief of staff environment: a Rome container of its own, built from this
# checkout, connected to a test Discord server through the agent's Discord bot.
# The team members are webhook authors that a second bot, the driver, runs.
#
#   environments/chief-of-staff/env.sh up [--no-build]  # start, or bring up to date
#   environments/chief-of-staff/env.sh reset            # wipe Rome and the test chats, start again
#   environments/chief-of-staff/env.sh down             # remove everything up created
#   environments/chief-of-staff/env.sh seed <dir>       # hand the agent the team roster and goals
#
# The verifier drives it through cos-env only. See README.md.
set -euo pipefail
# The state file holds the members' webhook tokens, so nothing here is readable by others.
umask 077

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$ENV_DIR" rev-parse --show-toplevel)"

# ROME_ENV_NAME runs a second, separate copy (its own container, volumes and
# state folder), for checking a build without touching the one in use.
NAME="${ROME_ENV_NAME:-chief-of-staff}"
STATE_DIR="${ROME_ENV_STATE_DIR:-$HOME/.rome-environments/$NAME}"
# Secrets come from one 1Password item, read with a service account scoped to
# the development vault. The secrets file is the fallback when the devbox has no
# service account token.
OP_VAULT="${COS_OP_VAULT:-Rome Dev}"
OP_ITEM="${COS_OP_ITEM:-Chief of staff test}"
OP_TOKEN_FILE="${COS_OP_TOKEN_FILE:-$HOME/.config/op/service-account-token}"
SECRETS_FILE="${COS_SECRETS_FILE:-$HOME/.config/rome/cos.env}"
RUN_DIR="$STATE_DIR/run"
STATE_FILE="$RUN_DIR/state.json"
BUILD_FILE="$RUN_DIR/build.json"
ROME_ENV_FILE="$RUN_DIR/rome.env"
OWNER_FILE="$RUN_DIR/owner"
# How many hours `cos-env clock` has moved the app's history back. Absent
# means none.
CLOCK_FILE="$RUN_DIR/clock"

IMAGE="rome-env-${NAME}:latest"
ROME="rome-env-${NAME}-rome"
HOME_VOLUME="rome-env-${NAME}-home"
MEMORY_VOLUME="rome-env-${NAME}-memory"
USER_VOLUME="rome-env-${NAME}-user"
# A throwaway checkout where this branch is merged with Rome changes under test,
# so they never land on this branch.
BUILD_TREE="$RUN_DIR/agent-tree"
# What the last `up` ran with, so a later `up`, `reset` or `clock` that does
# not set a COS_* setting keeps it rather than falling back to the default.
# A setting given in the environment, even empty, wins over the saved one.
SETTINGS_FILE="$RUN_DIR/settings"
# shellcheck disable=SC1090
[ ! -f "$SETTINGS_FILE" ] || . "$SETTINGS_FILE"
# Rome changes merged into the build, in order, separated by spaces. Each is a
# pull request as #<number>, a remote branch as origin/<branch>, or any commit.
# Empty builds this branch as it is.
AGENT_REFS="${COS_AGENT_REF-${SAVED_AGENT_REF-#2173}}"
# The chief of staff app, from its own private repository, installed into the
# running Rome the way a guardian installs an app from source. The devbox's
# GitHub sign-in fetches it, so no token enters the container.
APP_REPO="${COS_APP_REPO:-${SAVED_APP_REPO:-zhangfand/chief-of-staff}}"
APP_REF="${COS_APP_REF:-${SAVED_APP_REF:-main}}"
APP_SRC="$RUN_DIR/app-src"
APP_PATH_IN_ROME=/home/rome/app-sources/chief-of-staff
# Test only. An agent name to link the connected account to in place of
# COS_AGENT_NAME, written straight into Rome's database because no loaded agent
# has it. See link_unloaded_agent.
UNLOADED_AGENT="${COS_LINK_UNLOADED_AGENT-${SAVED_LINK_UNLOADED_AGENT-}}"
# 1 makes every chat answer every message, not only the dm-* chats.
HEAR_EVERY_MESSAGE="${COS_HEAR_EVERY_MESSAGE:-${SAVED_HEAR_EVERY_MESSAGE:-0}}"
# A note `version` carries for a ref, as JSON keyed by the ref, for what the
# ref's own state does not say.
REF_NOTES="${COS_REF_NOTES:-}"
[ -n "$REF_NOTES" ] || REF_NOTES='{}'
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

# Reads KEY=value lines from the secrets file. A value already set in the shell
# wins, as with 1Password. Blank lines and # comments are skipped.
load_from_file() {
  local line name value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#export }"
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    value="${value%\"}" value="${value#\"}" value="${value%\'}" value="${value#\'}"
    [ -n "${!name:-}" ] || export "$name=$value"
  done <"$SECRETS_FILE"
}

# Reads the secrets into the environment from the secrets file when it exists,
# otherwise from the 1Password vault through a service account token, and
# stops naming the first one missing. Values are never echoed.
load_secrets() {
  local source
  if [ -f "$SECRETS_FILE" ]; then
    source="$SECRETS_FILE"
    load_from_file
  elif [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] || [ -s "$OP_TOKEN_FILE" ]; then
    source="the 1Password item \"$OP_ITEM\" in the vault \"$OP_VAULT\""
    load_from_1password
  else
    die "no secrets: write $SECRETS_FILE, or put a 1Password service account token in $OP_TOKEN_FILE. README.md lists what either holds."
  fi
  local name
  for name in COS_DISCORD_SERVER_ID COS_AGENT_BOT_TOKEN COS_DRIVER_BOT_TOKEN; do
    [ -n "${!name:-}" ] || die "$source does not set $name"
  done
  if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    die "$source sets both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN. Keep the one model login the run should use."
  fi
  [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] ||
    die "$source sets no model login: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
}

# The members a chat holds, by the chat's name: the ones team.env lists for a
# shared chat, the one member of a private chat, and member1's second account
# wherever member1 is.
chat_members() {
  local chat="$1" var members=()
  if [[ "$chat" == "$COS_DM_CHAT_PREFIX"* ]]; then
    members=("${chat#"$COS_DM_CHAT_PREFIX"}")
  else
    var="COS_CHAT_MEMBERS_${chat//-/_}"
    read -r -a members <<<"${!var:-}"
  fi
  local member
  for member in "${members[@]}"; do
    printf '%s\n' "$member"
    [ "$member" != member1 ] || printf '%s\n' "member1:2"
  done
}

# Runs the Discord helper as the driver bot.
discord() {
  COS_STATE="$STATE_FILE" COS_TOKEN="${COS_TOKEN:-$COS_DRIVER_BOT_TOKEN}" node "$ENV_DIR/discord.mjs" "$@"
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
  if [ -n "$owner" ] && [ "$owner" != "$REPO_ROOT" ]; then
    [ "${ROME_ENV_TAKE_OVER:-0}" = 1 ] ||
      die "the environment belongs to $owner. Run down there, or set ROME_ENV_TAKE_OVER=1 to take it over."
    # Taking over in the middle of a verifier run in the owner's checkout would
    # rebuild or wipe the Rome that run is talking to.
    local pid
    for pid in $(pgrep -f 'verifier/verify\.mjs' || true); do
      [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" != "$owner"* ]] ||
        die "a verifier run (process $pid) is going in $owner. Wait for it to finish before taking the environment over."
    done
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
# The commit a ref names, fetched from origin first when it is a pull request
# or a remote branch.
resolve_ref() {
  local ref="$1"
  case "$ref" in
    "#"*)
      git -C "$REPO_ROOT" fetch --quiet origin "pull/${ref#\#}/head" &&
        git -C "$REPO_ROOT" rev-parse FETCH_HEAD
      ;;
    origin/*)
      git -C "$REPO_ROOT" fetch --quiet origin "${ref#origin/}" 2>/dev/null || true
      git -C "$REPO_ROOT" rev-parse "$ref"
      ;;
    *) git -C "$REPO_ROOT" rev-parse "$ref" ;;
  esac
}

# For a pull request ref, its state and title on GitHub when the image is built,
# as JSON fields to add to the ref's entry, plus any note REF_NOTES gives it.
pr_fields() {
  local ref="$1" fields=""
  if [[ "$ref" == "#"* ]] && command -v gh >/dev/null; then
    fields="$(gh pr view "${ref#\#}" --json state,title,url 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const p=JSON.parse(s);process.stdout.write(`,"state":${JSON.stringify(p.state)},"title":${JSON.stringify(p.title)},"url":${JSON.stringify(p.url)}`)})')" || fields=""
  fi
  fields+="$(node -e 'const n=JSON.parse(process.argv[1])[process.argv[2]];if(n)process.stdout.write(`,"note":${JSON.stringify(n)}`)' "$REF_NOTES" "$ref")"
  printf '%s' "$fields"
}

build_rome_image() {
  local main_sha env_sha env_dirty=false merged ref sha merged_refs="" done_refs="" refs
  git -C "$REPO_ROOT" fetch --quiet origin main
  main_sha="$(git -C "$REPO_ROOT" merge-base HEAD origin/main)"
  env_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- environments/chief-of-staff)" ] || env_dirty=true

  git -C "$REPO_ROOT" worktree remove --force "$BUILD_TREE" 2>/dev/null || true
  rm -rf "$BUILD_TREE"
  git -C "$REPO_ROOT" worktree add --quiet --detach "$BUILD_TREE" "$env_sha"
  read -r -a refs <<<"$AGENT_REFS"
  for ref in "${refs[@]}"; do
    sha="$(resolve_ref "$ref" 2>/dev/null)" || {
      git -C "$REPO_ROOT" worktree remove --force "$BUILD_TREE" 2>/dev/null || true
      die "cannot resolve \"$ref\". COS_AGENT_REF takes #<pull request>, origin/<branch> or a commit."
    }
    log "merging $ref (${sha:0:9}) into the build ..."
    if ! git -C "$BUILD_TREE" merge --no-edit --no-ff "$sha" >/dev/null 2>&1; then
      git -C "$BUILD_TREE" merge --abort 2>/dev/null || true
      git -C "$REPO_ROOT" worktree remove --force "$BUILD_TREE" 2>/dev/null || true
      die "$ref does not merge cleanly on top of ${done_refs:-this branch}. Rebase it on main, or change COS_AGENT_REF."
    fi
    done_refs+="${done_refs:+ + }$ref"
    merged_refs+="${merged_refs:+,}{\"ref\":\"$ref\",\"commit\":\"$sha\"$(pr_fields "$ref")}"
  done
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
  # agent.commit is the first ref, the agent's own; merged lists every ref in
  # the build, and tree the commit the image was built from.
  node -e '
    const [main, env, envDirty, refs, tree] = process.argv.slice(1);
    const merged = JSON.parse(`[${refs}]`);
    process.stdout.write(JSON.stringify({
      rome: { commit: main, dirty: false },
      agent: { commit: merged[0]?.commit ?? null, dirty: false, merged },
      environment: { commit: env, dirty: envDirty === "true" },
      tree,
      builtAt: new Date().toISOString(),
    }) + "\n");' "$main_sha" "$env_sha" "$env_dirty" "$merged_refs" "$merged" >"$BUILD_FILE"
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
# Runs watch-rome.sh beside the container as a systemd user service, so it
# outlives the command that started it, after stopping any earlier one.
WATCH_UNIT="rome-env-$NAME-watch"
SYSTEMD_BIN=/run/current-system/sw/bin

start_watch() {
  stop_watch
  mkdir -p "$RUN_DIR/incidents"
  if [ -x "$SYSTEMD_BIN/systemd-run" ]; then
    "$SYSTEMD_BIN/systemd-run" --user --quiet --collect --unit="$WATCH_UNIT" --setenv=PATH="$PATH" \
      "$ENV_DIR/watch-rome.sh" "$ROME" "$RUN_DIR/incidents" ||
      log "could not start the health watch; health failures will not be captured"
  else
    log "no systemd-run here; health failures will not be captured"
  fi
}

stop_watch() {
  [ -x "$SYSTEMD_BIN/systemctl" ] || return 0
  "$SYSTEMD_BIN/systemctl" --user stop "$WATCH_UNIT" 2>/dev/null || true
}

start_rome() {
  save_rome_logs
  stop_watch
  docker rm -f "$ROME" >/dev/null 2>&1 || true
  # The devbox runs many Romes at once. The cap keeps this one, and the Chrome
  # the image runs inside it, from taking the box down; Chrome dies with the
  # container on reset and down.
  # Logs go to a file of the container's own, kept whole across restarts,
  # rather than the host journal, which drops old entries.
  docker run -d --name "$ROME" --restart unless-stopped --memory 6g \
    --log-driver json-file --log-opt max-size=100m --log-opt max-file=10 \
    --env-file "$ROME_ENV_FILE" \
    -v "$HOME_VOLUME:/home/rome" -v "$MEMORY_VOLUME:/app/memory" -v "$USER_VOLUME:/home/user" \
    --cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined \
    "$IMAGE" >/dev/null
  start_watch
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
# Keeps the webhooks, display names and connection an earlier run recorded.
write_discord_state() {
  local agent driver chats names
  agent="$(COS_TOKEN="$COS_AGENT_BOT_TOKEN" discord whoami)"
  driver="$(discord whoami)"
  mapfile -t names < <(all_chat_names)
  chats="$(discord chats "${names[@]}")"
  node -e '
    const fs = require("fs");
    const [file, agent, driver, chats, dmPrefix] = process.argv.slice(1);
    let old = {};
    try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const s = { ...old, agent: JSON.parse(agent), driver: JSON.parse(driver), chats: JSON.parse(chats), dmPrefix };
    fs.writeFileSync(file, JSON.stringify(s) + "\n", { mode: 0o600 });' \
    "$STATE_FILE" "$agent" "$driver" "$chats" "$COS_DM_CHAT_PREFIX"
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

# Fetches the app's repository at APP_REF on the devbox, copies the checkout
# into the container, and installs it from source through Rome's app API, the
# same install `system:app_management` runs.
install_app() {
  if [ -d "$APP_SRC/.git" ]; then
    git -C "$APP_SRC" fetch --quiet origin || die "cannot fetch $APP_REPO. Is gh signed in with access to it?"
  else
    rm -rf "$APP_SRC"
    gh repo clone "$APP_REPO" "$APP_SRC" -- --quiet || die "cannot clone $APP_REPO. Is gh signed in with access to it?"
  fi
  local commit
  commit="$(git -C "$APP_SRC" rev-parse --verify --quiet "origin/$APP_REF^{commit}" || git -C "$APP_SRC" rev-parse --verify --quiet "$APP_REF^{commit}")" ||
    die "$APP_REPO has no ref \"$APP_REF\". Set COS_APP_REF to a branch or commit."
  git -C "$APP_SRC" checkout --quiet --detach "$commit"
  git -C "$APP_SRC" clean --quiet -fdx
  log "installing $APP_REPO at ${commit:0:9} into Rome ..."
  docker exec "$ROME" sh -c "rm -rf '$APP_PATH_IN_ROME' && mkdir -p '$(dirname "$APP_PATH_IN_ROME")'"
  docker cp --quiet "$APP_SRC/." "$ROME:$APP_PATH_IN_ROME"
  # The copy keeps the devbox's owner and modes, and Rome runs as rome.
  docker exec "$ROME" sh -c "chown -R rome:rome '$(dirname "$APP_PATH_IN_ROME")' && chmod -R u+rwX,go+rX '$APP_PATH_IN_ROME'"
  local result phase
  result="$(printf '{"source":{"mode":"source","path":"%s"}}' "$APP_PATH_IN_ROME" | api POST /apps)" ||
    die "Rome refused to install $APP_REPO: $result"
  phase="$(json phase <<<"$result")"
  [ -z "$(json error <<<"$result")" ] || die "installing $APP_REPO ended $phase: $(json error <<<"$result")"
  log "installed $(json appId <<<"$result"), $phase"
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    s.app = { repo: process.argv[2], ref: process.argv[3], commit: process.argv[4], installedAt: new Date().toISOString() };
    fs.writeFileSync(f, JSON.stringify(s) + "\n", { mode: 0o600 });' "$STATE_FILE" "$APP_REPO" "$APP_REF" "$commit"
}

# Test only, and not a setup Rome supports: links the agent's connected account
# to UNLOADED_AGENT, a name no loaded agent has, so a message the bot hears
# wakes no agent and the installed app handles it on its own. Rome's API
# refuses a link to an agent it has not loaded, so this stops Rome, writes the
# link into its database, and starts it again.
link_unloaded_agent() {
  local agent_id="$1"
  log "linking the connected account to $UNLOADED_AGENT, which no loaded agent has (test only) ..."
  docker stop "$ROME" >/dev/null
  docker run --rm -v "$HOME_VOLUME:/home/rome" --workdir /opt/rome/packages/core --entrypoint node "$IMAGE" -e '
    const db = new (require("better-sqlite3"))("/home/rome/.rome/default/rome.db");
    const r = db.prepare("UPDATE connected_accounts SET agent = ? WHERE platform = ? AND account_id = ?")
      .run(process.argv[1], "discord", process.argv[2]);
    if (r.changes !== 1) { console.error(`updated ${r.changes} connected accounts, not 1`); process.exit(1); }' \
    "$UNLOADED_AGENT" "$agent_id" || die "could not write the link into Rome's database"
  bring_rome_back start
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
  if [ -n "$UNLOADED_AGENT" ]; then
    link_unloaded_agent "$agent_id"
  else
    log "linking the $COS_AGENT_NAME agent to the connected account ..."
    printf '{"agent":"%s"}' "$COS_AGENT_NAME" | api PUT "/connected-accounts/discord/$agent_id/agent" >/dev/null ||
      die "Rome refused to link \"$COS_AGENT_NAME\". Did $APP_REPO install? GET /api/agents lists the loaded agents."
  fi
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

# Every test chat hears every bot message, since webhook authors count as bots. Every
# other chat setting keeps Rome's default.
let_chats_hear_bots() {
  local name tries=0
  # Rome sets a rule only on a chat whose kind it knows, from a message there
  # or from its platform's listing. Listing the connection's chats records each
  # kind, once the Discord client is ready to list them.
  until api GET "/chat-settings?connectionId=$(state connection)&limit=50" |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.exit(JSON.parse(s).items?.length?0:1))'; do
    tries=$((tries + 1))
    [ "$tries" -lt 30 ] || die "Rome lists no Discord chats for the agent's connected account"
    sleep 2
  done
  while IFS= read -r name; do
    if [[ "$name" == "$COS_DM_CHAT_PREFIX"* ]] || [ "$HEAR_EVERY_MESSAGE" = 1 ]; then
      # A direct message is answered without a mention, so the private chat
      # that stands in for one answers every message too. COS_HEAR_EVERY_MESSAGE
      # does the same for every chat.
      set_chat "$name" '{"activation":{"botMessages":"all","mode":"all"}}'
    else
      set_chat "$name" '{"activation":{"botMessages":"all"}}'
    fi
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

# Rome answers only the bond levels the guardian picks on the Inbox page, the
# guardian alone by default, and sends the rest through sender triage unless
# their level is trusted. The agent's README puts the team at inner circle and
# both settings at that level, so this does the same.
let_agent_answer_team() {
  log "letting the agent answer the team ..."
  printf '{"replyToBondLevels":["guardian","inner-circle"],"trustedBondLevels":["guardian","inner-circle"]}' |
    api PUT /settings >/dev/null
}

save_settings() {
  {
    printf 'SAVED_AGENT_REF=%q\n' "$AGENT_REFS"
    printf 'SAVED_APP_REPO=%q\n' "$APP_REPO"
    printf 'SAVED_APP_REF=%q\n' "$APP_REF"
    printf 'SAVED_LINK_UNLOADED_AGENT=%q\n' "$UNLOADED_AGENT"
    printf 'SAVED_HEAR_EVERY_MESSAGE=%q\n' "$HEAR_EVERY_MESSAGE"
  } >"$SETTINGS_FILE"
  log "settings: Rome refs \"$AGENT_REFS\", app $APP_REPO at $APP_REF, linked agent ${UNLOADED_AGENT:-$COS_AGENT_NAME}, every chat hears every message: $([ "$HEAR_EVERY_MESSAGE" = 1 ] && echo yes || echo no)"
}

# Fails unless Rome runs the app at APP_REF and the connected account links the
# agent the settings name.
check_settings_took() {
  local want_agent="${UNLOADED_AGENT:-$COS_AGENT_NAME}" agent app_ref
  app_ref="$(state app.ref)"
  [ "$app_ref" = "$APP_REF" ] || die "the installed app is at \"$app_ref\", not COS_APP_REF \"$APP_REF\""
  agent="$(api GET /connected-accounts | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const a = JSON.parse(s).accounts.find((x) => x.account.platform === "discord" && x.account.id === process.argv[1]);
      process.stdout.write(a?.agent ?? "");
    });' "$(state agent.id)")"
  [ "$agent" = "$want_agent" ] || die "the connected account links \"$agent\", not \"$want_agent\""
}

cmd_up() {
  local build=1
  [ "${1:-}" = "--no-build" ] && build=0
  mkdir -p "$RUN_DIR"
  claim_ownership
  load_secrets
  save_settings
  if [ "$build" = 1 ] || [ -z "$(image_sha)" ]; then build_rome_image; fi
  log "reading the bots and chats on Discord ..."
  write_discord_state
  write_rome_env
  log "starting Rome ..."
  start_rome
  if [ -n "$(api GET /connected-accounts | json accounts.0)" ]; then
    log "Rome already holds the connection, keeping it"
    install_app
    link_agent
  else
    connect_agent_bot
    install_app
    link_agent
  fi
  let_chats_hear_bots
  set_model
  let_agent_answer_team
  check_settings_took
  log "ready. Drive it with environments/chief-of-staff/cos-env. Hand it the team with: cos-env seed <dir>"
}

clear_chats() {
  local name
  while IFS= read -r name; do
    log "clearing #$name on Discord ..."
    COS_AGENT_TOKEN="$COS_AGENT_BOT_TOKEN" discord clear "$(state "chats.$name")"
  done < <(all_chat_names)
}

# Copies the Rome container's whole log into the run folder before the
# container goes, so a run's log outlives a reset. Named by when the container
# was made, which a restart keeps.
save_rome_logs() {
  local started
  started="$(docker inspect -f '{{.Created}}' "$ROME" 2>/dev/null)" || return 0
  mkdir -p "$RUN_DIR/logs"
  docker logs "$ROME" >"$RUN_DIR/logs/rome-${started%%.*}.log" 2>&1 || true
  rome_memory >"$RUN_DIR/logs/rome-${started%%.*}.memory.json" 2>/dev/null || true
}

# The Rome container's memory as JSON: its limit, the most it has used, and how
# many times the kernel killed a process in it for want of memory, all since the
# container was made.
rome_memory() {
  local created
  created="$(docker inspect -f '{{.Created}}' "$ROME")" || return 1
  docker exec "$ROME" sh -c 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.peak; grep "^oom_kill " /sys/fs/cgroup/memory.events' |
    node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const [max, peak, kills] = s.trim().split("\n");
        const limit = max === "max" ? null : Number(max);
        const oomKills = Number(kills.split(" ")[1]);
        console.log(JSON.stringify({ since: process.argv[1], limitBytes: limit, peakBytes: Number(peak), oomKills, hitLimit: oomKills > 0 }));
      });' "$created"
}

remove_rome() {
  save_rome_logs
  stop_watch
  docker rm -f "$ROME" >/dev/null 2>&1 || true
  docker volume rm "$HOME_VOLUME" "$MEMORY_VOLUME" "$USER_VOLUME" >/dev/null 2>&1 || true
}

cmd_reset() {
  mkdir -p "$RUN_DIR"
  claim_ownership
  load_secrets
  write_discord_state
  clear_chats
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    const s = JSON.parse(fs.readFileSync(f, "utf8")); delete s.members; delete s.connection;
    fs.writeFileSync(f, JSON.stringify(s) + "\n", { mode: 0o600 });' "$STATE_FILE"
  log "wiping Rome's home, memory and chats ..."
  remove_rome
  rm -f "$CLOCK_FILE"
  cmd_up --no-build
}

cmd_down() {
  claim_ownership
  if [ -f "$STATE_FILE" ] && (load_secrets) 2>/dev/null; then
    load_secrets
    discord delete-webhooks || log "could not delete the members' webhooks; the next seed replaces them"
  fi
  remove_rome
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR"
  log "removed. The test chats keep their messages until the next reset."
}

# Replaces one of the agent app's documents (roster or goals) with the markdown
# in a file, through the app's own HTTP surface.
put_document() {
  local document="$1" file="$2"
  node -e '
    const fs = require("fs");
    process.stdout.write(JSON.stringify({ body: fs.readFileSync(process.argv[1], "utf8") }));' "$file" |
    api PUT "/apps/$COS_AGENT_APP/documents/$document" >/dev/null ||
    die "Rome refused to write the $document document. Did $APP_REPO install?"
}

# Gives each member a webhook in each chat it is in, links all of a member's
# webhooks to one person, sets the names the members post under, and hands the
# agent the roster and goals. team.json is the verifier's team, whose members
# each name an account and a person: { "members": [{ "account": "member1",
# "name": "...", "bondLevel"?: "..." }, ...] }, inner circle when unset, as the
# agent's README sets the team. member1:2,
# member1's second account, belongs to member1's person and posts under the same
# name until renamed. The roster and goals are markdown the agent reads through
# its own documents.
# Deletes the people an earlier seed made: anyone who holds one of the members'
# webhooks as an account, or who has the name of a person in team.json. Seeding
# again then starts from no people, as after a reset.
forget_team() {
  local id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    log "deleting $id, from an earlier seed ..."
    api DELETE "/people/$id" </dev/null >/dev/null || die "Rome did not delete $id"
  done < <(api GET /people | node -e '
    const fs = require("fs");
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const team = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const hooks = new Set(Object.values(s.webhooks ?? {}).flatMap((h) => Object.values(h).map((w) => w.id)));
    const names = new Set((team.members ?? []).map((m) => m.name));
    let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      for (const p of JSON.parse(raw).people ?? []) {
        if (p.bondLevel === "guardian") continue;
        if (names.has(p.displayName) || p.accounts.some((a) => a.channel === "discord" && hooks.has(a.channelUserId)))
          console.log(p.id);
      }
    });' "$STATE_FILE" "$1")
}

cmd_seed() {
  local dir="${1:?usage: cos-env seed <dir>}"
  mkdir -p "$RUN_DIR"
  claim_ownership
  load_secrets
  local file
  for file in team.json roster.md goals.md; do
    [ -f "$dir/$file" ] || die "$dir has no $file"
  done
  local chat members plan="" member display bond accounts
  log "making the members' webhooks ..."
  while IFS= read -r chat; do
    members="$(chat_members "$chat" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split("\n").filter(Boolean))))')"
    plan+="${plan:+,}\"$chat\":$members"
  done < <(all_chat_names)
  printf '{%s}' "$plan" | discord webhooks
  forget_team "$dir/team.json"
  for member in "${MEMBERS[@]}"; do
    read -r bond display < <(node -e '
      const team = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const m = (team.members ?? []).find((m) => m.account === process.argv[2]);
      if (m?.name) process.stdout.write(`${m.bondLevel ?? "inner-circle"} ${m.name}\n`);' \
      "$dir/team.json" "$member") || die "team.json names no person for $member"
    # Every webhook of the member, its second account's included, is one of its accounts.
    accounts="$(node -e '
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const member = process.argv[2];
      const ids = Object.values(s.webhooks).flatMap((hooks) =>
        Object.entries(hooks).filter(([m]) => m.split(":")[0] === member).map(([, h]) => h.id));
      process.stdout.write(JSON.stringify(ids.map((id) => ({ channel: "discord", channelUserId: id }))));' \
      "$STATE_FILE" "$member")"
    log "linking $member to $display ..."
    printf '{"displayName":"%s","bondLevel":"%s","accounts":%s}' "$display" "$bond" "$accounts" |
      api POST /people >/dev/null || die "Rome did not create a person for $display"
    discord rename "$member" "$display"
    [ "$member" != member1 ] || discord rename "member1:2" "$display"
  done
  log "handing the roster and goals to the agent ..."
  put_document roster "$dir/roster.md"
  put_document goals "$dir/goals.md"
  log "seeded."
}

# Entry points for cos-env, which sources this file.
# Restarts or starts Rome and waits until its Discord client is ready, since
# Discord does not replay a message sent while the client is down, so a
# message posted before then never reaches Rome.
bring_rome_back() {
  local since
  since="$(date -u +%FT%T.%NZ)"
  docker "$1" "$ROME" >/dev/null
  wait_for_rome
  [ -n "$(state connection 2>/dev/null)" ] || return 0
  local attempts=0
  until docker logs --since "$since" "$ROME" 2>&1 | grep -q '"discord client ready"'; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 180 ] || die "Rome's Discord client never became ready. Inspect: docker logs $ROME"
    sleep 1
  done
}

# `cos-env clock forward <hours>` makes everything the app has heard that many
# hours older, `cos-env clock reset` undoes every move, and `cos-env clock`
# prints the hours moved. Test only: it rewrites the times in the app's own
# tables (the messages it heard, its queued events and its notes), because no
# clock can be moved for the whole of Rome: libfaketime hangs Claude Code at
# start. Rome and the model keep the real time, so after `forward 24` a message
# said before the move reads as said yesterday. Discord and the agent's
# earlier turns keep the real times.
# shellcheck disable=SC2120 # cos-env passes the arguments.
cos_clock() {
  local moved hours
  moved="$(cat "$CLOCK_FILE" 2>/dev/null || echo 0)"
  case "${1:-}" in
    "")
      printf '{"hoursAhead":%s}\n' "$moved"
      return
      ;;
    forward)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || die "usage: cos-env clock forward <hours>"
      hours="$2"
      ;;
    reset) hours=$((-moved)) ;;
    *) die "usage: cos-env clock [forward <hours> | reset]" ;;
  esac
  claim_ownership
  log "moving what the app has heard $hours hours into the past (test only) ..."
  docker exec -i -u rome "$ROME" node - "$hours" <<'JS' || die "could not move the app's times"
const Database = require("/app/node_modules/better-sqlite3");
const db = new Database("/home/rome/.rome/default/rome.db", { timeout: 10000 });
const ms = Number(process.argv[2]) * 3600 * 1000;
const back = (iso) => (iso ? new Date(Date.parse(iso) - ms).toISOString() : iso);
db.transaction(() => {
  const messages = db.prepare("select number, said_at, recorded_at from chief_of_staff__messages").all();
  const setMessage = db.prepare("update chief_of_staff__messages set said_at = ?, recorded_at = ? where number = ?");
  for (const m of messages) setMessage.run(back(m.said_at), back(m.recorded_at), m.number);
  const events = db.prepare("select seq, body, added_at from chief_of_staff__events").all();
  const setEvent = db.prepare("update chief_of_staff__events set body = ?, added_at = ? where seq = ?");
  for (const e of events) {
    let body = e.body;
    try {
      const b = JSON.parse(body);
      if (b && typeof b.saidAt === "string") body = JSON.stringify({ ...b, saidAt: back(b.saidAt) });
    } catch {}
    setEvent.run(body, e.added_at == null ? null : e.added_at - ms, e.seq);
  }
  const notes = db.prepare("select path, updated_at from chief_of_staff__notes").all();
  const setNote = db.prepare("update chief_of_staff__notes set updated_at = ? where path = ?");
  for (const n of notes) setNote.run(back(n.updated_at), n.path);
  process.stderr.write(`moved ${messages.length} messages, ${events.length} events, ${notes.length} notes\n`);
})();
JS
  moved=$((moved + hours))
  if [ "$moved" = 0 ]; then rm -f "$CLOCK_FILE"; else echo "$moved" >"$CLOCK_FILE"; fi
  cos_clock
}

# Prints one JSON line per agent turn Rome ran since the given time, with the
# tokens its model calls took, from Rome's own record of the session's messages.
cos_usage() {
  docker exec -i "$ROME" node - "${1:-}" <<'JS'
const Database = require("/app/node_modules/better-sqlite3");
const db = new Database("/home/rome/.rome/default/rome.db", { readonly: true });
const since = process.argv[2] ? Math.floor(Date.parse(process.argv[2]) / 1000) : 0;
if (Number.isNaN(since)) throw new Error(`not a time: ${process.argv[2]}`);
const rows = db
  .prepare(
    `select m.turn_id, m.session_id, s.name, min(m.created_at) as start,
       sum(m.input_tokens) as input, sum(m.output_tokens) as output,
       sum(m.cache_read_tokens) as cache_read, sum(m.cache_write_tokens) as cache_write,
       sum(m.cost_usd) as cost
     from rome_agent_messages m left join rome_sessions s on s.id = m.session_id
     where m.turn_id is not null and m.created_at >= ?
     group by m.turn_id order by start`,
  )
  .all(since);
// The model of the agent session that ran the turn: the newest session for
// the chat's key opened before the turn started.
const modelOf = db.prepare(
  `select provider, model from sessions
   where channel_thread_key = ? and created_at <= ? order by created_at desc limit 1`,
);
for (const r of rows) {
  const session = r.name ? modelOf.get(r.name, r.start) : undefined;
  process.stdout.write(
    `${JSON.stringify({
      start: new Date(r.start * 1000).toISOString(),
      turnId: r.turn_id,
      sessionId: r.session_id,
      session: r.name ?? null,
      model: session?.model ?? null,
      provider: session?.provider ?? null,
      inputTokens: r.input ?? 0,
      outputTokens: r.output ?? 0,
      cacheReadTokens: r.cache_read ?? 0,
      cacheWriteTokens: r.cache_write ?? 0,
      costUsd: r.cost ?? null,
    })}\n`,
  );
}
JS
}

# Stops Rome, posts the script's messages spread over the given minutes while
# it is down, then starts it again.
cos_offline() {
  local file="$1" minutes="${2:-60}" count gap
  [ -f "$file" ] || die "no script file $file"
  [[ "$minutes" =~ ^[0-9]+$ ]] || die "--for takes whole minutes"
  count="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((Array.isArray(s)?s:s.messages).length))' "$file")"
  gap=$((minutes * 60 / (count > 1 ? count : 1)))
  log "stopping Rome for $minutes minutes, with $count messages said meanwhile ..."
  docker stop "$ROME" >/dev/null
  # Rome comes back even when posting fails partway.
  trap 'bring_rome_back start' EXIT
  discord replay "$file" "$gap" "$((minutes * 60))"
  trap - EXIT
  log "starting Rome again ..."
  bring_rome_back start
}

# Prints the agent's memory folder as it is now, and the agent's Read, Write,
# Edit and Glob calls on it since the given time, read from Claude Code's
# transcripts: {files: [{path, bytes, modified}], toolUses: [{time, tool, path}]}.
cos_memory() {
  docker exec -i -u rome "$ROME" node - "${1:-}" <<'JS'
const fs = require("fs");
const path = require("path");
const MEMORY = "/home/rome/.rome/default/apps/data/chief-of-staff/memory";
const TRANSCRIPTS = "/home/rome/.claude/projects";
const since = process.argv[2] ? Date.parse(process.argv[2]) : 0;
if (Number.isNaN(since)) throw new Error(`not a time: ${process.argv[2]}`);
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
      })
    : [];
const files = walk(MEMORY)
  .map((p) => {
    const st = fs.statSync(p);
    return { path: path.relative(MEMORY, p), bytes: st.size, modified: st.mtime.toISOString() };
  })
  .sort((a, b) => a.path.localeCompare(b.path));
const toolUses = [];
for (const file of walk(TRANSCRIPTS).filter((p) => p.endsWith(".jsonl"))) {
  if (fs.statSync(file).mtimeMs < since) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("tool_use")) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const time = Date.parse(entry.timestamp ?? "");
    if (!(time >= since)) continue;
    for (const block of entry.message?.content ?? []) {
      if (block?.type !== "tool_use" || !["Read", "Write", "Edit", "Glob"].includes(block.name)) continue;
      const input = block.input ?? {};
      const target = input.file_path ?? input.path ?? input.pattern ?? "";
      const full = [input.path, input.pattern].filter(Boolean).join(" ");
      if (!String(target).includes(MEMORY) && !full.includes(MEMORY)) continue;
      toolUses.push({ time: new Date(time).toISOString(), tool: block.name, path: input.file_path ?? (input.path && input.pattern ? path.join(input.path, input.pattern) : target) });
    }
  }
}
toolUses.sort((a, b) => a.time.localeCompare(b.time));
process.stdout.write(`${JSON.stringify({ files, toolUses })}\n`);
JS
}

# Prints the roster or the goals document exactly as the app holds it, read
# through the app's own API, where `seed` writes them.
cos_doc() {
  local name="${1:-}"
  [ "$name" = roster ] || [ "$name" = goals ] || die "usage: cos-env doc roster|goals"
  api GET "/apps/$COS_AGENT_APP/state" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const doc = (JSON.parse(s).documents ?? []).find((d) => d.name === process.argv[1]);
      if (!doc) { process.stderr.write(`cos-env: the app holds no ${process.argv[1]} document\n`); process.exit(1); }
      process.stdout.write(doc.body);
    });' "$name"
}

cos_rome() {
  case "${1:-}" in
    stop) docker stop "$ROME" >/dev/null ;;
    start) bring_rome_back start ;;
    restart) bring_rome_back restart ;;
    renew-session)
      shift
      cos_renew_session "$@"
      ;;
    held)
      shift
      cos_held "$@"
      ;;
    *) die "usage: cos-env rome stop|start|restart|renew-session --chat <name>|held [--since <time>]" ;;
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
  bring_rome_back restart
  log "armed. The next message to the agent in #$chat renews its session once a minute has passed since its last turn. 'cos-env reset' restores the policy."
}

# The memory of the container before this one, as save_rome_logs kept it.
previous_memory() {
  local current file last=""
  current="$(docker inspect -f '{{.Created}}' "$ROME" 2>/dev/null)"
  # The glob sorts by name, and so by when each container was made.
  for file in "$RUN_DIR"/logs/rome-*.memory.json; do
    [ -e "$file" ] && [ "$file" != "$RUN_DIR/logs/rome-${current%%.*}.memory.json" ] && last="$file"
  done
  [ -z "$last" ] || cat "$last"
}

# Copies every Rome log since `since` into `dir`: each container's kept log and
# memory, and the current container's log and memory so far.
cos_logs() {
  local dir="${1:?usage: cos-env logs <dir> [--since <time>]}" since="${2:-}" file name created
  mkdir -p "$dir"
  for file in "$RUN_DIR"/logs/rome-*; do
    [ -e "$file" ] || continue
    name="$(basename "$file")" created="${name#rome-}" created="${created%%.log}" created="${created%%.memory.json}"
    [ -z "$since" ] || [[ ! "$created" < "${since%%.*}" ]] || continue
    cp "$file" "$dir/"
  done
  for file in "$RUN_DIR"/incidents/*; do
    [ -d "$file" ] || continue
    name="$(basename "$file")"
    [ -z "$since" ] || [[ ! "$name" < "${since%%.*}" ]] || continue
    mkdir -p "$dir/incidents" && cp -r "$file" "$dir/incidents/"
  done
  created="$(docker inspect -f '{{.Created}}' "$ROME" 2>/dev/null)" || return 0
  docker logs "$ROME" >"$dir/rome-${created%%.*}.log" 2>&1 || true
  rome_memory >"$dir/rome-${created%%.*}.memory.json" 2>/dev/null || true
}

# Prints as JSON the agent's replies envoy held for the guardian's approval or
# rejected since `--since` (an ISO time), oldest first, with envoy's reason,
# read from Rome's own record of approvals. The approvals API asks for the
# guardian's sign-in, which nothing outside Rome holds, so this reads Rome's
# database inside the container.
cos_held() {
  local since=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --since) since="${2:?--since needs a time}" && shift 2 ;;
      *) die "usage: cos-env rome held [--since <time>]" ;;
    esac
  done
  docker exec -i "$ROME" node - "$since" <<'JS'
const Database = require("/app/node_modules/better-sqlite3");
const db = new Database("/home/rome/.rome/default/rome.db", { readonly: true });
const since = process.argv[2] ? Math.floor(Date.parse(process.argv[2]) / 1000) : 0;
if (Number.isNaN(since)) throw new Error(`not a time: ${process.argv[2]}`);
const rows = db
  .prepare(
    `select id, status, created_at, resolved_at, description, payload from approvals
     where type = 'outgoing_message' and status != 'auto_approved' and created_at >= ?
     order by created_at`,
  )
  .all(since);
const held = rows.map((r) => {
  const p = JSON.parse(r.payload);
  return {
    id: r.id,
    // pending: held for the guardian; rejected: envoy refused it, or the
    // guardian did; approved: the guardian let it through later.
    status: r.status,
    time: new Date(r.created_at * 1000).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at * 1000).toISOString() : null,
    question: p.messageId ?? null,
    chatId: p.threadId ?? null,
    senderId: p.channelUserId ?? null,
    reply: p.response ?? null,
    reason: r.description,
  };
});
console.log(JSON.stringify(held, null, 2));
JS
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
    const [build, verifier, login, model, memory, previous, app] = process.argv.slice(1);
    const b = JSON.parse(build);
    console.log(JSON.stringify({
      rome: b.rome,
      agent: b.agent,
      environment: b.environment,
      tree: b.tree ?? null,
      app: app ? JSON.parse(app) : null,
      memory: {
        current: memory ? JSON.parse(memory) : null,
        previous: previous ? JSON.parse(previous) : null,
      },
      verifier: JSON.parse(verifier),
      model: {
        login,
        name: model ? (JSON.parse(model).anthropic?.large ?? null) : null,
        tierModelMappings: model ? JSON.parse(model) : null,
      },
      builtAt: b.builtAt,
    }, null, 2));' \
    "$(cat "$BUILD_FILE")" "$(tree_json environments/chief-of-staff/verifier)" "$login" "$model" \
    "$(rome_memory 2>/dev/null)" "$(previous_memory)" "$(node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).app;if(a)process.stdout.write(JSON.stringify({...a,dirty:false}))}catch{}' "$STATE_FILE")"
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
