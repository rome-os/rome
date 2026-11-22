#!/usr/bin/env bash
# Logs a dev stack's Codex in to a fake ChatGPT account served by server.mjs,
# through Codex's own config: no Rome code changes. Writes ~/.codex/auth.json
# (a ChatGPT login with unsigned tokens) and ~/.codex/config.toml (ChatGPT's
# backend at the fake server) in the stack's rome container.
# Codex needs https, so it also trusts the scratch CA from make-tls.sh, in this
# container only, and talks to server.mjs's TLS port (<port>+1). Codex
# refreshes the token at auth.openai.com, whose address only an env var Rome
# does not pass on can change, so this container's /etc/hosts sends that name
# to the host, where server.mjs answers on 443. It restarts Codex, not the
# container, which would rewrite /etc/hosts.
#   scripts/dev/fake-providers/use-fake-chatgpt.sh <compose-project> <tls-dir> [port]
#   scripts/dev/fake-providers/use-fake-chatgpt.sh <compose-project> --remove
# Dev only. Never run it against a stack that holds a real login.
set -euo pipefail
project="${1:?compose project, e.g. claude-my-branch}"
container="${project}-rome-1"
if [ "${2:-}" = "--remove" ]; then
  docker exec "$container" sh -c 'rm -f "$HOME/.codex/auth.json" "$HOME/.codex/config.toml" "$HOME/.codex/.rome-auth-revoked.json"'
  docker exec -u 0 "$container" sh -c 'rm -f /usr/local/share/ca-certificates/rome-fake-providers.crt && update-ca-certificates >/dev/null 2>&1; grep -v " auth.openai.com # rome-fake-providers" /etc/hosts > /tmp/hosts.rome && cat /tmp/hosts.rome > /etc/hosts'
  docker restart "$container" >/dev/null
  echo "fake ChatGPT removed from ${container}"
  exit 0
fi
tls="${2:?scratch TLS directory from make-tls.sh}"
port="${3:-18765}"
tls_port=$((port + 1))
docker exec -u 0 -i "$container" sh -c 'cat > /usr/local/share/ca-certificates/rome-fake-providers.crt && update-ca-certificates >/dev/null 2>&1' <"${tls}/ca.pem"
if docker exec "$container" sh -c 'test -f "$HOME/.codex/auth.json" && ! grep -q fake-chatgpt "$HOME/.codex/auth.json"'; then
  echo "use-fake-chatgpt: ${container} already holds a real-looking Codex login; refusing." >&2
  exit 1
fi
b64() { printf '%s' "$1" | base64 | tr -d '=\n' | tr '/+' '_-'; }
exp=$(($(date +%s) + 365 * 24 * 3600))
header=$(b64 '{"alg":"none","typ":"JWT"}')
claims=$(b64 "{\"email\":\"fake-chatgpt@example.com\",\"exp\":${exp},\"https://api.openai.com/auth\":{\"chatgpt_plan_type\":\"plus\",\"chatgpt_account_id\":\"fake-chatgpt-account\",\"chatgpt_user_id\":\"fake-chatgpt-user\"}}")
jwt="${header}.${claims}.fake-chatgpt"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# A revoked mark left from an earlier login would hide this one.
docker exec "$container" sh -c 'rm -f "$HOME/.codex/.rome-auth-revoked.json"'
docker exec -i "$container" sh -c 'mkdir -p "$HOME/.codex" && cat > "$HOME/.codex/auth.json"' <<JSON
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "${jwt}",
    "access_token": "${jwt}",
    "refresh_token": "fake-chatgpt-refresh",
    "account_id": "fake-chatgpt-account"
  },
  "last_refresh": "${now}"
}
JSON
docker exec -i "$container" sh -c 'cat > "$HOME/.codex/config.toml"' <<TOML
# Written by scripts/dev/fake-providers/use-fake-chatgpt.sh: ChatGPT's backend is the fake server.
chatgpt_base_url = "https://host.docker.internal:${tls_port}/backend-api/"
openai_base_url = "https://host.docker.internal:${tls_port}/backend-api/codex"
TOML
host_ip=$(docker exec "$container" getent hosts host.docker.internal | awk '{print $1; exit}')
# /etc/hosts is a bind mount, so it is rewritten in place rather than replaced.
docker exec -u 0 "$container" sh -c "grep -v ' auth.openai.com # rome-fake-providers' /etc/hosts > /tmp/hosts.rome; echo '${host_ip} auth.openai.com # rome-fake-providers' >> /tmp/hosts.rome; cat /tmp/hosts.rome > /etc/hosts"
# Rome starts Codex again with the new login and config.
docker exec "$container" sh -c 'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "codex.* app-server" && kill "${p#/proc/}"; done; true'
echo "fake ChatGPT login written to ${container}; Codex talks to https on host port ${tls_port}"
