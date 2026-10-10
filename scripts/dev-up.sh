#!/usr/bin/env bash
# Entry point for `pnpm dev:all`.
#
# Brings up the Rome dev environment as Docker containers and exits once
# the stack is ready:
#   1. Ensure the Traefik singleton is running (rome-traefik project).
#   2. Ensure the observability singleton is running (rome-obs project).
#   3. Build + up the worktree Compose project (Rome + browser sidecar).
#   4. Run `pnpm install --frozen-lockfile` inside the rome container.
#   5. Wait for /api/health + the configured Rome Cloud, seed the default guardian.
#   6. Write .obs/env with the worktree's URLs (shell KEY=VALUE).
#   7. Print the URL banner and exit. Containers keep running detached;
#      stop them with the command in the banner.
#
# Idempotent — safe to re-run.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

SLUG="$(scripts/worktree-slug.sh)"
export ROME_WORKTREE_SLUG="$SLUG"
ROME_PROFILE="${ROME_PROFILE:-default}"
export ROME_PROFILE
# Host uid/gid so the rome-workspace volume + the per-worktree .rome bind are
# writable inside the containers (macOS Docker forwards host ownership
# verbatim).
ROME_HOST_UID="$(id -u)"
ROME_HOST_GID="$(id -g)"
export ROME_HOST_UID ROME_HOST_GID

# Per-worktree host dir backing the container's ~/.rome — keeps siblings
# from racing on a shared lockfile/DB. See docs/assumption.md.
ROME_WORKTREE_HOME="${HOME}/.rome-worktrees/${SLUG}"
mkdir -p "$ROME_WORKTREE_HOME"

# `pnpm store path` returns the versioned path (e.g. .../store/v10); strip
# the suffix so the in-container pnpm picks its own v<N> underneath.
HOST_PNPM_STORE_VERSIONED="$(pnpm store path 2>/dev/null || true)"
if [ -z "$HOST_PNPM_STORE_VERSIONED" ]; then
  echo "dev-up: could not resolve host pnpm store via 'pnpm store path' — is pnpm installed on the host?" >&2
  exit 1
fi
ROME_HOST_PNPM_STORE="$(dirname "$HOST_PNPM_STORE_VERSIONED")"
mkdir -p "$ROME_HOST_PNPM_STORE"
export ROME_HOST_PNPM_STORE

# In-container installs read the registry from compose.dev.yml's
# npm_config_registry (${ROME_NPM_REGISTRY:-official}); host .npmrc files are
# invisible inside the container. When the var isn't set explicitly, default
# it to the host's effective registry so a local .npmrc mirror just works.
# A loopback host (localhost/127.0.0.1/::1 -- common for Verdaccio) means the
# host machine, so rewrite it to host.docker.internal; forwarding it verbatim
# would point the container back at itself and break the install.
if [ -z "${ROME_NPM_REGISTRY:-}" ]; then
  ROME_NPM_REGISTRY="$(pnpm config get registry 2>/dev/null || true)"
  case "$ROME_NPM_REGISTRY" in
    http://* | https://*)
      ROME_NPM_REGISTRY="$(printf '%s' "$ROME_NPM_REGISTRY" |
        sed -E 's#^(https?://)(localhost|127\.0\.0\.1|\[::1\]|::1)(:|/|$)#\1host.docker.internal\3#')"
      export ROME_NPM_REGISTRY
      ;;
    *) unset ROME_NPM_REGISTRY ;;
  esac
fi

