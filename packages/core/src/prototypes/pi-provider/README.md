# Pi provider SDK prototype

This is an inspectable, opt-in spike, not a production provider. It tests the
riskiest seams in the Pi provider proposal:

1. Pi's supported SDK can discover the models authenticated by Pi, including
   custom `models.json` entries.
2. A Pi `AgentSession` can be created with Rome's prompt and only Rome-owned
   custom tools, while Pi streaming/tool events are translated to Rome's
   provider-neutral `AgentMessage` shapes.
3. Behind `ROME_PI_PROVIDER_PROTOTYPE=1`, the real Rome settings/connect panel,
   normal model selector, conversation request, provider resolver, and chat
   transcript can carry one exact qualified Pi model through an ordinary turn.

The prototype never starts the Pi CLI, a PTY, or a terminal. The live-run path
uses an in-memory Pi session and disables Pi extensions, skills, prompt
templates, context files, session files, and built-in file/shell tools.
It remains source-only: Rome type-checks and runs it with `tsx`, while the core
production build excludes `src/prototypes/**` from emitted `dist` artifacts.

## Try it

### Actual Rome UI vertical slice

Build the dashboard, then run an isolated Rome profile on a loopback port:

```sh
pnpm build:apps # once per clean checkout
pnpm --filter rome-web build
ROME_PI_PROVIDER_PROTOTYPE=1 \
ROME_PROFILE=pi-provider-prototype \
INTERNAL_API_PORT=4318 \
INTERNAL_API_WEB_ROOT="$PWD/packages/web/dist" \
pnpm --filter @rome/core start
```

Open <http://127.0.0.1:4318/>. In **Settings → AI Tools**, the visibly labelled
**Pi Coding Agent · Prototype** row opens a native Rome configuration dialog.
Choose one of the reviewed one-token providers, paste a literal API token, and
save it directly into Pi's credential store. The dialog never reads the token
back; it independently reports stored/environment credential source, catalog
discovery, and the deliberately **not live-verified** validity state. Replace
and remove affect only the selected Pi credential, and external credentials are
left alone. `$ENV`, `!command`, OAuth, custom, and multi-field provider setup is
excluded from this prototype.

Kimi credentials are platform-specific. Select **Kimi For Coding** only for a
key created by the Kimi Code subscription console. Select **Moonshot AI
(global Kimi Platform)** or **Moonshot AI China (Kimi Platform)** for a
pay-as-you-go Kimi Platform key from the matching global or China endpoint;
those keys are not interchangeable.

After discovery, start a normal chat, open the standard model menu in the
composer, choose a `Pi prototype · provider / model` entry, and send a message.
The exact `pi-prototype:<qualified-id>` selection travels through the normal
session request and resolves only to the opt-in Pi adapter. The model menu
updates after save/remove/refresh without changing Auto or the current choice;
a selected Pi model that later disappears remains labelled unavailable.

### Standalone SDK inspection page

Start the isolated local UI prototype:

```sh
pnpm --filter @rome/core prototype:pi:ui
```

Open <http://127.0.0.1:4317/prototype/pi-provider>. The page is visibly marked
**PROTOTYPE · LOCAL ONLY**. It remains useful for inspecting the SDK seam by
itself; it is not evidence for the actual Rome UI route above.

- **Demo mode** is the default. Refresh discovery, choose either qualified
  model, enter a message, and press **Send**. Discovery goes through Pi's SDK
  using a temporary declarative catalog; the conversation response is a
  deterministic local stream and does not claim that a real provider ran.
- **Local Pi** reads the guardian's existing Pi-owned configuration. Configure
  Pi in the guardian's own terminal, select **Local Pi**, refresh, choose one
  discovered qualified model, and send a message to attempt a genuine SDK
  turn. The page never offers login or launches Pi CLI.
- Set `ROME_PI_PROTOTYPE_PORT` before the command to use another loopback port.

The local server binds only to `127.0.0.1`. Its browser API returns safe model
metadata and generic live-discovery/turn failures rather than raw SDK errors.
The live session retains the original spike's single `rome_probe` tool and
in-memory isolation; it exposes no shell, PTY, file tools, Pi extensions, or Pi
history.

### Command-line SDK seam

From the repository root, run the deterministic offline demonstration:

```sh
pnpm --filter @rome/core prototype:pi demo
```

It creates a temporary Pi `models.json` with two upstream providers that expose
the same bare model id. The output shows both as distinct, reversible qualified
ids and never prints the placeholder credential.

Inspect the guardian's real Pi configuration without network catalog refresh:

```sh
pnpm --filter @rome/core prototype:pi discover
```

Add `--refresh` to allow Pi's provider-owned remote catalog refresh (bounded to
15 seconds). Authentication and model setup remain Pi-owned in
`~/.pi/agent`; this command does not offer login.

