# Contributing to Rome

Rome welcomes bug reports, user-experience feedback, feature ideas, and pull requests. Rome is released under the [MIT License](LICENSE), and every contribution is accepted under the same license.

## Open an issue

Issues about user experience are as welcome as bug reports. If a flow is confusing, a screen looks rough, or a step takes longer than it should, open an issue and describe what you tried and what got in the way.

File a **bug report** when something Rome already ships behaves wrong. File a **feature request** when you hit a pain, a gap, or a user-experience problem and the fix is still undecided.

An automated triage process reads each new issue and applies its type, priority (`P0`–`P3`), and size labels. You do not need to label an issue yourself. The full issue rules are in [`docs/authoring/github-issues.md`](docs/authoring/github-issues.md).

## Set up a development environment

Follow [`DEVELOPMENT.md`](DEVELOPMENT.md). It covers the prerequisites (OrbStack or Docker, Nix, and direnv), the first-time setup, and `pnpm dev:all`, the single command that starts Rome locally.

## Coding principles

Prefer the simple, straightforward solution. A complicated solution to a low-impact problem is usually the wrong solution. Before you write code, and again before you open a pull request, check the change against these questions:

- **Is this the right problem?** State it in one sentence: "When _who_ does _what_, _this bad outcome_ happens, because _cause_." If you cannot name who hits it, the impact is unknown. If the cause is a guess, investigate first. If the sentence names your fix, it restates a solution, not a problem.
- **Is this the right solution?** Fix the cause, at the layer where it starts. Be wary of fixes that often hide a symptom instead: swallowing an error, adding a retry, raising a timeout, or patching each place the symptom appears instead of its source.
- **Is there a simpler alternative?** Always look for one. If you keep the more complex option, say why in the pull request.
- **What is the impact?** Weigh how many users the change helps, and how much, against the code and risk it adds.
- **Does it cover the main cases?** Handle the cases that real users hit. Do not add machinery for rare edge cases unless they put correctness, security, or data at risk.
- **Will it be easy to maintain?** Follow established patterns and good coding practice, so that the next contributor can read, change, and delete the code without surprises.

Reviewers judge a pull request by the same questions.

## Make a change

[`CLAUDE.md`](CLAUDE.md) is the working playbook for people and coding agents alike. It lists the repo layout, the patterns to follow, and the known traps. The points that matter most:

- If you name a chat, thread, account, agent, or connection in code, UI copy, or docs, use the words in [`docs/domains/`](docs/domains/README.md).
- If you build or edit an app under `rome_apps/`, read [`rome_apps/CLAUDE.md`](rome_apps/CLAUDE.md) first.
- If you write docs or PR text, follow [`docs/authoring/WRITING.md`](docs/authoring/WRITING.md).

Verify a change before you open a pull request:

1. Run `pnpm typecheck` on the host.
2. Run `pnpm test:unit`.
3. Run `pnpm dev:all` and confirm that the rome container logs `Rome started`.
4. If the change touches the UI, exercise the feature in the browser.

## Open a pull request

The full rules are in [`docs/authoring/prs.md`](docs/authoring/prs.md). In short:

- The title is a [Conventional Commit](https://www.conventionalcommits.org/), such as `fix(web): keep the composer visible on phones`. Check it with `scripts/check-pr-title.sh "<title>"`. Squash-and-merge uses the title as the commit on `main`, and the release flow reads it.
- The description opens with the problem, not with the list of changed files.
- The test plan lists the behaviors you verified, each with its observable outcome.
- A change to what the dashboard or an app shows includes phone (390×844) and desktop (1280×900) screenshots.

## Code review

Every pull request goes through an automated code review. The reviewers post a verdict and inline findings, and each finding carries a priority from `P0` (most severe) to `P3` (least severe).

- Fix every `P0` and `P1` finding before merge, unless you show in a reply that it is wrong or outside this PR. If it is a real defect that already existed, file an issue for it.
- Aim for approval from every reviewer. Each review ends with one of three verdicts:
  - **Approve** — the reviewer found nothing that blocks merge.
  - **Request changes** — a change is usually needed. Address the findings before merge.
  - **Comment** — the reviewer has concerns but does not block merge. Use your judgment: the pull request can often merge as is.
- If a `P2` or `P3` finding is a nitpick, push back in a reply that explains why the change is not worth it.
- CI must pass before merge.

A maintainer merges the pull request once the review and CI are settled.