# ---------------------------------------------------------------------------
# Reconcile helpers for the rome-edge singletons (obs, traefik).
#
# These singletons share a failure mode: each uses a fixed `container_name` and
# attaches to the *external* `rome-edge` network. When compose recreates such a
# container (it does so on any config-hash drift across invocations, even when
# the container is already healthy), the daemon intermittently fails to release
# the old endpoint before the new container claims the same name, and `up` dies
# with
#   Error response from daemon: failed to set up container networking:
#     endpoint with name <name> already exists in network rome-edge
# Because `rome-edge` is `external: true`, the orphaned endpoint outlives every
# compose project, so the *next* `dev:all` hits the same collision — and the
# failing `up` has already torn down the previously-healthy singleton, leaving
# the stack worse than before. That is the "dev:all got flaky" symptom.
#
# The real fix is to stop the spurious recreate. Compose's `up -d` is already
# idempotent — it only recreates a container when its config-hash drifts. The
# drift here is an artifact: these compose files bind-mount their assets via
# relative paths, so the resolved *absolute* source path is folded into the
# config-hash. Invoked from a worktree, every worktree computes a different hash
# for the byte-identical singleton, so each `up` recreates the previous
# worktree's container. We kill that by anchoring the shared singletons to the
# main working tree's path (see MAIN_WORKTREE below): the hash is then identical
# across worktrees and `up` leaves a converged singleton untouched, while still
# recreating on genuine config changes. The reclaim path below stays only as a
# safety net for the dangling-endpoint collision when a real recreate does run.
# ---------------------------------------------------------------------------

# Bring up a rome-edge singleton via compose's own idempotent `up`. If `up` hits
# the dangling-endpoint collision, reclaim the orphan once and retry with
# --force-recreate; if it still fails, surface the error and fail closed (never
# report success on a broken edge).
ensure_edge_singleton() {
  local out name
  if out="$("$@" 2>&1)"; then
    if [ -n "$out" ]; then printf '%s\n' "$out"; fi
    return 0
  fi
  name="$(printf '%s' "$out" |
    sed -n 's/.*endpoint with name \([^ ]*\) already exists in network rome-edge.*/\1/p' |
    head -1)"
  if [ -z "$name" ]; then
    printf '%s\n' "$out" >&2
    return 1
  fi
  echo "dev-up: reclaiming dangling rome-edge endpoint '${name}' and recreating ..." >&2
  docker network disconnect -f rome-edge "$name" >/dev/null 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  if "$@" --force-recreate; then return 0; fi
  echo "dev-up: ${name} could not claim its rome-edge endpoint even after reclaim." >&2
  echo "        A stale endpoint is wedged on the external rome-edge network. Clear it with:" >&2
  echo "          docker network disconnect -f rome-edge ${name}; docker rm -f ${name}" >&2
  echo "        then re-run pnpm dev:all. (If it persists, restart the Docker/OrbStack daemon.)" >&2
  return 1
}

# ---------------------------------------------------------------------------
# 0. Sanity — Docker is reachable.
# ---------------------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  echo "dev-up: docker daemon unreachable — is OrbStack / Docker Desktop running?" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 0.1. Slug collision — refuse to silently route another worktree's traffic
# into ours. If a project with this name is already up somewhere else, the
# user has two sibling worktrees with the same basename. Rename one.
# ---------------------------------------------------------------------------
existing_project_labels="$(
  docker ps --filter "label=com.docker.compose.project=${SLUG}" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' |
    sort -u
)"
if [ -n "$existing_project_labels" ]; then
  this_root="$(git rev-parse --show-toplevel)"
  other_roots=""
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    [ "$dir" = "$this_root" ] && continue
    other_roots="${other_roots}${dir}"$'\n'
  done <<<"$existing_project_labels"
  if [ -n "$other_roots" ]; then
    echo "dev-up: compose project \"${SLUG}\" is already running from another directory:" >&2
    while IFS= read -r dir; do
      [ -n "$dir" ] && printf '  %s\n' "$dir" >&2
    done <<<"$other_roots"
    echo "        Two worktrees share a basename. Rename one directory and retry." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 0.2. Preflight — drop containers in this project that reference a network
# that no longer exists. Compose pins network IDs onto exited containers; if
# the network was pruned or recreated under us (Docker Desktop restart, a
# sibling worktree's `compose down`, manual `network prune`), the next `up`
# fails with "network <id> not found". Removing the stale container lets
# compose recreate it on the current network. Bind-mounts and named volumes
# are unaffected.
# ---------------------------------------------------------------------------
existing_network_ids="$(docker network ls -q --no-trunc | tr '\n' ' ')"
stale_containers=""
while IFS= read -r cid; do
  [ -z "$cid" ] && continue
  netids="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.NetworkID}} {{end}}' "$cid" 2>/dev/null || true)"
  for nid in $netids; do
    case " $existing_network_ids " in
      *" $nid "*) ;;
      *)
        stale_containers="${stale_containers}${cid} "
        break
        ;;
    esac
  done
