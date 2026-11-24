#!/usr/bin/env bash
# Controls a running environment.
#
#   environments/slack-app/ctl.sh [--project <name>] <command> ...
#     (which copy, tools/copy.sh: default $SLACKENV_PROJECT, else slackenv)
#
#   environments/slack-app/ctl.sh stop|start|status rome-a|rome-b
#   environments/slack-app/ctl.sh connect rome-a|rome-b  (Rome's Slack app, as the guardian, in its workspace)
#   environments/slack-app/ctl.sh wipe-chat rome-a|rome-b <Slack conversation id> [--text <text>]...
#   environments/slack-app/ctl.sh port rome-a|rome-b send|read|thread|groups|call '<json>'
#   environments/slack-app/ctl.sh record rome-a|rome-b '{"chat":"<conversation id>[:<thread ts>]"}'
#   environments/slack-app/ctl.sh cloud-query        (SQL on stdin, JSON rows out)
#   environments/slack-app/ctl.sh distribution on|off   (the app's public distribution)
#   environments/slack-app/ctl.sh token-file rome-a|rome-b  (the connector's Slack token file)
#   environments/slack-app/ctl.sh old-connections rome-a|rome-b  (R10's slack_bot and slack)
#   environments/slack-app/ctl.sh product-tests [--add <host file>=<repo-relative path>]... [<repo-relative test file>]...
#   environments/slack-app/ctl.sh old-rows rome-a|rome-b  (whether old-connections' rows are still stored)
#   environments/slack-app/ctl.sh logs <service> [--since <RFC 3339 time>] [--tail <lines>]
#   environments/slack-app/ctl.sh gateway-probe rome-a|rome-b  (the slack-gateway Worker, as that instance)
#   environments/slack-app/ctl.sh as-instance rome-a|rome-b <file.mjs> [args]...  (a test script as that instance)
#   environments/slack-app/ctl.sh mailbox rome-a|rome-b  (the instance's relay mailbox: {depositUrl})
#   environments/slack-app/ctl.sh find-secret rome-a|rome-b '["<string>", ...]'  (counts per place, never content)
#
# connect walks Connect for the slack_app bot grant as the instance's guardian
# in its own workspace (Acme for rome-a, Bayside for rome-b) through Rome Cloud
# and the fake Slack's approve screen (tools/connect-slack.mjs); an instance
# already connected is left as it is.
# A stopped instance's address refuses connections; Rome Cloud, the relay and
# the fake Slack keep running, so events for it wait in its mailbox.
# wipe-chat stops the instance, wipes Rome's copy of the conversation
# (tools/wipe-chat.mjs) and starts it again if it was running. record prints
# the messages Chats has on record for a conversation (tools/chat-record.mjs),
# reading the database without writing it, the instance running or not.
# port makes one call to the Slack app connection's own port through an agent's
# execute_action and connector:connector_proxy, in a dashboard turn the model
# proxy answers itself (tools/port.mjs): a test-only path, one turn per call.
# cloud-query runs
# one query on Rome Cloud's database as a role that can only read.
# old-connections writes the two older Slack connections an upgrade leaves
# (tools/old-connections.mjs) into the stopped instance and starts it again;
# old-rows says, read-only, whether those rows are still in the database.
# logs prints the last 500 lines, or what --since and --tail ask for.
# gateway-probe checks the slack-gateway Worker as the instance, with the
# instance's signer, in its guardian's workspace (tools/gateway-probe.mjs): it
# binds that workspace to the instance and drains the instance's mailbox, so
# stop the instance first for the mailbox check.
# as-instance runs a Node file in the instance's network with its signer
# socket, the instance running or not, with SLACKENV_CLOUD (Rome Cloud's
# origin), SLACKENV_GATEWAY, SLACKENV_SLACK, SLACKENV_SIGNER_SOCKET and
# SLACKENV_CLOUD_COOKIES (the guardian's Rome Cloud session, a cookie map) set; it
# prints what the file prints. Test only: a token the file takes from the
# signer stays inside it. find-secret counts, read only, where the instance
# stores any of the strings: database columns, grant credentials, files under
# the homes and /run, and its logs.
# product-tests runs test files of the rome commit under test, unchanged, in
# an image of that commit with its dependencies (test-runner/Dockerfile).
# --add places a file that is not in the commit (a verifier's own test) at a
# path the commit does not have, read-only, and runs it with the rest. Like
# every command here it needs a bring-up first: it reads .state/rome-src.
set -euo pipefail
ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" = --project ]; then
  SLACKENV_PROJECT="${2:-}"
  shift 2 || true
