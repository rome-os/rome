# The environment's own Rome Cloud, sourced by env.sh. It runs the Rome Cloud
# ref under test with a database of its own, on the environment's network
# only, and its transcription provider is the stand-in (or real Soniox).
# The environment's Rome signs in to it with an instance token the
# environment writes into its database, as Rome Cloud's dev tokens do.

CLOUD="rome-env-${NAME}-cloud"
CLOUD_PG="rome-env-${NAME}-cloud-pg"
CLOUD_PG_VOLUME="rome-env-${NAME}-cloud-pg"
CLOUD_RUNNER_IMAGE="node:24-bookworm"
CLOUD_REPO="${ROME_CLOUD_REPO:-$HOME/workspace/rome-cloud}"
CLOUD_REF="${VOICE_CLOUD_REF:-origin/main}"
CLOUD_DIR="$STATE_DIR/rome-cloud"
CLOUD_ENV_FILE="$RUN_DIR/cloud.env"
CLOUD_BUILD_FILE="$RUN_DIR/cloud-build.json"
# Rome Cloud, as Rome sees it on the environment's network.
CLOUD_ORIGIN="http://cloud:3100"
CLOUD_ACCOUNT_EMAIL="guardian@voice-input.invalid"
STAND_IN_API_URL="http://transcriber:8790"

cloud_sql() { docker exec -i "$CLOUD_PG" psql -U pantheon -d pantheon -v ON_ERROR_STOP=1 -qAt "$@"; }

checkout_cloud() {
  [ -d "$CLOUD_REPO/.git" ] || die "no Rome Cloud clone at $CLOUD_REPO (set ROME_CLOUD_REPO)"
  git -C "$CLOUD_REPO" fetch --quiet origin
  git -C "$CLOUD_REPO" fetch --quiet origin "${CLOUD_REF#origin/}" 2>/dev/null || true
  git -C "$CLOUD_REPO" rev-parse --verify --quiet "$CLOUD_REF^{commit}" >/dev/null ||
    die "cannot resolve the Rome Cloud ref \"$CLOUD_REF\". Set VOICE_CLOUD_REF to a branch or commit."
  if [ ! -e "$CLOUD_DIR/.git" ]; then
    git -C "$CLOUD_REPO" worktree add --quiet --detach "$CLOUD_DIR" "$CLOUD_REF"
  else
    git -C "$CLOUD_DIR" checkout --quiet --force --detach "$CLOUD_REF"
  fi
  printf '{"ref":"%s","commit":"%s","checkedOutAt":"%s"}\n' \
    "$CLOUD_REF" "$(git -C "$CLOUD_DIR" rev-parse HEAD)" "$(date -u +%FT%TZ)" >"$CLOUD_BUILD_FILE"
  log "Rome Cloud at $(git -C "$CLOUD_DIR" rev-parse --short HEAD) ($CLOUD_REF)"
}

# Runs a command in the Rome Cloud checkout, as this user.
in_cloud_runner() {
  docker run --rm --network "$NETWORK" --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e npm_config_store_dir="$STATE_DIR/pnpm-store" \
    --env-file "$CLOUD_ENV_FILE" \
    -v "$STATE_DIR:$STATE_DIR" -w "$CLOUD_DIR" \
    "$CLOUD_RUNNER_IMAGE" bash -c "$1"
}

cloud_kept() { [ ! -f "$CLOUD_ENV_FILE" ] || sed -n "s/^$1=//p" "$CLOUD_ENV_FILE"; }

