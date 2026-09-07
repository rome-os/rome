#!/bin/bash
set -e

retry_command() {
  local attempts="$1"
  local delay_seconds="$2"
  local description="$3"
  shift 3

  local attempt=1
  while true; do
    if "$@"; then
      if [ "$attempt" -gt 1 ]; then
        echo "${description} succeeded on attempt ${attempt}."
      fi
      return 0
    fi

    if [ "$attempt" -ge "$attempts" ]; then
      echo "Warning: ${description} failed after ${attempts} attempts."
      return 1
    fi

    echo "${description} failed (attempt ${attempt}/${attempts}), retrying in ${delay_seconds}s ..."
    attempt=$((attempt + 1))
    sleep "$delay_seconds"
  done
}

tailscale_backend_state() {
  local status_json
  status_json="$(tailscale status --json 2>/dev/null)" || return 1
  printf '%s' "$status_json" | node -e "
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (typeof parsed.BackendState !== 'string') process.exit(1);
        process.stdout.write(parsed.BackendState);
      } catch {
        process.exit(1);
      }
    });
  " 2>/dev/null
}

tailscale_status_ready() {
  tailscale_backend_state >/dev/null 2>&1
}

tailscale_backend_running() {
  [ "$(tailscale_backend_state 2>/dev/null)" = "Running" ]
}

enable_tailscale_https_serve() {
  tailscale serve --bg --https=443 "http://localhost:${INTERNAL_API_PORT:-4141}"
}

# =============================================================================
# Rome — Docker entrypoint (usually runs as root, drops privileges via gosu)
# =============================================================================

ROME_DOCKER_USER_MODE="${ROME_DOCKER_USER_MODE:-multi}"
ROME_SINGLE_UID_MODE=0
if [ "$ROME_DOCKER_USER_MODE" = "root" ] || ! gosu rome true >/dev/null 2>&1; then
  ROME_SINGLE_UID_MODE=1
  if [ "$ROME_DOCKER_USER_MODE" != "root" ]; then
    echo "Using single-UID Docker mode: gosu cannot switch users in this container."
  fi
fi

safe_chown() {
  if [ "$ROME_SINGLE_UID_MODE" = "1" ]; then
    return 0
  fi
  chown "$@"
}

run_as_account() {
  local username="$1"
  local home_dir="$2"
  shift 2

  if [ "$ROME_SINGLE_UID_MODE" = "1" ]; then
    HOME="$home_dir" USER="$username" LOGNAME="$username" "$@"
    return
  fi

  gosu "$username" env HOME="$home_dir" USER="$username" LOGNAME="$username" "$@"
}

run_as_rome() {
  run_as_account rome /home/rome "$@"
}

run_as_user() {
  run_as_account user /home/user "$@"
}

# ─── Ensure home directories exist (bind-mounted /home may be empty) ────────
for dir_user_pair in "rome:rome" "user:user"; do
  u="${dir_user_pair%%:*}"
  g="${dir_user_pair##*:}"
  mkdir -p "/home/$u"
  safe_chown "$u:$g" "/home/$u"
  chmod 750 "/home/$u"
done
# The rome daemon runs in the shared "user" group and needs to create
# /home/user/* mount aliases such as /home/user/mount at runtime.
chmod 2775 /home/user

# Ensure Rome home contents survive named-volume reuse with the right owner.
mkdir -p /home/rome/.rome
safe_chown -R rome:rome /home/rome
chmod 750 /home/rome /home/rome/.rome

# Prepare shared sshfs mount roots before creating user dirs.
mkdir -p /var/lib/rome-hostfs/targets/home/user
safe_chown -R rome:user /var/lib/rome-hostfs
chmod 2750 /var/lib/rome-hostfs /var/lib/rome-hostfs/targets
chmod 2750 /var/lib/rome-hostfs/targets/home /var/lib/rome-hostfs/targets/home/user

mkdir -p /home/user/projects/default /home/user/mounts /home/user/mount-roots
safe_chown rome:user /home/user/projects /home/user/projects/default /home/user/mounts /home/user/mount-roots
chmod 775 /home/user/projects /home/user/projects/default /home/user/mounts /home/user/mount-roots