fi
# shellcheck source=tools/copy.sh
. "$ENV_DIR/tools/copy.sh"
[ -f "$STATE_DIR/compose.env" ] || {
  echo "copy $SLACKENV_PROJECT is not running (no $STATE_DIR/compose.env); run up.sh --project $SLACKENV_PROJECT first" >&2
  exit 1
}
compose() { docker compose --env-file "$STATE_DIR/compose.env" -f "$ENV_DIR/compose.yml" "$@"; }

action="${1:-}"
svc="${2:-}"
case "$action" in
  stop | start | status | connect | wipe-chat | record | port | token-file | old-connections | old-rows | gateway-probe | as-instance | mailbox | find-secret) case "$svc" in rome-a | rome-b) ;; *)
    echo "instance must be rome-a or rome-b" >&2
    exit 2
    ;;
  esac ;;
  cloud-query | product-tests) ;;
  distribution) case "$svc" in on | off) ;; *)
    echo "usage: ctl.sh distribution on|off" >&2
    exit 2
    ;;
  esac ;;
  logs) [ -n "$svc" ] || {
    echo "usage: ctl.sh logs <service> [--since <RFC 3339 time>] [--tail <lines>]" >&2
    exit 2
  } ;;
  *)
    sed -n '2,59p' "$0"
    exit 2
    ;;
esac

wait_healthy() {
  for _ in $(seq 1 300); do
    healthy && return 0
    sleep 1
  done
  healthy
}

# Runs a read-only tool on the instance's database: beside the running
# instance, the script coming in on stdin, or in its image when it is stopped.
read_only() {
  local tool="$1"
  shift
  if [ -n "$(compose ps -q --status running "$svc")" ]; then
    compose exec -T "$svc" node --input-type=module - "$@" <"$ENV_DIR/tools/$tool"
  else
    compose run --rm --no-deps -T --entrypoint node \
      -v "$ENV_DIR/tools/$tool:/slackenv/$tool:ro" "$svc" "/slackenv/$tool" "$@"
  fi
}

# Where each running container of the stack resolves slack.romeos.io, as
# {ok, gateway_tls, containers: {name: [addresses]}}. ok when every address is
# gateway-tls's on the network, or 127.0.0.1 in a container on the host's
# network (the browser's hosts entry); a container with no network resolves
# nothing. Anything else, or a container that cannot be asked, fails.
gateway_resolution() {
  local tls c name net addrs out=()
  tls="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$(compose ps -q gateway-tls)")"
  for c in $(compose ps -q --status running); do
    name="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$c")"
    net="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$c")"
    # shellcheck disable=SC2016 # expanded inside the container
    addrs="$(docker exec "$c" sh -c '
      if command -v getent >/dev/null; then getent ahostsv4 slack.romeos.io
      elif command -v nslookup >/dev/null; then nslookup slack.romeos.io 2>/dev/null | sed -n "s/^Address: //p"
      else echo unchecked; fi' 2>/dev/null |
      awk '{print $1}' | grep -E '^([0-9.]+|unchecked)$' | sort -u | tr '\n' ' ' || true)"
    out+=("$name" "$net" "$addrs")
  done
  node -e '
    const [tls, ...rest] = process.argv.slice(1);
    const inside = tls.trim().split(/\s+/).filter(Boolean);
    const containers = {};
    let ok = inside.length > 0;
    for (let i = 0; i < rest.length; i += 3) {
      const [name, net, addrs] = rest.slice(i, i + 3);
      const list = addrs.trim().split(/\s+/).filter(Boolean);
      containers[name] = list;
      // "unchecked": the container has no resolver tool, so it cannot be shown safe.
      for (const a of list) if (!inside.includes(a) && !(net === "host" && a === "127.0.0.1")) ok = false;
    }
    console.log(JSON.stringify({ ok, gateway_tls: inside, containers }));' "$tls" "${out[@]}"
}