done < <(docker ps -a --filter "label=com.docker.compose.project=${SLUG}" --format '{{.ID}}')
if [ -n "$stale_containers" ]; then
  echo "dev-up: removing containers with stale network references: $stale_containers"
  # shellcheck disable=SC2086
  docker rm -f $stale_containers >/dev/null
fi

# ---------------------------------------------------------------------------
# 1. Traefik singleton — idempotent up.
# ---------------------------------------------------------------------------
# Anchor the shared singletons (traefik, obs) to the main working tree's path so
# their compose config-hash is identical across all worktrees (see the
# reconcile-helper comment above for why per-worktree paths cause recreate
# churn). Consequence: singleton config tracks main's infra/ — edit infra files
# in the main checkout for a change to take effect for every worktree.
# The first porcelain record is always `worktree <path>` for the main checkout.
# Parse it with pure bash rather than `... | head -1`: piping `git worktree list`
# into an early-closing reader (head/awk-exit) SIGPIPEs git mid-enumeration, and
# under `set -o pipefail` that aborts the whole script. It only bites on hosts
# with many worktrees (git is still streaming when the reader closes), so it
# stayed latent. No pipe = no SIGPIPE.
MAIN_WORKTREE="$(git worktree list --porcelain)"
MAIN_WORKTREE="${MAIN_WORKTREE#worktree }"
MAIN_WORKTREE="${MAIN_WORKTREE%%$'\n'*}"
if [ -z "$MAIN_WORKTREE" ] || [ ! -d "$MAIN_WORKTREE/infra" ]; then
  echo "dev-up: could not resolve the main working tree's infra/ for the shared singletons." >&2
  exit 1
fi

echo "dev-up: ensuring Traefik singleton is up ..."
ensure_edge_singleton docker compose -f "$MAIN_WORKTREE/infra/traefik/compose.yml" up -d

# The rome-edge DNS singleton (dnsmasq, brought up with Traefik above) answers
# `*.rome.localhost` with Traefik's IP so in-container lookups match the browser.
# Every worktree service forwards its Docker resolver's upstream at this
# container's rome-edge IP (compose.dev.yml `dns: [${ROME_DNSMASQ_IP}]`). We can't
# pin a static IP without recreating the shared external network (it would
# disconnect every live worktree), so we inspect the current IP and export it.
# `restart: unless-stopped` keeps that IP stable across daemon restarts; a fresh
# worktree `up` re-reads it, so a rare dnsmasq re-IP self-heals on the next dev:all.
ROME_DNSMASQ_IP="$(docker inspect -f \
  '{{with index .NetworkSettings.Networks "rome-edge"}}{{.IPAddress}}{{end}}' \
  rome-traefik-dnsmasq-1 2>/dev/null || true)"
if [ -z "$ROME_DNSMASQ_IP" ]; then
  echo "dev-up: could not resolve the rome-edge DNS singleton (rome-traefik-dnsmasq-1) IP." >&2
  echo "        In-container *.rome.localhost lookups would fail. Is the Traefik singleton up?" >&2
  exit 1
fi
export ROME_DNSMASQ_IP
echo "dev-up: rome-edge DNS singleton at ${ROME_DNSMASQ_IP} (dns upstream for *.rome.localhost)"

# ---------------------------------------------------------------------------
# 2. Observability singleton — OTLP + ClickHouse + HyperDX UI.
# ---------------------------------------------------------------------------
# Local dev emits OTLP to the bundled local ClickStack (the `obs` service:
# Collector + ClickHouse + HyperDX UI). Start only that — the standalone
# `otel-collector` (→ ClickHouse Cloud) is an opt-in prod-mirror path and is
# left out of local boot so it can't crash-loop when CH Cloud is unreachable.
echo "dev-up: ensuring observability singleton (rome-obs) is up ..."
ensure_edge_singleton docker compose -f "$MAIN_WORKTREE/infra/observability/compose.yml" up -d obs

