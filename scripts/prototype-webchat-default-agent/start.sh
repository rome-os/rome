#!/usr/bin/env bash
# PROTOTYPE (webchat-default-agent): run a throwaway local Rome on its own
# profile and port. Usage: scripts/prototype-webchat-default-agent/start.sh
# Needs `pnpm install`, `pnpm build:apps`, `pnpm --filter rome-web build` first.
#
# `env -i` is deliberate: on a host that already runs Rome, the shell carries
# that instance's identity (PANTHEON_SLUG, ROME_INSTANCE_TOKEN, Statsig and
# OAuth keys). Inheriting them makes this throwaway instance act as the real one
# against Rome Cloud (relay mailbox mint + drain, cloud-auth gate).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${ROME_PROFILE:-wda-proto}"
PORT="${INTERNAL_API_PORT:-4310}"
SECRET_FILE="$HOME/.rome/$PROFILE.jwt-secret"
mkdir -p "$HOME/.rome"
[ -f "$SECRET_FILE" ] || (umask 077; head -c 32 /dev/urandom | base64 > "$SECRET_FILE")
cd "$ROOT/packages/core"
exec env -i \
  PATH="$PATH" HOME="$HOME" TZ=UTC \
  ROME_PROFILE="$PROFILE" \
  INTERNAL_API_PORT="$PORT" \
  INTERNAL_API_WEB_ROOT="$ROOT/packages/web/dist" \
  ROME_JWT_SECRET="$(cat "$SECRET_FILE")" \
  PANTHEON_BASE_ORIGIN="http://127.0.0.1:9" \
  pnpm exec tsx src/index.ts
