#!/command/with-contenv bash
# shellcheck shell=bash
# Gives the rome user control of tailscaled and enables HTTPS serve when the
# node is already logged in. Runs once per boot under the s6 longrun
# tailscale-setup, after tailscaled starts and init finishes.
#
# Tailscale is best-effort: the /api/tailnet endpoint retries HTTPS serve when
# the user reaches the Security step. Nothing waits on this script, so a slow or
# broken tailscaled never delays the daemon and the dashboard. It always exits
# 0, because a failure here must not stop the container.

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

retries=0
backend_state=""

echo "Waiting for tailscaled ..."
while [ ! -S /var/run/tailscale/tailscaled.sock ] && [ "$retries" -lt 30 ]; do
  retries=$((retries + 1))
  sleep 1
done
if [ ! -S /var/run/tailscale/tailscaled.sock ]; then
  echo "Warning: tailscaled did not start within 30 seconds."
  exit 0
fi
if ! retry_command 30 1 "tailscaled CLI readiness" tailscale_status_ready; then
  echo "Warning: tailscaled socket exists, but the CLI never became ready."
  exit 0
fi
echo "tailscaled is ready."
# Allow the rome user to run tailscale commands without sudo once the daemon responds.
if retry_command 10 2 "tailscale operator setup" tailscale set --operator=rome; then
  echo "tailscale operator set to rome."
fi

# If Tailscale is already authenticated, enable HTTPS serve now.
backend_state="$(tailscale_backend_state 2>/dev/null || true)"
if [ "$backend_state" = "Starting" ]; then
  retry_command 10 2 "tailscale backend reaching Running state" tailscale_backend_running || true
  backend_state="$(tailscale_backend_state 2>/dev/null || true)"
fi

if [ "$backend_state" = "Running" ]; then
  if retry_command 10 3 "tailscale HTTPS serve setup" enable_tailscale_https_serve; then
    echo "tailscale HTTPS serve enabled."
  else
    echo "Warning: tailscale serve failed (will be retried via /api/tailnet)"
  fi
fi
exit 0
