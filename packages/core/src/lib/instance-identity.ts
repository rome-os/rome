import { getRomeCloudOrigin } from "./rome-cloud-origin.js";
import { createLogger } from "../logger.js";

const log = createLogger("instance-identity");

// Must match Rome Cloud's INSTANCE_TOKEN_PREFIX. Distinct from the
// `rome_` account/CLI token so neither verifier mistakes one for the other.
const INSTANCE_TOKEN_PREFIX = "romeinst_";

// The DB key (in the `settings` table) that holds the durable instance token.
export const INSTANCE_TOKEN_SETTING_KEY = "instanceToken";

// The minimal settings reader/writer this module needs. `SettingsRepository`
// satisfies it; keeping the surface narrow lets instance-identity stay free of
// DB/Drizzle types.
export interface InstanceTokenStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function isValidInstanceToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.startsWith(INSTANCE_TOKEN_PREFIX);
}

// The durable instance credential. The DB is the single runtime
// read path: a provisioned VM gets the token injected into the env via
// cloud-init and seeds it into the DB at boot (see `seedInstanceTokenFromEnv`);
// the desktop/local app mints it through the in-app OAuth flow and persists it
// the same way. `getInstanceToken` only ever reads the in-memory cache that
// `hydrateInstanceToken` fills from the DB — it never touches the env.
let cachedInstanceToken: string | null = null;
const instanceTokenListeners = new Set<() => void>();

export function getInstanceToken(): string | null {
  return isValidInstanceToken(cachedInstanceToken) ? cachedInstanceToken : null;
}

