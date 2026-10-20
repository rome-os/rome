# Agent tooling gets a brokered provider capability, never the credential

- **Status**: Accepted
- **Date**: 2026-08-11
- **Architecture**: [Channels](../architecture/channels.md#connection-setup)

## Context

A trusted agent running in the Rome shell needs more of a provider's API than the [channel](../architecture/channels.md) surface exposes. Reading a guild, editing a structured message, or calling an endpoint Rome has not wrapped all sit outside Talk. The shape that fits is a command-line tool the agent invokes from the shell it already has.

Rome holds the provider credential for a connected service in the grant ledger, which is the source of truth for it. The credential's lifecycle is the grant epoch: conferral builds one, boot rehydrates one, credential replacement swaps one, and revoke or degrade kills one. Anything that carries the provider's authority has to follow that lifecycle or it becomes a second, divergent answer to the question of who is connected.

The credential itself is a long-lived bearer secret with no scoping. The provider mints no restricted child token for a local tool, so whatever a tool receives carries the bot's full REST authority. It is also valid from anywhere on the internet. A copy taken off the instance keeps working after the guardian revokes the connection in Rome, and Rome has no way to learn that the copy exists.

The industry default runs the other way. Every comparable tool — `gh`, `aws`, `stripe` — takes its credential in hand, through an environment variable, a config file, or a store under `$HOME`. A contributor building a provider CLI reaches for one of those three by reflex. The Discord CLI design records all three as separately proposed and separately rejected, which is the evidence that the default keeps coming back.

Rome runs that default itself in one narrow place. Grant custody projects a credential to a consumer that lives outside the Core process, and the GitHub and Slack grants use it. The artifact is a token file on the shared runtime tmpfs, read by the `gh` and `git` shell wrappers and by the connector app, and GitHub adds a `gh` CLI login under the runtime's `$HOME`. The ledger stays authoritative over whether that artifact exists, because the registry writes it when the grant reaches authorized and clears it on revoke and degrade. What custody cannot recover is containment: a copy taken while the grant is live outlasts the revoke, and nothing tells Rome the copy exists.

The runtime is guardian-only and the agents are trusted, so the question here is credential containment, not caller authorization. Who may invoke the capability is a separate decision that this record does not make.

## Decision

A Rome-authored agent tool never receives the provider credential of the Connection it acts on. Core exposes the provider's API as an Act operation on that Connection instead — the tool names a provider-relative operation, and the current grant epoch executes it with the credential that stays inside the Core process. Grant custody remains the one sanctioned exception, and it covers the consumers already holding it rather than every tool that asks.

## Alternatives

- **Project the credential into a runtime file the tool reads (§14.1).** Rejected because a file is copied off the instance in one read by the very process that is meant to read it, so file permissions cut accidental disclosure while leaving the copy alive after revoke. Grant custody pays that price for consumers Rome does not write the request path for, and a Rome-authored tool has the cheaper option.
- **Pass the credential in an environment variable such as `DISCORD_TOKEN` (§14.3).** Rejected because every subprocess inherits an environment value, the value surfaces in diagnostics, process inspection, and stray shell output, and nothing retracts it when the epoch dies. The `gh` and `git` wrappers wear that exposure per invocation because those binaries take a credential no other way.
- **Persist tool auth in a `$HOME` credential store, the way `gh` and `aws` do (§14.4).** Rejected because it stands up a second credential store that outlives a Connection revoke and drifts from the grant ledger, which ends the ledger's standing as the source of truth. GitHub's `gh` login survives as a custody artifact only because custody rewrites and clears it from grant state.
- **Mint a restricted child credential scoped to the tool.** Rejected because the provider issues no such credential, so the option only moves the full-authority secret into a new place under a reassuring name.
- **Hand the tool the live provider client object (§14.5).** Rejected because that client owns the credential together with process-local Gateway state, caches, and socket lifecycle, so passing it hands over the secret and a boundary that does not survive a process hop.
- **Add a dedicated Rome action per provider endpoint and ship no raw surface.** Rejected because it mirrors a large, changing external API into Rome's action contract, and an agent stays blocked on every endpoint the provider ships before Rome wraps it.
- **Keep the tool trusted and let it own request validation.** Rejected because the tool runs in the agent's blast radius, so a hand-crafted request would reach the credential-holding code with nothing between them.

## Consequences

Revocation becomes effective rather than advisory for a brokered provider. Killing the epoch on revoke, degrade, or credential replacement kills every tool's authority at the same instant, because there is no copy anywhere to hunt down. The grant ledger stays the single source of truth for what is connected, and boot rehydration needs no separate path for tooling. Redaction stops being a tool concern: the credential cannot appear in arguments, environment, output, or logs, because it never arrives.

The boundary generalizes past the change that introduced it. Any later provider CLI or agent tool inherits it without a new credential design, and the capability rides on Act, so moving where it is exposed does not reopen the containment question.

The cost is that Core owns more. Each new provider operation is a validated request and result contract written in Core, not a flag added to a tool that already holds the secret. Core revalidates everything the tool checked, since the tool is not a control. Rate-limit coordination, deadlines, and size limits move to Core as well. The tool stops working when Core is unreachable, and it cannot run off the instance at all.

This hides the credential. It does not reduce authority. Any process that reaches the broker wields the full provider authority of the connected bot while the grant is live. Per-caller and per-endpoint authorization is a separate design, and nothing in this record implies it.

Future diffs must respect:

- The credential behind a brokered capability stays in the Core process. It reaches no Rome-authored tool through arguments, environment, stdin, a config file, a `$HOME` store, or a projected runtime file, and not through a client object that carries one.
- Grant custody is the only sanctioned path that puts a provider credential outside the Core process, and its artifact stays a pure function of grant state: written when the grant reaches authorized, cleared on revoke and degrade. A new custody artifact is a new decision, and a service does not earn one by shipping a shell tool.
- A brokered request names a provider-relative operation and carries no URL, host, or credential field. Core owns the origin and the authorization header, and rejects a caller that tries to set either.
- Every brokered call resolves the current grant epoch at call time. A captured epoch handle fails after revoke, degrade, or credential replacement.
- Core validates each request it receives on its own terms. Validation in the tool is there for the caller's benefit and never stands in for the Core-side check.
- The capability answers on a loopback-bound transport, and Core refuses to mount the broker on any other host. A transport that crosses that boundary — a Unix socket, a separate container — brings its own caller credential, and the provider credential is never that caller credential.
- Adding per-caller or per-endpoint authorization is a new decision. Credential containment neither provides it nor blocks it.
