# Agents

What an agent is and how it runs. This context exists in the code and the docs already and is reused as it stands.

## Agent

A named Rome agent, such as main, sales or support. Its definition, model selection and capabilities are in [`concepts/agents.md`](../concepts/agents.md). Nothing in the domain language changes what an agent is.

- In a chat, an agent is a participant ([Chats](chats.md#agent)). It speaks through its own account or answers on the guardian's behalf. When it wakes, what it reads and where it speaks is in [Participation](participation.md).
- How an agent remembers what it observes in a chat or its threads is its own decision. Chats describes participants and messages and says nothing about memory.

## Agent policy

How a chat treats one agent's turns: whether the agent's text reaches the chat, whether the chat's first message names the chat, and whether its system prompt carries memory. The fields and their defaults are in [`concepts/agents.md`](../concepts/agents.md#agent-policy).

- The agent declares it in the `policy:` block of its definition. Nothing stores it, and every session of an agent has the same policy.
- In code it is `AgentPolicy` in [`packages/core/src/agent/domain/agent-policy.ts`](../../packages/core/src/agent/domain/agent-policy.ts).

## Skill

Know-how an agent reads and follows. An agent has the skills its installed apps offer, and a slash command invokes one for a turn. What a skill is, is in [`concepts/skills.md`](../concepts/skills.md).

- In code, `Skill` and the `SkillCatalog` port are in [`packages/core/src/agent/domain/skill.ts`](../../packages/core/src/agent/domain/skill.ts).

## System prompt

What the model reads before the conversation. It is built when a run opens the agent's session, and kept across reopens and forks of the model's session.

- An app's agent gets exactly the prompt it declares. A core agent gets its declared prompt, the charter, its identity and what Rome tells every core agent, with memory and project summaries when its [agent policy](#agent-policy) loads them.
- In code, the rules are in [`packages/core/src/agent/domain/system-prompt.ts`](../../packages/core/src/agent/domain/system-prompt.ts).

## Prompt

The words a turn was asked, plus what Rome adds about where the turn stands: where the chat is, what the guardian has open, the device folder and what the agent has not seen.

- What Rome adds can change from turn to turn, so it stays in the prompt and never in the system prompt.
- In code, the blocks Rome adds are in [`packages/core/src/agent/domain/prompt.ts`](../../packages/core/src/agent/domain/prompt.ts).

## Model provider account

Whose subscription an agent's turns run under when Rome credits is not the payer: the guardian's Codex (ChatGPT) account today. Rome never acts or chats as this account, so it is not a [connection](connections.md#connection) and has no connected account. Its alternative, Rome credits, has no external account at all.

- The guardian **authorizes** Rome to run models under the account, in a browser or by entering a device code, may **cancel** an authorization still in progress, and **revokes** it to take it back. Signing in to Rome is a different act ([Connections](connections.md#connection)) and never authorizes an account.
- The account is unauthorized, authorizing or authorized. An authorized account can be **expired**, as a [grant](connections.md#grant) can, when the provider stops accepting it. Authorizing again fixes it.
- The account reports its own availability ([Model provider availability](#model-provider-availability)), with the status and usage it read it off. Rome reads the report and derives nothing from it.
- The account also reports what the provider lets it do: the models its plan withholds, when the provider withholds some, and whether the provider limits its usage, as a subscription is and a billed account is not. Rome keeps no table of plans.
- A turn the provider refuses, for the credential or for usage, is learned by the provider's adapter, which tells its own account. The account shows it in its next report and holds a usage refusal until its end or until a later usage read shows capacity, since the provider's usage lags the turn it refused. Nothing else in Rome relays it.
- In code it is the `ModelAccount` port in [`packages/core/src/agent/domain/model-account.ts`](../../packages/core/src/agent/domain/model-account.ts), implemented by the Codex and Claude adapters. Authorizing, cancelling and the authorization state are the `ModelAccountAuthorization` port, which only the Codex adapter implements, since the guardian authorizes Claude outside Rome with the Claude CLI. The dashboard calls both. An agent's run never does.

## Model provider availability

Whether a run can use a model provider now, and why not. The provider's account reports it, and Rome remembers the report. A provider is **available**, **unauthorized** (no account authorized), **expired** (authorized once, and the provider stopped accepting it) or its **usage limit is reached**, until a time when one is known. Expired and unauthorized outrank a usage limit. How the account reads its provider's status and usage into one of these, and what it assumes when the provider states no end, is the adapter's, not Rome's.

- Before Rome has read an account, it knows nothing about that provider and a run treats it as available. That is about what Rome knows, not a state of the provider, so it is not a word.
- A run never tells availability anything. What it learns from a refused turn reaches availability through the account ([Model provider account](#model-provider-account)).
- Rome remembers the last report so the resolver, the concierge and the dashboard can read it without waiting on the provider's process, and asks again at start, hourly, when the account says it changed and when the dashboard asks. A remembered usage limit whose end has passed reads as available.
- In code the words and the reader's rules are in [`packages/core/src/agent/domain/model-account-report.ts`](../../packages/core/src/agent/domain/model-account-report.ts). `ModelAccounts` in [`packages/core/src/agent/application/model-accounts.ts`](../../packages/core/src/agent/application/model-accounts.ts) remembers the accounts' reports and decides when to ask. The reading of a provider's status, usage and refused turns into a report is `account-report.ts` beside the adapters. The resolver, the concierge and the dashboard read it. The usage switch, which moves a chat to another provider when one is at its limit, is `usage-switch.ts` beside the rules.

## Model selection

A model a guardian picks by name for a chat, such as `claude-sonnet` or `gpt-6-luna`, and the provider that serves it. It is one of a fixed list the agent context owns. Leaving the choice to Rome ("auto" in the dashboard) is not a selection but the absence of one, so the resolver picks by [tier](../concepts/agents.md#model-selection) instead.

- In code it is `ModelSelection` in [`packages/core/src/agent/domain/model-selection.ts`](../../packages/core/src/agent/domain/model-selection.ts). The webchat settings that store a guardian's pick read it from there.

## Payer

Who pays for a turn: the model provider account or Rome credits, one at a time. The provider that served the turn reports it, and Rome records it as read. In code it is `ModelFunding` on the model port.