// Update the in-process cache without touching the DB. Call after persisting a
// freshly-minted token so synchronous `getInstanceToken` callers see it at once.
export function setInstanceTokenInMemory(token: string | null): void {
  const nextToken = isValidInstanceToken(token) ? token : null;
  if (cachedInstanceToken === nextToken) return;
  cachedInstanceToken = nextToken;
  // The token is already persisted; a failing listener must not fail that write.
  for (const listener of instanceTokenListeners) {
    try {
      listener();
    } catch (err) {
      log.warn("instance token listener failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Subscribe to minted and revoked instance credentials in this process. */
export function onInstanceTokenChanged(listener: () => void): () => void {
  instanceTokenListeners.add(listener);
  return () => instanceTokenListeners.delete(listener);
}

// Load the persisted token from the DB into the cache. Run once at boot, before
// anything calls `getInstanceToken`.
export async function hydrateInstanceToken(store: InstanceTokenStore): Promise<void> {
  const stored = await store.get<string>(INSTANCE_TOKEN_SETTING_KEY);
  setInstanceTokenInMemory(stored ?? null);
}

// Cloud-only seeding: a provisioned VM gets `ROME_INSTANCE_TOKEN` injected into
// its env. Persist it to the DB so the runtime has one read path. Upserts on
// every boot so a rotated env token propagates. Desktop/local have no env token
// and fall through to the in-app enroll flow. Returns whether a token was seeded.
export async function seedInstanceTokenFromEnv(store: InstanceTokenStore): Promise<boolean> {
  // Dev only: force the box to boot un-enrolled even when a token is in the env,
  // so the dev stack exercises the real browser consent → enroll round trip
  // instead of short-circuiting to the seeded token. Prod never sets this.
  if (process.env.ROME_DEV_SKIP_TOKEN_SEED === "1") return false;
  const envToken = process.env.ROME_INSTANCE_TOKEN?.trim();
  if (!isValidInstanceToken(envToken)) return false;
  await store.set(INSTANCE_TOKEN_SETTING_KEY, envToken);
  return true;
}

// Persist a freshly-minted token (from the in-app OAuth enroll flow) and refresh
// the cache so it takes effect without a restart.
export async function persistInstanceToken(
  store: InstanceTokenStore,
  token: string,
): Promise<void> {
  await store.set(INSTANCE_TOKEN_SETTING_KEY, token);
  setInstanceTokenInMemory(token);
}

// Fail closed on a token Rome Cloud has rejected (revoked/unknown): drop it from
// the DB and the cache so `getInstanceToken` returns null, `instanceEnrolled`
// flips false, and the web routes back to the connect flow. Used by the identity
// heartbeat and any caller that observes a terminal auth signal.
export async function clearInstanceToken(store: InstanceTokenStore): Promise<void> {
  await store.delete(INSTANCE_TOKEN_SETTING_KEY);
  setInstanceTokenInMemory(null);
}

export interface InstanceIdentity {
  accountId: string;
  instanceId: string;
  /** The account owner's email (the guardian's, from signup). Present whenever
   *  Rome Cloud's whoami returns it; used to seed the email channel's guardian
   *  gate without manual entry. */
  email?: string;
  /** Rome Cloud profile picture for the account owner. Null means Cloud knows
   *  the account has no picture; undefined means the response omitted the field. */
  avatarUrl?: string | null;
}

// The outcome of presenting the durable token to Rome Cloud. `revoked` and
// `unknown` mirror the server's terminal signals: both mean "this
// instance is no longer valid," distinguished only so a caller can tell a
// tombstone (403) from a never-known/garbled token (401). `no_token` and
// `unconfigured` are local preconditions (not enrolled / no Rome Cloud origin);
// `unreachable` is a transient network failure — the only non-terminal miss.
export type ProveIdentityResult =
  | { status: "ok"; identity: InstanceIdentity }
  | { status: "revoked" }
  | { status: "unknown" }
  | { status: "no_token" }
  | { status: "unconfigured" }
  | { status: "unreachable" };

export interface ProveIdentityOptions {
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Present only for the one boot-time announcement. Recurring identity
   *  heartbeats omit it, so Rome Cloud can distinguish boots from liveness. */
  bootVersion?: string | null;
}

// The single client-side seam: present the durable instance token
// to Rome Cloud and learn who we are. This is the one place Appendix A swaps a
// bearer header for a key-signed challenge — every future service call brokers
// through here rather than handling the durable secret itself.
//
// The durable token is presented ONLY to Rome Cloud, never to a service edge.
export async function proveIdentity(opts: ProveIdentityOptions = {}): Promise<ProveIdentityResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const token = getInstanceToken();
  if (!token) return { status: "no_token" };

  const origin = getRomeCloudOrigin();
  if (!origin) return { status: "unconfigured" };

  let response: Response;
  try {
    const isBootAnnouncement = Object.hasOwn(opts, "bootVersion");
    response = await fetchImpl(new URL("/api/instance/whoami", origin), {
      method: isBootAnnouncement ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Cache-Control": "no-store",
        ...(isBootAnnouncement ? { "Content-Type": "application/json" } : {}),
      },
      ...(isBootAnnouncement ? { body: JSON.stringify({ version: opts.bootVersion }) } : {}),
      cache: "no-store",
    });
  } catch {
    // Network failure — non-terminal. The caller retries later; we never treat
    // an unreachable Rome Cloud as "not this instance."
    return { status: "unreachable" };
  }

  if (response.status === 401) return { status: "unknown" };
  if (response.status === 403) return { status: "revoked" };
  if (!response.ok) return { status: "unreachable" };

  const data = (await response.json().catch(() => null)) as {
    instanceId?: unknown;
    account?: { id?: unknown; email?: unknown; avatarUrl?: unknown } | null;
  } | null;
  const instanceId = typeof data?.instanceId === "string" ? data.instanceId : null;
  const accountId = typeof data?.account?.id === "string" ? data.account.id : null;
  if (!instanceId || !accountId) return { status: "unreachable" };
  const email = typeof data?.account?.email === "string" ? data.account.email : undefined;
  const avatarUrl =
    data?.account && Object.hasOwn(data.account, "avatarUrl")
      ? typeof data.account.avatarUrl === "string"
        ? data.account.avatarUrl
        : null
      : undefined;

  return { status: "ok", identity: { accountId, instanceId, email, avatarUrl } };
}

// Best-effort identity announcement at boot. Authenticate is "constant,
// invisible" — a single prove at startup gives operators
// visibility into which account this instance is bound to and bumps the
// server's `lastSeen`. Never blocks or fails boot. Returns the prove result so
// the caller can record the bound account from this one check instead of
// proving a second time.
export async function logInstanceIdentityAtBoot(
  version: string | null,
): Promise<ProveIdentityResult> {
  try {
    const result = await proveIdentity({ bootVersion: version });
    switch (result.status) {
      case "ok":
        log.info("instance enrolled", { instanceId: result.identity.instanceId });
        break;
      case "no_token":
        log.info("instance not enrolled (no instance token present)");
        break;
      case "unconfigured":
        log.debug("instance token present but Rome Cloud origin not configured");
        break;
      case "unreachable":
        log.warn("could not reach Rome Cloud to verify instance identity");
        break;
      case "unknown":
      case "revoked":
        // Terminal server signals. A provisioned/desktop client that owns the
        // token store would clear it here; core only holds an injected env var,
        // so it just surfaces the state loudly for operators.
        log.warn("instance token rejected by Rome Cloud", { reason: result.status });
        break;
    }
    return result;
  } catch (err) {
    log.warn("instance identity check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "unreachable" };
  }
}