# ---------------------------------------------------------------------------
# 2.1. Wait for the obs stack to be ready to ingest.
#
# Probe ClickHouse's /ping via the Traefik hop (clickhouse.rome.localhost → obs
# :8123): 200 means obs's storage backend — the slow part of the cold start
# ("Waiting for ClickHouse to be ready..." in the obs log) — is live, which is
# the gate that matters before the daemon emits. Once ClickHouse is up the
# bundled collector's OTLP receiver is already listening on :4318, where the
# daemon reaches it over compose DNS (rome-obs:4318) from inside rome-edge.
#
# We deliberately do NOT probe the OTLP receiver over Traefik
# (otlp.rome.localhost): that route is reserved (see infra/observability/
# compose.yml) and the daemon never uses it — the hop 404s an empty POST even
# while obs is fully healthy, so gating on it hangs dev:all for the whole
# timeout against a path nothing in prod exercises. ClickHouse /ping is
# host-reachable, unambiguous, and reflects real obs readiness.
# ---------------------------------------------------------------------------
echo "dev-up: waiting for obs singleton to become ready ..."
# Budget covers a *cold recreate* of the bundled ClickStack, not just a warm
# restart. The hyperdx-local image boots ClickHouse + Mongo + Collector + UI;
# on a cold recreate (first boot, post-Docker-restart, or after the
# endpoint-reclaim path above force-recreates it) ClickHouse takes ~130-150s
# here. A warm run leaves the converged obs untouched (compose's own idempotency
# — no recreate), so it answers on the first probe; this ceiling is only spent
# when obs actually had to come up.
attempts=0
until curl -fsS --max-time 3 -o /dev/null \
  http://clickhouse.rome.localhost:3000/ping 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 120 ]; then
    echo "dev-up: rome-obs never became ready (240s). Inspect:" >&2
    echo "        docker compose -f \"$MAIN_WORKTREE/infra/observability/compose.yml\" logs" >&2
    exit 1
  fi
  sleep 2
done
echo "dev-up: obs singleton ready"

# Rome Cloud is a separate repository and deployment. Use the shared service by
# default; developers can point at a staging or tunneled local Cloud checkout.
ROME_DEV_PANTHEON_ORIGIN="${ROME_DEV_PANTHEON_ORIGIN:-https://romeos.cc}"
ROME_DEV_PANTHEON_ORIGIN="${ROME_DEV_PANTHEON_ORIGIN%/}"
case "$ROME_DEV_PANTHEON_ORIGIN" in
  http://* | https://*) ;;
  *)
    echo "dev-up: ROME_DEV_PANTHEON_ORIGIN must be an http(s) origin, got: ${ROME_DEV_PANTHEON_ORIGIN}" >&2
    exit 1
    ;;
esac
export PANTHEON_BASE_ORIGIN="$ROME_DEV_PANTHEON_ORIGIN"
echo "dev-up: Rome Cloud -> ${PANTHEON_BASE_ORIGIN}"

# This instance's own public origin — the browser-reachable address Rome is
# served at, which core hands Rome Cloud as the enrollment redirect target. The
# rome container is NOT reachable at its own loopback (the browser reaches it
# through Traefik at <slug>.rome.localhost:3000), so core can't infer this — it
# must be told. Defaults to the Traefik host; override (e.g. an https tunnel to
# this stack's Rome) by exporting PANTHEON_INSTANCE_ORIGIN before `pnpm dev:all`.
export PANTHEON_INSTANCE_ORIGIN="${PANTHEON_INSTANCE_ORIGIN:-http://${SLUG}.rome.localhost:3000}"

# ---------------------------------------------------------------------------
# 3. Prepare the targeted runtime workspace and build the Rome dev image.
# ---------------------------------------------------------------------------
# A previous dev:all leaves the Rome container running detached. Quiesce it
# before the one-off `pnpm install` below mutates node_modules inside the shared
# rome-workspace volume — otherwise the running backend/Vite race the install on
# the same node_modules and the re-run hangs or restart-loops. rome-sync keeps
# running (it only touches source, never the ignored node_modules). The final
# `up --force-recreate` brings rome back; named volumes + per-worktree state
# remain.
if [ -n "$(docker compose -f compose.dev.yml -p "$SLUG" ps -q --status running rome)" ]; then
  echo "dev-up: stopping the existing Rome container before workspace rebuild ..."
  docker compose -f compose.dev.yml -p "$SLUG" stop rome
fi

echo "dev-up: preparing targeted Docker runtime workspace ..."
node scripts/docker/prepare-runtime-workspace.mjs

