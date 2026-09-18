# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The guardian dashboard (`packages/web`) and the app shells are web surfaces. `packages/desktop` is an Electron shell around a local Rome runtime, and `packages/mobile` is an Expo WebView shell that signs in at Rome Cloud and opens the guardian's own instance. Neither shell has its own design language.

## Users

**Guardian.** One Rome instance serves exactly one guardian, who owns its configuration, memory, policies, and approvals ([`docs/concepts/people.md`](docs/concepts/people.md#guardian)). Rome designs for two guardian populations, in this order:

1. **Technical builders first.** Developers and technical power users who self-host with Docker or run on Rome Cloud. They read code, git history, and agent traces, and they build or remix apps.
2. **Capable non-developers next.** The product is deliberately moving toward people who delegate outcomes in plain language and rarely open code. Everyday use must not require code literacy, even where builders get deeper inspection.

**Visitor.** A Rome Cloud account holder the guardian granted scoped access to, usually to open one shared app. A visitor never holds guardian privileges and does not need to understand Rome to use a shared app ([`docs/concepts/people.md`](docs/concepts/people.md#visitor)).

**App author.** Anyone who builds a Rome App with `@rome-os/app-runtime` and `@rome-os/app-web-sdk`, including the guardian, the in-Rome coding agent, and community authors publishing to the App Store.

**Operator.** The Rome Cloud team that provisions instances, handles account support, and monitors usage across guardian accounts.

## Product Purpose

Rome is the agentic OS for humans and agents. It scales the environment an agent works within, meaning its tools, workflows, memory, and interfaces, instead of only the model ([`VISION.md`](VISION.md)).

The guardian describes an outcome. Rome completes it, and when the work repeats, Rome turns it into a durable capability: an action, a skill, a workflow, or a Rome App with its own interface, agent, and data. Each capability becomes a building block for later, more ambitious requests.

Success means the environment compounds. Repeated work runs through proven actions instead of fresh model reasoning. Each repeated workload has a home of its own that stays useful after the conversation ends. The guardian trusts Rome with more responsibility because the evidence supports it.

## Positioning

Rome compounds a user-owned environment. What accumulates is executable software (actions, skills, and apps as git-tracked code, plus memory and app-private data), not bot state, chat history, or text notes. Agents, routines, and app interfaces all call the same named actions, which can pause for approval and record every run.

Rome earns autonomy through evidence and approvals. Access, competence, and authority are separate, and consequential actions need the guardian's approval.

Rome stays invisible while helping and fully inspectable on demand. The guardian can see what capabilities exist, what data and permissions they use, where they came from, and how they changed, and can correct or roll them back.

Rome is open source (MIT), self-hostable or run on Rome Cloud, and exportable, so the accumulated environment survives a model swap or a departure. The README comparison with Grok Bot, Muse, Hermes Agent, Manus, and Wabi is the maintained statement of this position.

## Operating Context

- **Chat (webchat)** is the only interactive surface and the default entry point. Guardians also reach the agent through channels such as Telegram, Discord, and WhatsApp.
- **Rome Apps** are the home for repeated work. "A workflow is a verb, an app is a noun." First-party apps in `rome_apps/` (assistant, briefing, browser-automation, coding, connector, dream, inbox, recap, showcases, skills, system, welcome-to-rome, workflow-studio) use the same app model as user-authored apps. [Replay](https://github.com/rome-os/rome-apps/tree/main/apps/replay) is maintained in the Rome Apps repository and installed separately.
- **Self-evolution loop.** The guardian describes a need, Rome writes a short spec, the guardian approves it, and Rome builds the app or workflow into the instance and keeps iterating in the same conversation.
- **Approvals and suspensions.** Actions can pause for the guardian's decision, and the guardian answers from the dashboard or a channel.
- **Background work.** Routines, scheduled tasks, and long-running follow-through run while the guardian is away, and results arrive as notifications, briefs, or app state.
- **Inspection.** Agent traces, replays, projects and memory file browsers, local changes and sync, and settings let the guardian check what happened.
- **Shared apps.** Guardians set each app to private, public, or a Rome Cloud email list, and visitors open it through the hosted app shell and sign-in gate.
- **Devices.** Keyboard-heavy desktop use, compact phone and tablet use through the browser or mobile shell, and hybrid touch-and-pointer devices.
- **First run.** `welcome-to-rome` onboards the guardian conversationally in the standard chat UI.

## Capabilities and Constraints

- A Rome App ships any mix of actions, agents, skills, hooks, web UI and APIs, and a database and files, declared in `app.yaml`. Together these form a capability, the unit Rome discovers and reuses. The app is that capability's human interface.
- App web bundles mount inside a Shadow DOM in the dashboard host. Apps receive the theme layer from the host and must compile their own geometry and typography tokens ([`rome_apps/CLAUDE.md`](rome_apps/CLAUDE.md)).
- Apps build on the public SDKs and the shared kit `@rome-os/ui`, which are published to npm through release-please.
- A Rome instance keeps working without Rome Cloud. It loses only centralized provisioning, third-party OAuth, and App Store installs.
- The dashboard is guardian-only. Visitors reach only the surfaces their email is allow-listed for.
- The interface ships in English and Simplified Chinese (`packages/web/src/i18n/locales`).
- Canonical terminology lives in [`docs/concepts/`](docs/concepts/index.md). Use "guardian", "visitor", "Rome App", "action", "skill", "routine", "approval", "capability", and "instance" as defined there.
- Rome Cloud is in preview.

## Brand Commitments

- **Name and line.** "Rome" and "The agentic OS for humans and agents." The closing line "Give your agents a place to grow." appears in the README.
- **Voice.** [`docs/ui/VOICE.md`](docs/ui/VOICE.md) governs every string a guardian reads. Rome is plain and calm, describes what the system does and what that costs, and does not perform warmth or apologize. Failure copy is economical, and everything else uses full sentences. Negative contractions are spelled out. Rome names itself only when Rome is the actor.
- **Documentation prose** follows [`docs/authoring/WRITING.md`](docs/authoring/WRITING.md).
- **Assets.** The logo (`packages/web/src/components/logo/rome-logo.svg`), the 3D mark (`docs/assets/rome-3d.png`), and the overview video poster (`docs/assets/rome-overview-video.jpg`).
- **Community.** The website at romeos.cc, the App Store, X (@RomeAILab), and Discord.

## Evidence on Hand

- Product thesis and principles: [`VISION.md`](VISION.md).
- Competitive comparison: the "How Rome compares" section of [`README.md`](README.md).
- Example requests Rome follows through on: code review loops, inbox triage, price tracking, and customer interviews (README).
- The overview video on YouTube, linked from the README.
- First-party apps in `rome_apps/`, the App Store at romeos.cc/store, and trace showcases through the showcases app.
- The repository holds no customer testimonials, case studies, usage metrics, benchmarks, pricing, or press. Future work must not invent any of these.

## Product Principles

1. **Experience becomes capability.** Completed work feeds reusable actions, skills, and apps. A surface that finishes a task should leave something the next task can reuse.
2. **Start from outcomes.** The guardian describes what they want, and apps are interfaces Rome builds when the work deserves one, not software the guardian must specify in advance.
3. **Earn autonomy.** Value comes before access, and evidence comes before autonomy. Consequential actions show their evidence, assumptions, and approval requirements before they run.
4. **Invisible by default, inspectable on demand.** Everyday use does not require managing the environment or reading code. Builders can always reach what exists, what it uses, where it came from, and how to roll it back.
5. **The environment belongs to the guardian.** It is open, git-tracked, and exportable, and Rome competes without lock-in.

## Accessibility & Inclusion

- WCAG 2.2 AA for new UI, with 44 to 48px touch targets on compact surfaces.
- Every action is reachable by keyboard, touch, mouse, pen, and assistive technology. Shortcuts, long-press, right-click, hover, and drag are accelerators, never the only path.
- Motion respects `prefers-reduced-motion`, and no interaction depends on motion.
- Copy works in English and Simplified Chinese, so layouts must tolerate both scripts and differing string lengths.
