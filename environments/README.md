# Environments

An environment stands up everything one feature needs, so a person or an agent can test that feature the way a user meets it. Each folder here is one environment, named after the main feature it tests.

| Environment | Tests |
| --- | --- |
| [onboarding](onboarding/README.md) | Sign-up from the Rome Cloud landing page, the onboarding questions, creating a Rome, opening it through Rome Cloud sign-in |

## Rules

Agents tend to build an environment that starts partway into the flow, quietly differs from production, and is never checked end to end. These rules decide whether an environment is good.

- **It starts where a real user starts.** Every step a user passes through on the way to the feature runs as real code. For onboarding, that is the Rome Cloud landing page, not a Rome that already exists.
- **A scripted walk-through proves it works.** One command starts the environment from nothing, walks the main path from the link a person would open, and passes. The walk-through is the environment's test, and a scheduled run of it is the environment's CI.
- **Every run starts from nothing and touches nothing else.** "Nothing else" covers other environments, other worktrees, and production.
- **Every difference from production is named.** The README lists each stand-in, what it means for the tester, and the features it leaves untested.

  > Prefer: "Dev sign-in replaces Google, so the Google consent screen is not tested."
  > Over: "Uses a dev IdP."

## Layout

Each environment folder holds:

- `README.md`, with what the environment tests, its differences from production, its commands, and how long a cold start takes.
- `env.sh`, with the subcommands `up`, `walk`, `reset` and `down`. `walk` resets the environment and runs the walk-through.
- The walk-through script and any files the containers need.

A piece that more than one environment uses moves to `scripts/`, and each environment calls it from there.
