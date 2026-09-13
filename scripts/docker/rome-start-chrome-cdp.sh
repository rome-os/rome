#!/usr/bin/env bash
set -euo pipefail

CDP_PORT="${ROME_CHROME_CDP_PORT:-9222}"
CHROME_INTERNAL_PORT="${ROME_CHROME_INTERNAL_CDP_PORT:-9223}"
BIND_ADDRESS="${ROME_CHROME_BIND_ADDRESS:-0.0.0.0}"
STARTUP_WAIT="${ROME_CHROME_STARTUP_WAIT:-20}"
KEEP_ALIVE="${ROME_CHROME_KEEP_ALIVE:-1}"
RESTART_DELAY="${ROME_CHROME_RESTART_DELAY:-2}"
CHROME_USER_DATA_DIR="${ROME_CHROME_USER_DATA_DIR:-$HOME/.rome/chrome-profile}"
# Keep Chrome's HTTP/media disk cache OFF the persistent chrome-profile volume
# (which mounts $HOME/.rome): the cache is regenerable and, left in the profile,
# grows to tens of GB and fills the host disk. Default to an ephemeral path on
# the container's writable layer (wiped on recreate) and hard-cap its size.
# Persistent cookies and localStorage stay in CHROME_USER_DATA_DIR.
CHROME_DISK_CACHE_DIR="${ROME_CHROME_DISK_CACHE_DIR:-$HOME/chrome-cache}"
CHROME_DISK_CACHE_SIZE="${ROME_CHROME_DISK_CACHE_SIZE:-536870912}"
CHROME_WINDOW_SIZE="${ROME_CHROME_WINDOW_SIZE:-1280,800}"
CHROME_URL="${ROME_CHROME_URL:-about:blank}"
TIMEZONE="${ROME_CHROME_TIMEZONE:-America/Los_Angeles}"
CHROME_LANG="${ROME_CHROME_LANG:-en-US}"
CHROME_FULLSCREEN="${ROME_CHROME_FULLSCREEN:-0}"
PROXY_URL="${ROME_CHROME_PROXY_URL:-}"
ENABLE_STEALTH="${ROME_CHROME_ENABLE_STEALTH:-1}"
DISABLE_SANDBOX="${ROME_CHROME_DISABLE_SANDBOX:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BROWSER_BINARY="${ROME_CHROME_BINARY:-}"
CHROMIUM_DIRECT_BINARY="${ROME_CHROME_DIRECT_BINARY:-/usr/lib/chromium/chromium}"

info() { printf '[chrome] %s\n' "$*"; }
err() { printf '[chrome] %s\n' "$*" >&2; }

strip_ipv6_brackets() {
  local host="$1"
  host="${host#[}"
  host="${host%]}"
  printf '%s' "$host"
}

format_url_host() {
  local host
  host="$(strip_ipv6_brackets "$1")"
  if [[ "$host" == *:* ]]; then
    printf '[%s]' "$host"
    return
  fi
  printf '%s' "$host"
}

get_proxy_probe_address() {
  local bind_address
  bind_address="$(strip_ipv6_brackets "$1")"
  case "$bind_address" in
    "" | "0.0.0.0")
      printf '127.0.0.1'
      ;;
    "::")
      printf '::1'
      ;;
    *)
      printf '%s' "$bind_address"
      ;;
  esac
}

if [[ -z "$BROWSER_BINARY" ]]; then
  if command -v google-chrome-stable >/dev/null 2>&1; then
    BROWSER_BINARY="$(command -v google-chrome-stable)"
  elif command -v chromium >/dev/null 2>&1; then
    BROWSER_BINARY="$(command -v chromium)"
  else
    err "no supported browser binary found (expected google-chrome-stable or chromium)"
    exit 1
  fi
fi

if [[ "$(basename "$BROWSER_BINARY")" == "chromium" && -x "$CHROMIUM_DIRECT_BINARY" ]]; then
  # Debian's /usr/bin/chromium wrapper sources /etc/chromium.d/apikeys, which
  # sets Google OAuth client credentials and can trigger restricted Chromium
  # profile sign-in when logging into Google web properties.
  BROWSER_BINARY="$CHROMIUM_DIRECT_BINARY"
fi

unset GOOGLE_API_KEY GOOGLE_DEFAULT_CLIENT_ID GOOGLE_DEFAULT_CLIENT_SECRET

CHROME_USER_AGENT="${ROME_CHROME_USER_AGENT:-}"
PROXY_PROBE_ADDRESS="$(get_proxy_probe_address "$BIND_ADDRESS")"
PROXY_PROBE_HOST="$(format_url_host "$PROXY_PROBE_ADDRESS")"

