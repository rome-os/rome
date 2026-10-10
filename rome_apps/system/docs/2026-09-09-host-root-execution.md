# Host root execution

The system app submits Linux root scripts through `execute_root_script` and
inspects or cancels accepted jobs through `manage_root_script`. The helper is
optional and execution requires explicit enablement in both Rome and host
policy.

Accepted jobs belong to the host service and survive the submitting action.
The result distinguishes acceptance from completion. Failed scripts return
their bounded output and job identity in the action error. A lost response
triggers inspection of the known job instead of another submission.

Core provides the host client only to system actions and derives job identity
from execution context. This wiring is an API boundary within the trusted
runtime, not isolation from other container code with access to the socket.

Validation covers the action envelopes, Core's Unix-socket protocol, trusted
execution identity, system-only injection in main and worker loaders, and the
system app build. The Linux integration check uses separate root-helper and
nonroot-client containers to verify execution, output limits, cancellation,
timeouts, duplicate requests, and recovery after helper restart.

Native macOS and Windows helpers use different host installation mechanisms
and are outside this Linux delivery. Host jobs follow the
[host execution contracts](../../../docs/concepts/host-execution.md).
