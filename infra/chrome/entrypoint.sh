#!/usr/bin/env bash
# Entrypoint for the dev-only Chrome sidecar (compose.dev.yml `chrome`
# service). Boots the virtual desktop stack, then hands PID over to the
# shared Chrome/CDP supervisor (bind-mounted from scripts/docker/), which
# keep-alives Chrome and socat-forwards CDP to $ROME_CHROME_BIND_ADDRESS:9222
# (127.0.0.1 — the network namespace is shared with the rome container).
#
# Unlike the production docker-entrypoint.sh there is no reuse / port-conflict
# logic here: the container is always created fresh by compose
# (`up --force-recreate` in dev-up.sh), so a plain sequential boot suffices.
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
DISPLAY_NUM="${DISPLAY#:}"
SCREEN_SIZE="${ROME_SCREEN_SIZE:-1280x800x24}"
if [[ "$SCREEN_SIZE" =~ ^([0-9]+x[0-9]+)(x([0-9]+))?$ ]]; then
  SCREEN_GEOMETRY="${BASH_REMATCH[1]}"
  SCREEN_DEPTH="${BASH_REMATCH[3]:-24}"
else
  echo "Error: ROME_SCREEN_SIZE must use WIDTHxHEIGHT or WIDTHxHEIGHTxDEPTH." >&2
  exit 1
fi
VNC_PORT="${ROME_VNC_PORT:-5900}"
NOVNC_PORT="${ROME_NOVNC_PORT:-6080}"

echo "Starting TigerVNC on ${DISPLAY}, RFB :${VNC_PORT} ..."
Xtigervnc "$DISPLAY" \
  -geometry "$SCREEN_GEOMETRY" \
  -depth "$SCREEN_DEPTH" \
  -SecurityTypes None \
  -localhost yes \
  -rfbport "$VNC_PORT" \
  -AlwaysShared \
  -AcceptCutText \
  -SendCutText \
  -ac >/tmp/xtigervnc.log 2>&1 &
tigervnc_pid=$!

retries=0
while [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
  if ! kill -0 "$tigervnc_pid" 2>/dev/null; then
    echo "Error: TigerVNC exited before creating display ${DISPLAY}." >&2
    tail -n 50 /tmp/xtigervnc.log >&2 || true
    exit 1
  fi
  retries=$((retries + 1))
  if [ "$retries" -gt 60 ]; then
    echo "Error: TigerVNC did not create display ${DISPLAY} within 30 seconds." >&2
    tail -n 50 /tmp/xtigervnc.log >&2 || true
    exit 1
  fi
  sleep 0.5
done

echo "Starting Openbox ..."
openbox >/tmp/openbox.log 2>&1 &

echo "Starting noVNC on :${NOVNC_PORT} ..."
websockify --web=/usr/share/novnc/ "$NOVNC_PORT" "localhost:${VNC_PORT}" >/tmp/novnc.log 2>&1 &

# The supervisor's own traps handle Chrome/socat/stealth teardown; the X
# stack above dies with the container.
exec /opt/rome/scripts/docker/rome-start-chrome-cdp.sh
