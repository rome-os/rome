#!/usr/bin/env bash
# Controls a running environment.
#
#   environments/slack-app/ctl.sh stop|start|status rome-a|rome-b
#   environments/slack-app/ctl.sh wipe-chat rome-a|rome-b <Slack conversation id> [--text <text>]...
#   environments/slack-app/ctl.sh cloud-query        (SQL on stdin, JSON rows out)
#   environments/slack-app/ctl.sh distribution on|off   (the app's public distribution)
#   environments/slack-app/ctl.sh token-file rome-a|rome-b  (the connector's Slack token file)
#   environments/slack-app/ctl.sh old-connections rome-a|rome-b  (R10's slack_bot and slack)
#   environments/slack-app/ctl.sh product-tests <repo-relative test file>...  (R9)
#   environments/slack-app/ctl.sh logs <service>
#
# A stopped instance's address refuses connections; Rome Cloud, the relay and
# the fake Slack keep running, so events for it wait in its mailbox.
# wipe-chat stops the instance, wipes Rome's copy of the conversation
# (tools/wipe-chat.mjs) and starts it again if it was running. cloud-query runs
# one query on Rome Cloud's database as a role that can only read.
# old-connections writes the two older Slack connections an upgrade leaves
# (tools/old-connections.mjs) into the stopped instance and starts it again.
# product-tests runs test files of the rome commit under test, unchanged, in
# an image of that commit with its dependencies (test-runner/Dockerfile). Like
# every command here it needs a bring-up first: it reads .state/rome-src.
set -euo pipefail
ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$ENV_DIR/.state"
[ -f "$STATE_DIR/compose.env" ] || {
  echo "the environment is not running (no .state/compose.env); run up.sh first" >&2
  exit 1
}
compose() { docker compose --env-file "$STATE_DIR/compose.env" -f "$ENV_DIR/compose.yml" "$@"; }

action="${1:-}"
svc="${2:-}"
case "$action" in
  stop | start | status | wipe-chat | token-file | old-connections) case "$svc" in rome-a | rome-b) ;; *)
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
    echo "usage: ctl.sh logs <service>" >&2
    exit 2
  } ;;
  *)
    sed -n '2,22p' "$0"
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
    compose logs --no-color --tail 500 "$svc"
    ;;
  token-file)
    token_file
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
    result="$(node "$ENV_DIR/tools/old-connections.mjs" link "$instance" "$STATE_DIR/$svc-cookies.json" "$fake" \
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
    # The member whose direct message it is, from the fake Slack, so the chat
    # is found by its key as well as by its address.
    port="$(sed -n 's/^FAKE_SLACK_PORT=//p' "$STATE_DIR/compose.env")"
    # shellcheck disable=SC2016 # the backticks are JavaScript
    member="$(CONVERSATION="$conversation" node -e '
      fetch(`http://127.0.0.1:${process.argv[1]}/_control/state`).then((r) => r.json()).then((s) => {
        for (const w of s.workspaces)
          for (const m of w.members) if (m.im_channel === process.env.CONVERSATION) console.log(m.id);
      }, () => {});' "$port")"
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
    [ $# -gt 0 ] || {
      echo "usage: ctl.sh product-tests <repo-relative test file>..." >&2
      exit 2
    }
    src="$STATE_DIR/rome-src"
    sha="$(git -C "$src" rev-parse HEAD)"
    result() { # <exit code> <runs json>
      printf '{"ok":%s,"commit":"%s","runs":[%s]%s}\n' "$([ "$1" -eq 0 ] && echo true || echo false)" "$sha" "$2" "${3:-}"
      exit "$1"
    }
    for f in "$@"; do
      if [[ "$f" == /* || "$f" == *..* ]] || ! git -C "$src" cat-file -e "HEAD:$f" 2>/dev/null; then
        result 2 "" ",\"error\":\"not in the commit: $f\""
      fi
    done
    image="slackenv-rome-test:${sha:0:12}"
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
    missing="$(docker run --rm --network none "$image" sh -c 'for f; do [ -f "/repo/$f" ] || echo "$f"; done' sh "$@")"
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
        if [ -n "$(find "$src/$d" -maxdepth 1 -name 'rstest.config.*' -print -quit)" ]; then
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
      docker run --rm --network none -w "/repo/$pkg" "$image" \
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
