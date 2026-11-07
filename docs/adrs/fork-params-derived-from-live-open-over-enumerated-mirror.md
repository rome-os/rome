# Exact-mode fork params are derived from the live open, not an enumerated mirror

- **Status**: Accepted
- **Date**: 2026-08-11
- **Concept**: [sessions — forked turns](../concepts/sessions.md#forked-turns)

## Context

An exact-mode [forked turn](../concepts/sessions.md#forked-turns) exists for one reason: the conversation prefix the model sees on the branch matches the source. That identity buys two things. The model behaves on the branch as it would have on the source, and the provider's prompt cache stays warm across the fork.

The parameter object a provider open takes keeps growing. Reasoning effort, MCP servers, the output contract, and the interactive-surface flag each arrived with a diff about some other feature. The author of the next such field wires it into the live open, which is the only open they are thinking about.

Divergence between the two opens carries no error signal. A field the fork omits still produces a valid open, a completed turn, and an answer that reads fine. The guardian pays for it as a cold prompt cache and as behavior drift on the branch, and both look like ordinary variation. Nothing throws, so nothing points at the missing field.

A fork also cannot be a straight copy. It runs as its own session and its own turn, so it must not carry the source session's identity or the source's per-turn execute callbacks. Reusing either one would attribute the fork's actions to whatever turn the source happens to be running.

Nothing drains a fork's stream into webchat either. The interactive tools the source advertises still belong in the fork's catalog, because the catalog is part of the prefix this decision protects. Those same tools cannot mount a card or resolve a handback on a branch no surface is watching. Their runtime has to answer honestly instead of claiming a delivery.

The model is the one open param the caller does choose. A fork is invoked for a purpose the caller knows — a recap, a review — and that purpose may warrant a different capability tier than the conversation is running on, so `ForkRunParams` carries a `tier` override. The prefix identity this decision protects is the system prompt and the tool catalog, not the model behind them, and a caller who wants the provider prompt cache keeps the source's model.

## Decision

An exact-mode fork derives its open params by spreading the parameters captured from the source session's last successful provider open. The spread drops the per-session identity fields, then overrides the caller's model and the execute callbacks bound to the fork's own session and turn. It also states that it has no speaker, so no widget shows while the advertised catalog stays identical. No exact-fork path builds that object field by field, and an isolated-mode fork enumerates its own deliberately empty surface.

## Alternatives

- **Enumerate the fields and construct a typed params object explicitly, the industry default.** The first cut of this design did exactly this. Rejected because the enumeration is a second copy of a list that grows elsewhere, and the copy falls behind without failing. A field wired into the live open and forgotten in the fork diverges the prefix silently.
- **Keep the enumeration but force completeness with an exhaustive type over the params.** Rejected because the type proves each field is mentioned, not that it carries the value the provider actually received. The check passes on a field the fork mentions and resolves differently.
- **Rebuild the fork's params from the source session's configuration instead of its open.** Rejected because the configuration moves under a live session. Catalogs change, the model resolves again, and the session reopens, so a rebuild reproduces the current configuration rather than the prefix the source is running on.
- **Capture the params once at the session's first open.** Rejected because a reopen replaces the prefix the provider holds. A fork derived from the first open would branch off a prefix the provider has already dropped.
- **Spread every field, including the identity fields and the source's callbacks.** Rejected because the identity fields point the fork at the source's provider thread, which the fork must never mutate. The source's callbacks would report the fork's tool calls under the source's turn.
- **Drop the interactive tools from an exact fork's catalog, since no surface can render them.** Rejected because the catalog is part of the model-visible prefix. A fork missing those tool definitions branches off a different prefix than the source, which is the divergence exact mode exists to prevent. The fork advertises them and detaches their runtime instead.
- **Catch drift with a test that compares the live params against the fork params.** Rejected because the test fails only after someone writes a fixture that exercises the new field. The spread cannot drift at all, so the guard costs a test suite to buy back a property the construction already has.
- **Treat prefix identity in exact mode as best-effort.** Rejected because a fork with an approximate prefix is isolated mode with tools attached. The caller asked for exact mode precisely because the difference is invisible to them at runtime.

## Consequences

A field added to the provider open params reaches exact forks with no second edit, and the author adding it needs no knowledge of the fork path. Review of such a diff asks two questions: whether the new field identifies one session, and whether it depends on a surface draining the stream. The spread carries every other field by construction.

The cost is legibility and a smaller maintained list. A reader of the fork factory sees a spread, a subtraction, and a short override list, not the set of parameters the fork runs with, so answering "what does an exact fork open with" means reading the live open. The subtraction list is now the thing that can be wrong. A future identity-shaped field left out of it leaks the source's identity into the fork, which is the failure this decision moves the risk toward and accepts, because that failure is loud where the omission was silent.

An exact fork also depends on the source having opened at least once. A source session with no successful provider open has nothing to derive from, and the fork call fails rather than opening on invented params.

Future diffs must respect:

- An exact-mode fork derives its open params from the source's captured live open. No path reconstructs them field by field, and no path rebuilds them from configuration.
- The capture tracks the last successful open, including reopens, not the first one.
- A new field on the provider open params flows into forks untouched unless it identifies one session, binds one turn's execution, depends on a surface draining the stream, or is the model.
- A field that does identify a session joins the strip list in the same diff that adds it. A field that binds a turn's execution or depends on a live surface joins the override list in that same diff.
- An exact fork advertises the source's interactive tool catalog and detaches the interactive runtime. The catalog belongs to the prefix, and the runtime reports what a detached branch can actually deliver.
- The model stays the caller's resolution, and the `tier` override on `ForkRunParams` stays available in both modes. A caller that wants the provider prompt cache passes the source's model.
- The model is the only open param a caller selects. A caller that wants a different tool surface or a different prefix defines a different agent or uses isolated mode.
