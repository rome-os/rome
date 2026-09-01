# Agents

An agent is an LLM-backed runtime entity: a named configuration that sets a model tier, a set of builtin tools and callable [actions](actions.md), a system prompt, and optionally the subagents it may delegate to. The runtime assembles the system prompt from the shared agent charter, the agent's own identity, and runtime context.

**Contracts:**

- An agent definition declares a [local artifact name](apps.md#artifact-names-and-references). The name cannot contain `:`, and `main` is reserved for Rome Core. Its `actions` and `allowedSubagents` references use canonical `<app-id>:<local-name>` ids for both same-app and cross-app references.
- The agent abstraction is provider-agnostic. An agent names a model *tier*, never a concrete model. The runtime maps each tier to a concrete model, and swapping the model provider does not change the agent contract.
- An agent whose behavior depends on a provider-specific capability may pin a provider. The pin is fail-closed: a pinned agent's sessions resolve only on that provider, and fail with a clear error rather than silently falling back to a provider that lacks the capability.
- Every agent conversation happens within a [session](sessions.md). There is no session-less agent turn.
- Each subagent has a restricted capability set appropriate to its role. Delegation never widens capabilities.

## Structured output

An agent may declare `outputSchema` when every model turn must end with data
rather than free-form prose. Rome admits only the portable JSON Schema subset
that both supported providers accept unchanged, then passes the schema to the
provider's native structured-output API.

**Contracts:**

- `outputSchema` applies to each provider turn, including forked turns. It is
  not a signal that a multi-turn conversation will eventually produce data.
- The provider owns constrained generation, validation feedback, and its
  internal retry policy. Rome does not add a second model retry loop.
- A successful terminal `result` carries the validated value in
  `structuredOutput`; `content` is that value's JSON serialization. Missing,
  invalid, or retry-exhausted provider output fails the turn.
- Structured output is separate from a handoff's guardian-approved handback.
  A handback may span several ordinary conversational turns; an
  `outputSchema` turn may not park on that interaction.

**Not to be confused with:**

- **[Action](actions.md)** — an action is code that runs. An agent is the LLM-backed entity that decides to run it.
- **[Session](sessions.md)** — the session is the durable boundary around a body of agent work. The agent is the configured entity doing the work.
- **[Guardian](people.md#guardian)** — the agent has its own identity (name, personality), separate from the human it serves.

## Agent hierarchy

Agents form a hierarchy with one orchestrator: the **main agent** handles trusted messages directly or delegates to role-restricted subagents (planning, quick tasks, read-only exploration). Coding work is not a subagent delegation — the main agent starts it through a coding [action](actions.md), so the work crosses the coding app's boundary. Two agents sit outside the delegation tree as gates: the [sentinel](messaging.md#sentinel) triages untrusted inbound messages, and the **envoy** validates outgoing messages before they are sent.
