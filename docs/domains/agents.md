# Agents

What an agent is and how it runs. This context exists in the code and the docs already and is reused as it stands.

## Agent

A named Rome agent, such as main, sales or support. Its definition, model selection and capabilities are in [`concepts/agents.md`](../concepts/agents.md). Nothing in the domain language changes what an agent is.

- In a chat, an agent is a participant ([Chats](chats.md#agent)). It speaks through its own account or answers on the guardian's behalf. When it wakes, what it reads and where it speaks is in [Participation](participation.md).
- How an agent remembers what it observes in a chat or its threads is its own decision. Chats describes participants and messages and says nothing about memory.

## Model provider account

Whose subscription an agent's turns run under when Rome credits is not the payer: the guardian's Codex (ChatGPT) account today. Rome never acts or chats as this account, so it is not a [connection](connections.md#connection) and has no connected account. Its alternative, Rome credits, has no external account at all.

- The guardian **authorizes** Rome to run models under the account, in a browser or by entering a device code, may **cancel** an authorization still in progress, and **revokes** it to take it back. Signing in to Rome is a different act ([Connections](connections.md#connection)) and never authorizes an account.
- The account is unauthorized, authorizing or authorized. An authorized account can be **expired**, as a [grant](connections.md#grant) can, when the provider stops accepting it. Authorizing again fixes it.
- The account reports its own status and usage. Rome reads them and derives neither.
- The account also reports what the provider lets it do: the models its plan allows, when the provider limits them, and whether the provider limits its usage, as a subscription is and a billed account is not. Rome keeps no table of plans.
- A turn the provider refuses, for the credential or for usage, is learned by the provider's adapter, which tells its own account. The account shows it in its next report. Nothing else in Rome relays it.
- In code it is the `ModelAccount` port in [`packages/core/src/agent/domain/model-account.ts`](../../packages/core/src/agent/domain/model-account.ts), implemented by the Codex and Claude adapters. Authorizing, cancelling and the authorization state are the `ModelAccountAuthorization` port, which only the Codex adapter implements, since the guardian authorizes Claude outside Rome with the Claude CLI. The dashboard calls both. An agent's run never does.

## Model provider availability

Whether a run can use a model provider now, and why not. Rome derives it from one source, what the provider's account reports about itself, its status and its usage. A provider is **available**, **unauthorized** (no account authorized), **expired** (authorized once, and the provider stopped accepting it) or its **usage limit is reached**, until a time when one is known. Expired and unauthorized outrank a usage limit. A usage limit with no known end is assumed to end five hours after it was seen unless a later read confirms it.

- Before Rome has read an account, it knows nothing about that provider and a run treats it as available. That is about what Rome knows, not a state of the provider, so it is not a word.
- A run never tells availability anything. What it learns from a refused turn reaches availability through the account ([Model provider account](#model-provider-account)).
- In code the rules are `availabilityFromAccount` and `currentAvailability` in [`packages/core/src/agent/domain/provider-availability.ts`](../../packages/core/src/agent/domain/provider-availability.ts). `ModelAvailability` in [`packages/core/src/agent/application/model-availability.ts`](../../packages/core/src/agent/application/model-availability.ts) reads the accounts and holds the answer. The resolver, the concierge and the dashboard read it. The usage switch, which moves a chat to another provider when one is at its limit, is `usage-switch.ts` beside the rules.

## Model selection

A model a guardian picks by name for a chat, such as `claude-sonnet` or `gpt-6-luna`, and the provider that serves it. It is one of a fixed list the agent context owns. Leaving the choice to Rome ("auto" in the dashboard) is not a selection but the absence of one, so the resolver picks by [tier](../concepts/agents.md#model-selection) instead.

- In code it is `ModelSelection` in [`packages/core/src/agent/domain/model-selection.ts`](../../packages/core/src/agent/domain/model-selection.ts). The webchat settings that store a guardian's pick read it from there.

## Payer

Who pays for a turn: the model provider account or Rome credits, one at a time. The provider that served the turn reports it, and Rome records it as read. In code it is `ModelFunding` on the model port.
