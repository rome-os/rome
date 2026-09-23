# Isolated Pi child prototype

This throwaway harness tests one architecture, not a production provider. Rome stores one
provider-scoped token in its existing settings store, loads it only for an operation, and starts a
fresh Node child with an allowlisted environment. The child receives an empty `auth.json`,
`models.json`, and model-store path, sets Pi offline for catalog refresh, and calls only
`ModelRuntime.create()`, `getAvailable()`, `getModel()`, and `streamSimple()`. It never constructs a
Pi resource loader or session manager, so Pi profiles, extensions, prompts, tools, and archives have
no entry point.

The prototype supports Anthropic only. This keeps the credential-to-environment mapping inspectable;
production would add one reviewed mapping at a time.

## Try it on a local development profile

Run the normal database migration first if this Rome profile has never been started. Then, from the
repository root:

```sh
# Read without terminal echo and send through stdin; the harness never prints it.
read -rsp "Anthropic token: " PI_TOKEN; echo
printf %s "$PI_TOKEN" | pnpm --filter @rome/core exec tsx \
  src/prototypes/pi-provider/cli.ts save anthropic
unset PI_TOKEN

pnpm --filter @rome/core exec tsx \
  src/prototypes/pi-provider/cli.ts status anthropic
pnpm --filter @rome/core exec tsx \
  src/prototypes/pi-provider/cli.ts discover anthropic

# Copy one exact qualified ID from discover, such as anthropic/<model-id>.
pnpm --filter @rome/core exec tsx \
  src/prototypes/pi-provider/cli.ts run anthropic '<qualified-id>' 'Reply with one short sentence.'

pnpm --filter @rome/core exec tsx \
  src/prototypes/pi-provider/cli.ts remove anthropic
```

The run command exercises Rome's `ModelProvider`/`ModelSession` streaming shape and records provider
`pi` plus the exact qualified model in accounting. The child is killed on interruption and its whole
credential-bearing environment disappears with the process. A new child is built from scratch and
does not inherit the prior credential.

## Focused proof

```sh
pnpm --filter @rome/core test -- pi-child-prototype.test.ts
```

The tests use fixture-only values and make no provider request. They prove SettingsRepository reload,
redacted public status, provider-scoped removal, SDK catalog discovery, minimal environment contents,
ordinary Rome stream/accounting mapping, cancellation, no credential in a later child, and that
sentinels in a normal Pi profile do not execute.

## Deliberate gaps

- No route, settings UI, provider registration, model resolver integration, migration, or release
  packaging.
- Only text in/text out is mapped. Rome tools, tool results, images, thinking, approvals, skills, and
  multi-turn reconstruction still need production adapters and integration tests.
- The prototype uses the existing generic settings table exactly as the current secret-storage
  precedent does; it does not harden or redesign at-rest storage.
- The static SDK catalog is not live credential verification. The first request can still fail for
  access, quota, entitlement, or revocation.
- The manual run performs a real provider request. Automated proof uses a child fixture branch and
  keeps Pi catalog refresh offline.

## Prototype-only browser harness

Start the same flow on a loopback-only development endpoint:

```sh
PI_PROTOTYPE_HOST=127.0.0.1 PI_PROTOTYPE_PORT=4397 \
  pnpm --filter @rome/core exec tsx src/prototypes/pi-provider/browser-server.ts
```

Open `http://127.0.0.1:4397/pi-prototype/`. The token field is cleared as soon as Save is clicked,
the page uses no browser storage, and only redacted status is returned. Fixed public errors prevent
SDK or credential details from reaching the browser. This browser surface is also throwaway
prototype code and does not register Pi as a production provider.