# Build the per-stack Rome images.
echo "dev-up: building dev images (rome + rome-sync + chrome) ..."
docker compose -f compose.dev.yml -p "$SLUG" build rome rome-sync chrome

# ---------------------------------------------------------------------------
# 3b. Start the source-sync sidecar and wait for its initial flush.
#
# rome-sync bind-mounts the worktree READ-ONLY and runs a local mutagen
# one-way-replica session into the container-owned rome-workspace volume
# (.gitignore-honored, so node_modules/dist never sync in). The volume must hold
# source before the install/build steps below — and before the rome backend —
# run against it, so block here until the sidecar reports healthy (its
# healthcheck flips once the initial `mutagen sync flush` completes). `--wait`
# fails closed on timeout so we never proceed against an empty /workspace.
# ---------------------------------------------------------------------------
echo "dev-up: starting source-sync sidecar (mutagen) and waiting for initial sync ..."
if ! docker compose -f compose.dev.yml -p "$SLUG" up -d --wait --wait-timeout 300 rome-sync; then
  echo "dev-up: rome-sync sidecar never became healthy (initial mutagen sync)." >&2
  echo "        Inspect: docker compose -f compose.dev.yml -p ${SLUG} logs rome-sync" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Sync node_modules to match the current lockfile.
#    Runs in a one-off container with --no-deps so the rome-workspace volume is
#    populated before any service that needs node_modules starts. (rome-sync is
#    already up from step 3b, so --no-deps won't restart it.)
# ---------------------------------------------------------------------------
# pnpm 11 reads/writes its global config at $HOME/.config/pnpm/config.yaml on
# every invocation (pnpm 10 silently tolerated an unreadable HOME). The
# rome-home named volume can carry root/stale-uid ownership from stacks created
# before the image pre-chmodded /rome-home, which turns that into a hard EACCES
# for the runtime uid — failing both this sync and the daemon's per-app
# `pnpm install` at boot. Reconcile the mountpoint plus pnpm's config/cache
# dirs to the runtime uid. Non-recursive on /rome-home itself (its contents
# include the host bind-mounted .rome); recursive only on .config/.cache.
# Idempotent.
docker compose -f compose.dev.yml -p "$SLUG" run --rm --no-deps -T --user 0:0 rome \
  sh -c "chown ${ROME_HOST_UID}:${ROME_HOST_GID} /rome-home \
      && mkdir -p /rome-home/.config /rome-home/.cache \
      && chown -R ${ROME_HOST_UID}:${ROME_HOST_GID} /rome-home/.config /rome-home/.cache"

echo "dev-up: syncing node_modules (pnpm install --frozen-lockfile) ..."
# node_modules lives inside the rome-workspace volume and persists across runs.
# When a config change makes the existing node_modules incompatible with the
# active store (e.g. a
# npm_config_store_dir migration), pnpm purges + reinstalls the modules dir, but
# first blocks on an interactive confirmation. This one-off container has no TTY
# (-T), so the prompt aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
# pnpm only skips that prompt when CI is set — confirm-modules-purge does NOT
# cover the no-TTY case. Scope CI to this install so it can't leak into the
# long-running daemon's tooling.
if ! docker compose -f compose.dev.yml -p "$SLUG" run --rm --no-deps -T -e CI=true rome pnpm install --frozen-lockfile \
  --filter @rome/core... \
  --filter @rome/discord-cli... \
  --filter @rome-os/node... \
  --filter rome-web... \
  --filter @rome-os/app-web-sdk... \
  --filter @rome-os/app-runtime... \
  --filter './rome_apps/*...'; then
  echo "dev-up: pnpm install failed — see the output above." >&2
  echo "        If package.json changed intentionally, update pnpm-lock.yaml on the host," >&2
  echo "        then re-run pnpm dev:all." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4b. Pre-pack the first-party app artifacts. `pnpm build:apps` builds the
