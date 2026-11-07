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
 * through `POST /api/instance/adopt` (api/routes/instance-adopt.ts). The request
 * carries only the instance token: the route links with it (instance-identity.ts)
 * and takes the slug from Rome Cloud's whoami answer, then writes it back here
 * with {@link applyInstanceSlug}, which updates `process.env` and so reaches
 * children forked later.
 *
 * The slug is also stored in the settings table as `{ from, to }`
 * ({@link INSTANCE_SLUG_SETTING_KEY}), written right after the link. A
 * respawned backend inherits the container's original env (the pool slug); at
 * boot {@link decideAdoptedSlug} re-applies `to` only while the env slug is still
 * `from`. Once the container is recreated with a newer `.env` (the adopted slug,
 * or a later address change), the env has moved on, the stored value is dropped
 * and the env wins. A crash between the link and that write leaves a linked box
 * without the slug; the control plane's call fails, so it quarantines the VM and
 * never retries adopt on it, and no resumable pending state is needed.
 *
 * Read live, so they follow an adopted identity:
 *   - lib/cloud-auth-gate.ts and lib/auto-upgrade-gate.ts (statsig gates):
 *     `resolveInstanceSlug()` at evaluation time.
 *   - index.ts `createAppOgImageSubscriber({ host })`: a getter, read per render.
 *     Social cards carry the host in their cache name (apps/og/store.ts), and the
 *     provisioning step after a link re-renders them, so cards drawn with the
 *     pool host are never served after adoption.
 *   - index.ts `createPromptSources(...)`: `publicOrigin` is a getter. Note
 *     the main-agent prefix is cached on the first turn, so an origin adopted
 *     after a turn only shows once the cache is dropped.
 *   - Action workers: the adopt route calls `restartWorkerWarmPool()`, so new
 *     workers fork with the updated env and run `loadConfig()` themselves
 *     (actions/engine.ts `createWorkerProcess`, actions/worker-runtime.ts).
 *     Workers that are mid-run retire after their run.
 *
 * Deliberately still captured at boot:
 *   - telemetry.ts `buildResourceAttributes()`: `service.instance.id` keeps the
 *     boot (pool) slug until the container is recreated, including after a
 *     backend respawn. The adopt route logs `instance adopted` with
 *     `{ from, to }` so operators can map the two.
 *
 * Readers outside core (not routed through here):
 *   - rome_apps/connector/src/api/github-webhook.ts `resolveInstanceWebhookUrl`:
 *     apps cannot import core, and the app SDK has no instance-origin accessor.
 *   - packages/rome-node-cli: `rome-node connect --server` reads
 *     `ROME_INSTANCE_TOKEN` in its own process.
 */

/** The settings-table key holding the {@link AdoptedSlug} of a runtime adoption. */
export const INSTANCE_SLUG_SETTING_KEY = "instanceSlug";

/** The stored record of a runtime adoption: the slug before it, and the one adopted. */
export interface AdoptedSlug {
  from: string | null;
  to: string;
}

export type AdoptedSlugDecision =
  | { action: "none" }
  | { action: "discard" }
  | { action: "apply"; slug: string };

/**
 * What boot does with the stored adoption. Apply `to` only while the env slug is
 * still `from` (a respawn inside the container that was adopted); if the env has
 * moved on, or the record is malformed, drop it and leave the env alone.
 */
export function decideAdoptedSlug(
  stored: unknown,
  envSlug: string | undefined,
): AdoptedSlugDecision {
  if (stored === null || stored === undefined) return { action: "none" };
  const { from, to } = (typeof stored === "object" ? stored : {}) as Partial<AdoptedSlug>;
  const wellFormed = isInstanceSlug(to) && (from === null || typeof from === "string");
  if (!wellFormed || (from ?? undefined) !== envSlug) return { action: "discard" };
  return { action: "apply", slug: to };
}

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

/** Whether the instance is hosted: it has a `PANTHEON_DOMAIN` to derive an origin from. */
export function isInstanceHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  return deriveInstanceOrigin("probe", env) !== null;
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
