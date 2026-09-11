#!/usr/bin/env bash
set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
TIMEZONE="${TIMEZONE:-America/Los_Angeles}"
CHROME_LANG="${CHROME_LANG:-en-US}"
CHROME_USER_AGENT="${CHROME_USER_AGENT:-}"
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
READY_FILE="${READY_FILE:-}"
CDP_BASE="http://127.0.0.1:${CDP_PORT}"

info() { printf '[stealth] %s\n' "$*"; }
err() { printf '[stealth] %s\n' "$*" >&2; }

accept_lang="$(CHROME_LANG="$CHROME_LANG" python3 -c '
import os

lang = os.environ["CHROME_LANG"].strip()
parts = []
for candidate in (lang, lang.split("-", 1)[0] if "-" in lang else ""):
    candidate = candidate.strip()
    if candidate and candidate not in parts:
        parts.append(candidate)

if not parts:
    parts = ["en-US", "en"]

accept = parts[0]
if len(parts) > 1:
    accept = f"{accept},{parts[1]};q=0.9"

print(accept)
')"

stealth_languages="$(CHROME_LANG="$CHROME_LANG" python3 -c '
import json
import os

lang = os.environ["CHROME_LANG"].strip()
parts = []
for candidate in (lang, lang.split("-", 1)[0] if "-" in lang else ""):
    candidate = candidate.strip()
    if candidate and candidate not in parts:
        parts.append(candidate)

if not parts:
    parts = ["en-US", "en"]

print(json.dumps(parts))
')"

get_ua_architecture() {
  local source="${1:-$(uname -m 2>/dev/null || echo '')}"
  local normalized
  normalized="$(printf '%s' "$source" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    *aarch64* | *arm64* | *arm*) echo "arm" ;;
    *x86_64* | *amd64* | *i386* | *i486* | *i586* | *i686* | *x86* | *win64* | *wow64* | *x64* | *intel*) echo "x86" ;;
    *) echo "" ;;
  esac
}

get_host_architecture() {
  case "$(uname -m 2>/dev/null || echo '')" in
    x86_64 | amd64 | i386 | i486 | i586 | i686 | x86) echo "x86" ;;
    aarch64 | arm64 | arm | armv*) echo "arm" ;;
    *) echo "" ;;
  esac
}

get_geo_for_timezone() {
  case "$1" in
    America/New_York) echo '{"latitude":40.7128,"longitude":-74.0060,"accuracy":100}' ;;
    America/Chicago) echo '{"latitude":41.8781,"longitude":-87.6298,"accuracy":100}' ;;
    America/Denver) echo '{"latitude":39.7392,"longitude":-104.9903,"accuracy":100}' ;;
    America/Los_Angeles) echo '{"latitude":34.0522,"longitude":-118.2437,"accuracy":100}' ;;
    America/Phoenix) echo '{"latitude":33.4484,"longitude":-112.0740,"accuracy":100}' ;;
    America/Anchorage) echo '{"latitude":61.2181,"longitude":-149.9003,"accuracy":100}' ;;
    Pacific/Honolulu) echo '{"latitude":21.3069,"longitude":-157.8583,"accuracy":100}' ;;
    America/Toronto) echo '{"latitude":43.6532,"longitude":-79.3832,"accuracy":100}' ;;
    America/Vancouver) echo '{"latitude":49.2827,"longitude":-123.1207,"accuracy":100}' ;;
    Europe/London) echo '{"latitude":51.5074,"longitude":-0.1278,"accuracy":100}' ;;
    Europe/Paris) echo '{"latitude":48.8566,"longitude":2.3522,"accuracy":100}' ;;
    Europe/Berlin) echo '{"latitude":52.5200,"longitude":13.4050,"accuracy":100}' ;;
    Europe/Amsterdam) echo '{"latitude":52.3676,"longitude":4.9041,"accuracy":100}' ;;
    Asia/Tokyo) echo '{"latitude":35.6762,"longitude":139.6503,"accuracy":100}' ;;
    Asia/Shanghai) echo '{"latitude":31.2304,"longitude":121.4737,"accuracy":100}' ;;
    Asia/Seoul) echo '{"latitude":37.5665,"longitude":126.9780,"accuracy":100}' ;;
    Asia/Singapore) echo '{"latitude":1.3521,"longitude":103.8198,"accuracy":100}' ;;
    Australia/Sydney) echo '{"latitude":-33.8688,"longitude":151.2093,"accuracy":100}' ;;
    *) echo '{"latitude":40.7128,"longitude":-74.0060,"accuracy":100}' ;;
  esac
}