#     rome_apps (and app SDKs), then packs each into dist/first-party-artifacts/
#     <id>/ — first-party apps are installed (not packed) from there at boot.
#     Runs inside the container so the artifacts land in the rome-workspace
#     volume, visible to the booting daemon. Idempotent: re-packs cleanly.
#
#     This single `pnpm -r` pass also builds @rome-os/app-web-sdk +
#     @rome-os/app-runtime: build:apps filters them in alongside rome_apps/*,
#     and pnpm runs the recursive build in topological order, so the SDKs
#     (whose dist/ holds the `rome build` CLI the apps' build scripts invoke)
#     compile before any app that depends on them. No separate SDK pre-build
#     step is needed — it would only duplicate this work and add a container.
# ---------------------------------------------------------------------------
echo "dev-up: pre-packing first-party app artifacts ..."
if ! docker compose -f compose.dev.yml -p "$SLUG" run --rm --no-deps -T rome \
  pnpm build:apps; then
  echo "dev-up: first-party app prepack failed — see the output above." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4c. Register the Rome OpenCLI plugins (every opencli-plugins/<site>/ dir,
#     installed as plugin "rome-<site>") with the in-container opencli. A local
#     plugin install is a symlink into ~/.opencli/plugins (HOME=/rome-home,
#     persistent volume), so host source edits flow through the mutagen sync
#     with no reinstall — the install only has to happen once per rome-home
#     volume. Idempotent; non-fatal because the stack is fully functional with
#     just the built-in opencli commands.
# ---------------------------------------------------------------------------
echo "dev-up: registering Rome opencli plugins ..."
if ! docker compose -f compose.dev.yml -p "$SLUG" run --rm --no-deps -T rome sh -c '
  failed=0
  for plugin_src in /workspace/opencli-plugins/*/; do
    plugin_src="${plugin_src%/}"
    [ -f "$plugin_src/opencli-plugin.json" ] || continue
    plugin_link="$HOME/.opencli/plugins/rome-$(basename "$plugin_src")"
    # Require the host-opencli link (the LAST install artifact) so a half-failed
    # prior install is retried, not skipped.
    if [ "$(readlink "$plugin_link" 2>/dev/null)" = "$plugin_src" ] &&
      [ -e "$plugin_src/node_modules/@jackwener/opencli/package.json" ]; then continue; fi
    rm -rf "$plugin_link"
    opencli plugin install "$plugin_src" || failed=1
  done
  exit "$failed"
'; then
  echo "dev-up: warning — opencli plugin install failed; built-in opencli commands remain available." >&2
fi

# ---------------------------------------------------------------------------
# 5. Start the worktree stack.
#
# Plain `up -d` — NOT `--force-recreate`. The only reason this step ever forced
# a recreate was the old bind-mount "zombie inode" hazard (#274): `/workspace`
# used to bind-mount `.docker/rome-runtime-workspace/`, which prepare-runtime-
# workspace.mjs `rm -rf`s every run, so a live container ended up pinned to a
# deleted inode and had to be recreated to reattach. `/workspace` is now a
# mutagen-fed named volume (rome-workspace), so that inode never dies and the
# hazard is gone. With it gone, force-recreate is pure cost: it tore down and
# rebooted Rome and Chrome on EVERY re-run even when nothing changed,
# adding the container recreate plus a full backend re-boot/health wait (~30s+).
#
# Plain `up -d` is the right idempotent primitive here, verified against a
# converged stack:
#   - converged       → no-op, same container ids, backend left running (~1s);
#   - genuine drift    → compose recreates only the drifted service (its default);
#   - chrome lockstep  → when rome IS recreated, `up -d` detects chrome's stale
#                        `network_mode: service:rome` namespace and recreates
#                        chrome on its own — no blanket force needed.
# rome's depends_on holds start ordering (waits for rome-sync healthy). Step 3
# stopped rome before the install; `up -d` restarts it against the freshly
# synced node_modules in the volume.
# ---------------------------------------------------------------------------
echo "dev-up: starting worktree stack (project=${SLUG}) ..."
# Per-worktree stack (project=$SLUG); the reclaim path protects against a wedged
# rome-edge endpoint.
ensure_edge_singleton docker compose -f compose.dev.yml -p "$SLUG" up -d rome chrome

# ---------------------------------------------------------------------------
# 5b. Wait for /api/health so the readiness banner doesn't print before
# `Rome started`. The daemon installs every packed first-party app on boot
# from dist/first-party-artifacts/ and re-applies any whose artifact hash
# changed — to pick up source-content drift after editing `rome_apps/<id>/`,
# re-run `pnpm build:apps` and restart the rome container.
# ---------------------------------------------------------------------------
echo "dev-up: waiting for backend to come up ..."
attempts=0
until curl -fsS --max-time 3 -o /dev/null "http://${SLUG}.rome.localhost:3000/api/health" 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 60 ]; then
    echo "dev-up: backend never answered /api/health (120s)." >&2
    echo "        Inspect: docker logs ${SLUG}-rome-1" >&2
    exit 1
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
# 5b'. Wait for Rome Cloud from both the host and the Rome container. The two
# probes cover the browser-facing and server-side OAuth/provisioning paths.
# ---------------------------------------------------------------------------
ROME_CLOUD_URL="$PANTHEON_BASE_ORIGIN"
echo "dev-up: waiting for Rome Cloud to serve (${ROME_CLOUD_URL}) ..."
attempts=0
until curl -fsS --max-time 3 -o /dev/null "$ROME_CLOUD_URL" 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 90 ]; then
    echo "dev-up: Rome Cloud (${ROME_CLOUD_URL}) never answered (180s)." >&2
    echo "        Check ROME_DEV_PANTHEON_ORIGIN and network reachability." >&2
    exit 1
  fi
  sleep 2
done
if ! docker compose -f compose.dev.yml -p "$SLUG" exec -T rome \
  curl -fsS --max-time 10 -o /dev/null "$PANTHEON_BASE_ORIGIN" 2>/dev/null; then
  echo "dev-up: Rome Cloud (${PANTHEON_BASE_ORIGIN}) is unreachable from inside Rome." >&2
  echo "        Server-side OAuth and provisioning flows will fail. Inspect with:" >&2
  echo "        docker compose -f compose.dev.yml -p ${SLUG} exec rome curl -v ${PANTHEON_BASE_ORIGIN}" >&2
  exit 1
fi
echo "dev-up: Rome Cloud is serving (host + in-container)"

# ---------------------------------------------------------------------------
# 5c. Ensure a default guardian account exists so the dashboard is usable
# without walking through the onboarding wizard each time a worktree is
# brought up. Idempotent: if a guardian already exists, skip.
#
# Defaults — overridable via env:
#   ROME_DEV_USERID         (default: dev)
#   ROME_DEV_PASSWORD       (default: rome-dev-default; min 8 chars)
#   ROME_DEV_GUARDIAN_NAME  (default: Dev)
# ---------------------------------------------------------------------------
ROME_DEV_USERID="${ROME_DEV_USERID:-dev}"
ROME_DEV_PASSWORD="${ROME_DEV_PASSWORD:-rome-dev-default}"
ROME_DEV_GUARDIAN_NAME="${ROME_DEV_GUARDIAN_NAME:-Dev}"

if [ "${#ROME_DEV_PASSWORD}" -lt 8 ]; then
  echo "dev-up: ROME_DEV_PASSWORD must be at least 8 characters." >&2
  exit 1
fi

ROME_API_BASE="http://${SLUG}.rome.localhost:3000"
echo "dev-up: checking guardian account state ..."
# /api/health can start returning OK before the system app's DB + repos finish
# initializing, so /api/bootstrap may still 500 for a brief window. Retry
# with the same cadence as the /api/health wait above.
attempts=0
guardian_state=""
until guardian_state="$(curl -fsS --max-time 5 "${ROME_API_BASE}/api/bootstrap" 2>/dev/null)" && [ -n "$guardian_state" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -gt 30 ]; then
    echo "dev-up: /api/bootstrap never returned a valid response (60s)." >&2
    echo "        Inspect: docker logs ${SLUG}-rome-1" >&2
    exit 1
  fi
  sleep 2
done

# if printf '%s' "$guardian_state" | grep -q '"exists":true'; then
#   echo "dev-up: guardian already exists — skipping default-account bootstrap."
# else
#   echo "dev-up: creating default guardian account (userId=${ROME_DEV_USERID}) ..."
#   cookie_jar="$(mktemp -t rome-dev-up-cookies.XXXXXX)"
#   trap 'rm -f "$cookie_jar"' EXIT
#
#   account_payload="$(printf '{"userId":"%s","password":"%s"}' "$ROME_DEV_USERID" "$ROME_DEV_PASSWORD")"
#   if ! curl -fsS --max-time 10 \
#       -c "$cookie_jar" \
#       -H "Content-Type: application/json" \
#       -X POST \
#       --data "$account_payload" \
#       "${ROME_API_BASE}/api/onboard/create-account" >/dev/null; then
#     echo "dev-up: /api/onboard/create-account failed." >&2
#     exit 1
#   fi

#   setup_payload="$(printf '{"profile":{"guardianName":"%s"}}' "$ROME_DEV_GUARDIAN_NAME")"
#   if ! curl -fsS --max-time 10 \
#       -b "$cookie_jar" -c "$cookie_jar" \
#       -H "Content-Type: application/json" \
#       -X POST \
#       --data "$setup_payload" \
#       "${ROME_API_BASE}/api/onboard/setup" >/dev/null; then
#     echo "dev-up: /api/onboard/setup failed." >&2
#     exit 1
#   fi
#
#   if ! curl -fsS --max-time 10 \
#       -b "$cookie_jar" -c "$cookie_jar" \
#       -X POST \
#       "${ROME_API_BASE}/api/onboard/complete" >/dev/null; then
#     echo "dev-up: /api/onboard/complete failed." >&2
#     exit 1
#   fi
#
#   rm -f "$cookie_jar"
#   trap - EXIT
#   echo "dev-up: default guardian account ready."
# fi

# ---------------------------------------------------------------------------
# 6. Write .obs/env — URL discovery for agents and scripts.
# ---------------------------------------------------------------------------
mkdir -p .obs
ROME_URL="http://${SLUG}.rome.localhost:3000"
OBS_UI_URL="http://obs.rome.localhost:3000"
ROME_OBS_QUERY_URL="http://clickhouse.rome.localhost:3000"

cat >.obs/env <<EOF
# Auto-generated by scripts/dev-up.sh — regenerated every
# \`pnpm dev:all\`. Consumed by agents and ad-hoc shell queries:
#   export \$(cat .obs/env | xargs)
# PANTHEON_SLUG is the telemetry service.instance.id. Dev sets no PANTHEON_SLUG
# (tenant-less self-hosted), so dev telemetry lands under \`unknown\`, shared by
# every worktree — obs queries can't filter one worktree from another.
PANTHEON_SLUG=${PANTHEON_SLUG:-unknown}
ROME_URL=${ROME_URL}
ROME_CLOUD_URL=${ROME_CLOUD_URL}
OBS_UI_URL=${OBS_UI_URL}
ROME_OBS_QUERY_URL=${ROME_OBS_QUERY_URL}
ROME_OBS_AUTH_TOKEN=
EOF

# ---------------------------------------------------------------------------
# 7. Banner.
# ---------------------------------------------------------------------------
# `ROME_WORKTREE_SLUG=...` prefix is load-bearing: compose.dev.yml uses
# required interpolation (:?) on the slug, so the file won't parse from a
# fresh shell otherwise.
cat <<EOF

┌─ Rome dev stack up (instance=${SLUG}) ────────────────────────
│ Dashboard     : ${ROME_URL}
│ Rome Cloud    : ${ROME_CLOUD_URL}
│ Observability : ${OBS_UI_URL}           (HyperDX UI)
│ ClickHouse    : ${ROME_OBS_QUERY_URL}   (raw SQL over HTTP)
│
│ Login as      : ${ROME_DEV_USERID} / ${ROME_DEV_PASSWORD}
│                 (override via ROME_DEV_USERID / ROME_DEV_PASSWORD)
│
│ In-container  :  ./r pnpm test   (./r <cmd>)
│ Logs          :  docker compose -f compose.dev.yml -p ${SLUG} logs -f
│ Stop stack    :  ROME_WORKTREE_SLUG=${SLUG} docker compose -f compose.dev.yml -p ${SLUG} stop
│ Nuke volumes  :  ROME_WORKTREE_SLUG=${SLUG} docker compose -f compose.dev.yml -p ${SLUG} down -v
│ Reset state   :  rm -rf ${ROME_WORKTREE_HOME}
│
│ URL env       :  .obs/env (shell KEY=VALUE)
└───────────────────────────────────────────────────────────────

EOF
