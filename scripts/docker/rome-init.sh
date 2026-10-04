#!/command/with-contenv bash
# shellcheck shell=bash
set -e

# =============================================================================
# Rome — one-time container setup, run as root by the s6 oneshot "init" before
# any long-running service starts. Drops privileges via gosu where it acts for
# the rome and user accounts. The services themselves are defined under
# /etc/s6-overlay/s6-rc.d (scripts/docker/s6-rc.d in the repo).
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

run_as_rome mkdir -p /home/rome/.rome
chmod 750 /home/rome /home/rome/.rome

# WeChat writes only into the runtime user's home and private session directory.
# Prepare its canonical link while this script still runs as root.
if [ "${WECHAT_USER_ENABLED:-false}" = "true" ]; then
  WECHAT_RUNTIME_UID="$(run_as_rome id -u)"
  WECHAT_RUNTIME_DIR="/run/user/$WECHAT_RUNTIME_UID"
  mkdir -p "$WECHAT_RUNTIME_DIR"
  safe_chown rome:rome "$WECHAT_RUNTIME_DIR"
  chmod 700 "$WECHAT_RUNTIME_DIR"
  if [ ! -e /opt/wechat ] && [ ! -L /opt/wechat ]; then
    ln -s /home/rome/.local/share/wechat/client/opt/wechat /opt/wechat
  fi
fi

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
  # Services read their environment from this directory, so removing the entry
  # keeps the password out of the daemon and every other service.
  rm -f /run/s6/container_environment/SSH_USER_PASSWORD
fi

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

# ─── Prepare the browser ────────────────────────────────────────────────────
if ! run_as_rome bash /opt/rome/scripts/docker/rome-start-opencli.sh; then
  echo "Warning: OpenCLI could not start. Browser connections are unavailable."
fi
if [ "${ROME_ENABLE_CHROME:-1}" != "0" ]; then
  write_chrome_clipboard_policy
fi

# ─── Fix authorized_keys permissions if mounted ────────────────────────────
if [ -f /home/user/.ssh/authorized_keys ]; then
  safe_chown user:user /home/user/.ssh /home/user/.ssh/authorized_keys
  chmod g-s,u=rwx,go= /home/user/.ssh
  chmod 600 /home/user/.ssh/authorized_keys
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
    ;;
  compiled)
    APP_RUNTIME_SENTINEL="/app/packages/core/dist"
    CADDYFILE_GENERATOR_CMD='node /app/dist/scripts/generate-caddyfile.js'
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

  safe_chown -R rome:rome /app
  chmod 750 /app

  # The fingerprint marks the sync complete, so it lands only after the chown.
  # A boot interrupted before this point syncs and chowns again on the next one.
  if [ -f "$IMAGE_SYNC_ID_FILE" ]; then
    cp "$IMAGE_SYNC_ID_FILE" "$APP_SYNC_ID_FILE"
  fi
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