build_ua_metadata() {
  local chrome_ver
  local full_ver
  local platform
  local architecture
  local bitness

  chrome_ver="$(echo "$CHROME_USER_AGENT" | grep -oP 'Chrome/\K[0-9]+' || echo "133")"
  full_ver="$(echo "$CHROME_USER_AGENT" | grep -oP 'Chrome/\K[0-9.]+' || echo "133.0.0.0")"
  architecture="$(get_ua_architecture "$CHROME_USER_AGENT")"
  if [[ -z "$architecture" ]]; then
    architecture="$(get_host_architecture)"
  fi
  bitness="$(getconf LONG_BIT 2>/dev/null || echo "64")"

  if echo "$CHROME_USER_AGENT" | grep -q "Windows"; then
    platform="Windows"
  elif echo "$CHROME_USER_AGENT" | grep -q "Macintosh"; then
    platform="macOS"
  else
    platform="Linux"
  fi

  cat <<EOF
{
  "brands": [
    {"brand": "Google Chrome", "version": "$chrome_ver"},
    {"brand": "Chromium", "version": "$chrome_ver"},
    {"brand": "Not_A Brand", "version": "24"}
  ],
  "fullVersionList": [
    {"brand": "Google Chrome", "version": "$full_ver"},
    {"brand": "Chromium", "version": "$full_ver"},
    {"brand": "Not_A Brand", "version": "24.0.0.0"}
  ],
  "fullVersion": "$full_ver",
  "platform": "$platform",
  "platformVersion": "6.5.0",
  "architecture": "$architecture",
  "model": "",
  "mobile": false,
  "bitness": "$bitness",
  "wow64": false
}
EOF
}

if ! python3 -c "import websocket" >/dev/null 2>&1; then
  err "python3 websocket-client module is missing"
  exit 1
fi

browser_version_json="$(curl -sf "${CDP_BASE}/json/version")" || {
  err "cannot get browser WebSocket URL from ${CDP_BASE}/json/version"
  exit 1
}

browser_ws="$(printf '%s' "$browser_version_json" | python3 -c "import json, sys; print(json.load(sys.stdin)['webSocketDebuggerUrl'])")" || {
  err "cannot parse browser WebSocket URL from ${CDP_BASE}/json/version"
  exit 1
}

if [[ -z "$CHROME_USER_AGENT" ]]; then
  CHROME_USER_AGENT="$(printf '%s' "$browser_version_json" | python3 -c "import json, sys; print(json.load(sys.stdin).get('User-Agent', ''))")"
  if [[ -z "$CHROME_USER_AGENT" ]]; then
    err "cannot determine browser user agent from ${CDP_BASE}/json/version"
    exit 1
  fi
fi

stealth_js_file="${SCRIPT_DIR}/stealth-inject.js"
if [[ ! -f "$stealth_js_file" ]]; then
  err "stealth injector not found at ${stealth_js_file}"
  exit 1
fi

geo_params="$(get_geo_for_timezone "$TIMEZONE")"
ua_metadata="$(build_ua_metadata)"
BROWSER_WS="$browser_ws" \
  STEALTH_JS_FILE="$stealth_js_file" \
  READY_FILE="$READY_FILE" \
  TIMEZONE="$TIMEZONE" \
  CHROME_LANG="$CHROME_LANG" \
  CHROME_USER_AGENT="$CHROME_USER_AGENT" \
  ACCEPT_LANG="$accept_lang" \
  STEALTH_LANGUAGES="$stealth_languages" \
  UA_METADATA="$ua_metadata" \
  GEO_PARAMS="$geo_params" \
  python3 <<'PY'
import json
import os
import sys

import websocket


def log(message: str) -> None:
    print(f"[stealth] {message}", flush=True)