# Shared runtime directory for shell integrations that need to be visible to
# both the rome service user and the interactive shell user.
mkdir -p /run/rome
safe_chown rome:user /run/rome
chmod 2770 /run/rome

# ─── Generate SSH host keys if missing ──────────────────────────────────────
if [ ! -f /etc/ssh/ssh_host_keys/ssh_host_rsa_key ]; then
  echo "Generating SSH host keys ..."
  ssh-keygen -t rsa -b 4096 -f /etc/ssh/ssh_host_keys/ssh_host_rsa_key -N ""
  ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_keys/ssh_host_ed25519_key -N ""
fi

# ─── Set user password if provided ──────────────────────────────────────────
if [ -n "$SSH_USER_PASSWORD" ]; then
  echo "user:$SSH_USER_PASSWORD" | chpasswd
  unset SSH_USER_PASSWORD
fi

cleanup_stale_x11_state() {
  local display_num="$1"
  local lock_file="/tmp/.X${display_num}-lock"
  local socket_file="/tmp/.X11-unix/X${display_num}"
  local owner_pid=""

  if [ -f "$lock_file" ]; then
    owner_pid="$(tr -cd '0-9' <"$lock_file" 2>/dev/null || true)"
    if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
      REUSED_X_SERVER="1"
      echo "Reusing existing X server on :${display_num} (pid ${owner_pid})."
      return 0
    fi

    echo "Removing stale X lock ${lock_file}."
    rm -f "$lock_file"
  fi

  if [ -S "$socket_file" ]; then
    echo "Removing stale X socket ${socket_file}."
    rm -f "$socket_file"
  fi
}

tcp_port_listening() {
  local port="$1"
  (
    exec 3<>"/dev/tcp/127.0.0.1/${port}"
  ) >/dev/null 2>&1
}

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

