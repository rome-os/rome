#!/usr/bin/env bash
# Controls a running environment.
#
#   environments/slack-app/ctl.sh stop|start|status rome-a|rome-b
#   environments/slack-app/ctl.sh wipe-chat rome-a|rome-b <Slack conversation id> [--text <text>]...
#   environments/slack-app/ctl.sh cloud-query        (SQL on stdin, JSON rows out)
#   environments/slack-app/ctl.sh logs <service>
#
# A stopped instance's address refuses connections; Rome Cloud, the relay and
# the fake Slack keep running, so events for it wait in its mailbox.
# wipe-chat stops the instance, wipes Rome's copy of the conversation
# (tools/wipe-chat.mjs) and starts it again if it was running. cloud-query runs
# one query on Rome Cloud's database as a role that can only read.
set -euo pipefail
ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$ENV_DIR/.state"
[ -f "$STATE_DIR/compose.env" ] || {
  echo "the environment is not running (no .state/compose.env)" >&2
  exit 1
}
compose() { docker compose --env-file "$STATE_DIR/compose.env" -f "$ENV_DIR/compose.yml" "$@"; }

action="${1:-}"
svc="${2:-}"
case "$action" in
  stop | start | status | wipe-chat) case "$svc" in rome-a | rome-b) ;; *)
    echo "instance must be rome-a or rome-b" >&2
    exit 2
    ;;
  esac ;;
  cloud-query) ;;
  logs) [ -n "$svc" ] || {
    echo "usage: ctl.sh logs <service>" >&2
    exit 2
  } ;;
  *)
    sed -n '2,13p' "$0"
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
