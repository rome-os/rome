# Welcome to Rome

Conversational first-run onboarding. The guardian chats with Rome in the
**standard Chat UI**, but the assistant's side of the conversation is **scripted**
— driven by a deterministic state machine instead of a model. No tokens are
spent on the conversation itself, and the assistant can never go off-script.

This is the first client of the **turn-middleware** seam. A turn
middleware registered by this app intercepts every turn whose
`agentName === "welcome-to-rome"` and produces the reply by emitting synthetic,
model-isomorphic events into the turn's event stream. The webchat SSE and
persistence pipeline is a pure downstream consumer of that stream, so a scripted
turn streams, persists, and renders exactly like a model turn — with zero
changes to the webchat route, storage, or the front-end Chat component.

## How it works

- `agents/welcome-to-rome.yaml` — a **code-backed agent**. The
  model declared here is never called. It exists only so the webchat send route
  accepts the agent name and acquires a real session/transcript. The middleware
  short-circuits before any model round.
- `hooks/turn-middleware/` — the middleware. `script.ts` is the state machine
  (one node per conversation step: greet → confirm the names → connect an AI →
  one question → brainstorm → pick an idea → done). `copy.ts` holds the
  user-facing strings so wording changes do not touch logic. `index.ts` wires
  them to `ctx.emit` and the progress repo. The name card writes the guardian
  name and the agent name through the host's guardian profile repository, which
  updates the settings and the guardian person row together. The connect-AI
  step is the host's `ai-tools-card` (rendered by rome-web, the same panel the
  settings page uses). It resolves itself when the status probe reports a
  provider logged in, and it can be skipped.
- `agents/welcome-memory.yaml` / `agents/welcome-app-ideas.yaml` — the
  **side-effect** agents (folding the guardian's answer into memory,
  brainstorming first-app ideas). The conversation is scripted, but these heavy
  steps remain real agents the middleware `summon`s. A scripted conversation is
  not "no model anywhere". A skipped connect defers the fold (the raw answer
  stays in the progress row) and shows the generic idea list instead of
  summoning.
- `db/` — the singleton progress table. `node` is the state-machine cursor.
  Captured artifacts are cached so a reload or restart resumes mid-conversation,
  which is how a Codex browser login that leaves the page lands back on the
  connect step.
- The idea picker ends the conversation: the build button opens a fresh chat
  with the idea's kickoff prompt in the composer, and the explore button opens
  an empty one.

## The landing screen

`src/web/App.tsx` is the **first screen a guardian sees in Rome**. The cloud
sign-in callback and the local onboarding page both land a freshly set-up
guardian on `/full/apps/welcome-to-rome` (see `resolveAuthRouting` in
`packages/web/src/lib/auth-routing.ts`), so this app's web bundle is the entry
point into the product. It is also the reset point: its one button clears the
progress row and replays the welcome.

It is deliberately a moment of delight rather than a form: a confetti burst on
mount (`canvas-confetti`, lazily code-split, honouring `prefers-reduced-motion`),
a floating hero mark with staggered entrance animation (keyframes in
`styles.css`), and a single **Start chat** button.

Pressing it calls `startChat({ agentName: "welcome-to-rome", … })` from
`@rome-os/app-web-sdk`, which creates the session, posts the kickoff turn, and
soft-navigates to `/chat/<id>` — where the scripted conversation below takes over.
(The kickoff text is ignored by the `greet` node; the state machine greets on
first contact regardless.)

## Starting a conversation directly

The same thing the button does, by hand — create a webchat session bound to this
agent and open it in the Chat UI:

```http
POST /chat/sessions
{ "name": "Welcome to Rome", "agentName": "welcome-to-rome" }
```

Send any first message and the scripted conversation begins.
