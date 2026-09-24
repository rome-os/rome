# Prototype: Webchat default agent (throwaway, do not merge)

This prototype answers `webchat-default-agent/prototype-brief.md` in `zhangfand/rome-work@8868d1b`.

## Try it under `pnpm dev:all` (the verified path)

Run it on a development machine, never on a host that runs a production Rome.

```bash
git switch prototype/webchat-default-agent-replay
# Hold the stack on local auth, and keep it un-enrolled even if a token is in the env.
ROME_DEV_SKIP_TOKEN_SEED=1 FEATURE_GATE_ROME_CLOUD_AUTH=off pnpm dev:all   # stays attached to logs
P=scripts/prototype-webchat-default-agent/dev-all.sh
$P sh 'curl -s -X POST 127.0.0.1:4141/api/onboard/create-account -H "content-type: application/json" -d "{\"userId\":\"proto\",\"password\":\"proto-pass-123\"}"'
$P scenarios install        # fixture app wda-proto-app with agent wda-proto-app:helper
$P scenarios state
```

Open `http://<slug>.rome.localhost:3000/settings/advanced`, where `<slug>` is
the output of `scripts/worktree-slug.sh`. Sign in as `proto` / `proto-pass-123`.
Use the same `scenarios` commands listed below through `$P scenarios ...`.
`$P ui <flow> a|b` replays the browser checks in the worktree's Chrome sidecar.
The `a` and `b` arguments are two isolated browser contexts. To restart Rome,
run `docker restart <slug>-rome-1`.

## Try it with a bare process (first run only)

```bash
pnpm install
pnpm --filter @rome-os/node build && pnpm --filter @rome/discord-cli build
pnpm build:apps && pnpm --filter rome-web build
scripts/prototype-webchat-default-agent/start.sh      # profile wda-proto, http://127.0.0.1:4310
curl -s -X POST 127.0.0.1:4310/api/onboard/create-account \
  -H 'content-type: application/json' -d '{"userId":"proto","password":"proto-pass-123"}'
node scripts/prototype-webchat-default-agent/scenarios.prototype.mjs install   # fixture app + agent
```

Open `http://127.0.0.1:4310/settings/advanced` and sign in as `proto`. The dashed
**Webchat default agent (prototype)** box at the top of Advanced is the rough
control. It saves when you change it. Choose `helper` (the fixture agent
`wda-proto-app:helper`), then open **Chat**. A dashed debug line above the
chat shows the draft key, the saved and effective default, and the latched seed
decision.

- Reload or upgrade the owning app:
  `scenarios.prototype.mjs reinstall-watch [version]`
- Disable or re-enable it: `scenarios.prototype.mjs disable|enable`
- Uninstall or reinstall it: `scenarios.prototype.mjs uninstall|install`
- Restart Rome: `stop.sh` then `start.sh`

`ui.prototype.mjs <flow> [a|b]` replays the browser checks headlessly. The flows
are `advanced`, `advanced-set`, `s1`, `entry`, `swap`, `remove`, `blank`, and
`window`. The `a` and `b` arguments select two separate browser profiles.

`start.sh` uses `env -i` on purpose. A shell on a host that already runs Rome
carries that instance's Rome Cloud identity. Without the scrub, this instance
provisions and drains the real relay mailbox.

## Where things live

- Removal rule: `decideOnCatalogEvent` in
  `packages/core/src/webchat/default-agent.prototype.ts`. It is registered in
  `packages/core/src/index.ts` right after `agentLoaderSubscriber`. The boot
  reconcile runs after first-party convergence.
- Seeding rule: `decideDraftDefaultAgentSeed` in
  `packages/web/src/lib/default-agent.prototype.ts`. FreeGrid latches it once per
  draft, keyed by `location.key`. ChatComponent applies it once through the
  composer handle.
- Routes: `GET` and `PUT /api/chat/default-agent` in `webchat.ts`. The session
  creation route is unchanged.
- Evidence: `evidence/`. It holds scenario traces, filtered server logs, and screenshots.
