#!/command/with-contenv bash
# shellcheck shell=bash
set -e

# =============================================================================
# Rome — one-time container setup, run as root by the s6 oneshot "init" before
# any long-running service starts. Drops privileges via gosu where it acts for
# the rome and user accounts. Setup that Rome's boot does not need runs after
# Rome is healthy, in rome-init-tools.sh. The services themselves are defined
# under /etc/s6-overlay/s6-rc.d (scripts/docker/s6-rc.d in the repo).
# =============================================================================

. /etc/s6-overlay/scripts/rome-init-lib

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
mkdir -p /home/user/.rome
safe_chown user:user /home/user/.rome

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
# rome-wait-for-rome marks Rome's first healthy answer here. /run can outlive a
# container restart, so each boot clears it.
rm -f /run/rome-boot-healthy
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

# ─── Ensure profile projects directory exists ──────────────────────────────
PROFILE="${ROME_PROFILE:-default}"
run_as_rome mkdir -p "/home/rome/.rome/$PROFILE/projects/default"

# ─── DB migrations ────────────────────────────────────────────────────────
# Migrations run inside the rome backend process — see
# packages/core/src/index.ts (reconcileAppsState → runMigrations). Running
# migrate.ts standalone here would fail on fresh installs because the app
# lockfile is created by the reconciler.

# ─── Generate Caddyfile from DB settings ──────────────────────────────────
echo "Generating Caddyfile from saved settings ..."
run_as_rome sh -c "$CADDYFILE_GENERATOR_CMD"
