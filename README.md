<p align="center">
  <img
    src="docs/assets/rome-3d.png"
    alt="Rome, a personal AI agent"
    width="240"
  />
</p>

<h1 align="center">Rome</h1>

<p align="center">
  <strong>The agentic OS for humans and agents.</strong>
</p>

<p align="center">
  <a href="https://github.com/rome-os/rome/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/rome-os/rome/actions/workflows/ci.yml/badge.svg" />
  </a>
  <a href="LICENSE">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  </a>
  <a href="https://x.com/RomeAILab">
    <img alt="Follow Rome on X" src="https://img.shields.io/badge/follow-%40RomeAILab-black?logo=x&amp;logoColor=white" />
  </a>
  <a href="https://discord.gg/g7EFmEtmqc">
    <img alt="Join the Rome Discord server" src="https://img.shields.io/badge/chat-Discord-5865F2?logo=discord&amp;logoColor=white" />
  </a>
</p>

<p align="center">
  <a href="https://romeos.cc/">Website</a>
  ·
  <a href="https://romeos.cc/login">Try Rome Cloud</a>
  ·
  <a href="https://romeos.cc/docs/rome">Documentation</a>
  ·
  <a href="https://romeos.cc/store">App Store</a>
</p>


## What is Rome?

Rome is an open source alternative to Grok Bot and Meta's Muse. The
[MIT-licensed](LICENSE) runtime combines persistent AI agents, scheduled
workflows, and apps you can inspect, extend, and self-host.

