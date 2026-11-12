# Onboarding environment

A local Rome Cloud, run from a Rome Cloud checkout, that creates each new Rome as a container on this machine from an image built from this Rome checkout. A person starts at the Rome Cloud landing page and ends in their new Rome's chat.

## What it tests

- The Rome Cloud landing page and its sign-up entry.
- The onboarding questions and the live preview beside them.
- Creating a Rome, including the warm pool, and the progress shown while it boots.
- Opening the Rome from the Rome Cloud dashboard, and the Rome's sign-in through Rome Cloud.
- The Rome's first screen after sign-in.

## Differences from production

- **Dev sign-in replaces Google, Microsoft and email.** Get started signs you in as `dev@rome.localhost` with no prompt, so the real sign-in screens are not tested. To sign up as someone else, open `/api/auth/dev/start?email=<address>` first.
- **No Rome credits.** The new Rome says that no AI provider is available, so anything that needs a model is not tested here.
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
| `environments/onboarding/env.sh reset` | Deletes every account and Rome, and starts again empty |
| `environments/onboarding/env.sh down` | Removes everything `up` created, except the Rome Cloud checkout and the image registry |

Rome Cloud is served at `https://onboarding-pantheon.romeos.dev`, and each Rome at `https://<address>.romeos.dev`.

`ROME_CLOUD_REF` picks the Rome Cloud commit, `origin/main` by default. `ROME_CLOUD_DIR` runs an existing Rome Cloud checkout as it is, and Rome Cloud's dev server reloads on each edit there. A committed change to Rome code is picked up by the next `up` or `walk`, which rebuild the image when it was built from another commit. An uncommitted change needs `up`, which always rebuilds.

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

A change to Rome code adds the Rome image build to `up`, which takes a few minutes and has not been timed separately.