# Rewritten on every start, so the transcriber switch reaches Rome Cloud.
write_cloud_env() {
  local jwt token_key relay_key mode gate
  jwt="$(cloud_kept PANTHEON_JWT_SECRET)"
  token_key="$(cloud_kept PANTHEON_OAUTH_TOKEN_ENCRYPTION_KEY)"
  relay_key="$(cloud_kept RELAY_SIGNING_KEY)"
  [ -n "$jwt" ] || jwt="$(openssl rand -hex 32)"
  [ -n "$token_key" ] || token_key="$(openssl rand -hex 32)"
  [ -n "$relay_key" ] || relay_key="$(node -e "const {privateKey}=require('crypto').generateKeyPairSync('ed25519');console.log(JSON.stringify(privateKey.export({format:'jwk'})))")"
  mode="$(state transcriber || true)"
  gate="$(state cloudGate || true)"
  {
    echo "DATABASE_URL=postgresql://pantheon:pantheon@${CLOUD_PG}:5432/pantheon"
    echo "PANTHEON_JWT_SECRET=$jwt"
    echo "PANTHEON_OAUTH_TOKEN_ENCRYPTION_KEY=$token_key"
    echo "PANTHEON_DOMAIN=voice-input.invalid"
    echo "NEXT_PUBLIC_PANTHEON_DOMAIN=voice-input.invalid"
    echo "PANTHEON_BASE_ORIGIN=$CLOUD_ORIGIN"
    echo "NEXT_TELEMETRY_DISABLED=1"
    echo "CLICKHOUSE_ENDPOINT=http://clickhouse.invalid:8123"
    echo "CLICKHOUSE_INSTANCE_USERNAME=none"
    echo "CLICKHOUSE_INSTANCE_PASSWORD=none"
    echo "RELAY_ORIGIN=https://relay.invalid"
    echo "RELAY_SIGNING_KEY=$relay_key"
    # Voice input's per-account gate, forced for every account without Statsig.
    echo "FEATURE_GATE_VOICE_INPUT=${gate:-on}"
    echo "TRANSCRIPTION_PROVIDER=soniox"
    if [ "$mode" = real ]; then
      [ -n "${SONIOX_API_KEY:-}" ] || die "transcriber real needs SONIOX_API_KEY in $SECRETS_FILE"
      # Soniox's own addresses are Rome Cloud's defaults.
      echo "TRANSCRIPTION_API_KEY=$SONIOX_API_KEY"
    else
      echo "TRANSCRIPTION_API_KEY=$STAND_IN_KEY"
      echo "TRANSCRIPTION_API_URL=$STAND_IN_API_URL"
      echo "TRANSCRIPTION_STREAM_URL=$STAND_IN_URL"
    fi
  } >"$CLOUD_ENV_FILE.new"
  mv "$CLOUD_ENV_FILE.new" "$CLOUD_ENV_FILE"
}

start_cloud_db() {
  if [ -z "$(docker ps -aq --filter "name=^${CLOUD_PG}$")" ]; then
    docker run -d --name "$CLOUD_PG" --network "$NETWORK" --restart unless-stopped --memory 1g \
      -e POSTGRES_USER=pantheon -e POSTGRES_PASSWORD=pantheon -e POSTGRES_DB=pantheon \
      -v "$CLOUD_PG_VOLUME:/var/lib/postgresql/data" postgres:16 >/dev/null
  fi
  docker start "$CLOUD_PG" >/dev/null
  local attempts=0
  until docker exec "$CLOUD_PG" pg_isready -U pantheon -q 2>/dev/null &&
    cloud_sql -c 'select 1' >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 60 ] || die "Rome Cloud's database never answered. Inspect: docker logs $CLOUD_PG"
    sleep 1
  done
}

start_cloud() {
  docker rm -f "$CLOUD" >/dev/null 2>&1 || true
  docker run -d --name "$CLOUD" --restart unless-stopped --memory 4g \
    --network "$NETWORK" --network-alias cloud \
    --user "$(id -u):$(id -g)" -e HOME=/tmp --env-file "$CLOUD_ENV_FILE" \
    -v "$STATE_DIR:$STATE_DIR" -w "$CLOUD_DIR/packages/pantheon" \
    "$CLOUD_RUNNER_IMAGE" node_modules/.bin/next dev --port 3100 --hostname 0.0.0.0 >/dev/null
  log "waiting for Rome Cloud ..."
  local attempts=0
  until [ "$(cloud_curl -o /dev/null -w '%{http_code}' /api/health 2>/dev/null)" = 200 ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 120 ] || die "Rome Cloud never answered. Inspect: docker logs $CLOUD"
    sleep 2
  done
  # The dev server compiles a route on its first request. Compile the routes
  # Rome calls now, so the first listening session is not the one that waits.
  local path
  for path in /v1/transcription/sessions /v1/usage/events; do
    cloud_curl -o /dev/null -X POST "$path" || true
  done
  cloud_curl -o /dev/null /v1/usage || true
}