See how Rome compares with [Grok Bot](#grok-bot-alternative) and
[Muse](#muse-alternative), or [run Rome with Docker](#run-with-docker).

Most progress in AI comes from scaling models. Rome scales the other axis, the environment: the tools, workflows, memory, and interfaces an agent works within ([why this matters](VISION.md)).

Rome is a guardrailed environment where human and agent collaborate, and the collaboration compounds. Agents build their own harnesses, design their own SOPs, and orchestrate workflows under your guidance. Proven capabilities stick. Every interaction raises the ceiling for the next.

<p align="center">
  <a href="https://www.youtube.com/watch?v=lyNGYEw4a6Y">
    <img
      src="docs/assets/rome-overview-video.jpg"
      alt="Watch Rome, an OS for Recursive Agents"
      width="800"
    />
  </a>
</p>


## Get started

### Rome Cloud

Rome Cloud provisions a private Rome environment for each guardian. It is currently
available as a preview.

[Join the preview →](https://romeos.cc/login)

### Run with Docker

One script checks for Docker, pulls the published image, and starts Rome:

```bash
curl -fsSL https://raw.githubusercontent.com/rome-os/rome/main/scripts/quickstart-docker.sh | bash
```

Or clone the repository and run the script from it:

```bash
git clone https://github.com/rome-os/rome.git
cd rome
./scripts/quickstart-docker.sh
```

The dashboard comes up at `http://localhost:7663`, bound to loopback only.
First-run onboarding is open to whoever reaches it first, so exposing it
beyond the machine takes an explicit `--bind`. State lives in named Docker
volumes, so re-running the script upgrades the container without losing data.
Telemetry export stays off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT`. Run
the script with `--help` for ports, profiles, and the other settings it
forwards.

### Run the development environment

To run this repository from source, you need:

- Node.js 24 or newer
- Corepack and pnpm 11.6
- Docker with Docker Compose

From a checkout of this repository:

```bash
corepack enable
pnpm install
pnpm dev:all
```

`pnpm dev:all` starts the production-shaped local stack: Rome, observability,
routing, and the web development server. It connects to `https://romeos.cc` by
default; set `ROME_DEV_PANTHEON_ORIGIN` to use another Rome Cloud deployment.
The script prints the local URLs and development credentials when startup completes.

This is the contributor development path, not the final production self-hosting
distribution. See [`CLAUDE.md`](CLAUDE.md) for the complete development loop,
container commands, and validation requirements.

## Rome Apps

**Rome App is the new way to interact with your agent.**

Chat is a good place to ask for something once. Repeated work deserves a place of
its own: an inbox that remembers what was triaged, a code review loop you can
inspect, a price tracker that keeps watching, or a morning brief that arrives on
schedule.

A Rome App combines a purpose-built interface, agent reasoning, reusable
workflows, and persistent data into one installable product. It is not a thin
wrapper around a prompt. The app remains useful after the conversation ends,
after the browser closes, and when the user comes back tomorrow.

| Purpose-built UI & UX | AI-native | Persistent by default | Community-powered |
| --- | --- | --- | --- |
| An interface designed for the job | Agents are part of how the product works | Data and workflows carry forward | Install, share, and learn from other builders |

A useful rule of thumb: **a workflow is a verb; an app is a noun**. Use a
workflow to perform a task and return a result. Build an app when the work needs
a home of its own, with user-editable data, multiple actions, or a persistent
agent.

### Rome can build the missing app

When there is not an app for what you need, describe it to Rome in plain
language. Rome can turn that request into a short specification, scaffold the
app or workflow, build it into your instance, and keep iterating with you in the
same conversation.

The result is ordinary, git-tracked source code rather than hidden model state.
Keep it private, adapt it as your needs change, or publish it for others to
install from the App Store. This creates Rome's self-evolution loop:

```text
Describe a need → Rome builds the capability → the app keeps working
       ↑                                              ↓
       └──────────── refine, reuse, and share ────────┘
```

### Under the hood

A Rome App starts with an `app.yaml` manifest and can ship any mix of:

| Artifact | Purpose |
| --- | --- |
| **Actions** | Typed operations that agents, routines, and app code can invoke |
| **Agents** | App-owned collaborators with their own instructions and tools |
| **Skills** | Plain-language procedures loaded when an agent needs them |
| **Hooks** | Extensions to message, event, and agent-turn lifecycles |
| **Web UI & APIs** | Purpose-built interfaces and app-owned HTTP surfaces |
| **Database & files** | Persistent, app-private state that survives across runs |

Together these form a **capability**: the unit Rome discovers and reuses in
later work. The app is that capability's human interface: apps organize human
interaction; capabilities organize agent action.

Apps build on two public SDKs:

- `@rome-os/app-runtime` for backend capabilities.
- `@rome-os/app-web-sdk` for embedded web interfaces and the Rome build CLI.

Browse the [Rome App Store](https://romeos.cc/store), read the
[building guide](https://romeos.cc/docs/building-apps), or start with the
[app quickstart](https://romeos.cc/docs/building-apps/quickstart).

## What people do with Rome

These are the kinds of requests Rome is designed to follow through on:

<table>
  <tr>
    <td><strong>Run the code review loop</strong><br><br>“Fix all P1 and P2 review comments until there are no merge blockers left. Let me know when you finish.”</td>
    <td><strong>Organize your email</strong><br><br>“Sort my inbox. Archive the noise, flag anything urgent, and draft replies for messages that need me.”</td>
  </tr>
  <tr>
    <td><strong>Track a game's price</strong><br><br>“Track the price of this game and let me know when it drops below $30.”</td>
    <td><strong>Interview your customers</strong><br><br>“Interview five customers about onboarding. Ask follow-up questions and summarize what we should improve.”</td>
  </tr>
</table>

Rome can handle one-off tasks, scheduled work, long-running follow-through, and
purpose-built app experiences without forcing everything into one chat window.

## How Rome compares

Rome sits where two product waves meet: persistent agents and personal
software. The agent products share Rome's thesis that agents should persist
and improve. There the comparison is what accumulates, what runs when work
repeats, and where you operate the result. The personal software platforms
share Rome's thesis that software should be built per person. There the
comparison is who and what stands behind the app.

| | What accumulates | What runs repeated work | Where you operate it | Hosting |
| --- | --- | --- | --- | --- |
| **Rome** | Actions, skills, and apps as git-tracked code, plus memory and app-private data | A saved action, with model calls only when the action needs them | A purpose-built app, plus chat channels (Telegram, Discord, WhatsApp) | Self-hosted or Rome Cloud |
| **[Grok Bot](https://docs.x.ai/grok-bot/overview)** (xAI) | Bot memory and preferences, reusable skills, and files on a shared cloud computer | Bots following skills through scheduled or event-triggered routines | Chat, file previews, computer access, and routine controls | xAI-hosted service |
| **[Muse](https://introducing.muse.ai/)** (Meta) | Personal memory, goals, files, and interactive artifacts on a dedicated cloud computer | An agent working on schedules and relevant events, with tools it can build | The Muse app and WhatsApp, plus goals, activity, approvals, and interactive artifacts | Meta-hosted service |
| **Hermes Agent** (Nous Research) | Bounded memory notes and skill documents, as text | The model, or a script-only cron job\* | A chat thread (chat clients, desktop app, or CLI) | Self-hosted |
| **Manus** | Files, tools, and databases on a persistent cloud computer, plus knowledge and playbooks | The model, or scripts left on its machine\* | A chat session, plus standalone web apps it builds | Hosted, with app-code export |

\* Hermes and Manus can schedule plain scripts that skip the model. A script
answers only to its timer. A Rome action is a building block: agents, apps,
and interfaces all call it, and it can pause for approval.

### Grok Bot alternative

[Grok Bot](https://docs.x.ai/grok-bot/overview) gives named agents a shared
cloud computer with a browser, files, and app logins. Bots remember context,
delegate to each other, and keep working while your laptop is closed. Its
[skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
capture reusable instructions and run work on schedules or supported events.
You can also preview and save
[generated files](https://docs.x.ai/grok-bot/files-and-results).

Rome is an open source Grok Bot alternative for people who want to run and
extend the agent environment themselves. You can [self-host](#run-with-docker),
choose a [supported model provider](docs/concepts/agents.md#model-selection),
and package repeated work as [Rome Apps](docs/concepts/apps.md). Each app can
combine an interface, persistent data, and callable actions. A saved
[action](docs/concepts/actions.md) runs code directly and uses a model only
when the task needs reasoning. Agents, schedules, and app interfaces can reuse
that same action.

### Muse alternative

[Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
is Meta's personal AI agent for everyday tasks and long-term goals. It runs
on a dedicated cloud computer, uses a browser and connected services, remembers
personal context, and follows up through the Muse app or WhatsApp. It asks for
approval before sensitive actions such as sending an email or making a purchase.

[Meta's design overview](https://introducing.muse.ai/) also describes tools
and interactive artifacts, including trackers and dashboards. Its interface
includes goals, activity history, editable memory, and structured approval
controls. Rome shares this emphasis on personal software.

Rome is a Muse alternative for people who want an MIT-licensed runtime they
can self-host and modify. You can also
[choose a model provider](docs/concepts/agents.md#model-selection).
In Rome, an [app](docs/concepts/apps.md) packages interfaces, actions, agents,
and persistent data into an installable capability. You and your agents can
reuse it across later tasks, adapt its source, and share it through the
[App Store](https://romeos.cc/store). Choose Rome when owning and extending
that environment matters to you.

The Grok Bot and Muse comparisons reflect the official documentation linked
above, reviewed on September 11, 2026.

### Other alternatives

**Hermes Agent** is the closest in spirit: MIT-licensed, self-hostable, with
curated memory, self-written skill documents, and a skill marketplace. What
persists is text that informs the next reasoning run, plus script-only cron
jobs that skip the model but answer only to their timer. Rome persists
software: executable actions, app-private databases, and purpose-built
interfaces. An action is a building block rather than a loose script: agents,
routines, and app interfaces all call the same one, it can pause for
approval, and every run is recorded. Rome already
discovers and composes capabilities from earlier work, and its agenda extends
to consolidating, refactoring, and retiring what goes stale
([VISION.md](VISION.md)). And Hermes offers one general interface to the agent
(chat clients, a desktop app, the terminal), while Rome grows a purpose-built
app for each repeated workload.

**Manus** delegates a goal to an agent on a persistent cloud computer: files
stay, installed tools stay, and scheduled jobs, long-running bots, and
databases can live on the machine. It also builds full-stack web apps whose
code you can export and host anywhere. The difference is what that persistence
is made of. A Manus schedule re-runs the agent at metered cost or fires a
script parked on the machine, reusable only by finding the file again, while
a Rome action is a named operation that every surface can call. A Manus app
is a deliverable that stands apart from the agent, while a Rome app is also a
capability the agent discovers and reuses in later work. And the Manus agent itself, with its knowledge,
playbooks, and machine, runs only in its cloud, while Rome self-hosts.

**Wabi** approaches from the personal software side: a social platform where
anyone prompts a mini app into existence, then shares and remixes it, with
Wabi hosting everything. It validates half of Rome's bet, software built per
person rather than for the average user. But there is no worker behind the
app: a Wabi app is the end product, and you still operate it yourself. A Rome
app is the interface to a capability, and the capability faces both ways: you
work through its views, and agents work through its actions, skills, and data
in later tasks. Every new Wabi app grows your library, and every new Rome
capability also extends what the agent can do next. Wabi asks you to describe
an app, while Rome asks you to describe an outcome and leaves an app behind
when the work deserves one.

### What Rome keeps

The difference is the unit of compounding. Grok Bot compounds hosted bot
state and skills, and Muse compounds personal context and artifacts.
Hermes compounds the agent's notes, Manus compounds a machine and its files,
and Wabi compounds a network of shareable apps. Rome compounds the
environment: executable, composable capability owned by you ([why that is the
durable asset](VISION.md)). Building blocks compose: a capability built for
one task becomes a part in a more ambitious one, so each request can ask for
more than the last. An inventory-aging action and a customer-churn skill,
built for separate tasks, later combine to clear seasonal inventory without a
broad markdown.

Proven actions close the cost and reliability gap, purpose-built apps close
the interface gap, and maintenance keeps the environment coherent as it
grows. Because the environment is open, git-tracked, and exportable, it
survives a model swap. Users stay for the compounding, not the lock-in.

## Repository map

Rome is a pnpm monorepo.

| Path | What lives there |
| --- | --- |
| [`packages/core/`](packages/core/) | Agent runtime, sessions, actions, events, channels, policies, memory, and persistence |
| [`packages/web/`](packages/web/) | Guardian-only web dashboard |
| [`packages/desktop/`](packages/desktop/) | Electron shell and local Rome runtime |
| [`rome_apps/`](rome_apps/) | First-party Rome Apps loaded through the same app model |
| [`packages/app-runtime-sdk/`](packages/app-runtime-sdk/) | Public backend SDK for Rome Apps |
| [`packages/app-web-sdk/`](packages/app-web-sdk/) | Public web SDK and app build tooling |
| [`docs/`](docs/) | Product concepts, architecture, decision records, and operations |

Common checks:

```bash
pnpm typecheck
pnpm test:unit
pnpm lint
pnpm build
```

## Documentation

- [`VISION.md`](VISION.md) — why Rome exists and the product principles it protects.
- [`docs/concepts/`](docs/concepts/index.md) — canonical domain vocabulary.
- [`docs/architecture/`](docs/architecture/index.md) — component boundaries and
  system invariants.
- [Using Rome](https://romeos.cc/docs/rome) — public guardian documentation.
- [Building Rome Apps](https://romeos.cc/docs/building-apps) — public app-author
  documentation and SDK guides.

<p align="center">
  <strong>Give your agents a place to grow.</strong><br />
  Start with one workflow. Rome keeps what works and compounds from there.
</p>
