#!/command/with-contenv bash
# shellcheck shell=bash

# =============================================================================
# Rome — container setup that Rome's boot does not need, run as root by the s6
# oneshot "init-tools". It waits for Rome to answer healthy first, so on a small
# VM it does not compete with Rome's boot for CPU. Every step is best effort: a
# failure warns and continues, because a failed oneshot would stop the container.
# =============================================================================

. /etc/s6-overlay/scripts/rome-init-lib

/etc/s6-overlay/scripts/rome-wait-for-rome

# ─── Start OpenCLI, the browser bridge ─────────────────────────────────────
if ! run_as_rome bash /opt/rome/scripts/docker/rome-start-opencli.sh; then
  echo "Warning: OpenCLI could not start. Browser connections are unavailable."
fi

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
  for plugin_src in /home/rome/.rome/*/projects/browser-automation/*/; do
    plugin_src="${plugin_src%/}"
    [ -f "$plugin_src/opencli-plugin.json" ] || continue
    plugin_link="/home/rome/.opencli/plugins/user-$(basename "$plugin_src")"
    if [ "$(readlink "$plugin_link" 2>/dev/null)" = "$plugin_src" ] &&
      [ -e "$plugin_src/node_modules/@jackwener/opencli/package.json" ]; then
      continue
    fi
    if ! { run_as_rome rm -f "$plugin_link" && run_as_rome opencli plugin install "$plugin_src"; }; then
      echo "Warning: user opencli plugin install failed: $plugin_src; continuing."
    fi
  done
  return "$failed"
}
if ! install_opencli_plugins; then
  echo "Warning: opencli plugin install failed; built-in opencli commands remain available."
fi

# ─── Configure the rome and user shells ────────────────────────────────────
# The provider OAuth token files under /run/rome are written by Rome's connection
# registry during boot, so after Rome is healthy the GitHub token is in place.
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

# Points npm's global prefix at ~/.local, so `npm install -g` works without root,
# survives upgrades with the home directory, and puts commands in ~/.local/bin.
# ~/.npmrc keeps any prefix already there, including one the account chose. The
# account writes the file itself, so root never follows a link it planted.
ensure_npm_prefix() {
  local username="$1"
  local home_dir="$2"

  run_as_account "$username" "$home_dir" sh -c '
    npmrc="$HOME/.npmrc"
    if grep -Eqs "^[[:space:]]*prefix[[:space:]]*=" "$npmrc"; then
      exit 0
    fi
    if [ -s "$npmrc" ] && [ -n "$(tail -c 1 "$npmrc")" ]; then
      printf "\n" >>"$npmrc"
    fi
    printf "prefix=%s\n" "$HOME/.local" >>"$npmrc"
  '
}

configure_shell_user() {
  local username="$1"
  local group_name="$2"
  local home_dir="$3"
  local alias_source_line='[ -f /app/scripts/docker/rome-shell-aliases.sh ] && . /app/scripts/docker/rome-shell-aliases.sh'
  local github_source_line='[ -f /app/scripts/docker/rome-github-shell.sh ] && . /app/scripts/docker/rome-github-shell.sh'
  local path_source_line='[ -f /usr/local/share/rome/rome-shell-path.sh ] && . /usr/local/share/rome/rome-shell-path.sh'

  mkdir -p "$home_dir/.rome"
  safe_chown "$username:$group_name" "$home_dir/.rome"

  for shell_rc in "$home_dir/.bashrc" "$home_dir/.profile"; do
    ensure_line_present "$shell_rc" "$alias_source_line"
    ensure_line_present "$shell_rc" "$github_source_line"
    ensure_line_present "$shell_rc" "$path_source_line"
    safe_chown "$username:$group_name" "$shell_rc"
  done
  if ! ensure_npm_prefix "$username" "$home_dir"; then
    echo "Warning: failed to set the npm global prefix for ${username}; continuing without it."
  fi

  if ! configure_github_git_helper "$username" "$home_dir"; then
    echo "Warning: failed to configure GitHub git credential helper for ${username}; continuing without it."
  fi
  ensure_git_instead_of "$username" "$home_dir" 'git@github.com:'
  ensure_git_instead_of "$username" "$home_dir" 'ssh://git@github.com/'
}

configure_shell_user rome rome /home/rome
configure_shell_user user user /home/user

exit 0