def fail(message: str) -> None:
    print(f"[stealth] {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


browser_ws = os.environ["BROWSER_WS"]
stealth_js_file = os.environ["STEALTH_JS_FILE"]
ready_file = os.environ.get("READY_FILE", "")
timezone = os.environ["TIMEZONE"]
chrome_lang = os.environ["CHROME_LANG"]
chrome_user_agent = os.environ["CHROME_USER_AGENT"]
accept_lang = os.environ["ACCEPT_LANG"]
stealth_languages = json.loads(os.environ["STEALTH_LANGUAGES"])
ua_metadata = json.loads(os.environ["UA_METADATA"])
geo_params = json.loads(os.environ["GEO_PARAMS"])

with open(stealth_js_file, "r", encoding="utf-8") as handle:
    stealth_js = handle.read()

if stealth_languages:
    stealth_js = (
        f"globalThis.__ROME_STEALTH_LANGUAGES__ = {json.dumps(stealth_languages)};\n"
        f"{stealth_js}"
    )

ws = websocket.create_connection(browser_ws, timeout=5)
msg_id = 0
pending_responses: dict[int, dict] = {}


def send(method: str, params: dict | None = None, session_id: str | None = None) -> dict:
    global msg_id
    msg_id += 1
    payload = {"id": msg_id, "method": method, "params": params or {}}
    if session_id is not None:
        payload["sessionId"] = session_id
    ws.send(json.dumps(payload))
    return recv_until_response(msg_id)


def recv_until_response(expected_id: int) -> dict:
    while True:
        buffered = pending_responses.pop(expected_id, None)
        if buffered is not None:
            if "error" in buffered:
                raise RuntimeError(buffered["error"].get("message", "CDP error"))
            return buffered

        raw = ws.recv()
        if not raw:
            fail("browser CDP connection closed")
        message = json.loads(raw)
        if message.get("id") == expected_id:
            if "error" in message:
                raise RuntimeError(message["error"].get("message", "CDP error"))
            return message
        if "id" in message:
            pending_responses[message["id"]] = message
            continue
        handle_event(message)


def set_ready() -> None:
    if not ready_file:
        return
    with open(ready_file, "w", encoding="utf-8") as handle:
        handle.write("ready\n")


def build_ua_override() -> dict:
    return {
        "userAgent": chrome_user_agent,
        "acceptLanguage": accept_lang,
        "platform": ua_metadata["platform"],
        "userAgentMetadata": ua_metadata,
    }


def auto_attach(session_id: str | None = None) -> None:
    send(
        "Target.setAutoAttach",
        {
            "autoAttach": True,
            "waitForDebuggerOnStart": True,
            "flatten": True,
        },
        session_id,
    )


def configure_target(session_id: str, target_info: dict, waiting_for_debugger: bool) -> None:
    target_type = target_info.get("type", "")
    target_id = target_info.get("targetId", "")

    try:
        if target_type in {"page", "iframe"}:
            # Auto-attach follows one level. Watch each document's children before resuming it.
            auto_attach(session_id)
        if target_type == "page":
            send("Emulation.setGeolocationOverride", geo_params, session_id)
            send("Emulation.setTimezoneOverride", {"timezoneId": timezone}, session_id)
            send("Emulation.setLocaleOverride", {"locale": chrome_lang}, session_id)
            send(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": 1280,
                    "height": 800,
                    "deviceScaleFactor": 1,
                    "mobile": False,
                    "screenWidth": 1280,
                    "screenHeight": 800,
                },
                session_id,
            )
            send("Network.enable", {}, session_id)
            send("Network.setUserAgentOverride", build_ua_override(), session_id)
        if target_type in {"page", "iframe"}:
            send("Page.addScriptToEvaluateOnNewDocument", {"source": stealth_js}, session_id)
            # Enable the Page agent so registered scripts also run in OOPIF documents.
            send("Page.enable", {}, session_id)
            log(f"stealth configured for {target_type} {target_id}")
    except Exception as exc:
        log(f"stealth injection failed on {target_type or 'target'} {target_id}: {exc}")
    finally:
        if waiting_for_debugger:
            try:
                send("Runtime.runIfWaitingForDebugger", {}, session_id)
            except Exception as exc:
                log(f"failed to resume target {target_id}: {exc}")


def handle_event(message: dict) -> None:
    if message.get("method") != "Target.attachedToTarget":
        return
    params = message.get("params", {})
    configure_target(
        params["sessionId"],
        params.get("targetInfo", {}),
        bool(params.get("waitingForDebugger")),
    )


try:
    auto_attach()

    targets = send("Target.getTargets", {}).get("result", {}).get("targetInfos", [])
    if not any(target.get("type") == "page" for target in targets):
        send("Target.createTarget", {"url": "about:blank"})

    set_ready()
    log("browser-level stealth guard active")

    while True:
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            # Quiet browsers may emit no events. Command-response waits still time out.
            continue
        if not raw:
            fail("browser CDP connection closed")
        handle_event(json.loads(raw))
except KeyboardInterrupt:
    pass
finally:
    try:
        ws.close()
    except Exception:
        pass
PY