# Runs a Node file as the instance: in its network, with its signer socket,
# in a one-off container of its image, so it works with Rome stopped.
#   as_instance <absolute file> [docker run options]... -- [file args]...
as_instance() {
  local file="$1" opts=() cloud slack_port
  shift
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    opts+=("$1")
    shift
  done
  [ "${1:-}" = "--" ] && shift
  cloud="$(sed -n 's/^CLOUD_ORIGIN=//p' "$STATE_DIR/compose.env")"
  slack_port="$(sed -n 's/^FAKE_SLACK_PORT=//p' "$STATE_DIR/compose.env")"
  # The guardian's Rome Cloud session from up.sh's sign-in, as a cookie map,
  # for steps a browser takes in production (Rome Cloud's Slack callback).
  if [ -f "$STATE_DIR/$svc-cloud-cookies.json" ]; then
    opts+=(-v "$STATE_DIR/$svc-cloud-cookies.json:/slackenv/cloud-cookies.json:ro"
      -e SLACKENV_CLOUD_COOKIES=/slackenv/cloud-cookies.json)
  fi
  compose run --rm --no-deps -T --entrypoint node "${opts[@]}" \
    -e SLACKENV_CLOUD="$cloud" -e SLACKENV_GATEWAY=https://slack.romeos.io \
    -e SLACKENV_SLACK="http://127.0.0.1:$slack_port" -e SLACKENV_SIGNER_SOCKET=/run/rome-signer/signer.sock \
    -v "$file:/slackenv/run/$(basename "$file"):ro" "$svc" "/slackenv/run/$(basename "$file")" "$@"
}

# The member whose direct message the conversation is, from the fake Slack,
# so the chat is found by its key as well as by its address.
member_of() {
  local port
  port="$(sed -n 's/^FAKE_SLACK_PORT=//p' "$STATE_DIR/compose.env")"
  # shellcheck disable=SC2016 # the backticks are JavaScript
  CONVERSATION="$1" node -e '
    fetch(`http://127.0.0.1:${process.argv[1]}/_control/state`).then((r) => r.json()).then((s) => {
      for (const w of s.workspaces)
        for (const m of w.members) if (m.im_channel === process.env.CONVERSATION) console.log(m.id);
    }, () => {});' "$port"
}

healthy() { compose exec -T "$svc" node -e 'fetch("http://127.0.0.1:9368/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' >/dev/null 2>&1; }

token_file() {
  # Whether the instance holds the Slack token file the connector reads, and
  # the last 6 characters of each token in it. The tokens stay inside.
  compose exec -T "$svc" node -e '
    const fs = require("fs");
    const path = process.env.ROME_SLACK_TOKEN_FILE?.trim() || "/run/rome/slack-oauth-token";
    const tail = (t) => (typeof t === "string" && t ? t.slice(-6) : null);
    let out = { instance: process.argv[1], path, exists: false };
    try {
      const j = JSON.parse(fs.readFileSync(path, "utf8"));
      out = { ...out, exists: true, bot_token_tail: tail(j.botToken), user_token_tail: tail(j.userToken), team_id: j.teamId ?? null };
    } catch (e) {
      if (e.code !== "ENOENT") out = { ...out, exists: true, error: String(e.message) };
    }
    console.log(JSON.stringify(out));' "$svc"
}

