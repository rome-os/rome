# Host execution

## Host job

A host job is a script accepted by a privileged service on the operating system hosting Rome. Its lifetime belongs to that service.

**Contracts:**

- Submission reports acceptance or a terminal result. Acceptance does not mean the script succeeded.
- A host job survives the submitting action and the Rome process. Cancelling that action does not cancel the host job.
- Inspection and cancellation address the same host job. Cancellation and timeouts stop its managed processes without undoing completed effects.
- A repeated request with the same identity and contents returns the existing job. Different contents under that identity are rejected.
- Lost contact leaves the outcome unknown. Recovery inspects the existing job and never starts a replacement automatically.
- An interrupted action worker reports the original host job identities. A routine does not automatically retry that uncertain execution.
- Host recovery never resumes an interrupted script. It records an unknown outcome when completion cannot be established.
- Root execution grants authority over the selected host, including its credentials. A job is not a sandbox for its script.

**Not to be confused with:**

- **[Action](actions.md)** — the Rome invocation that submits or manages a host job. Its execution record does not own the host process.
- **Container command** — a process inside the Rome container. Host execution runs on the selected operating system outside that container.
- **[Detached action](actions.md)** — independent work managed by Rome. A host job is managed outside Rome and retains its identity across Rome restarts.
