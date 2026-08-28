# Development Setup

## Prerequisites

- [OrbStack](https://orbstack.dev/) or Docker Desktop — Rome and its observability stack run as containers.
- [Nix](https://nixos.org/) + [direnv](https://direnv.net/) — manage host-side Node.js + pnpm for tools that run outside the container (e.g., `pnpm typecheck` on the host, editor tooling).

## First-time setup

1. Install OrbStack (or Docker Desktop):

```bash
brew install --cask orbstack
```

2. Install Nix (Determinate Systems installer):

```bash
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
```

3. Install and configure direnv:

```bash
brew install direnv
echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc
source ~/.zshrc
```

4. (Optional) Auto-allow direnv for this repo and its worktrees. Add to `~/.config/direnv/direnv.toml`:

```toml
[whitelist]
prefix = ["/path/to/rome-internal"]
```

5. Set up the project:

```bash
cd rome-internal
direnv allow          # activates Nix shell (provides node, pnpm)
pnpm install          # install JS dependencies on the host (used by editor tooling)
```

6. Start developing:

```bash
pnpm dev:all          # Rome container + obs singleton + Traefik singleton
```

## Running processes

`pnpm dev:all` is the single entry point. It calls `scripts/dev-up.sh`, which:

- Ensures the `rome-traefik` singleton is up (shared across worktrees).
- Ensures the `rome-obs` singleton is up (OTLP + ClickHouse + HyperDX UI; shared across worktrees).
- Builds the Rome dev image and brings up the worktree's Compose project.
- Writes `.obs/env` with discovery URLs and attaches to `docker compose logs`.

For other flows:

```bash
pnpm dev:desktop      # Electron shell, host-native (desktop can't run in Linux container yet)
pnpm dev:cdp          # CDP client
```

To run a command inside the worktree's Rome container:

```bash
./r pnpm test         # any command: ./r <cmd>
./r bash              # interactive shell
```

## Test environment

Package test scripts run through `scripts/test-env.sh`, which starts the test
process with `env -i`. Runtime configuration and credentials from the invoking
shell therefore do not silently affect tests.

The wrapper preserves only `PATH`, `HOME`, and the platform temporary-directory
variables. It fixes `NODE_ENV=test`, `TZ=UTC`, and the locale to `C`. It also
preserves the presence of `CI` and `GITHUB_ACTIONS`, which test runners use to reject
focused tests and emit workflow annotations. Non-interactive output is fixed to
no-color mode; interactive watch runs retain their terminal presentation.
Additions to this allowlist should be explicit and covered by
`scripts/test-env.test.ts`; application configuration and secrets must not be
added.

This isolates process environment variables, not the filesystem: `HOME` remains
the developer's real home so local package tooling continues to work. Tests that
read or write home-derived state must redirect it to a temporary directory, as
the core `createTestRome` harness does.

To provide configuration to a deliberately environment-backed test, set it
inside the scrubbed process rather than on the outer `pnpm` command:

```bash
scripts/test-env.sh env TEST_DATABASE_URL=postgres://... pnpm exec rstest -c packages/core/rstest.config.ts path/to/example.integration.test.ts
```

The launcher requires a POSIX shell and supports the project's macOS and Linux
development environments. Native Windows development is not supported; use WSL
or the development container.

## Per-worktree state

`pnpm dev:all` gives each worktree a physically separate host directory
backing the container's `~/.rome`:

```
host:      ~/.rome-worktrees/<slug>/   (per worktree, slug-keyed)
container: /rome-home/.rome/           (always; profile = "default")
```

The compose bind-mount routes one to the other. Rome's code is unaware
anything is per-worktree — all the slug logic lives in
`scripts/dev-up.sh` and `compose.dev.yml`. This satisfies the
single-tenant invariant (see `docs/architecture/process.md`): lockfile, SQLite DB,
app data, memory, and runtime-status are per-worktree on disk, so
sibling worktrees cannot race on shared state.

Reset a worktree:

```bash
docker compose -f compose.dev.yml -p "$(scripts/worktree-slug.sh)" down -v
rm -rf ~/.rome-worktrees/<slug>
```

`git worktree remove` without first running `down -v` leaves an orphan
host dir, but it cannot pollute any other worktree.

**Gotcha:** bare-metal `pnpm start` (host Node, no container) still
writes to `~/.rome/<profile>/`, so it does *not* share state with
`pnpm dev:all`. Mixing the two paths against the same source tree
produces two separate sets of state. `pnpm dev:all` is canonical;
`pnpm start` is for debugging the host process.

## Logging

The backend outputs structured JSON logs to stdout. Today Rome wires only
an OTEL **trace** exporter; the log bridge into rome-obs is not live yet, so
`otel_logs` in ClickHouse stays empty (see `docs/observability/schema.md`).
Until the bridge lands, tail container stdout:

```bash
docker compose -f compose.dev.yml -p "$(scripts/worktree-slug.sh)" logs -f rome | jq
```

Traces (per-action spans via `action:<name>`, plus HTTP spans from the
auto-instrumentation) are queryable in HyperDX at
`http://obs.rome.localhost:3000` or via ClickHouse SQL — see
`docs/observability/schema.md`.
