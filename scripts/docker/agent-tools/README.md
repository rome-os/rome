# Image agent tools

Core's package manifest and pnpm lockfile own Codex and the Claude Agent SDK.
The image's global Codex command links to that installed Codex package.
This npm manifest and lockfile own the standalone Claude Code command.

Claude Code and the Agent SDK have independent version numbers. Dependabot
updates their npm packages separately; it does not translate one version into
the other. The image installs Claude Code with npm ci and checks both global
commands exist.

Dependabot checks these three packages daily and opens pull requests. A person
reviews and merges each update. No workflow enables auto-merge, uses a personal
token, or writes changes from a pull_request_target job.

Before merging an update, run the relevant adapter and bundled-binary tests.
Build the agent-tools image stage for amd64 and arm64 and check the CLI version.
A listed model does not prove account entitlement or a successful model turn.
