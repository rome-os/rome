# Host execution

How Rome delegates scripts to a privileged Linux host service while keeping host authorization and job ownership outside the runtime.

## Components

- **System actions** submit, inspect, and cancel [host jobs](../concepts/host-execution.md#host-job).
- **Core client** binds submission to the current action execution and the configured host transport.
- **Host helper** owns authorization, job records, and privileged processes.
- **Host installer** provisions the helper and grants access to the intended Rome runtime.

```text
system action → Core client → local socket → host helper → privileged process
```

## Invariants

- Installation and permission to execute are separate. Both Rome and the host helper reject execution until explicitly enabled.
- The helper accepts local connections through a restricted socket. It exposes no network listener.
- The host installer controls the executable, configuration, and socket access. Agent arguments cannot choose a transport or executable path.
- The Core client gets execution identity from runtime context. Agent arguments cannot supply an actor, an approval decision, or an execution identity.
- The helper validates every request independently. Core validation is not the host authorization boundary.
- Socket access delegates host authority to the trusted runtime. Action visibility and Rome approvals do not isolate other code in the same container.
- A Linux VM and the computer running that VM are different hosts. The helper never silently changes the execution target.
- Job acceptance is durable before process creation. A reused identity cannot start another process, including after helper recovery.
- The main runtime preserves host job references across action worker loss. Worker failure cannot silently become a new host submission.
- Helper recovery waits for interrupted managed processes to stop before accepting another job. Cleanup survives the daemon process.
- Job output is bounded and remains in protected job records. General audit logs carry metadata without script contents or output.
- The installer keeps state and protocol compatibility across helper and Rome upgrades. A rollback cannot erase accepted job identities.

## Limits

The helper controls ordinary child processes, but unrestricted root code can change the host or create persistent services. Revoking access prevents future submissions, not earlier effects.

Hosted deployment must treat every credential on a tenant VM as accessible to that tenant's root scripts. Host permissions cannot contain a fleet credential from root.

Native macOS and Windows execution require their own host services. The Linux helper does not administer either operating system.