# curl against Rome Cloud from inside its container.
cloud_curl() {
  local args=()
  while [ $# -gt 1 ]; do args+=("$1") && shift; done
  docker exec "$CLOUD" curl -sS --max-time 180 "${args[@]}" "http://127.0.0.1:3100$1"
}

# One account, and one instance token on it for the environment's Rome. The
# token is kept in the state file; Rome Cloud stores only its hash.
ensure_cloud_instance() {
  local token instance_id hash account
  token="$(state cloud.instanceToken || true)"
  if [ -n "$token" ]; then
    hash="$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)"
    [ -n "$(cloud_sql -c "select 1 from account_instances where token_hash = '$hash' and status = 'active'")" ] && return
  fi
  account="$(cloud_sql -c "insert into users (email, slug) values ('$CLOUD_ACCOUNT_EMAIL', 'voice-input-guardian')
    on conflict (email) do update set email = excluded.email returning id")"
  token="romeinst_$(openssl rand 32 | basenc --base64url | tr -d '=\n')"
  instance_id="$(openssl rand -hex 16)"
  hash="$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)"
  cloud_sql -c "insert into account_instances (account_id, public_handle, token_hash, name, origin)
    values ('$account', '$instance_id', '$hash', 'voice input environment', 'dev')" >/dev/null
  set_state "{\"cloud\":{\"instanceToken\":\"$token\",\"instanceId\":\"$instance_id\",\"accountId\":\"$account\"}}"
}

cmd_cloud_up() {
  checkout_cloud
  write_cloud_env
  log "installing Rome Cloud's dependencies ..."
  in_cloud_runner "corepack pnpm install --frozen-lockfile --reporter=silent"
  start_cloud_db
  log "migrating Rome Cloud's database ..."
  in_cloud_runner "cd packages/pantheon && node_modules/.bin/drizzle-kit migrate --config drizzle.config.ts >/dev/null"
  ensure_cloud_instance
  start_cloud
}

# Empties Rome Cloud's database: the account, its instance, its sessions and usage.
remove_cloud_data() {
  docker rm -f "$CLOUD" "$CLOUD_PG" >/dev/null 2>&1 || true
  docker volume rm "$CLOUD_PG_VOLUME" >/dev/null 2>&1 || true
  [ ! -f "$STATE_FILE" ] || set_state '{"cloud":null}'
}

# Calls Rome Cloud as Rome does: from inside Rome's container, with a token
# from Rome's signer. Prints {status, body}, with any minted key removed.
#   cloud_call POST /v1/transcription/sessions
cloud_call() {
  docker exec -e "CALL_METHOD=$1" -e "CALL_PATH=$2" "$ROME" sh -c 'cd /opt/rome/packages/core && node --input-type=module -e "
    const { requestSignerToken } = await import(\"@rome-os/node-core/signer\");
    const token = await requestSignerToken(process.env.ROME_SIGNER_SOCKET);
    const method = process.env.CALL_METHOD;
    const r = await fetch(process.env.PANTHEON_BASE_ORIGIN + process.env.CALL_PATH, {
      method, headers: { authorization: \"Bearer \" + token, \"content-type\": \"application/json\" },
      body: method === \"GET\" ? undefined : \"{}\" });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { text }; }
    if (body && typeof body.token === \"string\") body.token = \"(removed)\";
    console.log(JSON.stringify({ status: r.status, body }, null, 2));
  "'
}

# Points the stand-in at Rome Cloud's temporary keys, or back at the
# long-lived key, to match how Rome signs in.
apply_stand_in_keys() {
  local minted=false
  [ "$(state signIn || echo cloud)" = cloud ] && minted=true
  curl -fsS -X PUT --data-binary "{\"mintedOnly\":$minted}" \
    "http://127.0.0.1:$TRANSCRIBER_CONTROL_PORT/keys" >/dev/null
}
