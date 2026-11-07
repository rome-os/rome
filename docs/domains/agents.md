# Agents

What an agent is and how it runs. This context exists in the code and the docs already and is reused as it stands.

## Agent

A named Rome agent, such as main, sales or support. Its definition, model selection and capabilities are in [`concepts/agents.md`](../concepts/agents.md). Nothing in the domain language changes what an agent is.

- In a chat, an agent is a participant ([Chats](chats.md#agent)). It speaks through its own account or answers on the guardian's behalf. When it wakes, what it reads and where it speaks is in [Participation](participation.md).
- How an agent remembers what it observes in a chat or its threads is its own decision. Chats describes participants and messages and says nothing about memory.
- An agent's name is the apps context's [artifact name](../concepts/apps.md#artifact-names-and-references): its canonical id, local name, aliases and legacy names. The agent context uses the name and does not define it.
- In code an installed agent is `Agent`, and the agents Rome can run are the `AgentCatalog` port, both in [`packages/core/src/agent/domain/agent-definition.ts`](../../packages/core/src/agent/domain/agent-definition.ts). An agent's owner there means only core, or the app that installed it.

## Agent definition

What an agent declares about itself in its file, in core or in an app. The fields are in [`concepts/agents.md`](../concepts/agents.md). Rome reads a definition and never stores or edits it. A session keeps the definition it opened with, which is why an agent's [policy](#agent-policy) is the same for every session of it.

- In code it is `AgentDefinition` in [`packages/core/src/agent/domain/agent-definition.ts`](../../packages/core/src/agent/domain/agent-definition.ts). `AgentLoader` reads the files when apps change and fills the `AgentCatalog` port.

## Agent policy

How a chat treats one agent's turns: whether the agent's text reaches the chat, whether the chat's first message names the chat, and whether its system prompt carries memory. The fields and their defaults are in [`concepts/agents.md`](../concepts/agents.md#agent-policy).

- The agent declares it in the `policy:` block of its definition. Nothing stores it, and every session of an agent has the same policy.
- In code it is `AgentPolicy` in [`packages/core/src/agent/domain/agent-policy.ts`](../../packages/core/src/agent/domain/agent-policy.ts).

## Skill

Know-how an agent reads and follows. An agent has the skills its installed apps offer, and a slash command invokes one for a turn. What a skill is, is in [`concepts/skills.md`](../concepts/skills.md).

- In code, `Skill` and the `SkillCatalog` port are in [`packages/core/src/agent/domain/skill.ts`](../../packages/core/src/agent/domain/skill.ts).

## Rome tools

The tools Rome serves the model during a turn, in four groups: actions, subagents, skills, and the group that asks the person. Each agent's are built from what it may call, and a provider mounts each group as one server.

- How an agent finds actions and skills, what a call on an action hands back, and what `ask_question` and `defer` accept are rules in [`packages/core/src/agent/domain/`](../../packages/core/src/agent/domain/).

## Session tools

The tools a session carries beyond the ones every session of its agent has, such as the Concierge's tools, and `propose_routine` where the widget drawing is card.

## Subagent

An agent that another agent's turn hands work to. The session that runs it has that turn as its parent.

- An agent names its subagents in its definition. When one is not installed, a core agent loads without it, because a core agent's subagents come from apps that may be reinstalling or disabled.
- An app's agent that names a subagent that is not installed fails to load, and its app reports the failure.
- A subagent that fails to load for its own reasons does not fail the agent that names it in the same load. That agent fails later, when a session opens it. The rule is `resolveSubagents` in [`packages/core/src/agent/domain/agent-definition.ts`](../../packages/core/src/agent/domain/agent-definition.ts).
- In code, the `Subagents` port is in [`packages/core/src/agent/domain/subagent.ts`](../../packages/core/src/agent/domain/subagent.ts).

## System prompt

What the model reads before the conversation. It is built when a run opens the agent's session, and kept across reopens and forks of the model's session.

- An app's agent gets exactly the prompt it declares. A core agent gets its declared prompt, the charter, its identity and what Rome tells every core agent, with memory and project summaries when its [agent policy](#agent-policy) loads them.
- In code, the rules are in [`packages/core/src/agent/domain/system-prompt.ts`](../../packages/core/src/agent/domain/system-prompt.ts).

## Prompt

The words a turn was asked, plus what Rome adds about where the turn stands: where the chat is, what the guardian has open, the device folder and what the agent has not seen.

- What Rome adds can change from turn to turn, so it stays in the prompt and never in the system prompt.
- In code, the blocks Rome adds are in [`packages/core/src/agent/domain/prompt.ts`](../../packages/core/src/agent/domain/prompt.ts).

## Model provider account

Whose subscription an agent's turns run under: the guardian's Codex (ChatGPT) account today. A [login](#model-provider-login) says how Rome reaches it. Rome never acts or chats as this account, so it is not a [connection](connections.md#connection) and has no connected account. Rome credits lead to no account at all.

- The guardian **authorizes** Rome to run models under the account, in a browser or by entering a device code, may **cancel** an authorization still in progress, and **revokes** it to take it back. Signing in to Rome is a different act ([Connections](connections.md#connection)) and never authorizes an account.
- The account is unauthorized, authorizing or authorized. An authorized account can be **expired**, as a [grant](connections.md#grant) can, when the provider stops accepting it. Authorizing again fixes it.
- The account reports its own status ([Model provider account status](#model-provider-account-status)), with the usage it read it off. Rome reads the report and derives nothing from it.
- The account also reports what the provider lets it do: the models its plan withholds, when the provider withholds some, and whether the provider limits its usage, as a subscription is and a billed account is not. Rome keeps no table of plans.
- A turn the provider refuses, for the credential or for usage, is learned by the provider's adapter, which tells its own account. The account shows it in its next report and holds a usage refusal until its end or until a later usage read shows capacity, since the provider's usage lags the turn it refused. Nothing else in Rome relays it.
- In code it is the `ModelAccount` port in [`packages/core/src/agent/domain/model-account.ts`](../../packages/core/src/agent/domain/model-account.ts), implemented by the Codex and Claude adapters. It only reports. Authorizing, cancelling and revoking are on the login's ports ([Model provider login](#model-provider-login)). The dashboard calls them. An agent's run never does.

## Model provider account status

Whether the guardian's own account is authorized, expired or absent, and whether it is at its usage limit. The account reports it, and Rome remembers the report. An account is **available**, **unauthorized** (no account authorized), **expired** (authorized once, and the provider stopped accepting it) or its **usage limit is reached**, until a time when one is known. Expired and unauthorized outrank a usage limit. How the account reads its provider's status and usage into one of these, and what it assumes when the provider states no end, is the adapter's, not Rome's.

- Before Rome has read an account, it knows nothing about that provider and a run treats it as available. That is about what Rome knows, not a state of the provider, so it is not a word.
- A run never tells an account anything. What it learns from a refused turn reaches the status through the account ([Model provider account](#model-provider-account)).
- Rome remembers the last report so the resolver, the concierge and the dashboard can read it without waiting on the provider's process, and asks again at start, hourly, when the account says it changed and when the dashboard asks. A remembered usage limit whose end has passed reads as available.
- The dashboard, the concierge, image generation and a tier restricted to one provider read the status, because they ask about the guardian's own account.
- In code the words and the reader's rules are in [`packages/core/src/agent/domain/model-account-report.ts`](../../packages/core/src/agent/domain/model-account-report.ts). `ModelAccounts` in [`packages/core/src/agent/application/model-accounts.ts`](../../packages/core/src/agent/application/model-accounts.ts) remembers the accounts' reports and decides when to ask. The reading of a provider's status, usage and refused turns into a report is `account-report.ts` beside the adapters. The usage switch, which moves a chat to another provider when one is at its limit, is `usage-switch.ts` beside the rules.

## Model provider availability

Whether a run can use a model provider now, read from the [login](#model-provider-login) in effect: available, expired, usage limit reached, or unauthorized only when the provider has no login at all. On Rome credits, Codex is available, whatever the guardian's account says.

- The resolver is its one reader. A reader that asks about the guardian's own account reads the [account status](#model-provider-account-status) instead.
- In code it is `providerAvailability` in [`packages/core/src/agent/domain/provider-availability.ts`](../../packages/core/src/agent/domain/provider-availability.ts), a pure function over the account's report and the login.

## Model provider login

How Rome is let in to a model provider. A login has one of three kinds, named by what it is to the guardian and how it bills: a **subscription login** (the guardian's ChatGPT login, or the Claude CLI's login), an **API credential** (stored, or from the environment), or **Rome credits**. Each provider offers some of them. The [account](#model-provider-account) is who, the login is how. A provider has at most one login in effect. A login leads to at most one account, and Rome credits lead to none.

- The provider reports what the login allows, the models and whether it is usage limited. Who is billed follows from the login. A model session reports the kind of login each turn ran on, unset when Rome cannot tell.
- Getting a login and using one are two acts. The guardian authorizes a ChatGPT login. Rome's setup picks which login Codex runs on.
- For Codex, Rome credits are used only while the ChatGPT account is unauthorized or expired, the instance is linked to Rome Cloud, and the credits can be spent. A usage limit alone, or an account not read yet, keeps the subscription login. This is one choice for the whole instance, and it can change while Rome runs ([Rome Cloud](../concepts/rome-cloud.md#rome-credits)).
- For Claude, Rome's setup picks nothing. A stored credential wins over an environment credential, which wins over the Claude CLI's login, so the guardian chooses by what they store. Where Rome found a credential is a detail of the login, not a kind.
- In code the logins and their ports are in [`packages/core/src/agent/domain/model-login.ts`](../../packages/core/src/agent/domain/model-login.ts). `CodexLogins` logs Rome in to and out of Codex and runs Codex on the login it is told to use. `ClaudeLogins` keeps the credential Rome stores for Claude and logs the CLI out, since the guardian signs in to Claude outside Rome. `claudeLogin` holds Claude's order. `ModelProviderLogins` is the revoke both adapters share. Rome's setup choice is [`packages/core/src/rome-cloud/codex-login.ts`](../../packages/core/src/rome-cloud/codex-login.ts), outside the agent context.

## Model resolution

Which provider and model a run uses. The ask is the most specific of the chat's [selection](#model-selection), the session's pin, the agent's own model and the agent's tier, and the resolution is the answer. A selection, a pin and an agent's own model are exact asks, and an exact ask resolves to exactly that model or fails, never to a substitute.

- A provider is **usable** when its [availability](#model-provider-availability) is available, or Rome has not read it yet. Resolution checks that first, and then whether the [login](#model-provider-login) in effect allows the model. So a failure is either an unavailable provider or a model the login does not allow.
- A tier resolves on the first usable provider in order (Codex on the guardian's account, Claude, Codex on Rome credits, then the mock) to that provider's model for the tier. When the login there does not allow that model, the ask fails rather than moving on to the next provider.
- A tier restricted to one provider asks about the guardian's own account, so Rome credits do not count for it.
- **Tier models** are the guardian's choice of model for each tier and provider. A provider with none chosen uses Rome's default for the tier. The stored setting keeps its older name, `tierModelMappings`.
- In code the ask is `ModelResolutionRequest` and the rule is `resolveModel` in [`packages/core/src/agent/domain/model-resolution.ts`](../../packages/core/src/agent/domain/model-resolution.ts), a pure function over the facts the resolver reads. `ModelResolver` in [`packages/core/src/agent/application/model-resolver.ts`](../../packages/core/src/agent/application/model-resolver.ts) reads them and words a failure for the wire.

## Model selection

A model a guardian picks by name for a chat, such as `claude-sonnet` or `gpt-6-luna`, and the provider that serves it. It is one of a fixed list the agent context owns. Leaving the choice to Rome ("auto" in the dashboard) is not a selection but the absence of one, so the resolver picks by [tier](../concepts/agents.md#model-selection) instead.

- In code it is `ModelSelection` in [`packages/core/src/agent/domain/model-selection.ts`](../../packages/core/src/agent/domain/model-selection.ts). The webchat settings that store a guardian's pick read it from there.
