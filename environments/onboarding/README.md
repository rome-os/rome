# Onboarding environment

A local Rome Cloud, run from a Rome Cloud checkout, that creates each new Rome as a container on this machine from an image built from this Rome checkout. A person starts at the Rome Cloud landing page and ends in their new Rome's chat.

## What it tests

- The Rome Cloud landing page and its sign-up entry.
- The onboarding questions and the live preview beside them.
- Creating a Rome, including the warm pool, and the progress shown while it boots.
- Opening the Rome from the Rome Cloud dashboard, and the Rome's sign-in through Rome Cloud.
- The Rome's first screen after sign-in.
- With `walk-cards`, the cards an agent waits on:
  - Core's connect card: the agent shows it for GitHub, Dismiss answers it, and the agent takes its next turn.
  - An app's connect card, through Fake Service: Connect opens Fake Service's sign-in, the walk signs in, I've authorized answers the agent, and the agent takes its next turn.
  - For each real provider with a test OAuth app set, Connect reaches that provider's authorization page.

## Differences from production

- **Dev sign-in replaces Google, Microsoft and email.** Get started signs you in as `dev@rome.localhost` with no prompt, so the real sign-in screens are not tested. To sign up as someone else, open `/api/auth/dev/start?email=<address>` first.
- **A model login of its own, not Rome credits.** With `ANTHROPIC_API_KEY` set, every new Rome runs on that key, and `walk-cards` and `models` send all three model tiers to `claude-haiku-5-5` (`ONBOARDING_MODEL` picks another). Production runs each tier on its own model, on Rome credits or the guardian's own login. Without the key, the new Rome says that no AI provider is available.
- **Test OAuth apps, not Rome's central ones.** Rome Cloud connects GitHub, Slack and Shopify through test apps registered to this environment's address, owned by test accounts. The central apps' own settings, such as their scopes and Shopify's review, are not tested. A provider without a test app cannot be connected here.
- **Fake Service is a service that exists only here.** It is an app in `fake-service/`, installed in each Rome by `walk-cards` or `fake-service`, that signs in through an OAuth test server, [mock-oauth2-server](https://github.com/navikt/mock-oauth2-server), at `https://onboarding-oauth.romeos.dev`. The sign-in page takes any user name. Fake Service goes through an app's connect card, not core's, so connecting a real provider still needs its test app. It keeps the connection in a temporary file, which a restart of the Rome forgets.
- **Signing in at a real provider is a person's step.** `walk-cards` stops at each provider's authorization page. Finish a connection by hand: sign in there as the test account, then press I've authorized on the card.
- **The cloud sign-in gate is forced on** in every new Rome, because there is no Statsig key. The rollout of that gate is not tested.
- **Each Rome is a container on this machine, not a VM.** Rome Cloud's Docker provider runs it in Docker-in-Docker, so VM provisioning, upgrades over SSH and host-level setup are not tested.
- **No telemetry, mail, relay or push.** Their settings point at addresses that do not resolve.
- **Cloudflare Access sits in front of every address.** Your browser signs in to Cloudflare once for Rome Cloud and once for each new Rome address.

## Commands

Run them from the repository root inside `nix develop`.

| Command | Does |
| --- | --- |
| `environments/onboarding/env.sh up` | Builds the Rome image from this checkout, checks out Rome Cloud, starts everything, and prints the link |
| `environments/onboarding/env.sh up --no-build` | The same, reusing the last Rome image |
| `environments/onboarding/env.sh walk` | Builds the Rome image when it was built from another commit, resets, then walks from the landing page to the new Rome's chat |
| `environments/onboarding/env.sh walk-cards` | The walk, then installs Fake Service and walks the chat cards in `cards.mjs`. Needs `ANTHROPIC_API_KEY` |
| `environments/onboarding/env.sh fake-service` | Installs the Fake Service app in every running Rome, in about a minute each |
| `environments/onboarding/env.sh models` | Sends every model tier of every running Rome to the cheap model. A Rome you make by hand runs on its default models until you run it |
| `environments/onboarding/env.sh reset` | Deletes every account and Rome, and starts again empty |
| `environments/onboarding/env.sh down` | Removes everything `up` created, except the Rome Cloud checkout and the image registry |

Rome Cloud is served at `https://onboarding-pantheon.romeos.dev`, and each Rome at `https://<address>.romeos.dev`.

`ROME_CLOUD_REF` picks the Rome Cloud commit, `origin/main` by default. `ROME_CLOUD_DIR` runs an existing Rome Cloud checkout as it is, and Rome Cloud's dev server reloads on each edit there. A committed change to Rome code is picked up by the next `up` or `walk`, which rebuild the image when it was built from another commit. An uncommitted change needs `up`, which always rebuilds.

## Secrets

The model login and the test OAuth apps live in a file on this machine, `~/.config/rome/onboarding.env`, outside the repository, with mode 600 and one `KEY=value` line each. `ONBOARDING_SECRETS_FILE` points elsewhere, and a variable already set in the shell wins. Every line is optional.

```
ANTHROPIC_API_KEY=            # the model login every new Rome runs on
ONBOARDING_MODEL=             # the model every tier runs on, claude-haiku-5-5 when unset
GITHUB_OAUTH_CLIENT_ID=       # a GitHub OAuth app owned by the test GitHub account
GITHUB_OAUTH_CLIENT_SECRET=
SLACK_OAUTH_CLIENT_ID=        # a Slack app in the test Slack workspace
SLACK_OAUTH_CLIENT_SECRET=
SHOPIFY_OAUTH_CLIENT_ID=      # a Shopify app in the test Partner account, for its development store
SHOPIFY_OAUTH_CLIENT_SECRET=
```

Register each test app's redirect address at `https://onboarding-pantheon.romeos.dev`, on the paths that Rome Cloud's `packages/pantheon/.env.example` names for that provider. `up` writes the apps into Rome Cloud's settings, so run it again after changing the file.

## Requirements

- Docker, and the shared Traefik that `pnpm dev:all` uses. `up` starts Traefik when it is not running.
- A Rome Cloud clone at `~/workspace/rome-cloud`, or `ROME_CLOUD_REPO`.
- The Cloudflare tunnel for `*.romeos.dev` described in the devbox's `docs/remote-access.md`, with a Cloudflare Access Bypass policy for this machine's IPv4 address. Each Rome calls Rome Cloud at its public address, and so does the walk-through.
- One onboarding environment per machine. Its router answers every `<name>.rome.localhost` that no other stack claims. The worktree that first ran `up` owns it, and the commands refuse to run from another worktree until `down`, or with `ROME_ENV_TAKE_OVER=1`.
- The Rome image goes through a registry container, `rome-env-registry` on port 5050, which any environment can share.

## Timing

Measured on the devbox:

| Step | Time |
| --- | --- |
| `up` with the Rome image already built and the database removed | 12 s |
| `walk`, from reset to the Rome's chat | 88 s |
| `walk` after `down` and a new commit, including the image rebuild | 97 s |

A rebuild with an empty Docker build cache takes longer and has not been timed.
