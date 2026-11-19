# Deployment: Profiles & Instances

Profiles isolate *what the user has*. Instances identify *what is running*. The two are deliberately distinct — the runtime invariants that fall out of this split live in [`../architecture/process.md`](../architecture/process.md).

## Profiles

A profile is a fully isolated data environment. Everything user-owned lives inside it: the database, the git-backed [memory](data.md#memory) directory, installed [apps](apps.md#rome-apps) and their persistent data, working directories for app development and agent coding tasks, and channel authentication state. Multiple profiles can exist on the same machine. Only one is active at a time.

**Contracts:**

- The profile is the *data* isolation boundary: nothing in one profile (database, memory, apps, auth state) is visible from another.
- Exactly one Rome process may serve a given `(host, profile)` pair. Running two is undefined behavior ([process invariants](../architecture/process.md#invariants)).

**Not to be confused with:**

- **[Instance](#instances)** — a profile isolates user data. An instance identifies the running Rome itself.

## Instances

An instance is a single Rome deployment identity, distinct from a profile. Where a profile isolates *user data*, an instance identifies *the running Rome itself* — the unit telemetry, observability, and operator tooling key on.

In development, the instance name is the worktree slug, so sibling worktrees on the same machine produce distinct telemetry streams. In production, it identifies the deployment. Profile and instance can diverge: the same profile name can run under different instance identities.

**Contracts:**

- The instance is the *telemetry* isolation boundary: observability and operator tooling key on the instance, never on the profile ([observability invariants](../architecture/observability.md#invariants)).

**Not to be confused with:**

- **[Profile](#profiles)** — an instance identifies the running Rome. A profile isolates the data it serves.
