# Security policy

If you believe you have found a security issue in Rome, report it privately first.

Rome is a personal agent platform that acts on its owner's behalf. This policy gives researchers a private path to report a vulnerability, and it states the trust model we use to triage reports.

## Reporting a vulnerability

Report security problems through GitHub private vulnerability reporting:

**[Report a vulnerability](https://github.com/rome-os/rome/security/advisories/new)**

Do not open a public issue, pull request, or discussion that discloses an unpatched vulnerability, an exploit path, a secret, or a security-sensitive proof of concept.

If you are unsure whether something is a vulnerability, report it privately. We would rather triage a careful report than miss a real issue.

Rome does not currently run a paid bug bounty program.

### What to include

- What you found, and why you believe it is security-relevant.
- The affected version, and the commit SHA when possible.
- Reproduction steps or a proof of concept against the latest release or `main`.
- The actual impact, including which [trust boundary](#trust-model) is crossed.
- Any remediation advice or focused patch you can provide.

Send proof-of-concept code as plain text. Do not attach executables. Reports without reproduction steps and a clear impact take longer to triage.

### Duplicate reports

- Search the [published advisories](https://github.com/rome-os/rome/security/advisories) before you file.
- If your report may duplicate an advisory, name it.
- We may close a later duplicate in favor of the earliest complete report.

## Response targets

We follow a coordinated vulnerability disclosure process. We aim to meet these targets:

| Stage | Target |
| --- | --- |
| Initial acknowledgment | Within 5 business days |
| Initial assessment | Within 14 business days |
| Fix and advisory | Within 90 days of the report |

These targets are indicative, not guarantees. They can change with the severity and exploitability of the issue and the complexity of the fix. We keep you informed of the status where we reasonably can.

## Supported versions

We patch only the latest release of Rome. We do not backport fixes to older releases. To stay protected, keep Rome on the latest release.

## Scope

### In scope

- The latest release of Rome.
- Active development code on the `main` branch of this repository.

### Out of scope

These are usually not vulnerabilities by themselves:

- Prompt injection without a policy, auth, approval, permission, or sandbox bypass.
- Generic jailbreak findings about a model without a Rome-specific defect.
- The owner using an intended feature, such as running code or browsing the web.
- A malicious app or plugin after the owner installs or enables it.
- Reports that need the owner's credentials, the owner's device, or administrator access to the machine that runs Rome.
- Scanner-only or dependency-only reports without a working reproduction and a real impact on Rome.
- Deployment choices that the documentation recommends against.
- Test-only code and maintainer tooling that does not ship in a release.
- Legacy or unsupported versions.
- Third-party services and systems that the Rome project does not own or operate.
- Denial-of-service, load, and other volumetric testing.
- Social engineering and physical attacks.

If you are unsure, report privately.

## Trust model

### One-owner trust model

Rome follows a personal assistant model: one trusted owner per instance, not a shared multi-tenant service.

- The owner is trusted. Rome does not try to protect an instance from its own owner.
- People whom the owner allows to message the agent can steer it within the permissions the owner granted.

### Agent and model assumptions

- The model is not a trusted principal. Assume that content from other people, from the web, and from the model itself can manipulate the agent.
- Security boundaries come from authentication, access control, permissions, approvals, and isolation.
- Prompt injection by itself is not a vulnerability unless it crosses one of those boundaries. For example, it skips a required approval, gives an untrusted person the owner's authority, or reaches data or accounts beyond the permissions the owner granted.

### App and plugin trust boundary

Apps and plugins that the owner installs are treated as trusted code.

- Only install apps and plugins that you trust.
- A report must show a boundary bypass, such as an install or permission check that does not hold, not only harmful behavior from an app the owner installed.

## Coordinated disclosure

Please do not disclose a vulnerability publicly until one of these happens first:

- A fix has been released.
- We have agreed on a disclosure timeline with you.
- 90 days have passed since your report.

When we fix a vulnerability, we publish a [GitHub security advisory](https://github.com/rome-os/rome/security/advisories) with the release that contains the fix. We request a CVE through GitHub for confirmed vulnerabilities in a component that we distribute. We may disclose earlier when that is needed to protect users.

## Safe harbor

We support good-faith security research that follows this policy. We will not take legal action against you for it, provided that you:

- Test only against your own instance, your own account, and your own data.
- Do not access, change, copy, or keep data that is not yours. If you reach such data by accident, stop and tell us.
- Do not run denial-of-service, load, or spam tests against a service that other people use.
- Stop testing once you have enough evidence to show the issue.
- Report the issue promptly and give us the agreed time to fix it before you disclose it publicly.

This safe harbor does not extend to third-party systems or services.

## Recognition

With your consent, we credit you in the security advisory.