CHROME_PID=""
SOCAT_PID=""
STEALTH_PID=""
TERMINATING="0"

cleanup() {
  TERMINATING="1"
  if [[ -n "$STEALTH_PID" ]]; then
    kill "$STEALTH_PID" 2>/dev/null || true
    wait "$STEALTH_PID" 2>/dev/null || true
    STEALTH_PID=""
  fi
  if [[ -n "$CHROME_PID" ]]; then
    kill "$CHROME_PID" 2>/dev/null || true
    wait "$CHROME_PID" 2>/dev/null || true
    CHROME_PID=""
  fi
  if [[ -n "$SOCAT_PID" ]]; then
    kill "$SOCAT_PID" 2>/dev/null || true
    wait "$SOCAT_PID" 2>/dev/null || true
    SOCAT_PID=""
  fi
}
shutdown() {
  cleanup
  exit 0
}
trap cleanup EXIT
trap shutdown INT TERM

export DISPLAY="${DISPLAY:-:99}"
export TZ="$TIMEZONE"
export HOME="${HOME:-/home/rome}"

chrome_args=(
  --disable-dev-shm-usage
  --use-gl=angle
  --use-angle=swiftshader-webgl
  --enable-unsafe-swiftshader
  --no-first-run
  --no-default-browser-check
  --password-store=basic
  # A persistent profile alone does not restore session cookies after a clean exit.
  --restore-last-session
  "--user-data-dir=$CHROME_USER_DATA_DIR"
  "--disk-cache-dir=$CHROME_DISK_CACHE_DIR"
  "--disk-cache-size=$CHROME_DISK_CACHE_SIZE"
  "--media-cache-size=$CHROME_DISK_CACHE_SIZE"
  "--window-size=$CHROME_WINDOW_SIZE"
  "--window-position=0,0"
  "--remote-debugging-port=$CHROME_INTERNAL_PORT"
  --remote-debugging-address=127.0.0.1
  "--lang=$CHROME_LANG"
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp
  --enforce-webrtc-ip-permission-check
  --remote-allow-origins=*
)
if [[ -n "$CHROME_USER_AGENT" ]]; then
  chrome_args+=("--user-agent=$CHROME_USER_AGENT")
fi
if [[ "$DISABLE_SANDBOX" != "0" ]]; then
  chrome_args+=(--no-sandbox)
fi
if [[ "$CHROME_FULLSCREEN" != "0" ]]; then
  chrome_args+=(
    --start-fullscreen
    --kiosk
  )
fi
if [[ -n "$PROXY_URL" ]]; then
  chrome_args+=("--proxy-server=$PROXY_URL")
fi

max_attempts=$((STARTUP_WAIT * 5))

cleanup_browser_instance() {
  if [[ -n "$STEALTH_PID" ]]; then
    kill "$STEALTH_PID" 2>/dev/null || true
    wait "$STEALTH_PID" 2>/dev/null || true
    STEALTH_PID=""
  fi
  if [[ -n "$CHROME_PID" ]]; then
    kill "$CHROME_PID" 2>/dev/null || true
    wait "$CHROME_PID" 2>/dev/null || true
    CHROME_PID=""
  fi
}

cleanup_cdp_proxy() {
  if [[ -n "$SOCAT_PID" ]]; then
    kill "$SOCAT_PID" 2>/dev/null || true
    wait "$SOCAT_PID" 2>/dev/null || true
    SOCAT_PID=""
  fi
}

ensure_cdp_proxy() {
  if [[ -n "$SOCAT_PID" ]] && kill -0 "$SOCAT_PID" 2>/dev/null; then
    return 0
  fi

  info "forwarding ${BIND_ADDRESS}:${CDP_PORT} to 127.0.0.1:${CHROME_INTERNAL_PORT}"
  socat TCP-LISTEN:"${CDP_PORT}",bind="${BIND_ADDRESS}",reuseaddr,fork TCP:127.0.0.1:"${CHROME_INTERNAL_PORT}" >/tmp/chrome-cdp-proxy.log 2>&1 &
  SOCAT_PID=$!
}

wait_for_internal_cdp() {
  local attempt=0
  while ((attempt < max_attempts)); do
    if curl -sf "http://127.0.0.1:${CHROME_INTERNAL_PORT}/json/version" >/dev/null; then
      return 0
    fi
    if [[ -n "$CHROME_PID" ]] && ! kill -0 "$CHROME_PID" 2>/dev/null; then
      err "Chrome exited before CDP became available; see /tmp/chrome-ui.log"
      return 1
    fi
    sleep 0.2
    attempt=$((attempt + 1))
  done

  err "CDP did not become available on 127.0.0.1:${CHROME_INTERNAL_PORT}"
  return 1
}

