#!/usr/bin/env bash
# Start or reuse one named desktop: Xtigervnc, Openbox and a loopback websockify.
# Contract and invariants: docs/architecture/named-desktops.md.
#
# Usage: rome-start-desktop.sh <name> <display> <vnc-port> <novnc-port> [openbox-config]
#
# Idempotent: a process that already runs for this display and these ports is
# reused, and only a missing one is started. Each program starts in its own
# session, so it outlives this script and whoever ran it. Run it as the user the
# desktop belongs to. Exits 1, with the reason on stderr, when the display or a
# port belongs to something else or a program fails to start.
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo "Usage: $0 <name> <display> <vnc-port> <novnc-port> [openbox-config]" >&2
  exit 2
fi
NAME="$1"
DISPLAY_ID="$2"
VNC_PORT="$3"
NOVNC_PORT="$4"
OPENBOX_CONFIG="${5:-}"
if ! [[ "$NAME" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || ! [[ "$DISPLAY_ID" =~ ^:[0-9]+$ ]] ||
  ! [[ "$VNC_PORT" =~ ^[0-9]+$ ]] || ! [[ "$NOVNC_PORT" =~ ^[0-9]+$ ]]; then
  echo "Error: invalid desktop ${NAME} ${DISPLAY_ID} ${VNC_PORT} ${NOVNC_PORT}." >&2
  exit 2
fi
DISPLAY_NUM="${DISPLAY_ID#:}"

tcp_port_listening() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

# True when a process matching $1 has every later argument as one of its argv
# entries. The /proc files are read with grep -z and never piped: under
# pipefail, grep -q closing a pipe early would fail the writer and read as a miss.
process_cmdline_contains_all() {
  local pattern="$1" pid needle missing
  shift
  for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
    missing=""
    for needle in "$@"; do
      if ! grep -zqFx -- "$needle" "/proc/${pid}/cmdline" 2>/dev/null; then
        missing=1
        break
      fi
    done
    [ -z "$missing" ] && return 0
  done
  return 1
}

process_env_contains() {
  local pid
  for pid in $(pgrep -x "$1" 2>/dev/null || true); do
    if grep -zqFx -- "$2" "/proc/${pid}/environ" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

# True when pid $1 is a live X server (Xtigervnc, Xvfb, Xorg and the like).
# A lock survives a container restart, and its pid can then name any new
# process, so a live owner that is not an X server leaves the lock stale. So
# does an owner that has exited, or a zombie nobody reaped.
x_server_alive() {
  local state comm
  state="$(sed -E 's/^.*\) (.).*$/\1/' "/proc/$1/stat" 2>/dev/null || true)"
  comm="$(cat "/proc/$1/comm" 2>/dev/null || true)"
  [ -n "$state" ] && [ "$state" != "Z" ] && [ "$state" != "X" ] && [[ "$comm" == X* ]]
}

fail() {
  echo "Error: $1" >&2
  [ -n "${2:-}" ] && tail -n 50 "$2" >&2 2>/dev/null
  exit 1
}

wait_for_tcp_port() {
  local port="$1" label="$2" pid="$3" log_file="$4" tries=0
  while [ "$tries" -lt 30 ]; do
    tcp_port_listening "$port" && return 0
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      fail "${label} exited before listening on :${port}." "$log_file"
    fi
    tries=$((tries + 1))
    sleep 1
  done
  fail "${label} did not start listening on :${port} within 30 seconds." "$log_file"
}

X_LOG="/tmp/xtigervnc-${NAME}.log"
OPENBOX_LOG="/tmp/openbox-${NAME}.log"
NOVNC_LOG="/tmp/novnc-${NAME}.log"

X_PID=""
if process_cmdline_contains_all Xtigervnc "$DISPLAY_ID" -rfbport "$VNC_PORT"; then
  echo "Reusing TigerVNC for ${NAME} on ${DISPLAY_ID}."
else
  LOCK="/tmp/.X${DISPLAY_NUM}-lock"
  if [ -f "$LOCK" ]; then
    OWNER="$(tr -cd '0-9' <"$LOCK" 2>/dev/null || true)"
    if [ -n "$OWNER" ] && x_server_alive "$OWNER"; then
      fail "the existing X server on ${DISPLAY_ID} is not Rome's TigerVNC process."
    fi
    echo "Removing stale X lock ${LOCK}."
    rm -f "$LOCK"
  fi
  rm -f "/tmp/.X11-unix/X${DISPLAY_NUM}"
  if tcp_port_listening "$VNC_PORT"; then
    fail "TCP port ${VNC_PORT} is already in use by another process."
  fi
  echo "Starting TigerVNC for ${NAME} on ${DISPLAY_ID}, RFB :${VNC_PORT} ..."
  setsid Xtigervnc "$DISPLAY_ID" -geometry 1280x800 -depth 24 \
    -SecurityTypes None -localhost yes -rfbport "$VNC_PORT" \
    -AlwaysShared -AcceptCutText -SendCutText -ac >"$X_LOG" 2>&1 </dev/null &
  X_PID=$!
fi
wait_for_tcp_port "$VNC_PORT" "TigerVNC for ${NAME}" "$X_PID" "$X_LOG"

if ! process_env_contains openbox "DISPLAY=${DISPLAY_ID}"; then
  OPENBOX_ARGS=()
  [ -n "$OPENBOX_CONFIG" ] && OPENBOX_ARGS=(--config-file "$OPENBOX_CONFIG")
  DISPLAY="$DISPLAY_ID" setsid openbox "${OPENBOX_ARGS[@]}" >"$OPENBOX_LOG" 2>&1 </dev/null &
  OPENBOX_PID=$!
  # Openbox has no readiness signal. It exits at once when it cannot run.
  for _ in 1 2 3 4 5; do
    kill -0 "$OPENBOX_PID" 2>/dev/null || fail "Openbox for ${NAME} exited during startup." "$OPENBOX_LOG"
    sleep 1
  done
fi

# Loopback only: the guardian-gated /desktop-proxy/<name>/ mount is its one client.
NOVNC_PID=""
if ! process_cmdline_contains_all websockify "127.0.0.1:${NOVNC_PORT}" "localhost:${VNC_PORT}"; then
  if tcp_port_listening "$NOVNC_PORT"; then
    fail "TCP port ${NOVNC_PORT} is already in use by another process."
  fi
  setsid websockify "127.0.0.1:${NOVNC_PORT}" "localhost:${VNC_PORT}" >"$NOVNC_LOG" 2>&1 </dev/null &
  NOVNC_PID=$!
fi
wait_for_tcp_port "$NOVNC_PORT" "websockify for ${NAME}" "$NOVNC_PID" "$NOVNC_LOG"