If that output includes a model, exercise a real SDK turn:

```sh
pnpm --filter @rome/core prototype:pi run anthropic/claude-sonnet-5 \
  "Call rome_probe with value hello, then report its result."
```

The command prints JSON Lines in Rome's `AgentMessage` shape. A successful tool
call demonstrates that the model sees a Rome-owned callback without gaining
Pi's shell or file tools. The final accounting identifies the provider as
`pi` and the model as the exact qualified Pi model id.

## What this proves

- `ModelRuntime.getAvailable()` returns dynamic, auth-filtered built-in and
  custom models. Provider plus model id can be encoded into Rome's existing
  exact-model string without collisions or routing through Rome's native
  provider of the same name.
- `createAgentSession()` accepts a caller-selected exact model, an isolated
  resource loader, in-memory settings/session state, a caller-owned system
  prompt, and caller-owned custom tools.
- Pi streams text, whole thinking blocks, tool start, tool result, terminal, and
  accounting information with enough structure to adapt to Rome's provider
  contract. The bridge waits for Pi's authoritative `thinking_end` instead of
  misrepresenting individual thinking deltas as complete Rome blocks.
- `AgentSession.abort()` is available for Rome cancellation. The prototype
  wires an optional `AbortSignal` to it.

## Findings and limitations

- **Tool eligibility is not discoverable.** Pi's current `Model` metadata says
  whether text/image input and reasoning are supported, but has no general
  “supports function tools” field. `getAvailable()` means authenticated, not
  proven compatible with Rome's tool contract. Production needs a conservative
  eligibility policy, an upstream capability addition, or a provider/model
  probe before satisfying the product acceptance criterion.
- **Auth availability is not a live access check.** A configured credential can
  still be revoked, out of quota, or denied for one model. Runtime failures must
  trigger a safe status refresh and Rome's structured error classification.
- **Pi and Rome have different transcript ownership.** The Rome UI slice stores
  the exact selected provider/model through Rome's normal session machinery,
  but each prototype adapter turn uses a fresh in-memory Pi session. It does
  not reconstruct prior Rome messages, resume, or fork. Production must make
  Rome authoritative and test prefix fidelity across eviction/restart.
- **Streaming phase is lossy.** Pi text deltas do not identify commentary versus
  final-answer phase. This bridge streams deltas immediately and classifies the
  completed block from Pi's stop reason. Rome UI behavior needs explicit review.
- **Pi still composes the effective system prompt.** Even with a full resource
  loader prompt override, the SDK appends runtime context such as `<cwd>` (shown
  by `demo`). Production must review this composition and make it stable across
  resume/fork rather than assuming Rome's input string is byte-identical on the
  wire.
- **Configuration can execute credential resolvers.** Pi custom model values may
  use `!command` resolution. Although that is Pi-owned credential configuration,
  production must decide whether the Rome daemon may execute it, bound it, and
  document the security boundary. This spike's demo uses only a literal dummy
  value.
- **Errors need hardening.** The discovery result exposes only failed provider
  ids, not SDK error text, but the live-turn path has not yet implemented Rome's
  auth/quota/transient error taxonomy or systematic secret redaction.
- **SDK churn and footprint are material.** The official package moved from the
  deprecated `@mariozechner` namespace to `@earendil-works`; this spike pins
  `@earendil-works/pi-coding-agent` 0.86.1. Its dependency graph includes
  provider SDKs that will increase install size and supply-chain surface.
- The opt-in slice wires guarded one-token credential management,
  discovery/status, exact model selection, resolver, and a basic streamed text
  turn into the existing Rome UI. It does not support
  approvals, Rome actions/skills/subagents, images, structured output, retries,
  reliable cancellation, or production tests. The only Pi tool is the harmless
  prototype `rome_probe`; no shell, PTY, file tool, extension, or Pi history is
  exposed.

## Recommended production breakdown

1. **Catalog and status (2–3 engineering days):** add Pi provider identity,
   safe status/refresh state, qualified-id storage, configuration diagnostics,
   and a settled tool-eligibility policy.
2. **Provider session adapter (4–6 days):** translate Rome prompts, images,
   actions/skills/subagents and Pi events; implement cancellation, max-turns,
   error classification, output schemas, and strict resource isolation.
3. **Durability and selection (3–5 days):** dynamic selector entries,
   unavailable saved choices, exact resolver behavior, transcript
   reconstruction/resume, model pins, and restart/idle/fork coverage.
4. **Security and product hardening (4–6 days):** AI Tools setup copy, secret
   redaction, credential-command policy, approval/tool tests, quota/revocation
   refresh, dependency review, and end-to-end regression coverage.

Estimate: roughly **3–4 engineering weeks** for one engineer, depending mainly
on the tool-eligibility decision and transcript-resume design. The work should
land in reviewable slices; this prototype should not be promoted wholesale.
