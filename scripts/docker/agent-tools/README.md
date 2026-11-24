# Image agent tools

Core's package manifest and pnpm lockfile own Codex and the Claude Agent SDK.
Both production and dev images link Codex to Core's package entrypoint.
The dev link becomes available after the workspace dependency install.
This npm manifest and lockfile own the standalone Claude Code command.

Claude Code and the Agent SDK have independent version numbers. Dependabot
updates their npm packages separately; it does not translate one version into
the other. Both images install Claude Code with npm ci. Production executes both global
commands at build time; dev uses Codex from its populated workspace.

Dependabot checks these three packages daily and opens pull requests. A person
reviews and merges each update. No workflow enables auto-merge, uses a personal
token, or writes changes from a pull_request_target job.

Before merging an update, run the relevant adapter and bundled-binary tests.
Build the agent-tools image stage for amd64 and arm64 and check the CLI version.
A listed model does not prove account entitlement or a successful model turn.
