#!/usr/bin/env bash
# Stops, starts or reports one instance of a running environment.
#
#   environments/slack-app/ctl.sh stop|start|status rome-a|rome-b
#   environments/slack-app/ctl.sh logs <service>
#
# A stopped instance's address refuses connections; Rome Cloud, the relay and
# the fake Slack keep running, so events for it wait in its mailbox.
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
  stop | start | status) case "$svc" in rome-a | rome-b) ;; *)
    echo "instance must be rome-a or rome-b" >&2
    exit 2
    ;;
  esac ;;
  logs) [ -n "$svc" ] || {
    echo "usage: ctl.sh logs <service>" >&2
    exit 2
  } ;;
  *)
    sed -n '2,8p' "$0"
    exit 2
    ;;
esac

healthy() { compose exec -T "$svc" node -e 'fetch("http://127.0.0.1:9368/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' >/dev/null 2>&1; }

case "$action" in
  stop)
    compose stop -t 30 "$svc" >/dev/null
    echo "{\"instance\":\"$svc\",\"state\":\"stopped\",\"at\":\"$(date -u +%FT%TZ)\"}"
    ;;
  start)
    compose start "$svc" >/dev/null
    for _ in $(seq 1 300); do
      healthy && break
      sleep 1
    done
    healthy || {
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
esac