case "$action" in
  stop)
    compose stop -t 30 "$svc" >/dev/null
    echo "{\"instance\":\"$svc\",\"state\":\"stopped\",\"at\":\"$(date -u +%FT%TZ)\"}"
    ;;
  start)
    compose start "$svc" >/dev/null
    wait_healthy || {
      echo "{\"instance\":\"$svc\",\"state\":\"unhealthy\"}"
      exit 1
    }
    echo "{\"instance\":\"$svc\",\"state\":\"running\",\"at\":\"$(date -u +%FT%TZ)\"}"
    ;;
  status)
    if healthy; then state=running; elif [ -n "$(compose ps -q --status running "$svc")" ]; then state=starting; else state=stopped; fi
    echo "{\"instance\":\"$svc\",\"state\":\"$state\"}"
    ;;
  logs)
    since="" tail=""
    shift 2
    while [ $# -gt 0 ]; do
      case "$1" in
        --since) since="${2:-}" ;;
        --tail) tail="${2:-}" ;;
        *)
          echo "logs takes only --since <RFC 3339 time> and --tail <lines>" >&2
          exit 2
          ;;
      esac
      shift 2 || {
        echo "$1 needs a value" >&2
        exit 2
      }
    done
    [ -z "$tail" ] || [[ "$tail" =~ ^([0-9]+|all)$ ]] || {
      echo "--tail takes a number of lines or all" >&2
      exit 2
    }
    # With --since alone, everything since then; with neither, the last 500.
    [ -n "$tail" ] || { [ -n "$since" ] && tail=all; } || tail=500
    compose logs --no-color --tail "$tail" ${since:+--since "$since"} "$svc"
    ;;
  token-file)
    token_file
    ;;
  connect)
    # The guardian's own workspace and member, and their Rome Cloud account.
    read -r team guardian < <(INDEX="$([ "$svc" = rome-a ] && echo 0 || echo 1)" node -e '
      const w = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).workspaces[+process.env.INDEX];
      console.log(w.id, w.members.find((m) => m.is_owner).id);' "$ENV_DIR/config/workspaces.json")
    fake="http://127.0.0.1:$(sed -n 's/^FAKE_SLACK_PORT=//p' "$STATE_DIR/compose.env")"
    port_var="ROME_$(echo "${svc#rome-}" | tr a-z A-Z)_PORT"
    cloud="$(sed -n 's/^CLOUD_ORIGIN=//p' "$STATE_DIR/compose.env")"
    # The approve screen signs in as the guardian, as Slack's would.
    curl -fsS -X POST -H 'content-type: application/json' -d "{\"team\":\"$team\",\"user\":\"$guardian\"}" \
      "$fake/_control/sign-in" >/dev/null
    NODE_EXTRA_CA_CERTS="$STATE_DIR/trust.pem" exec node "$ENV_DIR/tools/connect-slack.mjs" \
      --name "$svc" --instance "http://127.0.0.1:$(sed -n "s/^$port_var=//p" "$STATE_DIR/compose.env")" \
      --cookies "$STATE_DIR/$svc-cookies.json" --slack "$fake" \
      --cloud-sign-in "$cloud/api/auth/dev/start?email=" --email "guardian-${svc#rome-}@slackenv.test"
    ;;
  old-connections)
    # The guardian's own workspace and member: the first workspace is
    # rome-a's, the second rome-b's.
    read -r team guardian < <(INDEX="$([ "$svc" = rome-a ] && echo 0 || echo 1)" node -e '
      const w = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).workspaces[+process.env.INDEX];
      console.log(w.id, w.members.find((m) => m.is_owner).id);' "$ENV_DIR/config/workspaces.json")
    fake="http://127.0.0.1:$(sed -n 's/^FAKE_SLACK_PORT=//p' "$STATE_DIR/compose.env")"
    port_var="ROME_$(echo "${svc#rome-}" | tr a-z A-Z)_PORT"
    instance="http://127.0.0.1:$(sed -n "s/^$port_var=//p" "$STATE_DIR/compose.env")"
    # The rows carry the tokens, so the instance's image installs the apps in
    # the fake Slack (slack.com inside the network) and writes them itself.
    compose stop -t 30 "$svc" >/dev/null
    set +e
    written="$(compose run --rm --no-deps -T --entrypoint node \
      -v "$ENV_DIR/tools/old-connections.mjs:/slackenv/old-connections.mjs:ro" \
      "$svc" /slackenv/old-connections.mjs write --fake https://slack.com --team "$team" --guardian "$guardian" \
      2>/dev/null | tail -n 1)"
    code=$?
    set -e
    compose start "$svc" >/dev/null
    wait_healthy || {
      echo "{\"instance\":\"$svc\",\"state\":\"unhealthy\"}"
      exit 1
    }
    [ "$code" -eq 0 ] || {
      echo "$written"
      exit "$code"
    }
    printf '%s\n' "$written" >"$STATE_DIR/$svc-old-connections.json"
    # Boot rewrites the token file from the OAuth grant; give it a moment.
    for _ in $(seq 1 30); do
      token_file >"$STATE_DIR/$svc-token-file.json"
      grep -q '"exists":true' "$STATE_DIR/$svc-token-file.json" && break
      sleep 1
    done
    set +e
    result="$(node "$ENV_DIR/tools/old-connections.mjs" check "$instance" "$STATE_DIR/$svc-cookies.json" "$fake" \
      "$STATE_DIR/$svc-old-connections.json" "$STATE_DIR/$svc-token-file.json")"
    code=$?
    set -e
    printf '%s\n' "$result" | tee "$STATE_DIR/$svc-old-connections.json"
    exit "$code"
    ;;
  wipe-chat)
    conversation="${3:-}"
    [[ "$conversation" =~ ^[A-Z0-9]+$ ]] || {
      echo "usage: ctl.sh wipe-chat rome-a|rome-b <Slack conversation id> [--text <text>]..." >&2
      exit 2
    }
    # Texts Rome may have distilled from the chat, removed wherever they are.
    texts=()
    shift 3
    while [ $# -gt 0 ]; do
      [ "$1" = --text ] && [ $# -ge 2 ] || {
        echo "wipe-chat takes only --text <text> after the conversation id" >&2
        exit 2
      }
      texts+=(--text "$2")
      shift 2
    done
    member="$(member_of "$conversation")"
    running=false
    [ -n "$(compose ps -q --status running "$svc")" ] && running=true
    compose stop -t 30 "$svc" >/dev/null
    set +e
    result="$(compose run --rm --no-deps -T --entrypoint node \
      -v "$ENV_DIR/tools/wipe-chat.mjs:/slackenv/wipe-chat.mjs:ro" \
      "$svc" /slackenv/wipe-chat.mjs --conversation "$conversation" ${member:+--member "$member"} "${texts[@]}" 2>/dev/null)"
    code=$?
    set -e
    state=stopped
    if $running; then
      compose start "$svc" >/dev/null
      if wait_healthy; then state=running; else
        state=unhealthy
        [ "$code" -eq 0 ] && code=1
      fi
    fi
    RESULT="$result" STATE="$state" INSTANCE="$svc" node -e '
      let wipe; try { wipe = JSON.parse(process.env.RESULT.trim().split("\n").at(-1)); } catch { wipe = { ok: false, error: "no result from the wipe", output: process.env.RESULT }; }
      console.log(JSON.stringify({ instance: process.env.INSTANCE, state: process.env.STATE, ...wipe }));'
    exit "$code"
    ;;
  port)
    proxy_port="$(sed -n 's/^MODEL_PROXY_HOST_PORT=//p' "$STATE_DIR/compose.env")"
    [ -n "$proxy_port" ] || {
      echo "this bring-up predates ctl.sh port; run up.sh again" >&2
      exit 1
    }
    port_var="ROME_$(echo "${svc#rome-}" | tr a-z A-Z)_PORT"
    exec node "$ENV_DIR/tools/port.mjs" "${3:-}" "${4:-}" \
      --instance "http://127.0.0.1:$(sed -n "s/^$port_var=//p" "$STATE_DIR/compose.env")" \
      --cookies "$STATE_DIR/$svc-cookies.json" --proxy "http://127.0.0.1:$proxy_port"
    ;;
  record)
    chat="$(node -e '
      try { const c = JSON.parse(process.argv[1] ?? "").chat; if (typeof c === "string") console.log(c); } catch {}' "${3:-}")"
    [[ "$chat" =~ ^[A-Z0-9]+(:[0-9]+\.[0-9]+)?$ ]] || {
      echo "usage: ctl.sh record rome-a|rome-b '{\"chat\":\"<conversation id>[:<thread ts>]\"}'" >&2
      exit 2
    }
    member="$(member_of "${chat%%:*}")"
    read_only chat-record.mjs --chat "$chat" ${member:+--member "$member"}
    ;;
  old-rows)
    # The connection ids old-connections wrote, from what it saved.
    ids="$(node -e '
      try {
        const w = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        console.log(JSON.stringify({ slack_bot: w.slack_bot?.connection_id ?? null, slack: w.slack?.connection_id ?? null }));
      } catch {}' "$STATE_DIR/$svc-old-connections.json")"
    [ -n "$ids" ] || {
      echo "{\"error\":\"no .state/$svc-old-connections.json: run ctl.sh old-connections $svc first\"}"
      exit 1
    }
    read_only old-rows.mjs --ids "$ids"
    ;;
  gateway-probe)
    grep -q '^SLACK_GATEWAY_PORT=' "$STATE_DIR/compose.env" && [ -n "$(compose ps -q slack-gateway)" ] || {
      echo '{"error":"the slack-gateway Worker is not running: bring the stack up with a rome-cloud commit that has gateway/wrangler.slack.jsonc"}'
      exit 1
    }
    # The guardian's workspace: rome-a's is the first in config/workspaces.json, rome-b's the second.
    read -r team user < <(node -e '
      const w = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).workspaces[process.argv[2] === "rome-a" ? 0 : 1];
      console.log(w.id, w.members.find((m) => m.is_owner).id);' "$ENV_DIR/config/workspaces.json" "$svc")
    cloud="$(sed -n 's/^CLOUD_ORIGIN=//p' "$STATE_DIR/compose.env")"
    slack_port="$(sed -n 's/^FAKE_SLACK_PORT=//p' "$STATE_DIR/compose.env")"
    probe=(--team "$team" --user "$user" --cloud "$cloud" --slack "http://127.0.0.1:$slack_port"
      --resolution "$(gateway_resolution)")
    as_instance "$ENV_DIR/tools/gateway-probe.mjs" -- "${probe[@]}"
    ;;
  as-instance)
    file="${3:-}"
    [ -f "$file" ] || {
      echo "usage: ctl.sh as-instance rome-a|rome-b <file.mjs> [args]..." >&2
      exit 2
    }
    as_instance "$(cd "$(dirname "$file")" && pwd)/$(basename "$file")" -- "${@:4}"
    ;;
  mailbox)
    as_instance "$ENV_DIR/tools/mailbox.mjs" --
    ;;
  find-secret)
    strings="${3:-}"
    node -e 'const s = JSON.parse(process.argv[1]); if (!Array.isArray(s) || !s.length || !s.every((x) => typeof x === "string" && x)) process.exit(1)' "$strings" 2>/dev/null || {
      echo "usage: ctl.sh find-secret rome-a|rome-b '[\"<string>\", ...]'" >&2
      exit 2
    }
    inside="$(read_only find-secret.mjs --strings "$strings")"
    # The logs are counted here, on the host, from what docker keeps.
    compose logs --no-color --no-log-prefix "$svc" 2>&1 | node -e '
      const strings = JSON.parse(process.argv[1]);
      const inside = JSON.parse(process.argv[2]);
      let logs = "";
      process.stdin.on("data", (c) => { logs += c; }).on("end", () => {
        const counts = strings.map((s) => logs.split(s).length - 1);
        if (counts.some((n) => n > 0)) inside.places.logs = counts;
        const total = strings.map((_, i) => Object.values(inside.places).reduce((n, c) => n + c[i], 0));
        console.log(JSON.stringify({ ...inside, total }));
      });' "$strings" "$inside"
    ;;
  distribution)
    # Off, only the app's home workspace can approve it, as on Slack.
    port="$(sed -n 's/^FAKE_SLACK_PORT=//p' "$STATE_DIR/compose.env")"
    # shellcheck disable=SC2016 # the backticks are JavaScript
    node -e '
      fetch(`http://127.0.0.1:${process.argv[1]}/_control/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ distributed: process.argv[2] === "on" }) })
        .then((r) => r.json()).then((c) => console.log(JSON.stringify({ distributed: c.distributed, home_team: c.home_team })), (e) => { console.error(String(e)); process.exit(1); });' "$port" "$svc"
    ;;
  product-tests)
    shift
    src="$STATE_DIR/rome-src"
    sha="$(git -C "$src" rev-parse HEAD)"
    result() { # <exit code> <runs json>
      printf '{"ok":%s,"commit":"%s","runs":[%s]%s}\n' "$([ "$1" -eq 0 ] && echo true || echo false)" "$sha" "$2" "${3:-}"
      exit "$1"
    }
    # Files of the commit, then files --add places beside them.
    tests=() added=() mounts=()
    while [ $# -gt 0 ]; do
      if [ "$1" = --add ]; then
        spec="${2:-}"
        host="${spec%%=*}" dest="${spec#*=}"
        [ -n "$spec" ] && [ "$host" != "$spec" ] && [ -n "$host" ] && [ -n "$dest" ] || {
          echo "usage: --add <host file>=<repo-relative path>" >&2
          exit 2
        }
        [ -f "$host" ] || result 2 "" ",\"error\":\"no such file: $host\""
        [[ "$dest" == /* || "$dest" == *..* ]] && result 2 "" ",\"error\":\"not a repo-relative path: $dest\""
        # Placed only where the commit has nothing, so no product file is replaced.
        git -C "$src" cat-file -e "HEAD:$dest" 2>/dev/null &&
          result 2 "" ",\"error\":\"already in the commit, so not added: $dest\""
        added+=("$dest")
        mounts+=(-v "$(cd "$(dirname "$host")" && pwd)/$(basename "$host"):/repo/$dest:ro")
        shift 2
        continue
      fi
      tests+=("$1")
      shift
    done
    [ $((${#tests[@]} + ${#added[@]})) -gt 0 ] || {
      echo "usage: ctl.sh product-tests [--add <host file>=<repo-relative path>]... [<repo-relative test file>]..." >&2
      exit 2
    }
    for f in "${tests[@]}"; do
      if [[ "$f" == /* || "$f" == *..* ]] || ! git -C "$src" cat-file -e "HEAD:$f" 2>/dev/null; then
        result 2 "" ",\"error\":\"not in the commit: $f\""
      fi
    done
    set -- "${tests[@]}" "${added[@]}"
    image="$IMAGE_PREFIX-rome-test:${sha:0:12}"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      echo "building $image from rome $sha (first time for this commit: several minutes)" >&2
      ctx="$(mktemp -d)"
      git -C "$src" archive HEAD | tar -x -C "$ctx"
      # rome's .dockerignore drops test files; test-runner/Dockerfile.dockerignore
      # replaces it, and the copy in the context goes too in case a builder
      # reads that one.
      rm -f "$ctx/.dockerignore"
      docker build -q -t "$image" --label "slackenv.rome_sha=$sha" -f "$ENV_DIR/test-runner/Dockerfile" "$ctx" >&2 ||
        {
          rm -rf "$ctx"
          result 1 "" ',"error":"the test image did not build"'
        }
      rm -rf "$ctx"
    fi
    # An image without the files cannot check them: 126, as for a runner that
    # cannot start.
    missing="$(docker run --rm --network none "${mounts[@]}" "$image" sh -c 'for f; do [ -f "/repo/$f" ] || echo "$f"; done' sh "$@")"
    if [ -n "$missing" ]; then
      result 126 "" ",\"error\":\"not in the test image $image: $(echo "$missing" | tr '\n' ' ' | sed 's/ $//')\""
    fi
    # Each file runs in the package whose rstest config takes it, the way that
    # package's own test script runs: rome_apps' tests run under packages/core.
    declare -A groups=()
    for f in "$@"; do
      d="$(dirname "$f")"
      pkg=""
      while [ "$d" != . ] && [ "$d" != / ]; do
        # An added file's folder may not be in the commit.
        if [ -d "$src/$d" ] && [ -n "$(find "$src/$d" -maxdepth 1 -name 'rstest.config.*' -print -quit)" ]; then
          pkg="$d"
          break
        fi
        d="$(dirname "$d")"
      done
      pkg="${pkg:-packages/core}"
      groups[$pkg]+="$f "
    done
    runs=""
    code=0
    for pkg in "${!groups[@]}"; do
      read -ra files <<<"${groups[$pkg]}"
      set +e
      # rstest keeps the test files that start with an absolute filter.
      docker run --rm --network none "${mounts[@]}" -w "/repo/$pkg" "$image" \
        pnpm exec /repo/scripts/test-env.sh rstest run "${files[@]/#//repo/}"
      c=$?
      set -e
      [ "$code" -eq 0 ] && code=$c
      list="$(printf '"%s",' "${files[@]}")"
      runs+="${runs:+,}{\"package\":\"$pkg\",\"files\":[${list%,}],\"exit_code\":$c}"
    done
    result "$code" "$runs"
    ;;
  cloud-query)
    # The query is wrapped as a subquery, so one SELECT (or WITH) is taken,
    # and it runs as slackenv_reader in a read-only transaction.
    sql="$(cat)"
    sql="${sql%"${sql##*[![:space:];]}"}" # without trailing semicolons and space
    [ -n "$sql" ] || {
      echo "usage: echo 'select …' | ctl.sh cloud-query" >&2
      exit 2
    }
    compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U pantheon -d pantheon >/dev/null <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'slackenv_reader') THEN
    CREATE ROLE slackenv_reader LOGIN;
  END IF;
END $$;
ALTER ROLE slackenv_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE pantheon TO slackenv_reader;
GRANT USAGE ON SCHEMA public TO slackenv_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO slackenv_reader;
SQL
    # Each -c goes to the server as it is. Piped in, the query would be a psql
    # script, whose backslash commands (\! runs a shell) psql runs itself.
    compose exec -T postgres psql -q -At -v ON_ERROR_STOP=1 -U slackenv_reader -d pantheon \
      -c 'BEGIN TRANSACTION READ ONLY' \
      -c "SELECT coalesce(jsonb_agg(q), jsonb_build_array()) FROM (
$sql
) q" \
      -c 'ROLLBACK' </dev/null
    ;;
esac