wait_for_external_cdp() {
  local attempt=0
  while ((attempt < max_attempts)); do
    if curl -sf "http://${PROXY_PROBE_HOST}:${CDP_PORT}/json/version" >/dev/null; then
      return 0
    fi
    if [[ -n "$SOCAT_PID" ]] && ! kill -0 "$SOCAT_PID" 2>/dev/null; then
      err "CDP proxy exited unexpectedly; see /tmp/chrome-cdp-proxy.log"
      return 1
    fi
    sleep 0.2
    attempt=$((attempt + 1))
  done

  err "external CDP port ${PROXY_PROBE_ADDRESS}:${CDP_PORT} did not become reachable"
  return 1
}

start_stealth_guard() {
  if [[ "$ENABLE_STEALTH" == "0" ]]; then
    return 0
  fi

  info "starting CDP stealth guard"
  local stealth_ready_dir stealth_ready_file stealth_script
  stealth_ready_dir="$(mktemp -d)"
  stealth_ready_file="$stealth_ready_dir/ready"
  stealth_script="$SCRIPT_DIR/rome-apply-cdp-stealth.sh"
  CDP_PORT="$CHROME_INTERNAL_PORT" \
    READY_FILE="$stealth_ready_file" \
    TIMEZONE="$TIMEZONE" \
    CHROME_LANG="$CHROME_LANG" \
    CHROME_USER_AGENT="$CHROME_USER_AGENT" \
    SCRIPT_DIR="$SCRIPT_DIR" \
    "$stealth_script" >/tmp/chrome-stealth.log 2>&1 &
  STEALTH_PID=$!

  local attempt=0
  while ((attempt < max_attempts)); do
    if [[ -f "$stealth_ready_file" ]]; then
      rm -rf "$stealth_ready_dir"
      return 0
    fi
    if ! kill -0 "$STEALTH_PID" 2>/dev/null; then
      err "CDP stealth guard exited unexpectedly; see /tmp/chrome-stealth.log"
      rm -rf "$stealth_ready_dir"
      return 1
    fi
    sleep 0.2
    attempt=$((attempt + 1))
  done

  err "CDP stealth guard did not become ready; see /tmp/chrome-stealth.log"
  rm -rf "$stealth_ready_dir"
  return 1
}

start_chrome_instance() {
  mkdir -p "$CHROME_USER_DATA_DIR"
  rm -f \
    "$CHROME_USER_DATA_DIR/SingletonCookie" \
    "$CHROME_USER_DATA_DIR/SingletonLock" \
    "$CHROME_USER_DATA_DIR/SingletonSocket"

  info "starting Google Chrome on display ${DISPLAY} with CDP ${BIND_ADDRESS}:${CDP_PORT}"
  "$BROWSER_BINARY" "${chrome_args[@]}" "$CHROME_URL" >/tmp/chrome-ui.log 2>&1 &
  CHROME_PID=$!

  wait_for_internal_cdp || return 1

  if [[ -z "$CHROME_USER_AGENT" ]]; then
    CHROME_USER_AGENT="$(curl -sf "http://127.0.0.1:${CHROME_INTERNAL_PORT}/json/version" | python3 -c "import json, sys; print(json.load(sys.stdin).get('User-Agent', ''))")"
    if [[ -z "$CHROME_USER_AGENT" ]]; then
      err "could not determine browser user agent from CDP"
      return 1
    fi
  fi

  ensure_cdp_proxy
  wait_for_external_cdp || return 1
  start_stealth_guard || return 1

  curl -sf "http://${PROXY_PROBE_HOST}:${CDP_PORT}/json/version" || true
}

while [[ "$TERMINATING" != "1" ]]; do
  if ! start_chrome_instance; then
    cleanup_browser_instance
    cleanup_cdp_proxy
    if [[ "$KEEP_ALIVE" == "0" ]]; then
      exit 1
    fi
    info "Chrome startup failed; retrying in ${RESTART_DELAY}s"
    sleep "$RESTART_DELAY"
    continue
  fi

  if wait "$CHROME_PID"; then
    chrome_status=0
  else
    chrome_status=$?
  fi
  CHROME_PID=""
  cleanup_browser_instance

  if [[ "$KEEP_ALIVE" == "0" ]]; then
    exit "$chrome_status"
  fi

  info "Chrome exited with status ${chrome_status}; restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY"
done
