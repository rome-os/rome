# Process & Deployment

How a Rome process is bound to its host and its [profile](../concepts/deployment.md#profiles), how it identifies itself as an [instance](../concepts/deployment.md#instances), and how state mutations are serialised through it. The vocabulary is defined alongside in [`../concepts/deployment.md`](../concepts/deployment.md). This doc is about the runtime shape and the rules that fall out of it.

## Components

The shape is deliberately spare — there is no clustering, no leader election, no inter-process coordination layer:

- **One Rome process per `(host, profile)`.** The HTTP entry point is the only writer to profile state. Lifecycle CLI commands (`pnpm app:install`, `pnpm app:uninstall`, …) are HTTP clients of this same process.
- **The lockfile** at `~/.rome/<profile>/lockfile.json` is the durable boundary of profile state.
- **An in-process mutex** serialises every lifecycle mutation that crosses the lockfile boundary. Concurrency control is in-process only.
- **An identity pair** — `PANTHEON_SLUG` (instance slug: telemetry / operator tooling) and `ROME_PROFILE` (data isolation) — names the running process for each axis independently. In prod `PANTHEON_SLUG` is the Rome-Cloud-injected tenant slug. Dev is tenant-less and sets no `PANTHEON_SLUG`, so its telemetry `service.instance.id` is `unknown` (shared across worktrees), while the in-container profile stays `default`.

## Data tier

The **data tier** is the set of objects `createDataTier` (`packages/core/src/composition/data-tier.ts`) builds from one database handle. It holds every system repository and the WhatsApp and LinkedIn address books. It also holds factories for the channel list, the account-name directory, and the app runtime repositories. A repository layer in general is any code that reads and writes through repositories. The data tier is the one place Rome constructs them. The main process, the action worker, and every test harness compose through it, so a repository wired once reaches all of them.

Why every consumer composes through it: [Test harnesses compose through the production composition root](../adrs/test-harnesses-compose-through-the-production-composition-root.md).

## Invariants

- **Single-tenant.** Two Rome processes pointing at the same `(host, profile)` is undefined behaviour. The atomic rename + fsync on lockfile writes guards against crashes, not peers.
- **Instance ≠ profile.** A profile isolates user data (DB, memory, apps). An instance identifies the running Rome itself. Observability and operator tooling key on the instance, never on the profile.
- **Atomicity stops at the lockfile boundary.** Lockfile writes are all-or-nothing (temp-file + rename + fsync, file *and* parent directory). Hot-swap *below* the lockfile is best-effort — no atomic rollback. The recovery model is soft degradation: warnings, "failed" status entries, ignored hooks. No automatic retry.
- **Composition only constructs.** Composition never awaits and never performs I/O. Boot steps run after composition, in `main()`, in this order: seed and hydrate the instance token, apply stored app keys, recover interrupted webchat inputs, ensure the sentinel persons. A test harness that composes through the [data tier](#data-tier) runs none of them.
