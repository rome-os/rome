# Backend browser suite

These tests drive the built dashboard in Chromium against a real Rome. They
guard what a guardian sees of chats while the storage under them changes:
the chat list, transcripts after a reload, replies, titles, unread marks,
search, rename, archive, delete, the Sessions page with subagent runs and
the trace drawer, and a WeChat chat.

## What is real and what is fake

`packages/core/src/test/browser-e2e/server.ts` boots Rome's own
`src/index.ts` over a fresh home directory, with the built dashboard as its
web root. Two edges are fakes:

- **The model.** A loopback Anthropic Messages API
  ([`fake-anthropic.ts`](../../core/src/test/browser-e2e/fake-anthropic.ts)).
  Global setup stores it as the guardian's custom Anthropic environment, so the
  real Claude provider spawns the real Claude CLI for every turn. A test says
  what the model answers with a directive in its message, such as
  `E2E-REPLY <token>`. The file lists the directives.
- **WeChat.** A loopback iLink bot API
  ([`fake-ilink.ts`](../../core/src/test/browser-e2e/fake-ilink.ts)). The
  launcher routes the iLink origin to it, so the Settings connect flow, the
  long poll and the sends run Rome's own adapter. The QR login confirms at
  once and binds the guardian's WeChat user.

The launcher's control server, on port 4611, lets a test send a WeChat message
and read what Rome sent back. [`control.ts`](control.ts) wraps it.

## Run it

From the repository root, in the devShell:

```bash
pnpm build:apps
pnpm --filter rome-web build
pnpm --filter rome-web test:backend-e2e
```

Playwright starts the launcher and waits for it. A first boot installs every
first-party app's dependencies, which takes a minute or two. Locally,
Playwright reuses a launcher that already answers on port 4611, so you can keep
one running between runs:

```bash
E2E_HOME=/tmp/rome-e2e pnpm --filter @rome/core exec tsx src/test/browser-e2e/server.ts
```

Set `E2E_MODEL_LOG` to a file path to record every request the fake model
receives. Set `E2E_CHROMIUM_PATH` to use a Chromium that Playwright did not
install.

## Writing a test

- Name each chat with `token()`, because tests share one Rome and run one at a
  time.
- After an action, check the result after a reload as well, so the assertion
  reads storage and not the page's own state.
- Prefer roles and visible text over markup. Every test fails on a page error
  or a 5xx response, whatever it asserts.
