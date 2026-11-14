#!/usr/bin/env bash
# Starts or stops the provider try page as a user service, mounted on the
# tailnet at https://<devbox>.ts.net/voice-try.
#
#   environments/voice-input/try/run.sh start|stop|status
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${VOICE_TRY_PORT:-4790}"
UNIT=voice-try
PATH="$PATH:/run/current-system/sw/bin"

case "${1:-}" in
  start)
    systemctl --user stop "$UNIT" 2>/dev/null || true
    systemd-run --user --unit "$UNIT" --collect --setenv=PATH="$PATH" \
      "$(command -v node)" "$DIR/server.mjs" --port "$PORT" >/dev/null
    tailscale serve --bg --set-path /voice-try "$PORT" >/dev/null
    echo "https://$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')/voice-try"
    ;;
  stop)
    tailscale serve --https=443 --set-path /voice-try off >/dev/null 2>&1 || true
    systemctl --user stop "$UNIT" 2>/dev/null || true
    ;;
  status) systemctl --user status "$UNIT" --no-pager ;;
  *) echo "usage: run.sh start|stop|status" >&2 && exit 1 ;;
esac
