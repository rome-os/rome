# Process & Deployment

How a Rome process is bound to its host and its [profile](../concepts/deployment.md#profiles), how it identifies itself as an [instance](../concepts/deployment.md#instances), and how state mutations are serialised through it. The vocabulary is defined alongside in [`../concepts/deployment.md`](../concepts/deployment.md). This doc is about the runtime shape and the rules that fall out of it.

## Components

The shape is deliberately spare — there is no clustering, no leader election, no inter-process coordination layer:

- **One Rome process per `(host, profile)`.** The HTTP entry point is the only writer to profile state. Lifecycle CLI commands (`pnpm app:install`, `pnpm app:uninstall`, …) are HTTP clients of this same process.
- **The lockfile** at `~/.rome/<profile>/lockfile.json` is the durable boundary of profile state.
- **An in-process mutex** serialises every lifecycle mutation that crosses the lockfile boundary. Concurrency control is in-process only.
- **An identity pair** — `PANTHEON_SLUG` (instance slug: telemetry / operator tooling) and `ROME_PROFILE` (data isolation) — names the running process for each axis independently. In prod `PANTHEON_SLUG` is the Rome-Cloud-injected tenant slug. Dev is tenant-less and sets no `PANTHEON_SLUG`, so its telemetry `service.instance.id` is `unknown` (shared across worktrees), while the in-container profile stays `default`.

## Invariants

- **Single-tenant.** Two Rome processes pointing at the same `(host, profile)` is undefined behaviour. The atomic rename + fsync on lockfile writes guards against crashes, not peers.
- **Instance ≠ profile.** A profile isolates user data (DB, memory, apps). An instance identifies the running Rome itself. Observability and operator tooling key on the instance, never on the profile.
- **Atomicity stops at the lockfile boundary.** Lockfile writes are all-or-nothing (temp-file + rename + fsync, file *and* parent directory). Hot-swap *below* the lockfile is best-effort — no atomic rollback. The recovery model is soft degradation: warnings, "failed" status entries, ignored hooks. No automatic retry.

- **The daemon's exit is the container's exit.** In the production image, when the health-check daemon exits on its own, the container stops with the daemon's exit code, so a restart policy reads a crash as a failure. Nothing inside the container restarts the daemon.
- **A crashed supporting service leaves the daemon running.** The desktop, the browser, sshd, tailscaled, and Caddy each restart on their own when they exit.
- **One-time setup finishes before anything reads its output.** A service that reads the synced app code or the generated proxy config starts only after setup succeeds, and a failed setup stops the container with a non-zero exit code.
- **Boot runs only root-owned code as root.** Every script the container starts as root at boot lives in a path the rome user cannot write.