chrome_cdp_probe_host() {
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

chrome_cdp_ready() {
  local bind_address="$1"
  local port="$2"
  local probe_host=""

  probe_host="$(chrome_cdp_probe_host "$bind_address")"
  curl -sf --max-time 1 "http://$(format_url_host "$probe_host"):${port}/json/version" >/dev/null 2>&1
}

process_env_contains() {
  local process_name="$1"
  local env_entry="$2"
  local pid=""

  for pid in $(pgrep -x "$process_name" 2>/dev/null || true); do
    if tr '\0' '\n' <"/proc/${pid}/environ" 2>/dev/null | grep -Fxq "$env_entry"; then
      return 0
    fi
  done

  return 1
}

process_cmdline_contains_all() {
  local search_pattern="$1"
  shift

  local pid=""
  local cmdline=""
  local needle=""
  local missing_match=""

  for pid in $(pgrep -f "$search_pattern" 2>/dev/null || true); do
    cmdline="$(tr '\0' '\n' <"/proc/${pid}/cmdline" 2>/dev/null || true)"
    [ -n "$cmdline" ] || continue

    missing_match=""
    for needle in "$@"; do
      if ! printf '%s\n' "$cmdline" | grep -Fxq "$needle"; then
        missing_match="1"
        break
      fi
    done

    if [ -z "$missing_match" ]; then
      return 0
    fi
  done

  return 1
}

wait_for_background_process() {
  local pid="$1"
  local name="$2"
  local log_file="$3"
  local retries=0

  while [ "$retries" -lt 5 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Error: ${name} exited during startup."
      tail -n 50 "$log_file" || true
      exit 1
    fi

    retries=$((retries + 1))
    sleep 1
  done
}

wait_for_tcp_port() {
  local port="$1"
  local name="$2"
  local pid="$3"
  local log_file="$4"
  local retries=0

  while [ "$retries" -lt 30 ]; do
    if tcp_port_listening "$port"; then
      return 0
    fi

    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "Error: ${name} exited before listening on :${port}."
      tail -n 50 "$log_file" || true
      exit 1
    fi

    retries=$((retries + 1))
    sleep 1
  done

  echo "Error: ${name} did not start listening on :${port} within 30 seconds."
  tail -n 50 "$log_file" || true
  exit 1
}

write_chrome_clipboard_policy() {
  local policy_file_name="rome-clipboard-policy.json"
  local policy_dirs=(
    /etc/opt/chrome/policies/managed
    /etc/chromium/policies/managed
    /etc/chromium-browser/policies/managed
  )
  local policy_json=""
  local policy_dir=""
  local setting="${ROME_CHROME_CLIPBOARD_DEFAULT_SETTING:-}"

  if [ -z "$setting" ]; then
    for policy_dir in "${policy_dirs[@]}"; do
      rm -f "${policy_dir}/${policy_file_name}"
    done
    return 0
  fi

  if ! policy_json="$(
    ROME_CHROME_CLIPBOARD_DEFAULT_SETTING="$setting" \
      python3 - <<'PY'
import json
import os
import sys

setting_raw = os.environ.get("ROME_CHROME_CLIPBOARD_DEFAULT_SETTING", "").strip().lower()
setting_map = {"allow": 1, "block": 2, "ask": 3}
policy = {}

if setting_raw:
    if setting_raw not in setting_map:
        print(
            "Invalid ROME_CHROME_CLIPBOARD_DEFAULT_SETTING. Use allow, block, or ask.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    policy["DefaultClipboardSetting"] = setting_map[setting_raw]

print(json.dumps(policy, indent=2, sort_keys=True))
PY
  )"; then
    echo "Error: failed to render Chrome clipboard policy."
    exit 1
  fi

  for policy_dir in "${policy_dirs[@]}"; do
    mkdir -p "$policy_dir"
    printf '%s\n' "$policy_json" >"${policy_dir}/${policy_file_name}"
  done
}

# ─── Start virtual desktop stack ────────────────────────────────────────────
DISPLAY_NUM="${DISPLAY#:}"
SCREEN_SIZE="${ROME_SCREEN_SIZE:-1280x800x24}"
if [[ "$SCREEN_SIZE" =~ ^([0-9]+x[0-9]+)(x([0-9]+))?$ ]]; then
  SCREEN_GEOMETRY="${BASH_REMATCH[1]}"
  SCREEN_DEPTH="${BASH_REMATCH[3]:-24}"
else
  echo "Error: ROME_SCREEN_SIZE must use WIDTHxHEIGHT or WIDTHxHEIGHTxDEPTH."
  exit 1
fi
NOVNC_PORT="${ROME_NOVNC_PORT:-6080}"
VNC_PORT="${ROME_VNC_PORT:-5900}"

mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

REUSED_X_SERVER="0"
cleanup_stale_x11_state "$DISPLAY_NUM"

TIGERVNC_PID=""
if [ "$REUSED_X_SERVER" = "1" ]; then
  if ! process_cmdline_contains_all Xtigervnc "$DISPLAY" -rfbport "$VNC_PORT"; then
    echo "Error: the existing X server on ${DISPLAY} is not Rome's TigerVNC process."
    exit 1
  fi
  echo "Reusing TigerVNC on ${DISPLAY}, RFB :${VNC_PORT}."
else
  if tcp_port_listening "$VNC_PORT"; then
    echo "Error: TCP port ${VNC_PORT} is already in use by another process."
    exit 1
  fi

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
  TIGERVNC_PID=$!
fi

RETRIES=0
while [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && [ "$RETRIES" -lt 30 ]; do
  if [ -n "$TIGERVNC_PID" ] && ! kill -0 "$TIGERVNC_PID" 2>/dev/null; then
    echo "Error: TigerVNC exited before creating display ${DISPLAY}."
    tail -n 50 /tmp/xtigervnc.log || true
    exit 1
  fi
  RETRIES=$((RETRIES + 1))
  sleep 1
done
if [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
  echo "Error: TigerVNC did not start within 30 seconds."
  tail -n 50 /tmp/xtigervnc.log || true
  exit 1
fi
wait_for_tcp_port "$VNC_PORT" "TigerVNC" "$TIGERVNC_PID" /tmp/xtigervnc.log

OPENBOX_PID=""
if [ "$REUSED_X_SERVER" = "1" ] && process_env_contains openbox "DISPLAY=${DISPLAY}"; then
  echo "Reusing existing Openbox on ${DISPLAY}."
else
  echo "Starting Openbox ..."
  DISPLAY="$DISPLAY" openbox >/tmp/openbox.log 2>&1 &
  OPENBOX_PID=$!
  wait_for_background_process "$OPENBOX_PID" "Openbox" /tmp/openbox.log
fi

NOVNC_PID=""
if process_cmdline_contains_all websockify --web=/usr/share/novnc/ "$NOVNC_PORT" "localhost:${VNC_PORT}"; then
  echo "Reusing noVNC on :${NOVNC_PORT}."
else
  if tcp_port_listening "$NOVNC_PORT"; then
    echo "Error: TCP port ${NOVNC_PORT} is already in use by another process."
    exit 1
  fi

  echo "Starting noVNC on :${NOVNC_PORT} ..."
  websockify --web=/usr/share/novnc/ "$NOVNC_PORT" "localhost:${VNC_PORT}" >/tmp/novnc.log 2>&1 &
  NOVNC_PID=$!
fi
wait_for_tcp_port "$NOVNC_PORT" "noVNC" "$NOVNC_PID" /tmp/novnc.log

CHROME_WRAPPER_PID=""
if [ "${ROME_ENABLE_CHROME:-1}" != "0" ]; then
  write_chrome_clipboard_policy
  CHROME_CDP_PORT="${ROME_CHROME_CDP_PORT:-9222}"
  CHROME_INTERNAL_CDP_PORT="${ROME_CHROME_INTERNAL_CDP_PORT:-9223}"
  CHROME_BIND_ADDRESS="${ROME_CHROME_BIND_ADDRESS:-0.0.0.0}"

  if chrome_cdp_ready "$CHROME_BIND_ADDRESS" "$CHROME_CDP_PORT"; then
    echo "Reusing existing Chrome CDP on ${CHROME_BIND_ADDRESS}:${CHROME_CDP_PORT}."
  else
    if tcp_port_listening "$CHROME_CDP_PORT"; then
      echo "Error: Chrome CDP port ${CHROME_CDP_PORT} is already in use but no healthy CDP endpoint responded."
      exit 1
    fi
    if tcp_port_listening "$CHROME_INTERNAL_CDP_PORT"; then
      echo "Error: internal Chrome CDP port ${CHROME_INTERNAL_CDP_PORT} is already in use."
      exit 1
    fi

    echo "Starting Chrome with CDP on :${CHROME_CDP_PORT} ..."
    BROWSER_BINARY="${ROME_CHROME_BINARY:-}"
    if [ -z "$BROWSER_BINARY" ] && [ -f /etc/rome-browser-binary ]; then
      BROWSER_BINARY="$(cat /etc/rome-browser-binary)"
    fi
    run_as_rome env \
      DISPLAY="$DISPLAY" \
      ROME_CHROME_BINARY="${BROWSER_BINARY:-/usr/bin/google-chrome-stable}" \
      ROME_CHROME_NAME="${ROME_CHROME_NAME:-Chrome}" \
      ROME_CHROME_CDP_PORT="$CHROME_CDP_PORT" \
      ROME_CHROME_INTERNAL_CDP_PORT="$CHROME_INTERNAL_CDP_PORT" \
      ROME_CHROME_BIND_ADDRESS="$CHROME_BIND_ADDRESS" \
      ROME_CHROME_STARTUP_WAIT="${ROME_CHROME_STARTUP_WAIT:-20}" \
      ROME_CHROME_WINDOW_SIZE="${ROME_CHROME_WINDOW_SIZE:-1280,800}" \
      ROME_CHROME_URL="${ROME_CHROME_URL:-about:blank}" \
      ROME_CHROME_USER_DATA_DIR="${ROME_CHROME_USER_DATA_DIR:-/home/rome/.rome/chrome-profile}" \
      ROME_CHROME_FULLSCREEN="${ROME_CHROME_FULLSCREEN:-0}" \
      ROME_CHROME_DISABLE_SANDBOX="${ROME_CHROME_DISABLE_SANDBOX:-0}" \
      ROME_CHROME_ENABLE_STEALTH="${ROME_CHROME_ENABLE_STEALTH:-1}" \
      ROME_CHROME_TIMEZONE="${ROME_CHROME_TIMEZONE:-America/Los_Angeles}" \
      ROME_CHROME_LANG="${ROME_CHROME_LANG:-en-US}" \
      ROME_CHROME_CLIPBOARD_DEFAULT_SETTING="${ROME_CHROME_CLIPBOARD_DEFAULT_SETTING:-}" \
      ROME_CHROME_USER_AGENT="${ROME_CHROME_USER_AGENT:-}" \
      ROME_CHROME_PROXY_URL="${ROME_CHROME_PROXY_URL:-}" \
      /opt/rome/scripts/docker/rome-start-chrome-cdp.sh >/tmp/chrome-cdp.log 2>&1 &
    CHROME_WRAPPER_PID=$!
  fi
else
  echo "ROME_ENABLE_CHROME=0, skipping Chrome startup."
fi

# ─── Fix authorized_keys permissions if mounted ────────────────────────────
if [ -f /home/user/.ssh/authorized_keys ]; then
  safe_chown user:user /home/user/.ssh /home/user/.ssh/authorized_keys
  chmod g-s,u=rwx,go= /home/user/.ssh
  chmod 600 /home/user/.ssh/authorized_keys
fi

# ─── Start SSH daemon ──────────────────────────────────────────────────────
echo "Starting sshd ..."
/usr/sbin/sshd -D -e &
SSHD_PID=$!

# ─── Start Tailscale daemon ─────────────────────────────────────────────
echo "Starting tailscaled ..."
tailscaled \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --tun=userspace-networking &
TAILSCALED_PID=$!

echo "Waiting for tailscaled ..."
RETRIES=0
while [ ! -S /var/run/tailscale/tailscaled.sock ] && [ "$RETRIES" -lt 30 ]; do
  RETRIES=$((RETRIES + 1))
  sleep 1
done
if [ -S /var/run/tailscale/tailscaled.sock ]; then
  if retry_command 30 1 "tailscaled CLI readiness" tailscale_status_ready; then
    echo "tailscaled is ready."
    # Allow the rome user to run tailscale commands without sudo once the daemon responds.
    if retry_command 10 2 "tailscale operator setup" tailscale set --operator=rome; then
      echo "tailscale operator set to rome."
    fi
  else
    echo "Warning: tailscaled socket exists, but the CLI never became ready."
  fi
else
  echo "Warning: tailscaled did not start within 30 seconds."
fi

# ─── Try enabling HTTPS serve (best-effort, bounded retries) ─────────────
# If Tailscale is already authenticated, enable HTTPS serve now.
# For first-time onboarding, the /api/tailnet endpoint handles retries
# when the user reaches the Security step.
TAILSCALE_BACKEND_STATE="$(tailscale_backend_state 2>/dev/null || true)"
if [ "$TAILSCALE_BACKEND_STATE" = "Starting" ]; then
  retry_command 10 2 "tailscale backend reaching Running state" tailscale_backend_running || true
  TAILSCALE_BACKEND_STATE="$(tailscale_backend_state 2>/dev/null || true)"
fi

if [ "$TAILSCALE_BACKEND_STATE" = "Running" ]; then
  if retry_command 10 3 "tailscale HTTPS serve setup" enable_tailscale_https_serve; then
    echo "tailscale HTTPS serve enabled."
  else
    echo "Warning: tailscale serve failed (will be retried via /api/tailnet)"
  fi
fi

# Clean up legacy app layout from older images before rsync tries to delete it.
# Previous versions stored the web app at /app/web; current images use /app/packages/web.
if [ -d /app/web ] && [ ! -e /opt/rome/web ]; then
  rm -rf /app/web
fi

prune_removed_rome_apps() {
  local existing_path=""
  local app_name=""

  [ -d /app/rome_apps ] || return 0
  [ -d /opt/rome/rome_apps ] || return 0

  for existing_path in /app/rome_apps/*; do
    [ -e "$existing_path" ] || continue

    app_name="$(basename "$existing_path")"
    if [ ! -e "/opt/rome/rome_apps/${app_name}" ]; then
      rm -rf "$existing_path"
    fi
  done
}

link_image_backed_node_modules() {
  local source_path="$1"
  local target_path="$2"
  local current_target=""

  mkdir -p "$(dirname "$target_path")"

  if [ -L "$target_path" ]; then
    current_target="$(readlink "$target_path" 2>/dev/null || true)"
    if [ "$current_target" = "$source_path" ]; then
      safe_chown -h rome:rome "$target_path" 2>/dev/null || true
      return 0
    fi
  fi

  rm -rf "$target_path"
  ln -s "$source_path" "$target_path"
  safe_chown -h rome:rome "$target_path" 2>/dev/null || true
}

ensure_line_present() {
  local file_path="$1"
  local line="$2"

  touch "$file_path"
  if ! grep -Fqx "$line" "$file_path"; then
    printf '\n%s\n' "$line" >>"$file_path"
  fi
}

ensure_git_instead_of() {
  local username="$1"
  local home_dir="$2"
  local instead_of_value="$3"
  local existing_values=""

  existing_values="$(run_as_account "$username" "$home_dir" git config --global --get-all 'url.https://github.com/.insteadOf' 2>/dev/null || true)"
  if printf '%s\n' "$existing_values" | grep -Fxq "$instead_of_value"; then
    return 0
  fi

  run_as_account "$username" "$home_dir" git config --global --add 'url.https://github.com/.insteadOf' "$instead_of_value"
}

github_shell_token_file() {
  printf '%s' "${ROME_GITHUB_TOKEN_FILE:-/run/rome/github-oauth-token}"
}

github_shell_token() {
  local token_file=""
  token_file="$(github_shell_token_file)"

  if [ -r "$token_file" ]; then
    tr -d '\r\n' <"$token_file"
  fi
}

configure_github_git_helper() {
  local username="$1"
  local home_dir="$2"
  local token=""

  token="$(github_shell_token)"
  if [ -n "$token" ]; then
    printf '%s\n' "$token" | run_as_account "$username" "$home_dir" env GH_PROMPT_DISABLED=1 gh auth login --hostname github.com --git-protocol https --with-token
    run_as_account "$username" "$home_dir" env GH_PROMPT_DISABLED=1 gh auth setup-git --hostname github.com
    return 0
  fi

  if run_as_account "$username" "$home_dir" env GH_PROMPT_DISABLED=1 gh auth status --hostname github.com >/dev/null 2>&1; then
    run_as_account "$username" "$home_dir" env GH_PROMPT_DISABLED=1 gh auth setup-git --hostname github.com
    return 0
  fi

  echo "GitHub CLI is not authenticated for ${username}; skipping git credential helper setup."
}

configure_shell_user() {
  local username="$1"
  local group_name="$2"
  local home_dir="$3"
  local alias_source_line='[ -f /app/scripts/docker/rome-shell-aliases.sh ] && . /app/scripts/docker/rome-shell-aliases.sh'
  local github_source_line='[ -f /app/scripts/docker/rome-github-shell.sh ] && . /app/scripts/docker/rome-github-shell.sh'

  mkdir -p "$home_dir/.rome"
  safe_chown "$username:$group_name" "$home_dir/.rome"

  for shell_rc in "$home_dir/.bashrc" "$home_dir/.profile"; do
    ensure_line_present "$shell_rc" "$alias_source_line"
    ensure_line_present "$shell_rc" "$github_source_line"
    safe_chown "$username:$group_name" "$shell_rc"
  done

  if ! configure_github_git_helper "$username" "$home_dir"; then
    echo "Warning: failed to configure GitHub git credential helper for ${username}; continuing without it."
  fi
  ensure_git_instead_of "$username" "$home_dir" 'git@github.com:'
  ensure_git_instead_of "$username" "$home_dir" 'ssh://git@github.com/'
}

ROME_DOCKER_APP_CODE_MODE="${ROME_DOCKER_APP_CODE_MODE:-source}"

case "$ROME_DOCKER_APP_CODE_MODE" in
  source)
    APP_RUNTIME_SENTINEL="/app/packages/core/src"
    CADDYFILE_GENERATOR_CMD='node --import tsx /app/scripts/generate-caddyfile.ts'
    DAEMON_START_CMD='cd /app && node --import tsx /app/packages/core/src/daemon/index.ts'
    ;;
  compiled)
    APP_RUNTIME_SENTINEL="/app/packages/core/dist"
    CADDYFILE_GENERATOR_CMD='node /app/dist/scripts/generate-caddyfile.js'
    DAEMON_START_CMD='cd /app && node /app/packages/core/dist/daemon/index.js'
    ;;
  *)
    echo "Unsupported ROME_DOCKER_APP_CODE_MODE: $ROME_DOCKER_APP_CODE_MODE" >&2
    exit 1
    ;;
esac

# ─── Sync built app from /opt/rome to /app ──────────────────────────────────
# Skip rsync/chown when /app already matches this image fingerprint.
IMAGE_SYNC_ID_FILE="/opt/rome/.image-sync-id"
APP_SYNC_ID_FILE="/app/.image-sync-id"
NEEDS_SYNC="true"
if [ -f "$IMAGE_SYNC_ID_FILE" ] && [ -f "$APP_SYNC_ID_FILE" ] && cmp -s "$IMAGE_SYNC_ID_FILE" "$APP_SYNC_ID_FILE"; then
  if [ -d "$APP_RUNTIME_SENTINEL" ] && [ -d /app/packages/web ]; then
    NEEDS_SYNC="false"
  fi
fi

if [ "$NEEDS_SYNC" = "true" ]; then
  echo "Syncing application to /app ..."
  prune_removed_rome_apps
  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='/memory' \
    /opt/rome/ /app/

  # First-time init: populate the rome-memory volume from the image if it is empty.
  # On subsequent upgrades rsync skips /memory, so user-edited files are preserved.
  if [ -z "$(ls -A /app/memory 2>/dev/null)" ] && [ -d /opt/rome/memory ]; then
    echo "Initializing memory directory from image..."
    cp -a /opt/rome/memory/. /app/memory/
    safe_chown -R rome:rome /app/memory
  fi

  if [ -f "$IMAGE_SYNC_ID_FILE" ]; then
    cp "$IMAGE_SYNC_ID_FILE" "$APP_SYNC_ID_FILE"
  fi

  safe_chown -R rome:rome /app
  chmod 750 /app
  echo "Sync complete."
else
  echo "Application already synced for this image; skipping rsync."
fi

# Symlink workspace node_modules to the image copy (instant, no volume I/O)
link_image_backed_node_modules /opt/rome/node_modules /app/node_modules

for package_dir in /opt/rome/apps/* /opt/rome/packages/* /opt/rome/rome_apps/*; do
  if [ ! -f "$package_dir/package.json" ] || [ ! -e "$package_dir/node_modules" ]; then
    continue
  fi

  target_dir="/app${package_dir#/opt/rome}"
  link_image_backed_node_modules "$package_dir/node_modules" "$target_dir/node_modules"
done

# ─── Register the Rome OpenCLI plugins (idempotent) ────────────────────────
# Each opencli-plugins/<site>/ dir is a standalone OpenCLI plugin named
# "rome-<site>" that overrides/extends that site's built-in commands (see
# opencli-plugins/README.md). A local install symlinks the source dir into
# ~/.opencli/plugins/, so the rsync-updated /app copy is picked up by the next
# opencli invocation — the install itself only has to happen once per volume.
install_opencli_plugins() {
  local plugins_root="/app/opencli-plugins"
  local plugin_src=""
  local plugin_link=""
  local failed=0

  [ -d "$plugins_root" ] || return 0
  command -v opencli >/dev/null 2>&1 || return 0

  for plugin_src in "$plugins_root"/*/; do
    plugin_src="${plugin_src%/}"
    [ -f "$plugin_src/opencli-plugin.json" ] || continue
    plugin_link="/home/rome/.opencli/plugins/rome-$(basename "$plugin_src")"

    # The host-opencli link inside the plugin dir is the LAST artifact `plugin
    # install` produces, so its presence distinguishes a completed install from
    # a half-failed one (the plugins-dir symlink alone is created first).
    if [ "$(readlink "$plugin_link" 2>/dev/null)" = "$plugin_src" ] &&
      [ -e "$plugin_src/node_modules/@jackwener/opencli/package.json" ]; then
      continue
    fi
    rm -rf "$plugin_link"
    run_as_rome opencli plugin install "$plugin_src" || failed=1
  done
  return "$failed"
}
if ! install_opencli_plugins; then
  echo "Warning: opencli plugin install failed; built-in opencli commands remain available."
fi

# ─── Ensure profile projects directory exists ──────────────────────────────
PROFILE="${ROME_PROFILE:-default}"
run_as_rome mkdir -p "/home/rome/.rome/$PROFILE/projects/default"

# /run/rome is tmpfs (wiped on restart); the provider OAuth token files + gh/git
# shell auth are re-materialized IN PROCESS by the connection registry's custody
# hook during boot rehydration (packages/core/src/connections/registry.ts —
# syncCustody on grant load). Nothing consumes those files before the main
# process is up, so no separate pre-boot reconciler runs here.

configure_shell_user rome rome /home/rome
configure_shell_user user user /home/user

# ─── DB migrations ────────────────────────────────────────────────────────
# Migrations run inside the rome backend process — see
# packages/core/src/index.ts (reconcileAppsState → runMigrations). Running
# migrate.ts standalone here would fail on fresh installs because the app
# lockfile is created by the reconciler.

# ─── Generate Caddyfile from DB settings ──────────────────────────────────
echo "Generating Caddyfile from saved settings ..."
run_as_rome sh -c "$CADDYFILE_GENERATOR_CMD"

# ─── Start Caddy (public reverse proxy on port 8080) ─────────────────────
# Public internet only reaches port 8080 (mapped from VM host).
# Caddy whitelists specific paths and proxies them to Rome on port 4141.
# Tailnet users reach Rome directly via tailscale serve (runs in-container).
echo "Starting Caddy (public proxy on :8080) ..."
caddy start --config /etc/caddy/Caddyfile

# ─── Start health-check + capability daemon (owns backend + web lifecycle) ─
echo "Starting health-check + capability daemon ..."
run_as_rome sh -c "$DAEMON_START_CMD" &
DAEMON_PID=$!

# ─── Signal handling ──────────────────────────────────────────────────────
cleanup() {
  echo "Shutting down ..."
  caddy stop 2>/dev/null || true
  if [ -n "${CHROME_WRAPPER_PID:-}" ]; then
    kill "$CHROME_WRAPPER_PID" 2>/dev/null || true
    wait "$CHROME_WRAPPER_PID" 2>/dev/null || true
  fi
  kill "$NOVNC_PID" "$OPENBOX_PID" "$TIGERVNC_PID" "$DAEMON_PID" "$SSHD_PID" "$TAILSCALED_PID" 2>/dev/null || true
  wait "$NOVNC_PID" "$OPENBOX_PID" "$TIGERVNC_PID" "$DAEMON_PID" "$SSHD_PID" "$TAILSCALED_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# ─── Wait for the daemon to exit ──────────────────────────────────────────
wait "$DAEMON_PID" 2>/dev/null || true
echo "Health-check daemon exited, shutting down ..."
cleanup
