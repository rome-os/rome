#!/usr/bin/env bash
# Run the published Rome image with Docker — no repo checkout required, so the
# script can be fetched raw from GitHub and piped to bash. Everything it needs
# beyond Docker itself is POSIX userland plus bash.
set -euo pipefail

ROME_REPO_URL="https://github.com/rome-os/rome"

usage() {
  cat <<'EOF'
Usage: quickstart-docker.sh [options]

Check for a local Docker install, pull the published Rome image, and start it.
Rome's state lives in named Docker volumes, so re-running the script replaces
the container (picking up a newer image) without losing data. It also runs a
signer container (NAME-signer), which Rome Cloud requires, and re-running the
script adds or updates it.

Options:
  --name NAME       Container name; also names the signer container and prefixes
                    the data volumes (default: rome)
  --port PORT       Host port for the web dashboard (default: 7663 — "ROME"
                    on a phone keypad, chosen to dodge the crowd on 8080)
  --bind ADDR       Host address the published ports bind to (default:
                    127.0.0.1). First-run onboarding hands the guardian seat
                    to the first visitor, so bind a non-loopback address only
                    on a network you trust — or after onboarding completes.
  --image TAG       Image to pull and run (default: yunfanye/rome:latest)
  --env-file PATH   Extra env file passed to docker run
  --no-pull         Skip docker pull and run the locally available image
  -h, --help        Show this help

Environment overrides:
  ROME_QUICKSTART_CONTAINER_NAME
  ROME_QUICKSTART_HOST_PORT
  ROME_QUICKSTART_BIND_ADDRESS
  ROME_QUICKSTART_IMAGE
  ROME_QUICKSTART_ENV_FILE
  ROME_QUICKSTART_WAIT_SECONDS  Startup wait before giving up (default: 600)
  ROME_QUICKSTART_STATE_DIR     Where the generated web-login secret persists
                                (default: ~/.rome/quickstart)

Optional Rome settings, forwarded into the container when set in your shell:
  ANTHROPIC_API_KEY            Anthropic API key; without it, onboarding offers
                               Claude-account login instead
  PANTHEON_BASE_ORIGIN         Rome Cloud origin — enables the app store,
                               connector OAuth, and instance enrollment
                               (default: https://romeos.cc; export it empty
                               to run without Rome Cloud)
  ROME_LOOPBACK_CALLBACK_ORIGIN
                               Loopback origin the browser reaches this
                               container on, used by the Rome Cloud
                               enrollment callback (default:
                               http://localhost:<port>)
  ROME_PROFILE                 Profile name for data isolation
  LOG_LEVEL                    debug | info | warn | error
  SSH_USER_PASSWORD            Password for the container's SSH account; when
                               set, host port 2222 maps to the container's sshd
  OTEL_EXPORTER_OTLP_ENDPOINT  OTLP HTTP collector endpoint. Telemetry export
                               is disabled unless this is set.
EOF
}

fail() {
  echo "quickstart-docker: $1" >&2
  exit 1
}

container_name="${ROME_QUICKSTART_CONTAINER_NAME:-rome}"
host_port="${ROME_QUICKSTART_HOST_PORT:-7663}"
bind_address="${ROME_QUICKSTART_BIND_ADDRESS:-127.0.0.1}"
image="${ROME_QUICKSTART_IMAGE:-yunfanye/rome:latest}"
env_file="${ROME_QUICKSTART_ENV_FILE:-}"
wait_seconds="${ROME_QUICKSTART_WAIT_SECONDS:-600}"
state_dir="${ROME_QUICKSTART_STATE_DIR:-$HOME/.rome/quickstart}"
pull_image="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      container_name="${2:?--name requires a value}"
      shift 2
      ;;
    --port)
      host_port="${2:?--port requires a value}"
      shift 2
      ;;
    --bind)
      bind_address="${2:?--bind requires a value}"
      shift 2
      ;;
    --image)
      image="${2:?--image requires a value}"
      shift 2
      ;;
    --env-file)
      env_file="${2:?--env-file requires a value}"
      shift 2
      ;;
    --no-pull)
      pull_image="false"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ─── Docker preflight ───────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "quickstart-docker: Docker is not installed." >&2
  case "$(uname -s)" in
    Darwin)
      echo "Install Docker Desktop (https://www.docker.com/products/docker-desktop/)" >&2
      echo "or OrbStack (https://orbstack.dev), then re-run this script." >&2
      ;;
    Linux)
      echo "Install Docker Engine: https://docs.docker.com/engine/install/" >&2
      echo "(convenience path: curl -fsSL https://get.docker.com | sh)" >&2
      echo "Then re-run this script." >&2
      ;;
    *)
      echo "Install Docker (https://docs.docker.com/get-docker/), then re-run this script." >&2
      ;;
  esac
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but the daemon is not reachable — start Docker Desktop/OrbStack (or \`systemctl start docker\` on Linux) and re-run."
fi

# ─── Web-login secret ───────────────────────────────────────────────────────
# The backend falls back to a hardcoded JWT secret when ROME_JWT_SECRET is
# unset, which would let anyone who can reach the port forge a guardian
# session. Generate one per machine and persist it so guardian logins survive
# container replacement.
secret_file="$state_dir/jwt-secret"
if [[ ! -s "$secret_file" ]]; then
  mkdir -p "$state_dir"
  (
    umask 077
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 >"$secret_file"
    else
      od -An -tx1 -N32 /dev/urandom | tr -d ' \n' >"$secret_file"
    fi
  )
fi
jwt_secret="$(<"$secret_file")"
[[ -n "$jwt_secret" ]] || fail "failed to generate a web-login secret at $secret_file"

# ─── Pull and (re)start the container ───────────────────────────────────────
if [[ "$pull_image" == "true" ]]; then
  echo "quickstart-docker: pulling ${image} ..."
  docker pull "$image"
fi

if [[ -n "$(docker ps -aq --filter "name=^/${container_name}$")" ]]; then
  echo "quickstart-docker: replacing existing container ${container_name} (data volumes are kept)"
  docker rm -f "$container_name" >/dev/null
fi

case "$bind_address" in
  127.* | ::1 | localhost) ;;
  *)
    echo "quickstart-docker: binding to ${bind_address} — until onboarding completes, anyone who can reach this address can claim the instance as its guardian." >&2
    ;;
esac

echo "quickstart-docker: starting ${container_name} at http://localhost:${host_port}"
docker_run_args=(
  -d
  --name "$container_name"
  # NODE_ENV=production also keeps telemetry export off: without it the
  # backend assumes a dev container and targets the dev-stack collector.
  -e NODE_ENV=production
  -e WEB_HOST=0.0.0.0
  -e TS_HOSTNAME="$container_name"
  -e ROME_JWT_SECRET="$jwt_secret"
  -v "${container_name}-app:/app"
  -v "${container_name}-user-home:/home/user"
  -v "${container_name}-rome-home:/home/rome"
  -v "${container_name}-ssh-host-keys:/etc/ssh/ssh_host_keys"
  # SYS_ADMIN + fuse: the runtime mounts host-project sshfs aliases in-container.
  --cap-add SYS_ADMIN
  --device /dev/fuse:/dev/fuse
  --security-opt apparmor:unconfined
  --restart unless-stopped
  # Loopback by default: /api/onboard/create-account is unauthenticated until
  # the first guardian exists, so a port published on every interface lets any
  # LAN client claim a fresh instance before the local user does.
  -p "${bind_address}:${host_port}:8080"
)

for var in ANTHROPIC_API_KEY ROME_PROFILE LOG_LEVEL SSH_USER_PASSWORD OTEL_EXPORTER_OTLP_ENDPOINT; do
  if [[ -n "${!var:-}" ]]; then
    docker_run_args+=(-e "${var}=${!var}")
  fi
done
if [[ -n "${SSH_USER_PASSWORD:-}" ]]; then
  docker_run_args+=(-p "${bind_address}:2222:22")
fi

if [[ -n "$env_file" ]]; then
  [[ -f "$env_file" ]] || fail "env file not found: $env_file"
  docker_run_args+=(--env-file "$env_file")
fi

# ─── Rome Cloud ─────────────────────────────────────────────────────────────
# Container env with shell > --env-file > default precedence. `docker run`
# gives -e precedence over --env-file, so a shell-set value is forwarded with
# -e even when empty (empty means "feature off" and must beat an env-file
# pin); when the shell is silent, an env file pinning the var owns it; the
# default rides -e only when neither spoke.
# The winning value is also left in resolved_<VAR> for the signer below.
default_container_env() {
  local var="$1" default="$2" value
  if [[ -n "${!var+set}" ]]; then
    value="${!var}"
    docker_run_args+=(-e "${var}=${value}")
  elif [[ -z "$env_file" ]] || ! grep -q "^${var}=" "$env_file"; then
    value="$default"
    docker_run_args+=(-e "${var}=${value}")
  else
    value="$(grep "^${var}=" "$env_file" | tail -n 1)"
    value="${value#*=}"
  fi
  printf -v "resolved_${var}" '%s' "$value"
}

# The control-plane origin unlocks the app store, connector OAuth, the webhook
# relay, and instance enrollment. The hosted default carries no credentials —
# the instance self-enrolls through a browser PKCE flow when the user opts in,
# and login/onboarding stay local (cloud auth requires a cloud-provisioned
# slug).
default_container_env PANTHEON_BASE_ORIGIN "https://romeos.cc"
# Where Rome Cloud sends the browser after Connect. Without it, core builds
# the enrollment redirect_uri from its own in-container port, which this
# script never publishes. `localhost`, not 127.0.0.1: the dashboard session
# cookie lives on the localhost origin the script prints, and cookies do not
# cross hostnames.
default_container_env ROME_LOOPBACK_CALLBACK_ORIGIN "http://localhost:${host_port}"

# ─── Signer ─────────────────────────────────────────────────────────────────
# Holds the instance's signing key and issues the short-lived tokens Rome uses
# to authenticate to Rome Cloud. It runs from the same image with no network,
# and shares only its socket with Rome. It starts before Rome so that Docker
# creates its volumes from the image, which owns /keys and /run/rome-signer as
# the signer's uid. Without a Rome Cloud origin there is nothing to sign for.
signer_name="${container_name}-signer"
stop_targets="$container_name"
if [[ -n "$(docker ps -aq --filter "name=^/${signer_name}$")" ]]; then
  echo "quickstart-docker: replacing existing container ${signer_name} (its key volume is kept)"
  docker rm -f "$signer_name" >/dev/null
fi
if [[ -n "$resolved_PANTHEON_BASE_ORIGIN" ]]; then
  docker run -d --name "$signer_name" --restart unless-stopped \
    --user 10001:10001 --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --network none \
    -e "SIGNER_AUDIENCE=${resolved_PANTHEON_BASE_ORIGIN}" \
    -e SIGNER_KEY_DIR=/keys \
    -e SIGNER_SOCKET=/run/rome-signer/signer.sock \
    -v "${container_name}-signer-key:/keys" \
    -v "${container_name}-signer-sock:/run/rome-signer" \
    --entrypoint node "$image" /opt/rome/packages/signer/dist/main.js >/dev/null
  docker_run_args+=(
    -v "${container_name}-signer-sock:/run/rome-signer:ro"
    -e ROME_SIGNER_SOCKET=/run/rome-signer/signer.sock
  )
  stop_targets="$container_name $signer_name"
else
  echo "quickstart-docker: PANTHEON_BASE_ORIGIN is empty, so Rome Cloud is off and no signer is started."
fi

docker_run_args+=("$image")
docker run "${docker_run_args[@]}" >/dev/null

# ─── Wait for the backend ───────────────────────────────────────────────────
# The daemon inherits the backend's stdio, so the backend's "Rome started"
# line lands in `docker logs` — the same readiness signal the dev loop uses.
echo "quickstart-docker: waiting for Rome to start (first boot can take a few minutes) ..."
deadline=$((SECONDS + wait_seconds))
while ! docker logs "$container_name" 2>&1 | grep -qF "Rome started"; do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container_name" 2>/dev/null)" != "true" ]]; then
    echo "" >&2
    echo "quickstart-docker: container ${container_name} exited during startup. Last log lines:" >&2
    docker logs --tail 50 "$container_name" >&2 || true
    exit 1
  fi
  if ((SECONDS >= deadline)); then
    echo "" >&2
    echo "quickstart-docker: Rome did not start within ${wait_seconds}s. Last log lines:" >&2
    docker logs --tail 50 "$container_name" >&2 || true
    echo "It may still be booting — follow it with: docker logs -f ${container_name}" >&2
    exit 1
  fi
  sleep 5
  printf '.'
done
echo ""

# ─── Done ───────────────────────────────────────────────────────────────────
open_url() {
  case "$(uname -s)" in
    Darwin)
      open "$1" >/dev/null 2>&1 || true
      ;;
    *)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

echo ""
echo "Rome is running."
echo "  Dashboard : http://localhost:${host_port}"
echo "  Logs      : docker logs -f ${container_name}"
echo "  Stop      : docker stop ${stop_targets}"
echo ""
echo "If it looks good, could you star the repo so more people can find it?"
echo "  ${ROME_REPO_URL}"
# /dev/tty, not stdin: under `curl | bash` stdin is the script itself. Skip
# the prompt entirely when no terminal is attached.
if [[ -t 1 && -r /dev/tty ]]; then
  repo_slug="${ROME_REPO_URL#https://github.com/}"
  gh_ready="false"
  # Probe the credential the PUT will use: gh auth status exits 1 when any
  # known github.com account is stale, even while the active account works.
  if command -v gh >/dev/null 2>&1 && gh api --hostname github.com user >/dev/null 2>&1; then
    gh_ready="true"
  fi
  if [[ "$gh_ready" == "true" ]]; then
    prompt="Star ${repo_slug} now? [Y/n] "
  else
    prompt="Open ${ROME_REPO_URL} in your browser to leave a star? [Y/n] "
  fi
  reply=""
  read -r -p "$prompt" reply </dev/tty || reply="n"
  case "$reply" in
    [Nn]*) ;;
    *)
      if [[ "$gh_ready" == "true" ]]; then
        # Pin the host: gh api honors GH_HOST, and the readiness check above
        # validated the github.com login specifically.
        if gh api --hostname github.com --method PUT "user/starred/${repo_slug}" >/dev/null 2>&1; then
          echo "Starred ${repo_slug} — thank you!"
        else
          # auth status passes on tokens that lack the starring scope.
          echo "quickstart-docker: gh could not star ${repo_slug} — opening it in your browser instead." >&2
          open_url "$ROME_REPO_URL"
        fi
      else
        open_url "$ROME_REPO_URL"
      fi
      ;;
  esac
fi
