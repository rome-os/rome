/**
 * The instance's tenant identity, read from and applied to the environment.
 *
 * Three variables identify which tenant this Rome is:
 *   - `PANTHEON_SLUG`            — the instance slug
 *   - `PANTHEON_INSTANCE_ORIGIN` — the explicit public origin
 *   - `ROME_INSTANCE_TOKEN`      — the enrolled instance token
 *
 * This is the only file in `packages/core` that reads or writes them in the
 * environment. Everything else goes through {@link resolveInstanceSlug},
 * {@link getConfiguredInstanceOrigin} / {@link getInstanceOrigin} or
 * instance-identity.ts, which build on the raw readers below. Keeping the reads
 * here lets the source of these values change in one place.
 *
 * A blank hosted instance (a warm-pool VM) receives its identity at runtime
 * through `POST /api/instance/adopt` (api/routes/instance-adopt.ts): the token
 * goes through instance-identity.ts, and the slug is written back here with
 * {@link applyInstanceSlug}, which updates `process.env` and so reaches
 * children forked later. The slug is also stored in the settings table
 * ({@link INSTANCE_SLUG_SETTING_KEY}) and re-applied at boot (index.ts), so a
 * respawned process, which inherits the container's original env, keeps it.
 *
 * Read live, so they follow an adopted identity:
 *   - lib/cloud-auth-gate.ts and lib/auto-upgrade-gate.ts (statsig gates):
 *     `resolveInstanceSlug()` at evaluation time.
 *   - index.ts `createAppOgImageSubscriber({ host })`: a getter, read per render.
 *   - index.ts `new PromptBuilder(...)`: `romePublicOrigin` is a getter. Note
 *     the main-agent prefix is cached on the first turn, so an origin adopted
 *     after a turn only shows once the cache is dropped.
 *   - Action workers: the adopt route calls `restartWorkerWarmPool()`, so new
 *     workers fork with the updated env and run `loadConfig()` themselves
 *     (actions/engine.ts `createWorkerProcess`, actions/worker-runtime.ts).
 *     Workers that are mid-run retire after their run.
 *
 * Deliberately still captured at boot:
 *   - telemetry.ts `buildResourceAttributes()`: `service.instance.id` keeps the
 *     slug the process started with until the next restart. The adopt route logs
 *     `instance adopted` with `{ from, to }` so operators can map the two.
 *
 * Readers outside core (not routed through here):
 *   - rome_apps/connector/src/api/github-webhook.ts `resolveInstanceWebhookUrl`:
 *     apps cannot import core, and the app SDK has no instance-origin accessor.
 *   - packages/rome-node-cli: `rome-node connect --server` reads
 *     `ROME_INSTANCE_TOKEN` in its own process.
 */

/** The settings-table key holding a slug adopted at runtime. */
export const INSTANCE_SLUG_SETTING_KEY = "instanceSlug";

/** A DNS label: lowercase a-z, 0-9 and "-", 1-63 chars, no leading or trailing "-". */
export function isInstanceSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

/** `PANTHEON_SLUG`, trimmed. `undefined` when unset or blank. */
export function readEnvInstanceSlug(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const slug = env.PANTHEON_SLUG?.trim();
  return slug ? slug : undefined;
}

/**
 * `PANTHEON_INSTANCE_ORIGIN` exactly as set (not trimmed or validated).
 * `undefined` when unset; an empty string is returned as is.
 */
export function readEnvInstanceOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PANTHEON_INSTANCE_ORIGIN;
}

/**
 * `ROME_INSTANCE_TOKEN`, trimmed, as a hosted `.env` injects it. `undefined`
 * when unset. The caller validates the shape.
 *
 * Dev only: `ROME_DEV_SKIP_TOKEN_SEED=1` hides the token so the box boots
 * un-enrolled even when one is in the env, letting the dev stack exercise the
 * real browser consent → enroll round trip instead of short-circuiting to the
 * seeded token. Prod never sets this.
 */
export function readEnvInstanceToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ROME_DEV_SKIP_TOKEN_SEED === "1") return undefined;
  return env.ROME_INSTANCE_TOKEN?.trim();
}

/**
 * `https://<slug>.<PANTHEON_DOMAIN>`, or null when the instance is not hosted
 * (no `PANTHEON_DOMAIN`). Same derivation as `getConfiguredInstanceOrigin`.
 */
export function deriveInstanceOrigin(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const domain = env.PANTHEON_DOMAIN?.trim().replace(/^\.+|\.+$/g, "");
  return domain ? `https://${slug}.${domain}` : null;
}

/**
 * Make `slug` this instance's slug for the running process: sets
 * `PANTHEON_SLUG` and overwrites `PANTHEON_INSTANCE_ORIGIN` with the origin
 * derived from it (a warm VM's `.env` sets the pool origin explicitly, which
 * would otherwise win). Returns the new origin, or null, changing nothing, when
 * the instance is not hosted. The caller has validated the slug.
 */
export function applyInstanceSlug(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const origin = deriveInstanceOrigin(slug, env);
  if (!origin) return null;
  env.PANTHEON_SLUG = slug;
  env.PANTHEON_INSTANCE_ORIGIN = origin;
  return origin;
}
