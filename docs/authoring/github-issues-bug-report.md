# Bug Reports

A **bug report** is a GitHub issue for a defect in behavior the system already ships. [github-issues.md](github-issues.md) holds the rules every issue shares — the title shape, the Situation section, the type labels — and wins where a rule here conflicts with it.

## Title

A bug title states the symptom in present tense, not the fix.

> Prefer: "relay: drainer reconnects every ~50s instead of persisting".
> Over: "relay: fix the drainer reconnect storm".

## Body

Required sections, in order: Situation, Symptom, How to reproduce, Initial triage, Suspected root cause, Possible fixes. An Environment section may follow.

- **Symptom** — the exact error or behavior, the trigger, and the involved surface. Situation frames the problem in plain words. Symptom carries the exact string.
- **How to reproduce** — numbered steps from a clean state, with the exact commands and environment preconditions.
- **Initial triage** — what the investigation ruled in and ruled out, with evidence.
- **Suspected root cause** — one paragraph on the mechanism, tied to the evidence above.
- **Possible fixes** — a list of options.

Possible fixes enumerates the design space and picks nothing. The author of the fix decides.

> Prefer: "1. Align `resolveWebhookUrl` with the GitHub path. 2. Fail closed at boot when the relay URL is missing."
> Over: "Fix: align `resolveWebhookUrl` with the GitHub path."

Suspected root cause states its confidence. A guess labeled as confirmed poisons the next investigation.

> Prefer: "Suspected: the backoff resets on WS open — unverified beyond the log pattern."
> Over: the same hypothesis presented as a confirmed root cause.

## Labels

A bug report carries the `bug` label and exactly one of `P0`, `P1`, `P2`, `P3`. The label descriptions in the repo define the priorities. This file does not restate them.
