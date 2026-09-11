# Agents

An agent is an LLM-backed runtime entity: a named configuration that sets a model tier or an exact model ID, a set of builtin tools and callable [actions](actions.md), a system prompt, and optionally the subagents it may delegate to. The runtime assembles the system prompt from the shared agent charter, the agent's own identity, and runtime context.

**Contracts:**

- An agent definition declares a [local artifact name](apps.md#artifact-names-and-references). The name cannot contain `:`, and `main` is reserved for Rome Core. Its `actions` and `allowedSubagents` references use canonical `<app-id>:<local-name>` ids for both same-app and cross-app references.
- An agent can remain provider-agnostic by declaring `tier: large|medium|small`. The runtime maps the tier to an available provider and concrete model.
- An agent whose behavior depends on a provider-specific capability may pin a provider. A provider-pinned tier resolves only on that provider and fails rather than falling back to another provider.
- An agent that needs a specific model may declare `provider` with `modelId` instead of a tier. Rome requests that exact ID without tier mapping or automatic substitution. The provider and connected account must support the requested model.
- Every agent conversation happens within a [session](sessions.md). There is no session-less agent turn. Explicit guardian selections and saved session pins take precedence over the agent's configured model.
- Each subagent has a restricted capability set appropriate to its role. Delegation never widens capabilities.

## Model selection

Use a tier when the app should run across providers. Add `provider: openai` or `provider: anthropic` to restrict tier resolution to one provider. Use `modelId` when a particular provider model is required:

```yaml
name: fast_coding_agent
description: Completes coding tasks with a specific model.
provider: openai
modelId: gpt-5.3-codex-spark
reasoningEffort: high
permissionMode: default
tools:
  - Read
systemPromptPrefix: Complete the requested coding task.
```

`modelId` is the provider's model ID, not a WebChat selector slug. For example, `gpt-5.6-terra` is a provider ID while `gpt-5-6-terra` is a selector slug. IDs do not need to appear in Rome's WebChat catalog. Rome checks provider availability and known entitlements, and the provider validates IDs it receives. Declaring an ID does not grant access to that model.

**Validation:**

- `modelId` requires `provider: openai|anthropic` and a nonempty string containing no whitespace. Rome preserves the ID rather than trimming or rewriting it.
- `modelId` cannot be combined with `tier`, legacy `model`, or `codeBacked: true`.
- Without `modelId`, a tier is required. Legacy `model: opus|sonnet|haiku` remains accepted and normalizes to `large|medium|small`.
- The same schema validates runtime agent loading and packed-app installation. Older Rome versions that do not recognize `modelId` reject it rather than silently ignoring the pin.

An agent model pin supplies the default for a new session, not an instruction to migrate existing history. Changing the YAML affects new sessions. Existing sessions retain their [session model pin](sessions.md#model-pin) unless the guardian explicitly selects another model.

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
  `structuredOutput`. `content` is that value's JSON serialization. Missing,
  invalid, or retry-exhausted provider output fails the turn.
- Structured output is separate from a handoff's guardian-approved handback.
  A handback may span several ordinary conversational turns. An
  `outputSchema` turn may not park on that interaction.

**Not to be confused with:**

- **[Action](actions.md)** — an action is code that runs. An agent is the LLM-backed entity that decides to run it.
- **[Session](sessions.md)** — the session is the durable boundary around a body of agent work. The agent is the configured entity doing the work.
- **[Guardian](people.md#guardian)** — the agent has its own identity (name, personality), separate from the human it serves.

## Agent hierarchy

Agents form a hierarchy with one orchestrator: the **main agent** handles trusted messages directly or delegates to role-restricted subagents (planning, quick tasks, read-only exploration). Coding work is not a subagent delegation — the main agent starts it through a coding [action](actions.md), so the work crosses the coding app's boundary. Two agents sit outside the delegation tree as gates: the [sentinel](messaging.md#sentinel) triages untrusted inbound messages, and the **envoy** validates outgoing messages before they are sent.
